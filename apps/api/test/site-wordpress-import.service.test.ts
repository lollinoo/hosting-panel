import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SiteWordpressImportDtoSchema, WORDPRESS_IMPORT_KIND, type OperationKind } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  memberships,
  membershipRoles,
  operations,
  organizations,
  resourceGrants,
  saveSiteWordpressLastImport,
  serviceInstances,
  siteBackups,
  sites,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import { SITE_WORDPRESS_UPDATE_STEPS } from "../src/sites/site-wordpress-applier.js";
import { SITE_WORDPRESS_IMPORT_STEPS } from "../src/sites/site-wordpress-import-applier.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../src/tokens.js";

const KEY = Buffer.alloc(32, 7);
const JWT_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PW = "sentinel-pass-phrase";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "test-backups",
  prefix: "panel",
  accessKeyId: "AKIATESTONLY0001",
  secretAccessKey: "test-only-not-a-secret",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const ZIP = (entries: { p: string; d?: string }[] = []) => Buffer.from(`HPSIMZIP\n${JSON.stringify(entries)}`, "utf8");
const WP_ZIP = ZIP([
  { p: "index.php", d: b64("<?php // imported index") },
  { p: "wp-load.php", d: b64("<?php // load") },
  { p: "wp-includes/version.php", d: b64("<?php $wp_version = '6.9';") },
  { p: "wp-content/themes/neutral/style.css", d: b64("/* Theme Name: Neutral */") },
]);
const DUMP = Buffer.from("CREATE TABLE wp_options (option_id int);\n", "utf8");
// What no answer or audit event of these routes may hold (I15, the task's rule 7).
const LEAK = /hp_i[saum]_|\.htpanel-import|HP_[A-Z]|\/var\/|\/backup\/|docker|container|"password"/i;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("WordPress import: the customer's routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminUserId: string;
  let a: { orgId: string; token: string; siteId: string; userId: string };
  let foreignSiteId: string;
  let svc: string;
  const answers: unknown[] = [];

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string, body?: unknown, key: string = randomUUID()) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    answers.push(raw);
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : ({} as Json) };
  }

  beforeEach(async () => {
    answers.length = 0;
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "staff@example.test", name: "Staff", password: PW });
    adminUserId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: JWT_PEM,
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("staff@example.test", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Customer A",
      ownerEmail: "admin@example.test",
      ownerName: "Customer A",
    });
    const orgId = created.body.data.organizationId as string;
    const token = await login("admin@example.test", created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, SITE);
    expect(site.status).toBe(202);
    const foreign = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, domain: "old.example.test", ownerOrganizationId: null });
    expect(foreign.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    foreignSiteId = foreign.body.data.siteId as string;
    const [user] = await dbClient.db.select({ id: users.id }).from(users).where(eq(users.email, "admin@example.test"));
    a = { orgId, token, siteId: site.body.data.siteId as string, userId: user!.id };
    const [instance] = await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, a.siteId));
    svc = instance!.id;
    answers.length = 0;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  const base = (siteId = a.siteId) => `/v1/organizations/${a.orgId}/managed-sites/${siteId}/wordpress/import`;
  const reason = (body: Json) => (body.error?.details as { reason?: string }[] | undefined)?.[0]?.reason;
  const audits = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const importAudits = async () =>
    (await dbClient.db.select().from(auditEvents)).filter((e) => e.action.startsWith("site.wordpress.import."));
  const importOps = async () => (await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND);
  const setSite = (set: Partial<typeof sites.$inferInsert>) => dbClient.db.update(sites).set(set).where(eq(sites.id, a.siteId));
  const chunk = (data: Buffer, over: Partial<{ uploadId: string; offset: number; final: boolean }> = {}) => ({
    uploadId: "upload_0123456789abcdef",
    offset: 0,
    dataBase64: b64(data),
    final: true,
    ...over,
  });
  const fill = async () => {
    expect((await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP))).status).toBe(200);
    expect((await call("PUT", `${base()}/files/dump`, a.token, chunk(DUMP))).status).toBe(200);
  };
  async function enqueue(kind: OperationKind, steps: readonly { key: string; label: string }[], extra: { userId?: string; lock?: boolean } = {}) {
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: a.orgId,
      kind,
      resourceType: "site",
      resourceId: a.siteId,
      requestedByUserId: extra.userId,
      lockKey: extra.lock === false ? undefined : `site:${a.siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps,
      outboxPayload: { siteId: a.siteId },
    });
    return operation.id;
  }
  // An import that switched and could not be undone leaves its plan behind (R155).
  const leaveRemains = async () => {
    await fill();
    const importId = "0123456789abcdef0123456789abcdef";
    await sim.siteFiles({ serviceInstanceId: svc, op: "import.unpack", importId });
    await sim.siteFiles({ serviceInstanceId: svc, op: "import.switch", importId });
    expect(sim.files.importState(svc).plans).toEqual([importId]);
  };

  it("GET answers the slots, the earlier import, the running import and the stored outcome", async () => {
    const empty = await call("GET", base(), a.token);
    expect(empty.status).toBe(200);
    expect(SiteWordpressImportDtoSchema.parse(empty.body.data)).toEqual({
      available: true,
      backupsConfigured: false,
      slots: { archive: { state: "empty", size: 0, uploadId: null }, dump: { state: "empty", size: 0, uploadId: null } },
      earlierImportUnfinished: false,
      runningOperation: null,
      lastImport: null,
    });

    await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP.subarray(0, 20), { final: false }));
    await call("PUT", `${base()}/files/dump`, a.token, chunk(DUMP));
    const lastImport = {
      operationId: "op_00000000000000000000000000000001",
      finishedAt: "2026-11-15T10:05:00.000Z",
      outcome: "imported",
      reason: null,
      backup: "skipped",
      oldAddress: "http://old.example.test",
      leftOut: ["wp-config.php"],
      tables: 12,
      line: null,
      errorNumber: null,
    };
    await saveSiteWordpressLastImport(dbClient.db, { siteId: a.siteId, organizationId: a.orgId, lastImport });
    const opId = await enqueue(WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS);
    const full = (await call("GET", base(), a.token)).body.data as Json;
    expect(SiteWordpressImportDtoSchema.parse(full)).toBeTruthy();
    expect(full.slots).toEqual({
      archive: { state: "partial", size: 20, uploadId: "upload_0123456789abcdef" },
      dump: { state: "complete", size: DUMP.length, uploadId: null },
    });
    expect(full.runningOperation).toEqual({
      id: opId,
      kind: WORDPRESS_IMPORT_KIND,
      status: "queued",
      steps: SITE_WORDPRESS_IMPORT_STEPS.map((s) => ({ key: s.key, status: "pending" })),
    });
    expect(full.lastImport).toEqual(lastImport);

    // A stored outcome that no longer parses reads as null (R146.2).
    await saveSiteWordpressLastImport(dbClient.db, { siteId: a.siteId, organizationId: a.orgId, lastImport: { ...lastImport, extra: 1 } });
    expect((await call("GET", base(), a.token)).body.data.lastImport).toBeNull();
  });

  it("GET answers slots null and 200 when the executor fails or its wait ends", async () => {
    for (const outcome of ["timeout", "not_found"] as const) {
      sim.files.failNextImport("import.stat", outcome);
      const res = await call("GET", base(), a.token);
      expect([outcome, res.status, res.body.data.slots, res.body.data.earlierImportUnfinished]).toEqual([outcome, 200, null, false]);
    }
  });

  it("an unfinished earlier import shows on GET, survives a discard and refuses a start before anything is written", async () => {
    await leaveRemains();
    expect((await call("GET", base(), a.token)).body.data.earlierImportUnfinished).toBe(true);
    expect((await call("DELETE", `${base()}/files`, a.token)).status).toBe(204);
    const after = (await call("GET", base(), a.token)).body.data as Json;
    expect([after.earlierImportUnfinished, after.slots.archive.state]).toEqual([true, "empty"]);

    // R164.5.3: the remains are named before the files, with empty, half and full slots.
    for (const slot of [null, "archive", "dump"]) {
      if (slot) expect((await call("PUT", `${base()}/files/${slot}`, a.token, chunk(slot === "archive" ? WP_ZIP : DUMP))).status).toBe(200);
      const res = await call("POST", base(), a.token, { confirm: true });
      expect([slot, res.status, res.body.error.code, reason(res.body)]).toEqual([slot, 409, "RESOURCE_LOCKED", "earlier_import_unfinished"]);
    }
    expect(await importOps()).toEqual([]);
    expect(await audits("site.wordpress.import.requested")).toEqual([]);
  });

  it("guards in order on every change: capability, WordPress site, site state, then a running import", async () => {
    const config = app.nestApp.get(CONTROL_PLANE_CONFIG_TOKEN) as ControlPlaneRuntimeConfig;
    const mutations = (): [string, string, unknown?][] => [
      ["PUT", `${base()}/files/archive`, chunk(WP_ZIP)],
      ["POST", `${base()}/files/dump/pick`, { path: "site.sql" }],
      ["DELETE", `${base()}/files`],
      ["POST", base(), { confirm: true }],
    ];
    const expectAll = async (status: number, code: string, why: string) => {
      for (const [method, path, body] of mutations()) {
        const res = await call(method, path, a.token, body);
        expect([method, path, res.status, res.body.error?.code, reason(res.body)]).toEqual([method, path, status, code, why]);
      }
    };
    (config as { runtimeBackend: string }).runtimeBackend = "local-simulator";
    await setSite({ phpVersion: null, status: "deploying" });
    await expectAll(422, "NOT_SUPPORTED", "wordpress_unavailable");
    expect((await call("GET", base(), a.token)).body.data).toMatchObject({ available: false, slots: null });
    (config as { runtimeBackend: string }).runtimeBackend = "linux-systemd";
    await expectAll(422, "NOT_SUPPORTED", "not_wordpress");
    await setSite({ phpVersion: "8.3" });
    await expectAll(409, "RESOURCE_LOCKED", "not_ready");
    await setSite({ status: "ready" });

    await enqueue(WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS);
    await expectAll(409, "RESOURCE_LOCKED", "import_running");
    expect(await importAudits()).toEqual([]);
  });

  it("a running update of the same site does not block an upload", async () => {
    await enqueue("site.wordpress.update", SITE_WORDPRESS_UPDATE_STEPS);
    const res = await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP));
    expect([res.status, res.body.data]).toEqual([200, { received: WP_ZIP.length }]);
  });

  it("upload passes each chunk on unchanged and audits the final chunk only", async () => {
    const first = await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP.subarray(0, 30), { final: false }));
    expect([first.status, first.body]).toEqual([200, { data: { received: 30 } }]);
    expect(await audits("site.wordpress.import.file_uploaded")).toEqual([]);
    const last = await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP.subarray(30), { offset: 30 }));
    expect(last.body.data).toEqual({ received: WP_ZIP.length });
    // The bytes the executor holds are exactly the bytes sent: the unpack reads them as a WordPress archive.
    await sim.siteFiles({ serviceInstanceId: svc, op: "import.put", slot: "dump", uploadId: "upload_0123456789abcdef", offset: 0, dataBase64: b64(DUMP), final: true });
    expect(await sim.siteFiles({ serviceInstanceId: svc, op: "import.unpack", importId: "0123456789abcdef0123456789abcdef" })).toMatchObject({ entries: 4 });
    const rows = await audits("site.wordpress.import.file_uploaded");
    expect(rows.map((r) => [r.targetId, r.organizationId, r.actorId])).toEqual([[a.siteId, a.orgId, a.userId]]);
    expect(rows[0]!.details).toEqual({ requestId: expect.any(String), slot: "archive", size: WP_ZIP.length });
  });

  it("each refusal of the executor reaches the customer as its closed reason, with no executor text", async () => {
    const cases: [string, string, Json, () => void][] = [
      ["archive", "not_a_zip", chunk(Buffer.from("PK\x03\x04 not the simulator's zip")), () => undefined],
      ["dump", "dump_not_sql", chunk(Buffer.from([0x00, 0x01, 0x02])), () => undefined],
      ["dump", "upload_mismatch", chunk(DUMP, { offset: 99 }), () => undefined],
      ["dump", "too_large", chunk(DUMP, { offset: 3 * 1024 ** 3 }), () => undefined],
      ["archive", "disk_full", chunk(WP_ZIP), () => sim.files.failNextImport("import.put", "disk_full")],
    ];
    for (const [slot, why, body, arm] of cases) {
      arm();
      const res = await call("PUT", `${base()}/files/${slot}`, a.token, body);
      expect([why, res.status >= 400, reason(res.body)]).toEqual([why, true, why]);
      expect(res.body.error.message).not.toMatch(/IPC|executor|simulat/i);
    }
    sim.files.failNextImport("import.put", "timeout");
    const lost = await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP));
    expect([lost.status, lost.body.error.code]).toEqual([502, "OPERATION_AMBIGUOUS"]);
    expect(lost.body.error.message).not.toMatch(/IPC|executor|dispatch/i);
    expect(await audits("site.wordpress.import.file_uploaded")).toEqual([]);
  });

  it("pick moves a file of the site into a slot and refuses a path outside, a protected path and a folder", async () => {
    sim.files.seed(svc, [{ path: "exports/site.sql", kind: "file", data: DUMP }]);
    const res = await call("POST", `${base()}/files/dump/pick`, a.token, { path: "exports/site.sql" });
    expect([res.status, res.body.data]).toEqual([200, { state: "complete", size: DUMP.length, uploadId: null }]);
    const rows = await audits("site.wordpress.import.file_picked");
    expect(rows.map((r) => r.details)).toEqual([{ requestId: expect.any(String), slot: "dump", path: "exports/site.sql" }]);
    expect((await call("GET", base(), a.token)).body.data.slots.dump.state).toBe("complete");

    for (const [path, status, why] of [
      ["../outside.sql", 400, "invalid_path"],
      ["/etc/hosts", 400, "invalid_path"],
      ["wp-content/mu-plugins/hp-mail.php", 403, "protected"],
      ["wp-content", 400, "is_a_directory"],
      ["missing.zip", 404, "not_found"],
    ] as const) {
      const refused = await call("POST", `${base()}/files/archive/pick`, a.token, { path });
      const said = refused.status === 400 && why === "invalid_path" ? refused.body.error.details[0].message : reason(refused.body);
      expect([path, refused.status, said]).toEqual([path, status, why]);
    }
    expect(await audits("site.wordpress.import.file_picked")).toHaveLength(1);
  });

  it("discard empties both slots and is audited", async () => {
    await fill();
    const res = await call("DELETE", `${base()}/files`, a.token);
    expect(res.status).toBe(204);
    const slots = (await call("GET", base(), a.token)).body.data.slots as Json;
    expect([slots.archive.state, slots.dump.state]).toEqual(["empty", "empty"]);
    const rows = await audits("site.wordpress.import.files_discarded");
    expect(rows.map((r) => r.details)).toEqual([{ requestId: expect.any(String) }]);
  });

  it("start refuses until both files are complete, and writes nothing", async () => {
    let res = await call("POST", base(), a.token, { confirm: true });
    expect([res.status, res.body.error.code, reason(res.body)]).toEqual([409, "RESOURCE_LOCKED", "files_incomplete"]);
    await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP));
    await call("PUT", `${base()}/files/dump`, a.token, chunk(DUMP, { final: false }));
    res = await call("POST", base(), a.token, { confirm: true });
    expect(reason(res.body)).toBe("files_incomplete");
    expect(await importOps()).toEqual([]);
    expect(await audits("site.wordpress.import.requested")).toEqual([]);
  });

  it("start without backups queues the import with no copy row, audits it, replays its key and refuses a second", async () => {
    await fill();
    const res = await call("POST", base(), a.token, { confirm: true }, "k-import");
    expect(res.status).toBe(202);
    const operationId = res.body.data.operationId as string;
    expect(res.body).toEqual({
      data: { siteId: a.siteId, operationId },
      links: { operation: `/v1/organizations/${a.orgId}/operations/${operationId}` },
    });
    const [op] = await importOps();
    expect([op!.id, op!.lockKey, op!.requestedByUserId, op!.status]).toEqual([operationId, `site:${a.siteId}`, a.userId, "queued"]);
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);
    const requested = await audits("site.wordpress.import.requested");
    expect(requested.map((r) => r.details)).toEqual([{ requestId: expect.any(String), operationId, backup: "skipped" }]);

    const replay = await call("POST", base(), a.token, { confirm: true }, "k-import");
    expect([replay.status, replay.body.data.operationId]).toEqual([202, operationId]);
    expect(await importOps()).toHaveLength(1);
    expect(await audits("site.wordpress.import.requested")).toHaveLength(1);

    const second = await call("POST", base(), a.token, { confirm: true }, "k-other");
    expect([second.status, reason(second.body)]).toEqual([409, "import_running"]);
    expect(await importOps()).toHaveLength(1);
  });

  it("start with backups set up writes the pre_update copy row of its operation", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    await fill();
    expect((await call("GET", base(), a.token)).body.data.backupsConfigured).toBe(true);
    const res = await call("POST", base(), a.token, { confirm: true });
    expect(res.status).toBe(202);
    const operationId = res.body.data.operationId as string;
    expect(await dbClient.db.select().from(siteBackups)).toEqual([
      expect.objectContaining({ siteId: a.siteId, kind: "pre_update", status: "running", operationId }),
    ]);
    expect((await audits("site.wordpress.import.requested"))[0]!.details).toMatchObject({ operationId, backup: "taken" });
  });

  it("the seventh heavy action of the hour is refused with retryAt; a server administrator's are not counted", async () => {
    await fill();
    const heavy = async (userId: string, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const id = await enqueue(WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS, { userId, lock: false });
        await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, id));
      }
    };
    await heavy(adminUserId, 6);
    const allowed = await call("POST", base(), a.token, { confirm: true });
    expect(allowed.status).toBe(202);
    await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, allowed.body.data.operationId as string));

    await heavy(a.userId, 5);
    const before = (await importOps()).length;
    const res = await call("POST", base(), a.token, { confirm: true });
    expect([res.status, res.body.error.code, reason(res.body)]).toEqual([409, "QUOTA_EXCEEDED", "too_many_requests"]);
    expect(res.body.error.details[0]).toMatchObject({ field: "retryAt", message: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect((await importOps()).length).toBe(before);
    expect(await audits("site.wordpress.import.requested")).toHaveLength(1);
  });

  it("the routes check the organisation first, then the permission, the slot and the exact body", async () => {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email: "reader@example.test", name: "Reader", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: a.orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    await dbClient.db
      .insert(resourceGrants)
      .values({ id: `rg_${randomUUID()}`, organizationId: a.orgId, principalUserId: userId, resourceId: a.siteId, permission: "site.read" });
    const reader = await login("reader@example.test", PW);
    const routes = (siteId: string): [string, string, unknown?][] => [
      ["PUT", `${base(siteId)}/files/archive`, chunk(WP_ZIP)],
      ["POST", `${base(siteId)}/files/dump/pick`, { path: "site.sql" }],
      ["DELETE", `${base(siteId)}/files`],
      ["POST", base(siteId), { confirm: true }],
    ];

    expect((await call("GET", base(foreignSiteId), reader)).status).toBe(404);
    expect((await call("GET", base(), reader)).status).toBe(200);
    for (const [method, path, body] of routes(foreignSiteId)) {
      expect([method, path, (await call(method, path, reader, body)).status]).toEqual([method, path, 404]);
    }
    for (const [method, path, body] of routes(a.siteId)) {
      expect([method, path, (await call(method, path, reader, body)).status]).toEqual([method, path, 403]);
    }

    for (const [method, path, body] of [
      ["PUT", `${base()}/files/other`, chunk(WP_ZIP)],
      ["POST", `${base()}/files/plugins/pick`, { path: "site.sql" }],
      ["PUT", `${base()}/files/archive`, { ...chunk(WP_ZIP), overwrite: true }],
      ["POST", `${base()}/files/dump/pick`, { path: "site.sql", to: "x" }],
      ["POST", base(), { confirm: true, force: true }],
      ["POST", base(), {}],
    ] as const) {
      const res = await call(method, path, a.token, body);
      expect([path, body, res.status, res.body.error.code]).toEqual([path, body, 400, "VALIDATION_ERROR"]);
    }

    await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, a.orgId));
    expect((await call("GET", base(), a.token)).status).toBe(200);
    for (const [method, path, body] of routes(a.siteId)) {
      expect([method, path, (await call(method, path, a.token, body)).status]).toEqual([method, path, 403]);
    }
    expect(await importOps()).toEqual([]);
    expect(await importAudits()).toEqual([]);
  });

  it("no answer or audit event names a staging name, a folder of the panel, a host path or a variable, and none has a password", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    sim.files.seed(svc, [{ path: "site.sql", kind: "file", data: DUMP }]);
    await call("PUT", `${base()}/files/archive`, a.token, chunk(Buffer.from("not a zip")));
    await call("PUT", `${base()}/files/archive`, a.token, chunk(WP_ZIP));
    await call("POST", `${base()}/files/dump/pick`, a.token, { path: "site.sql" });
    await call("POST", `${base()}/files/dump/pick`, a.token, { path: "wp-content/mu-plugins/hp-mail.php" });
    await call("GET", base(), a.token);
    await call("POST", base(), a.token, { confirm: true });
    await call("POST", base(), a.token, { confirm: true });
    await call("GET", base(), a.token);
    await dbClient.db.update(operations).set({ status: "succeeded" });
    sim.files.failNextImport("import.discard", "timeout");
    expect((await call("DELETE", `${base()}/files`, a.token)).status).toBe(502);
    expect((await call("DELETE", `${base()}/files`, a.token)).status).toBe(204);
    await leaveRemains();
    await call("POST", base(), a.token, { confirm: true });
    await call("GET", base(), a.token);

    expect(answers.length).toBeGreaterThan(10);
    for (const raw of answers) {
      expect(raw).not.toMatch(LEAK);
    }
    const events = await importAudits();
    expect(events.map((e) => e.action).sort()).toEqual([
      "site.wordpress.import.file_picked",
      "site.wordpress.import.file_uploaded",
      "site.wordpress.import.file_uploaded",
      "site.wordpress.import.file_uploaded",
      "site.wordpress.import.files_discarded",
      "site.wordpress.import.requested",
    ]);
    expect(JSON.stringify(events)).not.toMatch(LEAK);
  });
});
