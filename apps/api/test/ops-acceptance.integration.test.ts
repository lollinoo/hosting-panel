import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AdminAlertDtoSchema } from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  createDatabaseClient,
  domains,
  encryptedSecrets,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  siteBackups,
  sites,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { enqueueSiteDomainsOperation } from "../src/sites/site-domains-applier.js";

const KEY = Buffer.alloc(32, 11);
const PW = "sentinel-password-0003";
const SETUP = { installationName: "Ops Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-test-1",
  bucket: "sentinel-bucket",
  prefix: "panel",
  accessKeyId: "SENTINELKEYID0001",
  secretAccessKey: "sentinel-secret-0001",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const PLANTED = "PLANTEDOPERATIONTEXT";
const MIN = 60_000;
const HOUR = 60 * MIN;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = { method: string; path: string };

/** Records every method call made on a port. */
function recorded<T extends object>(target: T): { port: T; calls: string[] } {
  const calls: string[] = [];
  const port = new Proxy(target, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(p));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { port, calls };
}

/** Same parser as admin-route-guard.integration.test.ts. */
function listRoutes(tree: string): Route[] {
  const stack: string[] = [];
  const out: Route[] = [];
  for (const line of tree.split("\n")) {
    const m = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (method !== "HEAD" && method !== "OPTIONS") out.push({ method, path: stack.join("") });
    }
  }
  return out;
}

const siteSpec = (n: string) => ({
  name: `Site ${n}`,
  domain: `wp-${n.toLowerCase()}.example.test`,
  title: `Site ${n}`,
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
});

describe("M5b operations acceptance", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let execCalls: string[];
  let agentCalls: string[];
  let adminToken: string;
  let adminUserId: string;
  const org: Record<"A" | "B", { id: string; token: string }> = {} as never;
  const site: Record<string, string> = {};

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

  async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: Json; raw: string; headers: Headers }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw, headers: res.headers };
  }

  const count = async (table: typeof operations | typeof siteBackups | typeof outboxEvents | typeof auditEvents) =>
    (await dbClient.db.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n;
  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const auditCount = async (action: string, targetId?: string) =>
    (await dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), targetId ? eq(auditEvents.targetId, targetId) : undefined))).length;
  const backupsBase = (o: "A" | "B", s: string) => `/v1/organizations/${org[o].id}/managed-sites/${site[s]!}/backups`;
  // Marks an operation done so the site lock is free for the next action.
  const done = (id: string) => dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, id));
  const alerts = async () => {
    const res = await call("GET", "/v1/admin/alerts", adminToken);
    expect(res.status).toBe(200);
    return { list: z.array(AdminAlertDtoSchema).parse(res.body.data), raw: res.raw };
  };

  async function failSucceededMoves(): Promise<void> {
    await dbClient.db.execute(sql.raw("CREATE FUNCTION test_fail_succeeded() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"));
    await dbClient.db.execute(sql.raw("CREATE TRIGGER test_fail_succeeded BEFORE UPDATE ON operations FOR EACH ROW WHEN (NEW.status = 'succeeded') EXECUTE FUNCTION test_fail_succeeded()"));
  }
  async function allowSucceededMoves(): Promise<void> {
    await dbClient.db.execute(sql.raw("DROP TRIGGER IF EXISTS test_fail_succeeded ON operations"));
    await dbClient.db.execute(sql.raw("DROP FUNCTION IF EXISTS test_fail_succeeded()"));
  }

  const adminSecrets = async (siteId: string) => (await dbClient.db.select({ id: encryptedSecrets.id }).from(encryptedSecrets)
    .where(and(eq(encryptedSecrets.siteId, siteId), eq(encryptedSecrets.secretKey, "WP_ADMIN_PASSWORD_INITIAL")))).length;

  async function createSite(o: "A" | "B", key: string): Promise<string> {
    const res = await call("POST", `/v1/organizations/${org[o].id}/managed-sites`, org[o].token, siteSpec(key));
    expect(res.status, `create site ${key}`).toBe(202);
    await app.outboxWorker.processPendingOnce();
    site[key] = res.body.data.siteId as string;
    return site[key];
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    adminUserId = admin.userId;
    const exec = recorded<DockerExecutorPort>(new InMemoryDockerSimulatorAdapter());
    const agent = recorded<HostAgentPort>(new InMemoryHostSimulatorAdapter());
    execCalls = exec.calls;
    agentCalls = agent.calls;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      runtimeBackend: "linux-systemd",
      dockerExecutor: exec.port,
      hostAgent: agent.port,
      dnsLookup: { lookup: async () => ({ a: [SETUP.hostIpv4], aaaa: [] }) },
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner-a@example.test", ownerName: "Owner A" });
    expect(created.status).toBe(201);
    org.A = { id: created.body.data.organizationId as string, token: await login("owner-a@example.test", created.body.data.temporaryPassword as string) };
    // One customer per host: the second organisation gets its own host, as in site-restore-routes.
    const [hostA] = await dbClient.db.select().from(hosts).limit(1);
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId, platformInstallationId: hostA!.platformInstallationId, name: "panel-b.example.test", hostname: "panel-b.example.test",
      ipv4Address: "10.0.0.2", hostingMode: "dedicated", totalCpuMilli: 4000, totalMemoryBytes: "8589934592", totalStorageBytes: "107374182400",
    });
    const orgBId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: orgBId, platformInstallationId: hostA!.platformInstallationId, name: "Org B", slug: "org-b-ops" });
    await dbClient.db.insert(hostAllocations).values({ id: `alloc_${randomUUID()}`, hostId: hostBId, organizationId: orgBId, status: "active" });
    const userB = `usr_${randomUUID()}`;
    const memB = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userB, email: "owner-b@example.test", name: "Owner B", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: memB, organizationId: orgBId, userId: userB });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId: memB, roleId: "role_customer_owner" });
    org.B = { id: orgBId, token: await login("owner-b@example.test", PW) };
    for (const k of ["A1", "A2", "A3", "A4", "A5"]) await createSite("A", k);
    for (const k of ["B1", "B2"]) await createSite("B", k);
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
  });

  afterAll(async () => {
    await allowSucceededMoves();
    await app?.close();
    await dbClient.close();
  });

  describe("point 1: the heavy-action limit per organisation, through the routes", () => {
    it("24 actions over five sites, then QUOTA_EXCEEDED on any site with nothing written; site limit, other organisation and administrator behave as designed", async () => {
      const plan = ["A1", "A1", "A1", "A1", "A1", "A2", "A2", "A2", "A2", "A2", "A3", "A3", "A3", "A3", "A3", "A4", "A4", "A4", "A4", "A4", "A5", "A5", "A5", "A5"];
      const t0 = Date.now();
      for (const [i, s] of plan.entries()) {
        const res = await call("POST", backupsBase("A", s), org.A.token, {});
        expect(res.status, `action ${String(i + 1)} on ${s}: ${res.raw}`).toBe(202);
        await done(res.body.data.operationId as string);
      }
      const t1 = Date.now();

      const before = { ops: await count(operations), backups: await count(siteBackups), outbox: await count(outboxEvents), audit: await count(auditEvents) };
      for (const s of ["A5", "A1"]) {
        const refused = await call("POST", backupsBase("A", s), org.A.token, {});
        expect(refused.status, refused.raw).toBe(409);
        expect(refused.body.error.code).toBe("QUOTA_EXCEEDED");
        const retryAt = refused.body.error.details[0].message as string;
        expect(refused.body.error.message).toBe(`Too many backup actions in this organisation; try again at ${retryAt}`);
        expect(refused.body.error.details).toEqual([{ field: "retryAt", reason: "too_many_requests", message: retryAt }]);
        const at = Date.parse(retryAt);
        expect(at).toBeGreaterThan(Date.now());
        expect(at).toBeLessThanOrEqual(t1 + HOUR);
        expect(at).toBeGreaterThanOrEqual(t0 + HOUR - 1_000);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
        // Nothing about the other sites: no id, no name, no count.
        for (const other of ["A1", "A2", "A3", "A4", "A5"].filter((x) => x !== s)) {
          expect(refused.raw).not.toContain(site[other]!);
          expect(refused.raw).not.toContain(`Site ${other}`);
        }
        // The retry time can hold :24 or :25; take it out before looking for a count.
        expect(refused.raw.replaceAll(retryAt, "")).not.toMatch(/\b(24|25)\b/);
      }
      expect({ ops: await count(operations), backups: await count(siteBackups), outbox: await count(outboxEvents), audit: await count(auditEvents) }).toEqual(before);
      // No lock is left: a non-heavy write on the site is accepted.
      expect((await call("POST", `/v1/organizations/${org.A.id}/managed-sites/${site.A5!}/files/folders`, org.A.token, { path: "free-lock" })).status).toBe(204);

      // The other organisation keeps its own six per site, then hits the site limit with the site sentence.
      for (let i = 0; i < 6; i += 1) {
        const res = await call("POST", backupsBase("B", "B1"), org.B.token, {});
        expect(res.status, `B1 action ${String(i + 1)}`).toBe(202);
        await done(res.body.data.operationId as string);
      }
      const seventh = await call("POST", backupsBase("B", "B1"), org.B.token, {});
      expect(seventh.status).toBe(409);
      expect(seventh.body.error.message).toMatch(/^Too many backup actions on this site; try again at /);

      // The administrator's route is not counted against the organisation.
      const adminRun = await call("POST", `/v1/admin/backups/sites/${site.A5!}/run`, adminToken, {});
      expect(adminRun.status, adminRun.raw).toBe(202);
      await done(adminRun.body.data.operationId as string);
    });
  });

  describe("point 2: a hung operation", () => {
    it("reconciling past its lease: no alert before the delay, operation_stuck after, gone after recovery and the site takes a new operation", async () => {
      const siteId = site.B2!;
      const { operation } = await enqueueOperationTransactional(dbClient.db, {
        organizationId: org.B.id,
        kind: "site.files.archive",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        idempotencyKey: `hung-${randomUUID()}`,
        outboxPayload: {},
      });
      const setLease = (ms: number) =>
        dbClient.db.update(operations).set({ status: "reconciling", leaseExpiresAt: new Date(Date.now() - ms), errorCode: "INTERNAL_ERROR", errorMessage: `${PLANTED} /var/lib/x` }).where(eq(operations.id, operation.id));
      await dbClient.db.update(outboxEvents).set({ status: "processing" }).where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);

      await setLease(4 * MIN);
      expect((await alerts()).list.filter((a) => a.subject === operation.id)).toEqual([]);
      await setLease(6 * MIN);
      const after = await alerts();
      const stuck = after.list.filter((a) => a.subject === operation.id);
      expect(stuck.map((a) => a.kind)).toEqual(["operation_stuck"]);
      expect(Object.keys(stuck[0]!.details as Json).sort()).toEqual(["kind", "operationId", "siteId", "siteName"]);
      expect(after.raw).not.toContain(PLANTED);
      expect(after.raw).not.toContain("/var/");

      const blocked = await call("POST", `/v1/admin/backups/sites/${siteId}/run`, adminToken, {});
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe("RESOURCE_LOCKED");

      const recovery = await app.outboxWorker.recoverUnknownOperations();
      expect(recovery.markedUnknown).toBeGreaterThanOrEqual(1);
      expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect((await alerts()).list.filter((a) => a.subject === operation.id)).toEqual([]);
      const next = await call("POST", `/v1/admin/backups/sites/${siteId}/run`, adminToken, {});
      expect(next.status, next.raw).toBe(202);
      await done(next.body.data.operationId as string);
    });

    it("unknown is operation_unknown only after its delay, and carries no error text", async () => {
      const id = `op_${randomUUID()}`;
      const at = (ms: number) => new Date(Date.now() - ms);
      await dbClient.db.insert(operations).values({
        id, organizationId: org.B.id, kind: "site.files.extract", status: "unknown", resourceType: "site", resourceId: site.B2!,
        startedAt: at(20 * MIN), updatedAt: at(14 * MIN), leaseExpiresAt: null, errorCode: "INTERNAL_ERROR", errorMessage: `${PLANTED} Bearer sentinel`,
      });
      expect((await alerts()).list.filter((a) => a.subject === id)).toEqual([]);
      await dbClient.db.update(operations).set({ updatedAt: at(16 * MIN) }).where(eq(operations.id, id));
      const { list, raw } = await alerts();
      expect(list.filter((a) => a.subject === id).map((a) => a.kind)).toEqual(["operation_unknown"]);
      expect(raw).not.toContain(PLANTED);
      expect(raw).not.toContain("Bearer");
      await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.id, id));
    });
  });

  describe("point 3: settling is all or nothing, seen from outside", () => {
    it("provisioning: a failed settle leaves the site not ready and no succeeded audit; a good one writes both", async () => {
      await failSucceededMoves();
      let res;
      try {
        res = await call("POST", "/v1/admin/sites", adminToken, { ...siteSpec("P1"), ownerOrganizationId: null });
        expect(res.status).toBe(202);
        await app.outboxWorker.processPendingOnce();
      } finally {
        await allowSucceededMoves();
      }
      const siteId = res.body.data.siteId as string;
      expect((await opRow(res.body.data.operationId as string)).status).not.toBe("succeeded");
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.status).not.toBe("ready");
      expect(await auditCount("site.provision.succeeded", siteId)).toBe(0);
      // The first admin password is deleted only inside the settle that succeeds.
      expect(await adminSecrets(siteId)).toBe(1);

      const good = await call("POST", "/v1/admin/sites", adminToken, { ...siteSpec("P2"), ownerOrganizationId: null });
      await app.outboxWorker.processPendingOnce();
      const goodId = good.body.data.siteId as string;
      expect((await opRow(good.body.data.operationId as string)).status).toBe("succeeded");
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, goodId)))[0]!.status).toBe("ready");
      expect(await auditCount("site.provision.succeeded", goodId)).toBe(1);
      expect(await adminSecrets(goodId)).toBe(0);
    });

    it("domains: a failed settle leaves the applied routes and the applied audit absent; a good one writes both", async () => {
      const siteId = site.A3!;
      const read = async () => (await dbClient.db.select({ r: sites.appliedRoutes, url: sites.siteUrl }).from(sites).where(eq(sites.id, siteId)))[0]!;
      const before = await read();
      // An active certificate changes the plan to https, so a settled apply must change the stored routes.
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * 24 * HOUR) }).where(eq(domains.siteId, siteId));
      await failSucceededMoves();
      let opId: string;
      try {
        opId = (await enqueueSiteDomainsOperation(dbClient.db, { organizationId: org.A.id, siteId })).operation.id;
        await app.outboxWorker.processPendingOnce();
      } finally {
        await allowSucceededMoves();
      }
      expect((await opRow(opId)).status).not.toBe("succeeded");
      // update_address stores the address and the transition plan by design; the final plan (https redirect) is the settle's.
      const failed = await read();
      expect(before.r).toEqual([expect.objectContaining({ tls: false, httpsRedirect: false })]);
      expect(failed.r).toEqual([expect.objectContaining({ tls: true, httpsRedirect: false })]);
      expect(await auditCount("site.domains.applied", siteId)).toBe(0);

      await app.outboxWorker.recoverUnknownOperations();
      await dbClient.db.update(operations).set({ status: "failed", leaseExpiresAt: null }).where(and(eq(operations.id, opId), sql`${operations.status} NOT IN ('succeeded', 'failed', 'cancelled')`));
      const good = (await enqueueSiteDomainsOperation(dbClient.db, { organizationId: org.A.id, siteId })).operation.id;
      await app.outboxWorker.processPendingOnce();
      expect((await opRow(good)).status).toBe("succeeded");
      const after = await read();
      expect(after.r).toEqual([expect.objectContaining({ tls: true, httpsRedirect: true })]);
      expect(after.url).toBe(`https://${siteSpec("A3").domain}`);
      expect(await auditCount("site.domains.applied", siteId)).toBe(1);
    });

    it("backups: a failed settle leaves the operation not succeeded; recovery settles it succeeded", async () => {
      const res = await call("POST", `/v1/admin/backups/sites/${site.A4!}/run`, adminToken, {});
      expect(res.status, res.raw).toBe(202);
      const opId = res.body.data.operationId as string;
      await failSucceededMoves();
      try {
        await app.outboxWorker.processPendingOnce();
      } finally {
        await allowSucceededMoves();
      }
      expect((await opRow(opId)).status).not.toBe("succeeded");
      await app.outboxWorker.recoverUnknownOperations();
      expect((await opRow(opId)).status).toBe("succeeded");
    });

    it("files: a failed archive settle leaves the operation not succeeded; nothing reports it done", async () => {
      const base = `/v1/organizations/${org.A.id}/managed-sites/${site.A2!}/files`;
      expect((await call("POST", `${base}/folders`, org.A.token, { path: "settle-dir" })).status).toBe(204);
      const res = await call("POST", `${base}/archive`, org.A.token, { paths: ["settle-dir"], to: "settle.zip" });
      expect(res.status, res.raw).toBe(202);
      const opId = res.body.data.operationId as string;
      await failSucceededMoves();
      try {
        await app.outboxWorker.processPendingOnce();
      } finally {
        await allowSucceededMoves();
      }
      expect((await opRow(opId)).status).not.toBe("succeeded");
      expect(await auditCount("operation.recovered.succeeded", opId)).toBe(0);
      await app.outboxWorker.recoverUnknownOperations();
      expect(["succeeded", "failed"]).toContain((await opRow(opId)).status);

      const good = await call("POST", `${base}/archive`, org.A.token, { paths: ["settle-dir"], to: "settle-2.zip" });
      await app.outboxWorker.processPendingOnce();
      expect((await opRow(good.body.data.operationId as string)).status).toBe("succeeded");
    });
  });

  describe("point 4: the audit pages", () => {
    const ACTION = "test.ops.page";
    const insert = (rows: { id: string; ts: Date; org?: string; action?: string }[]) =>
      dbClient.db.insert(auditEvents).values(rows.map((r) => ({ id: r.id, timestamp: r.ts, organizationId: r.org ?? null, actorType: "system" as const, action: r.action ?? ACTION, targetType: "test" })));
    const page = (q: string) => call("GET", `/v1/admin/audit?${q}`, adminToken);

    it("rows inserted between page reads give no duplicate and skip no starting row", async () => {
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      // 35 starting rows, with ties on the timestamp.
      const starting = Array.from({ length: 35 }, (_, i) => ({ id: `ev_start_${String(i).padStart(2, "0")}`, ts: new Date(base + Math.floor(i / 3) * 1000) }));
      await insert(starting);
      const seen: string[] = [];
      let cursor: string | null = null;
      let n = 0;
      do {
        const res = await page(`action=${ACTION}&limit=10${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        seen.push(...(res.body.data as Json[]).map((r) => r.id as string));
        cursor = res.body.page.nextCursor as string | null;
        n += 1;
        // New rows land between reads: newer, older and tied with the page edge.
        await insert([
          { id: `ev_new_hi_${String(n)}`, ts: new Date() },
          { id: `ev_new_tie_${String(n)}`, ts: new Date(base + 5_000) },
        ]);
      } while (cursor && n < 20);
      expect(new Set(seen).size).toBe(seen.length);
      for (const s of starting) expect(seen).toContain(s.id);
    });

    it("a customer gets 403", async () => {
      const res = await call("GET", "/v1/admin/audit", org.A.token);
      expect(res.status).toBe(403);
    });

    it("organizationId, action and the range combine; another organisation's cursor leaks nothing", async () => {
      const t = Date.parse("2025-06-01T00:00:00.000Z");
      await insert([
        { id: "ev_f_a_in1", ts: new Date(t + 1_000), org: org.A.id, action: "test.ops.filter" },
        { id: "ev_f_a_in2", ts: new Date(t + 2_000), org: org.A.id, action: "test.ops.filter" },
        { id: "ev_f_a_out", ts: new Date(t + 9_000_000), org: org.A.id, action: "test.ops.filter" },
        { id: "ev_f_a_other", ts: new Date(t + 1_500), org: org.A.id, action: "test.ops.other" },
        { id: "ev_f_b_in", ts: new Date(t + 3_000), org: org.B.id, action: "test.ops.filter" },
      ]);
      const range = `from=${new Date(t).toISOString()}&to=${new Date(t + 60_000).toISOString()}`;
      const res = await page(`organizationId=${org.A.id}&action=test.ops.filter&${range}`);
      expect(res.status).toBe(200);
      expect((res.body.data as Json[]).map((r) => r.id)).toEqual(["ev_f_a_in2", "ev_f_a_in1"]);

      const crossed = await page(`organizationId=${org.A.id}&action=test.ops.filter&${range}&cursor=ev_f_b_in`);
      expect(crossed.status).toBe(200);
      expect((crossed.body.data as Json[]).every((r) => r.organizationId === org.A.id)).toBe(true);
      expect(crossed.raw).not.toContain(org.B.id);
    });

    it("limit 0, -1, 1e9 and abc answer 400, never 500; an injection-shaped cursor is an empty page", async () => {
      for (const limit of ["0", "-1", "1e9", "abc", "101", ""]) {
        const res = await page(`limit=${encodeURIComponent(limit)}`);
        if (limit === "") expect([200, 400]).toContain(res.status);
        else expect(res.status, `limit=${limit}`).toBe(400);
      }
      const inj = await page(`cursor=${encodeURIComponent("x') OR 1=1 --")}`);
      expect(inj.status).toBe(200);
      expect(inj.body.data).toEqual([]);
    });
  });

  describe("point 7: the guard sees the four new routes", () => {
    it("the route list the walk reads holds the four routes, all under the guarded prefix, and the walk has a value for :component", () => {
      const GUARDED = /^\/v1\/(admin(\/|$)|hosts(\/|$)|allocations(\/|$))/;
      const routes = listRoutes(app.fastify.printRoutes({ commonPrefix: false })).filter((r) => r.method === "GET" && GUARDED.test(r.path));
      const paths = routes.map((r) => r.path);
      for (const p of ["/v1/admin/health", "/v1/admin/alerts", "/v1/admin/sites/:siteId/logs", "/v1/admin/logs/:component"]) expect(paths).toContain(p);
      const walk = readFileSync(new URL("./admin-route-guard.integration.test.ts", import.meta.url), "utf8");
      expect(walk).toContain(GUARDED.source);
      expect(walk).toMatch(/component:\s*"[a-z_]+"/);
    });
  });

  describe("point 9: CP-01, background passes only read", () => {
    it("one drift pass and one domain pass make read calls only", async () => {
      execCalls.length = 0;
      agentCalls.length = 0;
      await app.driftReconciler.reconcileAllOnce();
      await app.domainReconciler.reconcileOnce();
      const READS = new Set(["pingEngine", "getPanelContainers", "getObservedState", "getCertificateStatus", "getSftpStatus", "getMailRelayStatus", "getHostTelemetry", "checkHealth", "isRuntimeAvailable"]);
      const seen = [...new Set([...execCalls, ...agentCalls])].sort();
      console.info(`CP-01 calls seen: ${seen.join(", ")}`);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((c) => !READS.has(c))).toEqual([]);
    });
  });
});
