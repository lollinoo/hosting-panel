import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  archiveBackupTarget,
  auditEvents,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  insertLocalTarget,
  insertS3Target,
  insertSiteBackup,
  insertSiteBackupCopies,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  setSitePolicy,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackupCopies,
  siteBackups,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

// HCP-SPEC-004 BKP-15 (QA, independent of the engineers' suites): two customer organisations, one installation with a
// local target and four S3 targets (offered, private, disabled, archived). Another organisation's backup / copy /
// target ids answer 404 and say nothing; no customer body carries an endpoint, bucket, prefix, credential, local root,
// host path or snapshot id; a customer chooses only what the administrator offers and enabled; the administrator
// routes refuse everybody else before the body is read; a client never names a repository, a path or a snapshot; a
// restore/download targetId needs a succeeded copy of that backup on that target.
const KEY = Buffer.alloc(32, 15);
const PW = "correct horse battery";
const SECRET = "canary-tenancy-s3-secret-DO-NOT-LEAK-77";
const ENDPOINT_HOST = "canary-tenancy-s3.example.net";
const BUCKET = "canary-tenancy-bucket";
const PREFIX = "canary-tenancy-prefix";
const ACCESS_KEY = "AKIACANARYTENANCY1";
const LOCAL_ROOT = "/var/lib/hosting-panel/local-repos/CANARYROOT";
const SNAPSHOT_LOCAL = "5ca1ab1e0badc0de";
const SNAPSHOT_S3 = "feedfacecafebeef";
const LEAKS = [
  SECRET,
  ENDPOINT_HOST,
  BUCKET,
  PREFIX,
  ACCESS_KEY,
  "CANARYROOT",
  "/var/lib/hosting-panel",
  "local-repos",
  SNAPSHOT_LOCAL,
  SNAPSHOT_S3,
  "restic",
  "secretAccessKey",
  "accessKeyId",
];
const ZERO_TARGET = `bkt_${"0".repeat(32)}`;
const SITE_A = {
  name: "Hotel Tenancy",
  domain: "hoteltenancy-bkp.it",
  title: "Hotel Tenancy",
  adminUser: "admin",
  adminEmail: "admin@hoteltenancy-bkp.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_B = {
  ...SITE_A,
  name: "Bar Tenancy",
  domain: "bartenancy-bkp.it",
  adminEmail: "admin@bartenancy-bkp.it",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Res {
  status: number;
  raw: string;
  body: Json;
}

/** The error envelope without per-request noise: two refusals that are indistinguishable have equal shapes. */
const shape = (res: Res) => {
  const { requestId: _r, timestamp: _t, ...error } = (res.body.error ?? {}) as Json;
  return { status: res.status, error };
};

describe("BKP-15: backup targets, copies and policies across tenants", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminUserId: string;
  let tokenA: string;
  let tokenB: string;
  let orgA: string;
  let orgB: string;
  let siteA: string;
  let siteB: string;
  let localId: string;
  let s3Pub: string; // enabled, offered to customers
  let s3Hidden: string; // enabled, NOT offered
  let s3Off: string; // offered but disabled
  let s3Gone: string; // offered but archived

  const base = () => app.baseUrl!;
  const pathOf = (org: string, site: string) => `/v1/organizations/${org}/managed-sites/${site}`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string | null; body?: unknown; raw?: string; key?: string | null } = {},
  ): Promise<Res> {
    const key = opts.key === undefined ? randomUUID() : opts.key;
    const hasBody = opts.raw !== undefined || opts.body !== undefined;
    const res = await fetch(`${base()}${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(key === null || method === "GET" ? {} : { "Idempotency-Key": key }),
      },
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await call("POST", "/v1/auth/login", {
      key: null,
      body: {
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      },
    });
    return res.body.data.accessToken as string;
  }

  async function createSite(token: string, org: string, body: typeof SITE_A): Promise<string> {
    const res = await call("POST", `/v1/organizations/${org}/managed-sites`, { token, body });
    expect(res.status).toBe(202);
    return res.body.data.siteId as string;
  }

  async function createOtherOrg(): Promise<{ orgId: string; token: string }> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "tenancy-host-b.test",
      hostname: "tenancy-host-b.test",
      ipv4Address: "10.0.0.32",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    const id = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id,
      platformInstallationId: inst!.id,
      name: "Other Tenancy Org",
      slug: "other-tenancy-org",
    });
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: `alloc_${randomUUID()}`, hostId, organizationId: id, status: "active" });
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: userId,
      email: "owner-b@tenancy.it",
      name: "Owner B",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: id, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return { orgId: id, token: await login("owner-b@tenancy.it", PW) };
  }

  /** A finished (or half-finished) backup with one copy per entry; priority = position + 1. */
  async function seedBackup(
    copies: readonly { targetId: string; status: "succeeded" | "failed" | "running" }[],
    forSite = siteA,
  ): Promise<string> {
    const operationId = `op_${randomUUID().replaceAll("-", "")}`;
    const { id } = await insertSiteBackup(dbClient.db, {
      siteId: forSite,
      kind: "manual",
      status: "running",
      operationId,
      siteUrl: "http://hoteltenancy-bkp.it",
      startedAt: new Date(Date.now() - 60_000),
    });
    await insertSiteBackupCopies(
      dbClient.db,
      id,
      operationId,
      copies.map((c, i) => ({ targetId: c.targetId, priority: i + 1, required: true })),
    );
    for (const row of await dbClient.db.select().from(siteBackupCopies).where(eq(siteBackupCopies.backupId, id))) {
      const wanted = copies.find((c) => c.targetId === row.targetId)!;
      if (wanted.status === "succeeded") {
        const snapshotId = row.targetId === localId ? SNAPSHOT_LOCAL : SNAPSHOT_S3;
        await settleSiteBackupCopy(dbClient.db, row.id, { status: "succeeded", snapshotId, sizeBytes: 4096 });
      } else if (wanted.status === "failed") {
        await settleSiteBackupCopy(dbClient.db, row.id, { status: "failed", problem: "other" });
      }
    }
    await settleSiteBackupAggregate(dbClient.db, id);
    return id;
  }

  /** What a refused request must not change. */
  async function state() {
    const targets = (await dbClient.db.select().from(backupTargets)).sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify({
      targets,
      ops: (await dbClient.db.select({ id: operations.id }).from(operations)).length,
      outbox: (await dbClient.db.select({ id: outboxEvents.id }).from(outboxEvents)).length,
      backups: (await dbClient.db.select().from(siteBackups)).map((b) => [b.id, b.status, b.restoreTargetId, b.archiveTargetId]),
      copies: (await dbClient.db.select({ id: siteBackupCopies.id }).from(siteBackupCopies)).length,
    });
  }

  const noLeak = (res: Res, label: string) => {
    for (const needle of LEAKS) {
      expect(res.raw.toLowerCase(), `${label} leaks ${needle}`).not.toContain(needle.toLowerCase());
    }
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Test Tenancy",
      hostHostname: "panel-tenancy.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin-ten@x.it", name: "Admin", password: PW });
    adminUserId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
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
    adminToken = await login("admin-ten@x.it", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", {
      token: adminToken,
      key: null,
      body: { organizationName: "Hotel Tenancy Org", ownerEmail: "mario-ten@hotel.it", ownerName: "Mario" },
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario-ten@hotel.it");
    orgA = created.body.data.organizationId as string;
    tokenA = await login("mario-ten@hotel.it", created.body.data.temporaryPassword as string);
    ({ orgId: orgB, token: tokenB } = await createOtherOrg());
    siteA = await createSite(tokenA, orgA, SITE_A);
    siteB = await createSite(tokenB, orgB, SITE_B);
    await app.outboxWorker.processPendingOnce();

    const s3 = (name: string, bucket: string, customerSelectable: boolean) =>
      insertS3Target(dbClient.db, KEY, {
        name,
        endpoint: `https://${ENDPOINT_HOST}`,
        region: "eu-south-1",
        bucket,
        prefix: PREFIX,
        accessKeyId: ACCESS_KEY,
        secretAccessKey: SECRET,
        customerSelectable,
        actorId: adminUserId,
      }).then((r) => r.id);
    localId = (await insertLocalTarget(dbClient.db, { name: "On this server", customerSelectable: true, actorId: adminUserId })).id;
    await dbClient.db.update(backupTargets).set({ localRoot: LOCAL_ROOT }).where(eq(backupTargets.id, localId));
    s3Pub = await s3("Offsite offered", `${BUCKET}-pub`, true);
    s3Hidden = await s3("Offsite private", `${BUCKET}-hidden`, false);
    s3Off = await s3("Offsite disabled", `${BUCKET}-off`, true);
    s3Gone = await s3("Offsite archived", `${BUCKET}-gone`, true);
    await dbClient.db.update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, s3Off));
    await archiveBackupTarget(dbClient.db, s3Gone);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operations).where(eq(operations.organizationId, orgA));
    await dbClient.db.delete(operations).where(eq(operations.organizationId, orgB));
    await dbClient.db.delete(backupSettings);
    for (const id of [siteA, siteB]) await setSitePolicy(dbClient.db, id, null, adminUserId);
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: "http://hoteltenancy-bkp.it" }).where(eq(sites.id, siteA));
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: "http://bartenancy-bkp.it" }).where(eq(sites.id, siteB));
    for (const [id, patch] of [
      [localId, { enabled: true, customerSelectable: true }],
      [s3Pub, { enabled: true, customerSelectable: true }],
      [s3Hidden, { enabled: true, customerSelectable: false }],
    ] as const) {
      await dbClient.db.update(backupTargets).set(patch).where(eq(backupTargets.id, id));
    }
    const policy = await call("PATCH", "/v1/admin/backup-policies/default", {
      token: adminToken,
      key: null,
      body: { targetIds: [localId] },
    });
    expect(policy.status).toBe(200);
  });

  describe("another organisation's ids (BKP-15)", () => {
    it("answers 404 on every customer route when the site belongs to another organisation, and changes nothing", async () => {
      const backupId = await seedBackup([{ targetId: localId, status: "succeeded" }]);
      const before = await state();
      const p = pathOf(orgB, siteA); // B's own org in the path, A's site: the site is not B's
      const crossOrg = pathOf(orgA, siteA); // A's path, B's credential
      const calls: Array<[string, string, unknown?]> = [
        ["GET", "/backups"],
        ["GET", "/backup-policy"],
        ["PATCH", "/backup-policy", { targetIds: [s3Pub] }],
        ["POST", "/backups", {}],
        ["POST", "/backups", { targetId: localId }],
        ["POST", `/backups/${backupId}/restore`, { confirmName: SITE_A.name }],
        ["POST", `/backups/${backupId}/restore`, { confirmName: SITE_A.name, targetId: localId }],
        ["POST", `/backups/${backupId}/download`, {}],
        ["POST", `/backups/${backupId}/download`, { targetId: localId }],
        ["GET", `/backups/${backupId}/download?offset=0&length=1024`],
      ];
      const missing = shape(await call("GET", `${pathOf(orgB, `site_${randomUUID()}`)}/backups`, { token: tokenB }));
      for (const [method, suffix, body] of calls) {
        const res = await call(method, `${p}${suffix}`, { token: tokenB, body });
        expect(res.status, `${method} ${suffix}`).toBe(404);
        noLeak(res, `${method} ${suffix}`);
        expect(res.raw).not.toContain(backupId);
        expect(res.raw).not.toContain(localId);
        // The same answer as for a site that does not exist: nothing tells the two apart.
        expect(shape(res).error.code).toBe(missing.error.code);

        const cross = await call(method, `${crossOrg}${suffix}`, { token: tokenB, body });
        expect([403, 404], `${method} ${suffix} (A's path)`).toContain(cross.status);
        noLeak(cross, `${method} ${suffix} (A's path)`);
      }
      expect(await state()).toBe(before);
    });

    it("refuses the organisation's own site with another organisation's backup and copy ids: the same 404 as an id that never existed", async () => {
      const foreign = await seedBackup([
        { targetId: localId, status: "succeeded" },
        { targetId: s3Pub, status: "succeeded" },
      ]);
      const before = await state();
      const own = pathOf(orgB, siteB);
      const unknown = `bkp_${"a".repeat(32)}`;
      const routes: Array<[string, (id: string) => string, unknown]> = [
        ["POST", (id) => `/backups/${id}/restore`, { confirmName: SITE_B.name }],
        ["POST", (id) => `/backups/${id}/restore`, { confirmName: SITE_B.name, targetId: localId }],
        ["POST", (id) => `/backups/${id}/restore`, { confirmName: SITE_B.name, targetId: s3Pub }],
        ["POST", (id) => `/backups/${id}/download`, {}],
        ["POST", (id) => `/backups/${id}/download`, { targetId: localId }],
        ["GET", (id) => `/backups/${id}/download?offset=0&length=1024`, undefined],
      ];
      for (const [method, suffix, body] of routes) {
        const real = await call(method, `${own}${suffix(foreign)}`, { token: tokenB, body });
        const none = await call(method, `${own}${suffix(unknown)}`, { token: tokenB, body });
        expect(real.status, suffix(foreign)).toBe(404);
        expect(shape(real)).toEqual(shape(none));
        expect(real.raw).not.toContain(foreign);
        noLeak(real, suffix(foreign));
      }
      // B's list shows nothing of A's backups, copies or targets with ids.
      const list = await call("GET", `${own}/backups`, { token: tokenB });
      expect(list.status).toBe(200);
      expect(list.body.data.backups).toEqual([]);
      expect(list.raw).not.toContain(foreign);
      expect(await state()).toBe(before);
    });

    it("does not show an operation of one organisation to the other", async () => {
      const queued = await call("POST", `${pathOf(orgA, siteA)}/backups`, { token: tokenA, body: {} });
      expect(queued.status).toBe(202);
      const opId = queued.body.data.operationId as string;
      for (const path of [`/v1/organizations/${orgB}/operations/${opId}`, `/v1/organizations/${orgA}/operations/${opId}`]) {
        const res = await call("GET", path, { token: tokenB });
        expect([403, 404], path).toContain(res.status);
        expect(res.raw).not.toContain(localId);
        noLeak(res, path);
      }
      const own = await call("GET", `/v1/organizations/${orgA}/operations/${opId}`, { token: tokenA });
      expect(own.status).toBe(200);
      noLeak(own, "owner operation");
    });
  });

  describe("nothing about a target's location or credentials reaches a customer", () => {
    it("scans every customer answer for endpoint, bucket, prefix, key, secret, local root, paths and snapshot ids", async () => {
      // A backup with a local and an S3 copy, a hidden/disabled/archived target elsewhere.
      await dbClient.db.update(backupTargets).set({ customerSelectable: true }).where(eq(backupTargets.id, s3Pub));
      await call("PATCH", "/v1/admin/backup-policies/default", { token: adminToken, key: null, body: { targetIds: [s3Pub] } });
      const backupId = await seedBackup([{ targetId: localId, status: "succeeded" }]);
      const p = pathOf(orgA, siteA);

      // Sanity: the administrator does see the location (the scan below is not vacuous).
      const adminView = await call("GET", "/v1/admin/backup-targets", { token: adminToken, key: null });
      expect(adminView.raw).toContain(ENDPOINT_HOST);
      expect(adminView.raw).toContain(BUCKET);
      expect(adminView.raw).toContain("CANARYROOT");
      expect(adminView.raw).not.toContain(SECRET); // not even the administrator gets the secret back

      const answers: Array<[string, Res]> = [];
      answers.push(["list", await call("GET", `${p}/backups`, { token: tokenA })]);
      answers.push(["policy get", await call("GET", `${p}/backup-policy`, { token: tokenA })]);
      answers.push(["policy patch", await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [localId] } }) ]);
      answers.push(["policy patch hidden", await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [s3Hidden] } })]);
      answers.push(["policy patch unknown", await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [ZERO_TARGET] } })]);
      answers.push(["restore", await call("POST", `${p}/backups/${backupId}/restore`, { token: tokenA, body: { confirmName: SITE_A.name, targetId: localId } })]);
      answers.push(["restore without copy", await call("POST", `${p}/backups/${backupId}/restore`, { token: tokenA, body: { confirmName: SITE_A.name, targetId: s3Pub } })]);
      answers.push(["download", await call("POST", `${p}/backups/${backupId}/download`, { token: tokenA, body: { targetId: localId } })]);
      answers.push(["download read", await call("GET", `${p}/backups/${backupId}/download?offset=0&length=1024`, { token: tokenA })]);
      answers.push(["create hidden", await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: s3Hidden } })]);
      answers.push(["create ok", await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: s3Pub } })]);
      answers.push(["create strict", await call("POST", `${p}/backups`, { token: tokenA, body: { repositoryUrl: `s3:https://${ENDPOINT_HOST}/${BUCKET}` } })]);
      for (const [label, res] of answers) {
        expect(res.status, label).toBeLessThan(500);
        noLeak(res, label);
      }
      for (const [label, res] of answers.filter(([, r]) => r.status === 202)) {
        const op = await call("GET", `/v1/organizations/${orgA}/operations/${res.body.data.operationId}`, { token: tokenA });
        noLeak(op, `${label} operation`);
      }
      // Private targets do not appear as choices or by id.
      const choices = answers[1]![1].body.data.choices as Array<{ id: string; kind: string }>;
      expect(choices.map((c) => c.id).sort()).toEqual([localId, s3Pub].sort());
      for (const c of choices) expect(Object.keys(c).sort()).toEqual(["id", "kind"]);
      for (const [label, res] of answers) {
        for (const id of [s3Hidden, s3Off, s3Gone]) expect(res.raw, `${label} names ${id}`).not.toContain(id);
      }
    });

    it("keeps the secret, endpoint and local root out of the operation, outbox and audit rows a customer request leaves behind", async () => {
      const backupId = await seedBackup([{ targetId: localId, status: "succeeded" }]);
      const p = pathOf(orgA, siteA);
      const stored: string[] = [];
      const snap = async () => {
        stored.push(
          JSON.stringify({
            ops: await dbClient.db.select().from(operations),
            outbox: await dbClient.db.select().from(outboxEvents),
            audit: await dbClient.db.select().from(auditEvents),
          }),
        );
        // One site action at a time: settle the previous one so the next request is accepted.
        await dbClient.db.delete(outboxEvents);
        await dbClient.db.delete(operations).where(eq(operations.organizationId, orgA));
        await dbClient.db.update(siteBackups).set({ restoreStatus: null, archiveStatus: null });
      };
      const steps: Array<[string, string, Json]> = [
        ["restore", `${p}/backups/${backupId}/restore`, { confirmName: SITE_A.name, targetId: localId }],
        ["download", `${p}/backups/${backupId}/download`, { targetId: localId }],
        ["create", `${p}/backups`, { targetId: s3Pub }],
      ];
      for (const [label, path, body] of steps) {
        const res = await call("POST", path, { token: tokenA, body });
        expect(res.status, label).toBe(202);
        await snap();
      }
      expect(stored.join("")).toContain("site.backups"); // the rows exist: the scan is not vacuous
      for (const needle of [SECRET, ENDPOINT_HOST, BUCKET, PREFIX, ACCESS_KEY, "CANARYROOT", SNAPSHOT_LOCAL, SNAPSHOT_S3]) {
        expect(stored.join(""), `stored rows leak ${needle}`).not.toContain(needle);
      }
    });
  });

  describe("a customer chooses only what the administrator offers", () => {
    const refusals = () => [
      ["private", s3Hidden],
      ["disabled", s3Off],
      ["archived", s3Gone],
      ["unknown", ZERO_TARGET],
    ] as const;

    it("creates a backup on an offered, enabled target and refuses private, disabled, archived and unknown ones with one 404", async () => {
      const p = pathOf(orgA, siteA);
      const before = await state();
      const shapes: unknown[] = [];
      for (const [label, id] of refusals()) {
        const res = await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: id } });
        expect(res.status, label).toBe(404);
        noLeak(res, label);
        expect(res.raw).not.toContain(id);
        shapes.push(shape(res));
      }
      expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
      expect(await state()).toBe(before);

      const ok = await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: s3Pub } });
      expect(ok.status).toBe(202);
      const copies = await dbClient.db.select().from(siteBackupCopies);
      expect(copies.map((c) => c.targetId)).toEqual([s3Pub]);
    });

    it("applies the administrator's change at once: a target no longer offered, or disabled, is refused", async () => {
      const p = pathOf(orgA, siteA);
      await dbClient.db.update(backupTargets).set({ customerSelectable: false }).where(eq(backupTargets.id, s3Pub));
      expect((await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: s3Pub } })).status).toBe(404);
      await dbClient.db.update(backupTargets).set({ customerSelectable: true, enabled: false }).where(eq(backupTargets.id, s3Pub));
      expect((await call("POST", `${p}/backups`, { token: tokenA, body: { targetId: s3Pub } })).status).toBe(404);
      expect(await dbClient.db.select().from(siteBackups)).toHaveLength(0);
    });

    it("sets the site policy only to offered targets: 404 for the rest, one answer, policy unchanged", async () => {
      const p = pathOf(orgA, siteA);
      const shapes: string[] = [];
      for (const [label, id] of refusals()) {
        const res = await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [id] } });
        expect(res.status, label).toBe(404);
        noLeak(res, label);
        shapes.push(JSON.stringify(shape(res)));
      }
      expect(new Set(shapes).size).toBe(1);
      const after = await call("GET", `${p}/backup-policy`, { token: tokenA });
      expect(after.body.data).toMatchObject({ inherited: true, targetIds: [localId] });
      expect((await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [s3Pub] } })).status).toBe(200);
      // A mixed list is refused as a whole.
      expect((await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [s3Pub, s3Hidden] } })).status).toBeGreaterThanOrEqual(400);
      expect((await call("GET", `${p}/backup-policy`, { token: tokenA })).body.data.targetIds).toEqual([s3Pub]);
    });

    it("keeps a customer's choice on one site out of the other organisation's site and policy", async () => {
      expect((await call("PATCH", `${pathOf(orgA, siteA)}/backup-policy`, { token: tokenA, body: { targetIds: [s3Pub] } })).status).toBe(200);
      const other = await call("GET", `${pathOf(orgB, siteB)}/backup-policy`, { token: tokenB });
      expect(other.body.data).toMatchObject({ inherited: true, targetIds: [localId] });
      // Not a customer-writable field of the policy or the targets.
      for (const body of [
        { targetIds: [localId], customerSelectable: true },
        { targetIds: [localId], enabled: true },
        { targetIds: [localId], retentionDays: 1 },
        { targetIds: [localId], scheduleHourUtc: 3 },
        { retentionDays: 1 },
      ]) {
        const res = await call("PATCH", `${pathOf(orgB, siteB)}/backup-policy`, { token: tokenB, body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it("lets the administrator name any enabled live target for a site, but not a disabled or archived one", async () => {
      const run = (targetId: string) =>
        call("POST", `/v1/admin/backups/sites/${siteA}/run`, { token: adminToken, body: { targetId } });
      expect((await run(s3Off)).status).toBe(404);
      expect((await run(s3Gone)).status).toBe(404);
      expect((await run(s3Hidden)).status).toBe(202);
      expect((await dbClient.db.select().from(siteBackupCopies)).map((c) => c.targetId)).toEqual([s3Hidden]);
    });

    it("lets a customer see a target only through the id and kind of the offered choices (no name, no usage)", async () => {
      const res = await call("GET", `${pathOf(orgA, siteA)}/backup-policy`, { token: tokenA });
      expect(res.raw).not.toMatch(/Offsite|On this server|usage|lastTest|archivedAt|customerSelectable/);
      expect(Object.keys(res.body.data).sort()).toEqual(["choices", "inherited", "targetIds"]);
    });
  });

  describe("administrator routes refuse everybody else before the body is read", () => {
    const targetRoutes: Array<[string, string]> = [
      ["GET", "/v1/admin/backup-targets"],
      ["POST", "/v1/admin/backup-targets"],
      ["PATCH", `/v1/admin/backup-targets/${"x"}`],
      ["POST", `/v1/admin/backup-targets/${"x"}/test`],
      ["POST", `/v1/admin/backup-targets/${"x"}/initialize`],
      ["DELETE", `/v1/admin/backup-targets/${"x"}`],
      ["GET", "/v1/admin/backup-policies/default"],
      ["GET", "/v1/admin/backup-policies/panel"],
      ["GET", "/v1/admin/backup-policies/bogus"],
      ["PATCH", "/v1/admin/backup-policies/default"],
      ["PATCH", "/v1/admin/backup-policies/panel"],
      ["PATCH", "/v1/admin/backup-policies/bogus"],
      ["GET", "/v1/admin/backups"],
      ["PATCH", "/v1/admin/backups"],
      ["DELETE", "/v1/admin/backups"],
      ["POST", "/v1/admin/backups/test"],
      ["GET", "/v1/admin/backups/sites"],
      ["POST", `/v1/admin/backups/sites/${"x"}/run`],
      ["POST", `/v1/admin/backups/sites/${"x"}/restore`],
    ];

    // Bodies that would be valid, invalid or hostile: none may change the answer from 403 (customer) or 401 (nobody).
    const bodies: Array<[string, { body?: unknown; raw?: string }]> = [
      ["no body", {}],
      ["empty object", { body: {} }],
      ["a valid-looking change", { body: { kind: "local", name: "Hijack", customerSelectable: true, targetIds: [ZERO_TARGET], retentionDays: 1 } }],
      ["a hostile S3 target", { body: { kind: "s3", name: "x", endpoint: "http://169.254.169.254", bucket: "b", prefix: "p", accessKeyId: "k", secretAccessKey: "s" } }],
      ["a schema-invalid body", { body: { retentionDays: "nope", targetIds: "nope", unknown: true } }],
      ["an array", { body: [1, 2, 3] }],
    ];

    it("answers 403 to a customer owner and 401 to nobody on every administrator backup route, for any body", async () => {
      const before = await state();
      for (const [method, path] of targetRoutes) {
        const real = path.replace("/x", `/${localId}`);
        for (const p of [path, real]) {
          for (const [label, opts] of bodies) {
            const body = method === "GET" || method === "DELETE" ? {} : opts;
            const customer = await call(method, p, { token: tokenA, key: randomUUID(), ...body });
            expect(customer.status, `${method} ${p} (${label}) as customer`).toBe(403);
            noLeak(customer, `${method} ${p} as customer`);
            const org2 = await call(method, p, { token: tokenB, key: randomUUID(), ...body });
            expect(org2.status, `${method} ${p} (${label}) as other customer`).toBe(403);
            const anon = await call(method, p, { token: null, key: randomUUID(), ...body });
            expect(anon.status, `${method} ${p} (${label}) anonymous`).toBe(401);
          }
        }
      }
      expect(await state()).toBe(before);
    });

    const malformed = async () => {
      const seen: string[] = [];
      for (const [method, path] of targetRoutes.filter(([m]) => m !== "GET" && m !== "DELETE")) {
        for (const token of [tokenA, null]) {
          const res = await call(method, path.replace("/x", `/${localId}`), { token, raw: "{not json" });
          if (res.status !== (token ? 403 : 401)) seen.push(`${method} ${path} ${token ? "customer" : "anonymous"} -> ${res.status}`);
        }
      }
      return seen;
    };

    it("never executes anything for a malformed JSON body: refused with 400 at the latest, nothing changed", async () => {
      const before = await state();
      for (const [method, path] of targetRoutes.filter(([m]) => m !== "GET" && m !== "DELETE")) {
        const res = await call(method, path.replace("/x", `/${localId}`), { token: tokenA, raw: "{not json" });
        expect([400, 403], `${method} ${path}`).toContain(res.status);
        noLeak(res, `${method} ${path} malformed`);
      }
      expect(await state()).toBe(before);
    });

    // Was ISSUE_FOUND (low, #17): the JSON parser answered 400 before requireServerAdmin ran. A parse error on an
    // administrator route now waits for the same check, so the caller learns nothing before it is authorised.
    it("refuses a customer (403) and anonymous (401) before a malformed JSON body is parsed", async () => {
      expect(await malformed()).toEqual([]);
    });

    it("never lets a customer read the targets or the secret through the legacy admin settings route", async () => {
      const res = await call("GET", "/v1/admin/backups", { token: tokenA, key: null });
      expect(res.status).toBe(403);
      noLeak(res, "legacy settings as customer");
    });
  });

  describe("a client never names a repository, a path or a snapshot", () => {
    const hostile = (): Array<[string, Json]> => [
      ["repositoryUrl", { repositoryUrl: `s3:https://${ENDPOINT_HOST}/${BUCKET}` }],
      ["repo", { repo: "/var/lib/hosting-panel/local-repos/other" }],
      ["path", { path: "/etc/passwd" }],
      ["localRoot", { localRoot: "/" }],
      ["snapshotId", { snapshotId: "deadbeef" }],
      ["snapshot", { snapshot: "latest" }],
      ["target object", { target: { kind: "local", repoDir: "/tmp/x" } }],
      ["endpoint and bucket", { endpoint: "https://evil.example", bucket: "evil", prefix: "x" }],
      ["a path as targetId", { targetId: "../../etc/passwd" }],
      ["a repository URL as targetId", { targetId: `s3:https://${ENDPOINT_HOST}/${BUCKET}` }],
      ["an absolute path as targetId", { targetId: LOCAL_ROOT }],
      ["an upper-case id", { targetId: `BKT_${"A".repeat(32)}` }],
      ["a non-string id", { targetId: 7 }],
      ["a list of ids", { targetId: [ZERO_TARGET] }],
    ];

    it("rejects every extra or malformed key on create, restore, download and the admin routes with 400 and queues nothing", async () => {
      const backupId = await seedBackup([{ targetId: localId, status: "succeeded" }]);
      const p = pathOf(orgA, siteA);
      const before = await state();
      for (const [label, extra] of hostile()) {
        const routes: Array<[string, string, string | null, Json]> = [
          ["customer create", `${p}/backups`, tokenA, extra],
          ["customer restore", `${p}/backups/${backupId}/restore`, tokenA, { confirmName: SITE_A.name, ...extra }],
          ["customer download", `${p}/backups/${backupId}/download`, tokenA, extra],
          ["admin run", `/v1/admin/backups/sites/${siteA}/run`, adminToken, extra],
          ["admin restore", `/v1/admin/backups/sites/${siteA}/restore`, adminToken, { confirmName: SITE_A.name, ...extra }],
        ];
        for (const [route, path, token, body] of routes) {
          const res = await call("POST", path, { token, body });
          expect(res.status, `${route} with ${label}`).toBe(400);
          noLeak(res, `${route} with ${label}`);
        }
        const policy = await call("PATCH", `${p}/backup-policy`, { token: tokenA, body: { targetIds: [localId], ...extra } });
        expect(policy.status, `policy with ${label}`).toBe(400);
        const adminPolicy = await call("PATCH", "/v1/admin/backup-policies/default", { token: adminToken, key: null, body: extra });
        expect(adminPolicy.status, `admin policy with ${label}`).toBe(400);
      }
      expect(await state()).toBe(before);
    });

    it("ignores a repository, path or snapshot in the query of the archive read", async () => {
      const backupId = await seedBackup([{ targetId: localId, status: "succeeded" }]);
      const p = `${pathOf(orgA, siteA)}/backups/${backupId}/download`;
      const plain = await call("GET", `${p}?offset=0&length=1024`, { token: tokenA });
      const loaded = await call(
        "GET",
        `${p}?offset=0&length=1024&repo=${encodeURIComponent(LOCAL_ROOT)}&snapshotId=deadbeef&path=/etc/passwd&targetId=${s3Hidden}`,
        { token: tokenA },
      );
      expect([400, plain.status]).toContain(loaded.status);
      if (loaded.status !== 400) expect(shape(loaded)).toEqual(shape(plain));
      noLeak(loaded, "archive read with hostile query");
    });

    it("restores from the stored copy's snapshot and target only: the persisted target comes from the copy, the payload carries no client value", async () => {
      const backupId = await seedBackup([
        { targetId: localId, status: "succeeded" },
        { targetId: s3Pub, status: "succeeded" },
      ]);
      const res = await call("POST", `${pathOf(orgA, siteA)}/backups/${backupId}/restore`, {
        token: tokenA,
        body: { confirmName: SITE_A.name, targetId: s3Pub },
      });
      expect(res.status).toBe(202);
      const row = (await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId)))[0]!;
      expect(row.restoreTargetId).toBe(s3Pub);
      expect(row.snapshotId).toBe(SNAPSHOT_LOCAL); // the aggregate mirrors the lowest priority; the restore reads the s3 copy's own
      const payloads = JSON.stringify(await dbClient.db.select().from(outboxEvents));
      expect(payloads).not.toContain(SNAPSHOT_S3);
      expect(payloads).not.toContain("repo");
    });
  });

  describe("restore and download need a succeeded copy of the backup on the requested target", () => {
    it("refuses a target that has a failed, running, missing, private, disabled or archived copy-less state with one 404", async () => {
      const mixed = await seedBackup([
        { targetId: localId, status: "succeeded" },
        { targetId: s3Pub, status: "failed" },
      ]);
      const p = pathOf(orgA, siteA);
      const before = await state();
      const random = await call("POST", `${p}/backups/${mixed}/restore`, {
        token: tokenA,
        body: { confirmName: SITE_A.name, targetId: ZERO_TARGET },
      });
      const shapes = new Set<string>([JSON.stringify(shape(random))]);
      for (const targetId of [s3Pub /* failed copy */, s3Hidden, s3Off, s3Gone, ZERO_TARGET]) {
        const restore = await call("POST", `${p}/backups/${mixed}/restore`, { token: tokenA, body: { confirmName: SITE_A.name, targetId } });
        const download = await call("POST", `${p}/backups/${mixed}/download`, { token: tokenA, body: { targetId } });
        const admin = await call("POST", `/v1/admin/backups/sites/${siteA}/restore`, {
          token: adminToken,
          body: { confirmName: SITE_A.name, backupId: mixed, targetId },
        });
        for (const [label, res] of [["restore", restore], ["download", download], ["admin restore", admin]] as const) {
          // The administrator's route has its own wording for "no succeeded backup": 400, never an accepted restore.
          expect(res.status, `${label} ${targetId}`).toBe(label === "admin restore" ? 400 : 404);
          noLeak(res, `${label} ${targetId}`);
          expect(res.raw).not.toContain(targetId);
          if (label !== "admin restore") shapes.add(JSON.stringify(shape(res)));
        }
      }
      // The same answer whether the target has a failed copy, no copy, or does not exist at all (no oracle).
      expect(shapes.size).toBe(1);
      expect(await state()).toBe(before);
    });

    it("refuses every target while a copy of the backup is still running, and a backup whose copies all failed", async () => {
      const running = await seedBackup([
        { targetId: localId, status: "succeeded" },
        { targetId: s3Pub, status: "running" },
      ]);
      const dead = await seedBackup([{ targetId: localId, status: "failed" }]);
      const p = pathOf(orgA, siteA);
      const before = await state();
      for (const backupId of [running, dead]) {
        for (const targetId of [localId, s3Pub, undefined]) {
          const body = targetId ? { targetId } : {};
          expect((await call("POST", `${p}/backups/${backupId}/restore`, { token: tokenA, body: { confirmName: SITE_A.name, ...body } })).status).toBe(404);
          expect((await call("POST", `${p}/backups/${backupId}/download`, { token: tokenA, body })).status).toBe(404);
        }
      }
      expect(await state()).toBe(before);
    });

    it("accepts the target that does hold a succeeded copy, and persists exactly that target", async () => {
      const backupId = await seedBackup([
        { targetId: s3Pub, status: "failed" },
        { targetId: localId, status: "succeeded" },
      ]);
      const p = pathOf(orgA, siteA);
      const restore = await call("POST", `${p}/backups/${backupId}/restore`, { token: tokenA, body: { confirmName: SITE_A.name, targetId: localId } });
      expect(restore.status).toBe(202);
      noLeak(restore, "restore accepted");
      const row = (await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId)))[0]!;
      expect(row.restoreTargetId).toBe(localId);
      await dbClient.db.update(siteBackups).set({ restoreStatus: null }).where(eq(siteBackups.id, backupId));
      await dbClient.db.delete(operations).where(eq(operations.kind, "site.backups.restore"));
      const download = await call("POST", `${p}/backups/${backupId}/download`, { token: tokenA, body: { targetId: localId } });
      expect(download.status).toBe(202);
      expect((await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId)))[0]!.archiveTargetId).toBe(localId);
    });
  });
});
