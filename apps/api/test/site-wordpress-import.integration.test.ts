import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_OPERATION_KINDS,
  type OperationKind,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  getSiteWordpressState,
  memberships,
  membershipRoles,
  operations,
  operationSteps,
  organizations,
  resourceGrants,
  serviceInstances,
  siteBackups,
  sites,
  transitionOperation,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { SiteFilesRequest, SiteJobRequest } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { runBreakGlassUnlock } from "../src/cli/break-glass.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import { SITE_WORDPRESS_INSPECT_STEPS, SITE_WORDPRESS_UPDATE_STEPS, SiteWordpressApplier } from "../src/sites/site-wordpress-applier.js";
import { SITE_WORDPRESS_IMPORT_STEPS, SiteWordpressImportApplier } from "../src/sites/site-wordpress-import-applier.js";

// Records which lane filter claimed which operation.
const claims = vi.hoisted(() => [] as { filter: unknown; operationIds: string[] }[]);
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    claimPendingOutboxEvents: async (...args: Parameters<typeof actual.claimPendingOutboxEvents>) => {
      const rows = await actual.claimPendingOutboxEvents(...args);
      claims.push({
        filter: args[3],
        operationIds: rows.map((r) => (r.payload as { operationId: string }).operationId),
      });
      return rows;
    },
  };
});

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

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("WordPress import: the lane, the hand-over to recovery and the routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let a: { orgId: string; token: string; siteId: string };
  let foreignSiteId: string;

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

  async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function enqueue(siteId: string, kind: OperationKind, steps: readonly { key: string; label: string }[]) {
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: a.orgId,
      kind,
      resourceType: "site",
      resourceId: siteId,
      lockKey: `site:${siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps,
      outboxPayload: { siteId },
    });
    return operation.id;
  }

  async function unknownOperation(siteId: string, kind: OperationKind, steps: readonly { key: string; label: string }[]) {
    const id = await enqueue(siteId, kind, steps);
    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, id));
    return id;
  }

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "staff@example.test", name: "Staff", password: PW });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: JWT_PEM,
      runtimeBackend: "linux-systemd",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
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
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    const token = await login("admin@example.test", created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, SITE);
    expect(site.status).toBe(202);
    a = { orgId, token, siteId: site.body.data.siteId as string };
    // A site the administrator keeps for the platform: another organisation's site for customer A.
    const foreign = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, domain: "old.example.test", ownerOrganizationId: null });
    expect(foreign.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    foreignSiteId = foreign.body.data.siteId as string;
    claims.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("an import is taken by the WordPress lane, never by the main lane, and handed to its applier", async () => {
    const apply = vi.spyOn(SiteWordpressImportApplier.prototype, "apply").mockResolvedValue(undefined);
    const shipped = vi.spyOn(SiteWordpressApplier.prototype, "apply").mockResolvedValue(undefined);
    const opId = await enqueue(a.siteId, WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS);

    await app.outboxWorker.processPendingOnce();

    const takers = claims.filter((c) => c.operationIds.includes(opId));
    expect(takers.map((c) => c.filter)).toEqual([{ includeKinds: [...WORDPRESS_OPERATION_KINDS, WORDPRESS_IMPORT_KIND] }]);
    const main = claims.find((c) => (c.filter as { excludeKinds?: string[] }).excludeKinds !== undefined);
    expect((main!.filter as { excludeKinds: string[] }).excludeKinds).toContain(WORDPRESS_IMPORT_KIND);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].id).toBe(opId);
    expect(shipped).not.toHaveBeenCalled();
    expect((await opRow(opId)).status).toBe("processing"); // the spy settled nothing
  });

  it("an import of unknown outcome goes to the import applier's recover, an update still to its own", async () => {
    const importId = await unknownOperation(a.siteId, WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS);
    const updateId = await unknownOperation(foreignSiteId, "site.wordpress.update", SITE_WORDPRESS_UPDATE_STEPS);
    const recover = vi.spyOn(SiteWordpressImportApplier.prototype, "recover").mockResolvedValue("pending");
    const shipped = vi.spyOn(SiteWordpressApplier.prototype, "recover").mockResolvedValue("pending");

    expect(await app.outboxWorker.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0, convergedSucceeded: 0 });
    expect(recover.mock.calls.map((c) => c[0].id)).toEqual([importId]);
    expect(shipped.mock.calls.map((c) => c[0].id)).toEqual([updateId]);
    expect((await opRow(importId)).status).toBe("unknown");

    const sentence = "A test sentence of the import applier.";
    recover.mockImplementation(async (op) => {
      await transitionOperation(dbClient.db, op.id, "failed", { errorCode: "OPERATION_INTERRUPTED", errorMessage: sentence });
      return "settled";
    });
    expect(await app.outboxWorker.recoverUnknownOperations()).toMatchObject({ convergedFailed: 1 });
    const recovered = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "operation.recovered.failed"));
    expect(recovered.map((r) => [r.targetId, (r.details as Json)["reason"]])).toEqual([[importId, sentence]]);
    const [site] = await dbClient.db.select({ status: sites.status }).from(sites).where(eq(sites.id, a.siteId));
    expect(site!.status).not.toBe("degraded");
  });

  const routes = (siteId: string): [string, string, unknown?][] => {
    const base = `/v1/organizations/${a.orgId}/managed-sites/${siteId}/wordpress/import`;
    return [
      ["GET", base],
      ["PUT", `${base}/files/archive`, { uploadId: "upload_0123456789abcdef", offset: 0, dataBase64: "QUJD", final: true }],
      ["POST", `${base}/files/dump/pick`, { path: "site.sql" }],
      ["DELETE", `${base}/files`],
      ["POST", base, { confirm: true }],
    ];
  };

  it("another organisation's site answers 404 on every import route", async () => {
    for (const [method, path, body] of routes(foreignSiteId)) {
      const res = await call(method, path, a.token, body);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  });

  it("the own site's GET answers the real import state", async () => {
    const res = await call("GET", routes(a.siteId)[0]![1], a.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      available: true,
      backupsConfigured: false,
      slots: {
        archive: { state: "empty", size: 0, uploadId: null },
        dump: { state: "empty", size: 0, uploadId: null },
      },
      earlierImportUnfinished: false,
      runningOperation: null,
      lastImport: null,
    });
  });

  it("the WordPress tab's GET never shows a running import", async () => {
    await enqueue(a.siteId, WORDPRESS_IMPORT_KIND, SITE_WORDPRESS_IMPORT_STEPS);
    const res = await call("GET", `/v1/organizations/${a.orgId}/managed-sites/${a.siteId}/wordpress`, a.token);
    expect(res.status).toBe(200);
    expect(res.body.data.runningOperation).toBeNull();
  });
});

// ---- qa-api (cycle 8): the routes across tenants and roles, and every way the operation can be left hanging ----

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** The simulator's own archive format (HPSIMZIP), a WordPress tree under one top folder. */
const ARCHIVE = Buffer.from(
  `HPSIMZIP\n${JSON.stringify([
    { p: "site/index.php", d: b64("<?php // imported index") },
    { p: "site/wp-load.php", d: b64("<?php // load") },
    { p: "site/wp-includes/version.php", d: b64("<?php $wp_version = '6.9';") },
    { p: "site/wp-content/themes/neutral/style.css", d: b64("/* Theme Name: Neutral */") },
    { p: "site/wp-config.php", d: b64("<?php // the old configuration") },
  ])}`,
  "utf8",
);
const DUMP = Buffer.from("-- MariaDB dump\nCREATE TABLE `wp_options` (id int);\nINSERT INTO `wp_options` VALUES (1);\n", "utf8");
/** R151: never sent a second time once started. */
const NEVER_TWICE = ["import.unpack", "db.import:prepare", "db.import-load", "import.switch", "db.import:switch", "wordpress.import-finalize"];
const ambiguous = () => Object.assign(new Error("timeout"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });

type Customer = { orgId: string; token: string; siteId: string; userId: string };

describe("qa-api: the import routes across tenants and roles, and an operation left hanging", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminUserId: string;
  let a: Customer;
  let b: Customer;
  /** Every executor call, by name (`db.import:<step>` for the database job). */
  const sent: string[] = [];
  /** One-shot faults by call name: thrown before the call, or after its effect. */
  const faults = new Map<string, { when: "before" | "after"; error: () => Error }>();

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

  async function call(method: string, path: string, as: string, body?: unknown, key: string | null = randomUUID()) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function customerWithSite(name: string, email: string, domain: string): Promise<Customer> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: name, ownerEmail: email, ownerName: name });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    const token = await login(email, created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, { ...SITE, domain });
    expect(site.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const [user] = await dbClient.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    return { orgId, token, siteId: site.body.data.siteId as string, userId: user!.id };
  }

  const imp = (c: Customer, siteId = c.siteId, orgId = c.orgId) => `/v1/organizations/${orgId}/managed-sites/${siteId}/wordpress/import`;
  const wp = (c: Customer) => `/v1/organizations/${c.orgId}/managed-sites/${c.siteId}/wordpress`;
  const reason = (body: Json) => (body.error?.details as { reason?: string }[] | undefined)?.[0]?.reason;
  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const stepsOf = async (id: string) =>
    Object.fromEntries(
      (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => [s.key, s.status]),
    );
  const lastImport = async (c: Customer) =>
    ((await getSiteWordpressState(dbClient.db, { organizationId: c.orgId, siteId: c.siteId }))?.lastImport ?? null) as Json | null;
  const importAudits = async () =>
    (await dbClient.db.select().from(auditEvents))
      .filter((r) => r.action.startsWith("site.wordpress.import."))
      .sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime());
  const ended = async (opId: string) =>
    (await importAudits()).filter((r) => r.action === "site.wordpress.import.finished" && (r.details as Json)["operationId"] === opId);
  const siteStatus = async (c: Customer) => (await dbClient.db.select({ s: sites.status }).from(sites).where(eq(sites.id, c.siteId)))[0]?.s;
  const svcOf = async (c: Customer) => (await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, c.siteId)))[0]!.id;
  const configureBackups = () =>
    upsertBackupSettings(dbClient.db, KEY, {
      endpoint: "https://s3.example.test",
      region: "eu-south-1",
      bucket: "test-backups",
      prefix: "panel",
      accessKeyId: "AKIATESTONLY0001",
      secretAccessKey: "test-only-not-a-secret",
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: adminUserId,
    });

  async function upload(c: Customer, slot: "archive" | "dump", data: Buffer, chunk = 48) {
    const uploadId = `upload_${slot}_0123456789abcdef`;
    for (let offset = 0; offset < data.length; offset += chunk) {
      const res = await call("PUT", `${imp(c)}/files/${slot}`, c.token, {
        uploadId,
        offset,
        dataBase64: data.subarray(offset, offset + chunk).toString("base64"),
        final: offset + chunk >= data.length,
      });
      expect([slot, offset, res.status]).toEqual([slot, offset, 200]);
    }
  }
  const ready = async (c: Customer) => {
    await upload(c, "archive", ARCHIVE);
    await upload(c, "dump", DUMP);
  };

  /** Starts an import through the route; the armed fault leaves it unknown through the real worker. */
  async function crash(c: Customer, arm: () => void): Promise<string> {
    await ready(c);
    const res = await call("POST", imp(c), c.token, { confirm: true });
    expect(res.status).toBe(202);
    arm();
    await app.outboxWorker.processPendingOnce();
    const id = res.body.data.operationId as string;
    expect((await opRow(id)).status).toBe("unknown");
    return id;
  }

  /** One recovery pass of the real worker; answers the calls it sent. */
  async function pass() {
    sent.length = 0;
    const result = await app.outboxWorker.recoverUnknownOperations();
    return { result, calls: [...sent] };
  }

  const fault = async (name: string, real: () => Promise<unknown>) => {
    const f = faults.get(name);
    if (f?.when === "before") {
      faults.delete(name);
      throw f.error();
    }
    const out = await real();
    if (f) {
      faults.delete(name);
      throw f.error();
    }
    return out;
  };

  async function enqueue(siteId: string, kind: OperationKind, steps: readonly { key: string; label: string }[], orgId: string) {
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: orgId,
      kind,
      resourceType: "site",
      resourceId: siteId,
      lockKey: `site:${siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps,
      outboxPayload: { siteId },
    });
    return operation.id;
  }

  /** The lock answer of a shipped heavy action of the site. */
  const refresh = (c: Customer) => call("POST", `${wp(c)}/refresh`, c.token, {});

  beforeEach(async () => {
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
    a = await customerWithSite("Customer A", "admin@example.test", "wp-a.example.test");
    // One customer per server: the other organisation is the platform's, whose site the administrator keeps.
    const platform = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, domain: "old.example.test", ownerOrganizationId: null });
    expect(platform.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const platformSiteId = platform.body.data.siteId as string;
    const [row] = await dbClient.db.select({ org: sites.organizationId }).from(sites).where(eq(sites.id, platformSiteId));
    b = { orgId: row!.org, token: adminToken, siteId: platformSiteId, userId: adminUserId };
    const files = sim.siteFiles.bind(sim);
    const jobs = sim.runSiteJob.bind(sim);
    vi.spyOn(sim, "siteFiles").mockImplementation((async (req: SiteFilesRequest) => {
      sent.push(req.op);
      return fault(req.op, () => files(req));
    }) as never);
    vi.spyOn(sim, "runSiteJob").mockImplementation((async (req: SiteJobRequest) => {
      const name = req.kind === "db.import" ? `db.import:${String(req.params?.["step"])}` : req.kind;
      sent.push(name);
      return fault(name, () => jobs(req));
    }) as never);
    sent.length = 0;
    faults.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  // ---- point 4 ----
  it("the whole path: chunked uploads, a start, six steps by the worker, the outcome and the audit trail in order", async () => {
    await ready(a);
    const before = await call("GET", imp(a), a.token);
    expect(before.body.data.slots).toEqual({
      archive: { state: "complete", size: ARCHIVE.length, uploadId: null },
      dump: { state: "complete", size: DUMP.length, uploadId: null },
    });
    const started = await call("POST", imp(a), a.token, { confirm: true });
    expect(started.status).toBe(202);
    const opId = started.body.data.operationId as string;
    expect(started.body).toEqual({ data: { siteId: a.siteId, operationId: opId }, links: { operation: `/v1/organizations/${a.orgId}/operations/${opId}` } });
    expect((await call("GET", imp(a), a.token)).body.data.runningOperation).toMatchObject({ id: opId, status: "queued" });

    await app.outboxWorker.processPendingOnce();

    const op = await call("GET", started.body.links.operation as string, a.token);
    expect(op.body.data.status).toBe("succeeded");
    expect((op.body.data.steps as Json[]).map((s) => [s["key"], s["status"]])).toEqual([
      ["check", "succeeded"],
      ["backup", "skipped"],
      ["unpack", "succeeded"],
      ["database", "succeeded"],
      ["switch", "succeeded"],
      ["finish", "succeeded"],
    ]);
    const after = await call("GET", imp(a), a.token);
    expect(after.body.data).toMatchObject({
      runningOperation: null,
      earlierImportUnfinished: false,
      slots: { archive: { state: "empty" }, dump: { state: "empty" } },
      lastImport: {
        operationId: opId,
        outcome: "imported",
        reason: null,
        backup: "skipped",
        oldAddress: "http://old.example.test",
        leftOut: ["wp-config.php"],
        line: null,
        errorNumber: null,
      },
    });
    const trail = await importAudits();
    expect(trail.map((r) => [r.action, r.actorType, r.actorId, r.organizationId, r.targetId])).toEqual([
      ["site.wordpress.import.file_uploaded", "user", a.userId, a.orgId, a.siteId],
      ["site.wordpress.import.file_uploaded", "user", a.userId, a.orgId, a.siteId],
      ["site.wordpress.import.requested", "user", a.userId, a.orgId, a.siteId],
      ["site.wordpress.import.finished", "system", null, a.orgId, a.siteId],
    ]);
    expect(trail.map((r) => (r.details as Json)["slot"] ?? (r.details as Json)["outcome"] ?? (r.details as Json)["backup"])).toEqual([
      "archive",
      "dump",
      "skipped",
      "imported",
    ]);
    expect(sim.files.importState(await svcOf(a))).toEqual({ gate: false, plans: [] });
  });

  it("with backups set up the step backup takes the copy and the outcome says taken", async () => {
    await configureBackups();
    await ready(a);
    const started = await call("POST", imp(a), a.token, { confirm: true });
    const opId = started.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();
    expect((await opRow(opId)).status).toBe("succeeded");
    expect(await stepsOf(opId)).toMatchObject({ backup: "succeeded", finish: "succeeded" });
    expect(await lastImport(a)).toMatchObject({ outcome: "imported", backup: "taken" });
    expect(await dbClient.db.select({ s: siteBackups.status, k: siteBackups.kind }).from(siteBackups).where(eq(siteBackups.operationId, opId))).toEqual([
      { s: "succeeded", k: "pre_update" },
    ]);
  });

  // ---- point 8: recovery through recoverUnknownOperations of the real worker ----
  const UNDO = ["db.import:undo", "import.undo"];
  const arms: Record<string, () => void> = {
    unpack: () => sim.files.failNextImport("import.unpack", "timeout"),
    database: () => faults.set("db.import-load", { when: "after", error: ambiguous }),
    switch: () => sim.files.failNextImport("import.switch", "timeout"),
  };

  it.each([
    ["unpack", "nothing_changed"],
    ["database", "nothing_changed"],
    ["switch", "site_restored"],
  ])("unknown during %s: the undo pair, %s, reason interrupted, the slots kept, the lock released", async (at, outcome) => {
    const opId = await crash(a, arms[at]!);
    expect(await stepsOf(opId)).toMatchObject({ [at]: "unknown" });
    const status = await siteStatus(a);

    const { result, calls } = await pass();

    expect(result).toMatchObject({ convergedFailed: 1, convergedSucceeded: 0 });
    expect(calls).toEqual(UNDO);
    expect(calls.filter((c) => NEVER_TWICE.includes(c))).toEqual([]);
    expect(await lastImport(a)).toMatchObject({ operationId: opId, outcome, reason: "interrupted" });
    expect((await opRow(opId)).status).toBe("failed");
    expect(await ended(opId)).toHaveLength(1);
    expect(await siteStatus(a)).toBe(status);
    expect(sim.files.importState(await svcOf(a))).toEqual({ gate: false, plans: [] });
    const state = await call("GET", imp(a), a.token);
    expect(state.body.data.slots).toMatchObject({ archive: { state: "complete" }, dump: { state: "complete" } });
    expect(state.body.data.earlierImportUnfinished).toBe(false);
    expect((await refresh(a)).status).toBe(202);
  });

  it.each([
    ["db.import undo exit 92", () => sim.failNextJob("db.import", 92), ["db.import:undo"]],
    ["import.undo { complete: false }", () => sim.files.failNextImport("import.undo", "undo_incomplete"), UNDO],
  ] as const)("%s ends undo_incomplete: the operation failed, the lock released, the GET says so, a new start refused", async (_t, arm, expected) => {
    const opId = await crash(a, arms["switch"]!);
    const status = await siteStatus(a);
    arm();
    const { result, calls } = await pass();
    expect(result).toMatchObject({ convergedFailed: 1 });
    expect(calls).toEqual(expected);
    expect(await lastImport(a)).toMatchObject({ operationId: opId, outcome: "undo_incomplete", reason: "interrupted" });
    expect((await opRow(opId)).status).toBe("failed");
    expect(await siteStatus(a)).toBe(status);

    // point 10: the GET says so, a new start is refused while the plan is held, the lock is free.
    const state = await call("GET", imp(a), a.token);
    expect(state.body.data).toMatchObject({ earlierImportUnfinished: true, runningOperation: null, lastImport: { outcome: "undo_incomplete" } });
    await ready(a);
    const again = await call("POST", imp(a), a.token, { confirm: true });
    expect([again.status, again.body.error?.code, reason(again.body)]).toEqual([409, "RESOURCE_LOCKED", "earlier_import_unfinished"]);
    expect((await refresh(a)).status).toBe(202);
  });

  it.each([
    ["db.import undo exit 1", () => sim.failNextJob("db.import", 1)],
    ["db.import undo, a transport error", () => faults.set("db.import:undo", { when: "before", error: () => new Error("socket hang up") })],
    ["import.undo, a transport error", () => faults.set("import.undo", { when: "before", error: () => new Error("socket hang up") })],
    ["import.undo with its end unknown", () => sim.files.failNextImport("import.undo", "timeout")],
    ["the executor down", () => sim.setEngineReachable(false)],
  ] as const)("%s: nothing written, still unknown with the lock, another site recovered, the next pass settles", async (_t, arm) => {
    const opId = await crash(a, arms["switch"]!);
    const other = await enqueue(b.siteId, "site.wordpress.inspect", SITE_WORDPRESS_INSPECT_STEPS, b.orgId);
    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, other));
    const status = await siteStatus(a);
    arm();

    const first = await pass();
    sim.setEngineReachable(true);
    expect(first.calls.filter((c) => NEVER_TWICE.includes(c))).toEqual([]);
    expect(first.calls[0]).toBe("db.import:undo");
    expect(await lastImport(a)).toBeNull();
    expect(await ended(opId)).toEqual([]);
    expect(await opRow(opId)).toMatchObject({ status: "unknown" });
    expect((await opRow(other)).status).toBe("failed");
    const locked = await refresh(a);
    expect([locked.status, locked.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);

    const second = await pass();
    expect(second.calls).toEqual(UNDO);
    expect(await lastImport(a)).toMatchObject({ operationId: opId, outcome: "site_restored", reason: "interrupted" });
    expect((await opRow(opId)).status).toBe("failed");
    expect(await ended(opId)).toHaveLength(1);
    expect(await siteStatus(a)).toBe(status);
  });

  it.each([
    ["refused", () => sim.files.failNextImport("import.finish", "staging_unsafe")],
    ["with its end unknown", () => sim.files.failNextImport("import.finish", "timeout")],
  ] as const)("import.finish %s in apply leaves the operation unknown, recovery is pending until it works (R162)", async (_t, arm) => {
    const opId = await crash(a, arm);
    expect(await stepsOf(opId)).toMatchObject({ switch: "succeeded", finish: "unknown" });
    expect(await lastImport(a)).toBeNull();
    expect(await ended(opId)).toEqual([]);
    const status = await siteStatus(a);

    // A pass whose import.finish fails again: pending, nothing written, no db.import finish.
    arm();
    const first = await pass();
    expect(first.calls).toEqual(["import.finish"]);
    expect(first.result).toMatchObject({ convergedFailed: 0, convergedSucceeded: 0 });
    expect(await opRow(opId)).toMatchObject({ status: "unknown" });
    expect(await lastImport(a)).toBeNull();
    expect(await ended(opId)).toEqual([]);
    expect((await refresh(a)).status).toBe(409);

    const second = await pass();
    expect(second.calls.slice(0, 2)).toEqual(["import.finish", "db.import:finish"]);
    expect(second.calls.filter((c) => NEVER_TWICE.includes(c))).toEqual([]);
    expect(second.result).toMatchObject({ convergedSucceeded: 1 });
    expect((await opRow(opId)).status).toBe("succeeded");
    expect(await stepsOf(opId)).toMatchObject({ finish: "succeeded" });
    expect(await lastImport(a)).toMatchObject({ operationId: opId, outcome: "imported", reason: null });
    expect(await ended(opId)).toHaveLength(1);
    expect(sim.files.importState(await svcOf(a))).toEqual({ gate: false, plans: [] });
    expect(await siteStatus(a)).toBe(status);
  });

  it("import.finish fine and db.import finish failing in recovery: imported, the step finish failed", async () => {
    const opId = await crash(a, () => sim.files.failNextImport("import.finish", "timeout"));
    sim.failNextJob("db.import", 97);
    const { calls, result } = await pass();
    expect(calls.slice(0, 2)).toEqual(["import.finish", "db.import:finish"]);
    expect(result).toMatchObject({ convergedSucceeded: 1 });
    expect((await opRow(opId)).status).toBe("succeeded");
    expect(await stepsOf(opId)).toMatchObject({ finish: "failed" });
    expect(await lastImport(a)).toMatchObject({ outcome: "imported" });
  });

  it("the copy still running: pending, no import call sent", async () => {
    await configureBackups();
    await ready(a);
    const res = await call("POST", imp(a), a.token, { confirm: true });
    const opId = res.body.data.operationId as string;
    // A crash during the copy: the step backup running, the operation unknown.
    await dbClient.db.update(operationSteps).set({ status: "succeeded" }).where(and(eq(operationSteps.operationId, opId), eq(operationSteps.key, "check")));
    await dbClient.db.update(operationSteps).set({ status: "running" }).where(and(eq(operationSteps.operationId, opId), eq(operationSteps.key, "backup")));
    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, opId));
    vi.spyOn(sim, "backups").mockRejectedValue(new Error("socket hang up"));
    const { calls, result } = await pass();
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ convergedFailed: 0, convergedSucceeded: 0 });
    expect((await opRow(opId)).status).toBe("unknown");
    expect(await lastImport(a)).toBeNull();
  });

  it("the site deleted meanwhile: the operation failed and no call sent", async () => {
    const opId = await crash(a, arms["switch"]!);
    await dbClient.db.delete(sites).where(eq(sites.id, a.siteId));
    const { calls, result } = await pass();
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ convergedFailed: 1 });
    expect((await opRow(opId)).status).toBe("failed");
    expect(await ended(opId)).toHaveLength(1);
  });

  // ---- point 9 ----
  it("a second pass over a settled import writes nothing twice, even when the operation is made unknown again", async () => {
    const opId = await crash(a, arms["switch"]!);
    await pass();
    const stored = await lastImport(a);
    const audits = (await dbClient.db.select().from(auditEvents)).length;
    expect((await pass()).calls).toEqual([]);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(audits);

    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, opId));
    const again = await pass();
    expect(again.calls).toEqual([]);
    expect(await lastImport(a)).toEqual(stored);
    expect(await ended(opId)).toHaveLength(1);
    expect((await opRow(opId)).status).toBe("failed");
  });

  // ---- point 10: an operation that stays unknown keeps the lock until the break-glass unlock ----
  it("an import left unknown refuses the site's other heavy actions until the break-glass unlock frees it", async () => {
    await configureBackups();
    const opId = await crash(a, arms["switch"]!);
    sim.failNextJob("db.import", 1);
    await pass();
    expect((await opRow(opId)).status).toBe("unknown");
    for (const res of [
      await refresh(a),
      await call("POST", `/v1/organizations/${a.orgId}/managed-sites/${a.siteId}/backups`, a.token, {}),
    ]) {
      expect([res.status, res.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    }
    await runBreakGlassUnlock({ dbClient, operationId: opId, reason: "qa test unlock" });
    expect((await refresh(a)).status).toBe(202);
  });

  // ---- point 1 ----
  const fiveRoutes = (orgId: string, siteId: string): [string, string, unknown?][] => {
    const base = `/v1/organizations/${orgId}/managed-sites/${siteId}/wordpress/import`;
    return [
      ["GET", base],
      ["PUT", `${base}/files/archive`, { uploadId: "upload_0123456789abcdef", offset: 0, dataBase64: ARCHIVE.toString("base64"), final: true }],
      ["POST", `${base}/files/dump/pick`, { path: "site.sql" }],
      ["DELETE", `${base}/files`],
      ["POST", base, { confirm: true }],
    ];
  };
  /** The error body with the ids of the path and the request id taken out. */
  const errorOf = (body: Json, ...ids: string[]) => {
    let text = JSON.stringify(body.error ?? body);
    for (const id of ids) text = text.split(id).join("<id>");
    return JSON.parse(text.replace(/"requestId":"[^"]*"/g, '"requestId":"<r>"')) as unknown;
  };

  it("tenancy: another organisation's site and a site that does not exist answer the same 404 on the five routes, before any permission", async () => {
    const missing = `${a.siteId.slice(0, -6)}000000`;
    const deniedBefore = (await dbClient.db.select().from(auditEvents)).length;
    const viaA = fiveRoutes(a.orgId, b.siteId);
    const none = fiveRoutes(a.orgId, missing);
    const viaB = fiveRoutes(b.orgId, b.siteId);
    for (const [i, [method, path, body]] of viaA.entries()) {
      const foreign = await call(method, path, a.token, body);
      const absent = await call(method, none[i]![1], a.token, body);
      const otherOrg = await call(method, viaB[i]![1], a.token, body);
      expect([method, path, foreign.status, absent.status, otherOrg.status]).toEqual([method, path, 404, 404, 404]);
      // The body does not tell a site of another organisation from one that does not exist.
      expect(errorOf(foreign.body, b.siteId)).toEqual(errorOf(absent.body, missing));
    }
    expect(sent.filter((c) => c.startsWith("import."))).toEqual([]);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(deniedBefore);
  });

  it("tenancy: the server administrator gets on the import routes what the shipped WordPress routes give", async () => {
    const shippedGet = await call("GET", wp(a), adminToken);
    const shippedChange = await call("POST", `${wp(a)}/refresh`, adminToken, {});
    for (const [method, path, body] of fiveRoutes(a.orgId, a.siteId)) {
      const res = await call(method, path, adminToken, body);
      const shipped = method === "GET" ? shippedGet : shippedChange;
      expect([method, res.status === 404, res.status === 403]).toEqual([method, shipped.status === 404, shipped.status === 403]);
    }
  });

  it("a slot of one site is never reached through the id of another", async () => {
    await upload(a, "archive", ARCHIVE);
    const viaOther = await call("PUT", `${imp(a, b.siteId)}/files/dump`, a.token, {
      uploadId: "upload_dump_0123456789abcdef",
      offset: 0,
      dataBase64: DUMP.toString("base64"),
      final: true,
    });
    expect(viaOther.status).toBe(404);
    const other = await sim.files.handle({ serviceInstanceId: await svcOf(b), op: "import.stat" });
    expect(other).toMatchObject({ archive: { state: "empty", size: 0 }, dump: { state: "empty", size: 0 } });
    const own = await call("GET", imp(a), a.token);
    expect(own.body.data.slots).toMatchObject({ archive: { state: "complete" }, dump: { state: "empty" } });
  });

  // ---- point 2 ----
  async function member(email: string, grant: "site.read" | null): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: "Member", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: a.orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    if (grant) {
      await dbClient.db
        .insert(resourceGrants)
        .values({ id: `rg_${randomUUID()}`, organizationId: a.orgId, principalUserId: userId, resourceId: a.siteId, permission: grant });
    }
    return login(email, PW);
  }
  const deniedRows = async () =>
    (await dbClient.db.select().from(auditEvents)).filter((r) => !r.action.startsWith("site.wordpress.import.") && (r.details as Json)["outcome"] !== "requested");

  it("roles: a reader may read but not change, a member without site.read is refused as on the shipped tab, a suspended organisation reads only", async () => {
    const reader = await member("reader@example.test", "site.read");
    const nobody = await member("member@example.test", null);
    const [get, ...changes] = fiveRoutes(a.orgId, a.siteId);

    // What the shipped tab writes for one refusal.
    const before = (await deniedRows()).length;
    const shipped = await call("POST", `${wp(a)}/refresh`, reader, {});
    expect(shipped.status).toBe(403);
    const shippedRows = (await deniedRows()).slice(before);
    const shape = (r: (typeof shippedRows)[number]) => [r.action, r.actorType, r.targetType, r.targetId, Object.keys(r.details as Json).sort()];
    expect(shippedRows).toHaveLength(1);

    expect((await call("GET", get![1], reader)).status).toBe(200);
    for (const [method, path, body] of changes) {
      const n = (await deniedRows()).length;
      const res = await call(method, path, reader, body);
      expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 403, shipped.body.error.code]);
      const rows = (await deniedRows()).slice(n);
      expect(rows.map(shape)).toEqual(shippedRows.map(shape));
    }
    // The 404 of another organisation's site comes before the permission: the reader gets 404, not 403, and nothing is written.
    const n404 = (await dbClient.db.select().from(auditEvents)).length;
    for (const [method, path, body] of fiveRoutes(a.orgId, b.siteId)) {
      expect([method, (await call(method, path, reader, body)).status]).toEqual([method, 404]);
    }
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(n404);

    const shippedNone = await call("GET", wp(a), nobody);
    const noneGet = await call("GET", get![1], nobody);
    expect(shippedNone.status).not.toBe(200);
    expect([noneGet.status, noneGet.body.error?.code]).toEqual([shippedNone.status, shippedNone.body.error?.code]);

    await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, a.orgId));
    expect((await call("GET", get![1], a.token)).status).toBe(200);
    const suspendedShipped = await call("POST", `${wp(a)}/refresh`, a.token, {});
    for (const [method, path, body] of changes) {
      const res = await call(method, path, a.token, body);
      expect([method, res.status, res.body.error?.code]).toEqual([method, suspendedShipped.status, suspendedShipped.body.error?.code]);
    }
    expect(suspendedShipped.status).toBe(403);
    expect(await importAudits()).toEqual([]);
    expect(sent.filter((c) => c.startsWith("import.") && c !== "import.stat")).toEqual([]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toEqual([]);
  });

  // ---- point 3 ----
  it("bodies: an unknown key, a third slot, a negative offset, a chunk over the limit, a bad Idempotency-Key are 400 and reach no executor", async () => {
    const base = imp(a);
    const chunk = { uploadId: "upload_0123456789abcdef", offset: 0, dataBase64: "QUJD", final: true };
    const bad: [string, string, unknown, string | null][] = [
      ["PUT", `${base}/files/archive`, { ...chunk, extra: 1 }, randomUUID()],
      ["PUT", `${base}/files/theme`, chunk, randomUUID()],
      ["PUT", `${base}/files/archive`, { ...chunk, offset: -1 }, randomUUID()],
      ["PUT", `${base}/files/archive`, { ...chunk, dataBase64: "A".repeat(699_056) }, randomUUID()],
      ["PUT", `${base}/files/archive`, { ...chunk, uploadId: "short" }, randomUUID()],
      ["POST", `${base}/files/dump/pick`, { path: "site.sql", extra: 1 }, randomUUID()],
      ["POST", `${base}/files/theme/pick`, { path: "site.sql" }, randomUUID()],
      ["POST", base, { confirm: true, extra: 1 }, randomUUID()],
      ["POST", base, { confirm: false }, randomUUID()],
      ["POST", base, {}, randomUUID()],
      ["POST", base, { confirm: true }, null],
      ["POST", base, { confirm: true }, "x".repeat(300)],
    ];
    for (const [method, path, body, key] of bad) {
      const res = await call(method, path, a.token, body, key);
      expect([method, path.slice(base.length), res.status, res.body.error?.code]).toEqual([method, path.slice(base.length), 400, "VALIDATION_ERROR"]);
    }
    expect(sent).toEqual([]);
    expect(await importAudits()).toEqual([]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toEqual([]);
  });

  // ---- point 5 ----
  it("busy: while an import of the site runs, a start, an upload, a pick and a discard are refused import_running", async () => {
    await ready(a);
    const first = await call("POST", imp(a), a.token, { confirm: true });
    expect(first.status).toBe(202);
    sent.length = 0;
    const [, put, pick, discard, start] = fiveRoutes(a.orgId, a.siteId);
    for (const [method, path, body] of [put!, pick!, discard!, start!]) {
      const res = await call(method, path, a.token, body);
      expect([method, path, res.status, res.body.error?.code, reason(res.body)]).toEqual([method, path, 409, "RESOURCE_LOCKED", "import_running"]);
    }
    expect(sent.filter((c) => c !== "import.stat")).toEqual([]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toHaveLength(1);
  });

  it("busy: another operation holding the lock gives the shipped lock answer; an update running does not block an upload", async () => {
    await enqueue(a.siteId, "site.wordpress.update", SITE_WORDPRESS_UPDATE_STEPS, a.orgId);
    await ready(a);
    const shipped = await refresh(a);
    const res = await call("POST", imp(a), a.token, { confirm: true });
    expect([res.status, res.body.error?.code]).toEqual([shipped.status, shipped.body.error?.code]);
    expect([res.status, res.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toEqual([]);
    expect((await importAudits()).map((r) => r.action)).not.toContain("site.wordpress.import.requested");
  });

  it("busy: files_incomplete, and earlier_import_unfinished while the simulator holds a plan (R155)", async () => {
    await upload(a, "archive", ARCHIVE);
    const half = await call("POST", imp(a), a.token, { confirm: true });
    expect([half.status, reason(half.body)]).toEqual([409, "files_incomplete"]);
    await upload(a, "dump", DUMP);
    const svc = await svcOf(a);
    const earlier = "c".repeat(32);
    await sim.files.handle({ serviceInstanceId: svc, op: "import.unpack", importId: earlier });
    await sim.files.handle({ serviceInstanceId: svc, op: "import.switch", importId: earlier });
    expect((await call("GET", imp(a), a.token)).body.data.earlierImportUnfinished).toBe(true);
    const res = await call("POST", imp(a), a.token, { confirm: true });
    expect([res.status, res.body.error?.code, reason(res.body)]).toEqual([409, "RESOURCE_LOCKED", "earlier_import_unfinished"]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toEqual([]);
  });

  it("busy: the seventh heavy action of the hour is an import refused QUOTA_EXCEEDED with retryAt", async () => {
    await ready(a);
    for (let i = 0; i < 6; i += 1) {
      const res = await call("POST", imp(a), a.token, { confirm: true });
      expect([i, res.status]).toEqual([i, 202]);
      await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, res.body.data.operationId as string));
    }
    const seventh = await call("POST", imp(a), a.token, { confirm: true });
    expect([seventh.status, seventh.body.error?.code]).toEqual([409, "QUOTA_EXCEEDED"]);
    expect(seventh.body.error.details).toEqual([{ field: "retryAt", message: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), reason: "too_many_requests" }]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind === WORDPRESS_IMPORT_KIND)).toHaveLength(6);
  });

  // ---- point 6 ----
  it("idempotency: the same key twice is one operation, one row, one audit event; the platform site is off the customer routes as on the shipped tab", async () => {
    await ready(a);
    const first = await call("POST", imp(a), a.token, { confirm: true }, "k-import-qa");
    const second = await call("POST", imp(a), a.token, { confirm: true }, "k-import-qa");
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body.data.operationId).toBe(first.body.data.operationId);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.idempotencyKey === "k-import-qa")).toHaveLength(1);
    expect((await importAudits()).filter((r) => r.action === "site.wordpress.import.requested")).toHaveLength(1);

    // The administrator's platform site is not on the customer routes, as on the shipped tab.
    expect((await call("GET", imp(b), b.token)).status).toBe((await call("GET", wp(b), b.token)).status);
  });
});
