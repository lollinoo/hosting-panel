import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  SiteWordpressPasswordResetDtoSchema,
  WORDPRESS_OPERATION_KINDS,
  type OperationKind,
  type SiteWordpressLastUpdateDto,
  type SiteWordpressStateDto,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  memberships,
  membershipRoles,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  resourceGrants,
  saveSiteWordpressLastUpdate,
  saveSiteWordpressState,
  siteBackups,
  sites,
  transitionOperation,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter, SIMULATED_WORDPRESS_STATE } from "@hosting-panel/docker-executor";
import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { hashPassword } from "../src/auth/password.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import {
  SITE_WORDPRESS_INSPECT_STEPS,
  SITE_WORDPRESS_INTERRUPTED,
  SITE_WORDPRESS_UPDATE_STEPS,
  SiteWordpressApplier,
} from "../src/sites/site-wordpress-applier.js";

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
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("WordPress tools: the outbox lane, recovery and the routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminUserId: string;

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

  async function call(method: string, path: string, as: string, body?: unknown, key: string = randomUUID()): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function customerWithSite(name: string, email: string, domain: string) {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: name,
      ownerEmail: email,
      ownerName: name,
    });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, email);
    const token = await login(email, created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, { ...SITE, domain });
    expect(site.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return { orgId, token, siteId: site.body.data.siteId as string };
  }

  async function unknownOperation(orgId: string, siteId: string, kind: OperationKind, steps: readonly { key: string; label: string }[]) {
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
    await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, operation.id));
    return operation.id;
  }

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;

  let a: { orgId: string; token: string; siteId: string };
  let foreignSiteId: string;

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
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
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    a = await customerWithSite("Hotel Mario", "mario@hotel.it", "hotel.it");
    // A site the administrator keeps for the platform: another organisation's site for customer A.
    const foreign = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, domain: "bar.it", ownerOrganizationId: null });
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

  it("a WordPress operation is taken by its own lane, never by the main lane", async () => {
    const apply = vi.spyOn(SiteWordpressApplier.prototype, "apply").mockResolvedValue(undefined);
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: a.orgId,
      kind: "site.wordpress.inspect",
      resourceType: "site",
      resourceId: a.siteId,
      lockKey: `site:${a.siteId}`,
      leaseDurationMs: SITE_STEP_LEASE_MS,
      steps: SITE_WORDPRESS_INSPECT_STEPS,
      outboxPayload: { siteId: a.siteId },
    });

    await app.outboxWorker.processPendingOnce();

    const takers = claims.filter((c) => c.operationIds.includes(operation.id));
    expect(takers.map((c) => c.filter)).toEqual([{ includeKinds: [...WORDPRESS_OPERATION_KINDS, "site.wordpress.import"] }]);
    const main = claims.find((c) => (c.filter as { excludeKinds?: string[] }).excludeKinds !== undefined);
    expect((main!.filter as { excludeKinds: string[] }).excludeKinds).toEqual(expect.arrayContaining([...WORDPRESS_OPERATION_KINDS]));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].id).toBe(operation.id);
  });

  it("an interrupted check fails with its sentence and asks nothing of the executor", async () => {
    const jobs = vi.spyOn(sim, "runSiteJob");
    const recover = vi.spyOn(SiteWordpressApplier.prototype, "recover");
    const opId = await unknownOperation(a.orgId, a.siteId, "site.wordpress.inspect", SITE_WORDPRESS_INSPECT_STEPS);

    const result = await app.outboxWorker.recoverUnknownOperations();

    expect(result.convergedFailed).toBe(1);
    const op = await opRow(opId);
    expect(op.status).toBe("failed");
    expect(op.errorMessage).toBe(SITE_WORDPRESS_INTERRUPTED);
    expect(SITE_WORDPRESS_INTERRUPTED).toBe("The check was interrupted. Press Check now.");
    expect(jobs).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("an update of unknown outcome is handed to the applier's recover", async () => {
    const opId = await unknownOperation(a.orgId, a.siteId, "site.wordpress.update", SITE_WORDPRESS_UPDATE_STEPS);
    const recover = vi.spyOn(SiteWordpressApplier.prototype, "recover").mockResolvedValue("pending");

    expect(await app.outboxWorker.recoverUnknownOperations()).toMatchObject({ convergedFailed: 0, convergedSucceeded: 0 });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]![0].id).toBe(opId);
    expect((await opRow(opId)).status).toBe("unknown");

    const sentence = "The outcome of the update is not known. Check the versions below.";
    recover.mockImplementation(async (op) => {
      await transitionOperation(dbClient.db, op.id, "failed", { errorCode: "OPERATION_INTERRUPTED", errorMessage: sentence });
      return "settled";
    });
    expect(await app.outboxWorker.recoverUnknownOperations()).toMatchObject({ convergedFailed: 1 });
    const audits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "operation.recovered.failed"));
    expect(audits.map((r) => (r.details as Json)["reason"])).toEqual([sentence]);
  });

  it("a recovery that throws leaves that operation unknown and the pass goes on with the next", async () => {
    const older = await unknownOperation(a.orgId, a.siteId, "site.wordpress.update", SITE_WORDPRESS_UPDATE_STEPS);
    const younger = await unknownOperation(a.orgId, foreignSiteId, "site.wordpress.inspect", SITE_WORDPRESS_INSPECT_STEPS);
    vi.spyOn(SiteWordpressApplier.prototype, "recover").mockRejectedValueOnce(
      Object.assign(new Error(`job said ${"tail"}`), { code: "VALIDATION_ERROR" }),
    );

    const result = await app.outboxWorker.recoverUnknownOperations();

    expect(result).toMatchObject({ convergedFailed: 1, convergedSucceeded: 0 });
    expect(result.recoveryErrors).toEqual([{ kind: "site.wordpress.update", operationId: older, errorCode: "VALIDATION_ERROR" }]);
    expect((await opRow(younger)).status).toBe("failed");
    expect(await opRow(older)).toMatchObject({ status: "unknown", errorCode: null, errorMessage: null });
    const failedAudits = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.targetId, older));
    expect(failedAudits).toEqual([]);
  });

  const routes = (orgId: string, siteId: string): [string, string, unknown?][] => {
    const base = `/v1/organizations/${orgId}/managed-sites/${siteId}/wordpress`;
    return [
      ["GET", base],
      ["POST", `${base}/refresh`, {}],
      ["POST", `${base}/updates`, { scope: "all" }],
      ["POST", `${base}/administrators/1/password-reset`, {}],
    ];
  };

  it("another organisation's site answers 404 on every route", async () => {
    for (const [method, path, body] of routes(a.orgId, foreignSiteId)) {
      const res = await call(method, path, a.token, body);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  const STATE: SiteWordpressStateDto = { ...SIMULATED_WORDPRESS_STATE, checkedAt: "2026-11-15T10:00:00.000Z", problem: null };
  const LAST_UPDATE: SiteWordpressLastUpdateDto = {
    operationId: "op_00000000000000000000000000000001",
    target: { scope: "plugin", name: "classic-editor" },
    status: "succeeded",
    finishedAt: "2026-11-15T10:05:00.000Z",
    problem: null,
    backup: "skipped",
    items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" }],
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

  const wp = (siteId = a.siteId) => `/v1/organizations/${a.orgId}/managed-sites/${siteId}/wordpress`;
  const seedState = (state: unknown = STATE) => saveSiteWordpressState(dbClient.db, { organizationId: a.orgId, siteId: a.siteId, state });
  const configureBackups = () => upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
  const setSite = (set: Partial<typeof sites.$inferInsert>) => dbClient.db.update(sites).set(set).where(eq(sites.id, a.siteId));
  const wpOps = async () => (await dbClient.db.select().from(operations)).filter((o) => (WORDPRESS_OPERATION_KINDS as readonly string[]).includes(o.kind));
  const audits = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const finish = (id: string) => dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, id));
  const reason = (body: Json) => (body.error.details as { reason?: string }[])[0]?.reason;
  const mutations = (): [string, unknown][] => [
    [`${wp()}/refresh`, {}],
    [`${wp()}/updates`, { scope: "core" }],
    [`${wp()}/administrators/1/password-reset`, {}],
  ];

  it("a reader may look but not act, and a suspended organisation is refused", async () => {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email: "reader@hotel.it", name: "Reader", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: a.orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    await dbClient.db
      .insert(resourceGrants)
      .values({ id: `rg_${randomUUID()}`, organizationId: a.orgId, principalUserId: userId, resourceId: a.siteId, permission: "site.read" });
    const reader = await login("reader@hotel.it", PW);

    expect((await call("GET", wp(), reader)).status).toBe(200);
    for (const [path, body] of mutations()) {
      expect([path, (await call("POST", path, reader, body)).status]).toEqual([path, 403]);
    }

    // As on every shipped site route, a suspended organisation keeps reading but cannot change anything.
    await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, a.orgId));
    expect((await call("GET", wp(), a.token)).status).toBe(200);
    for (const [path, body] of mutations()) {
      expect([path, (await call("POST", path, a.token, body)).status]).toEqual([path, 403]);
    }
    expect(await wpOps()).toEqual([]);
  });

  it("guards in order: capability, WordPress site, site state; a stopped site is accepted", async () => {
    await seedState();
    const config = app.nestApp.get(CONTROL_PLANE_CONFIG_TOKEN) as ControlPlaneRuntimeConfig;
    const expectAll = async (status: number, code: string, why: string) => {
      for (const [path, body] of mutations()) {
        const res = await call("POST", path, a.token, body);
        expect([path, res.status, res.body.error?.code, reason(res.body)]).toEqual([path, status, code, why]);
      }
    };

    (config as { runtimeBackend: string }).runtimeBackend = "local-simulator";
    await setSite({ phpVersion: null, siteType: null, status: "deploying" });
    await expectAll(422, "NOT_SUPPORTED", "wordpress_unavailable");
    (config as { runtimeBackend: string }).runtimeBackend = "linux-systemd";
    await expectAll(422, "NOT_SUPPORTED", "not_wordpress");
    await setSite({ phpVersion: "8.3", siteType: "wordpress" });
    await expectAll(409, "RESOURCE_LOCKED", "not_ready");
    await setSite({ status: "maintenance" });
    await expectAll(409, "RESOURCE_LOCKED", "not_ready");
    expect(await wpOps()).toEqual([]);
    expect(sim.jobs.filter((j) => j.kind.startsWith("wordpress.") && j.kind !== "wordpress.install")).toEqual([]);

    await setSite({ status: "stopped" });
    expect((await call("POST", `${wp()}/refresh`, a.token, {})).status).toBe(202);
  });

  it("refresh queues one check with its audit, replays its key and refuses a second while one runs", async () => {
    const res = await call("POST", `${wp()}/refresh`, a.token, {}, "k-refresh");
    expect(res.status).toBe(202);
    const operationId = res.body.data.operationId as string;
    expect(res.body).toEqual({
      data: { siteId: a.siteId, operationId },
      links: { operation: `/v1/organizations/${a.orgId}/operations/${operationId}` },
    });
    const op = await opRow(operationId);
    expect(op).toMatchObject({
      kind: "site.wordpress.inspect",
      status: "queued",
      resourceType: "site",
      resourceId: a.siteId,
      lockKey: `site:${a.siteId}`,
      idempotencyKey: "k-refresh",
    });
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId));
    expect(steps.map((s) => [s.key, s.status])).toEqual([["inspect", "pending"]]);
    const outbox = (await dbClient.db.select().from(outboxEvents)).find((e) => (e.payload as Json)["operationId"] === operationId);
    expect(outbox!.payload).toMatchObject({ siteId: a.siteId });

    const replay = await call("POST", `${wp()}/refresh`, a.token, {}, "k-refresh");
    expect([replay.status, replay.body.data.operationId]).toEqual([202, operationId]);
    const audit = await audits("site.wordpress.refresh");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: a.orgId, targetType: "site", targetId: a.siteId, actorType: "user" });
    expect(audit[0]!.details).toMatchObject({ outcome: "requested", operationId });

    const second = await call("POST", `${wp()}/refresh`, a.token, {});
    expect([second.status, second.body.error.code]).toEqual([409, "RESOURCE_LOCKED"]);
    expect(await audits("site.wordpress.refresh")).toHaveLength(1);
    expect(await call("POST", `${wp()}/refresh`, a.token, { force: true })).toMatchObject({ status: 400 });
    expect(await call("POST", `${wp()}/refresh`, a.token)).toMatchObject({ status: 409 });
  });

  it("an update without backups queues backup, update and settle with no copy row", async () => {
    await seedState();
    const res = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" }, "k-update");
    expect(res.status).toBe(202);
    const operationId = res.body.data.operationId as string;
    expect(res.body.links.operation).toBe(`/v1/organizations/${a.orgId}/operations/${operationId}`);
    expect(await opRow(operationId)).toMatchObject({
      kind: "site.wordpress.update",
      resourceType: "site",
      resourceId: a.siteId,
      lockKey: `site:${a.siteId}`,
    });
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId));
    expect(steps.map((s) => s.key).sort()).toEqual(["backup", "settle", "update"]);
    const outbox = (await dbClient.db.select().from(outboxEvents)).find((e) => (e.payload as Json)["operationId"] === operationId);
    expect(outbox!.payload).toMatchObject({ siteId: a.siteId, target: { scope: "plugin", name: "classic-editor" } });
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);
    const audit = await audits("site.wordpress.update");
    expect(audit.map((r) => r.details)).toEqual([
      expect.objectContaining({ outcome: "requested", operationId, target: { scope: "plugin", name: "classic-editor" } }),
    ]);

    const replay = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" }, "k-update");
    expect([replay.status, replay.body.data.operationId]).toEqual([202, operationId]);
    expect(await audits("site.wordpress.update")).toHaveLength(1);
    const second = await call("POST", `${wp()}/updates`, a.token, { scope: "all" });
    expect([second.status, second.body.error.code]).toEqual([409, "RESOURCE_LOCKED"]);
  });

  it("an update with backups set up inserts the pre_update copy row of its operation", async () => {
    await configureBackups();
    const res = await call("POST", `${wp()}/updates`, a.token, { scope: "all" });
    expect(res.status).toBe(202);
    const rows = await dbClient.db.select().from(siteBackups);
    expect(rows).toEqual([
      expect.objectContaining({ siteId: a.siteId, kind: "pre_update", status: "running", operationId: res.body.data.operationId }),
    ]);
  });

  it("the seventh heavy action in an hour, copies and updates mixed, is refused and leaves nothing", async () => {
    await configureBackups();
    const backups = `/v1/organizations/${a.orgId}/managed-sites/${a.siteId}/backups`;
    for (let i = 0; i < 6; i += 1) {
      const res = i % 2 === 0 ? await call("POST", backups, a.token, {}) : await call("POST", `${wp()}/updates`, a.token, { scope: "core" });
      expect([i, res.status]).toEqual([i, 202]);
      await finish(res.body.data.operationId as string);
    }
    const before = { ops: (await dbClient.db.select().from(operations)).length, copies: (await dbClient.db.select().from(siteBackups)).length };

    const seventh = await call("POST", `${wp()}/updates`, a.token, { scope: "core" });
    expect([seventh.status, seventh.body.error.code]).toEqual([409, "QUOTA_EXCEEDED"]);
    expect((await dbClient.db.select().from(operations)).length).toBe(before.ops);
    expect((await dbClient.db.select().from(siteBackups)).length).toBe(before.copies);
    expect(await audits("site.wordpress.update")).toHaveLength(3);
  });

  it("an update request must be exact and name an item of the stored state", async () => {
    for (const body of [
      { scope: "all", force: true },
      { scope: "all", name: "akismet" },
      { scope: "plugin" },
      { scope: "plugin", name: "../akismet" },
      { scope: "theme", name: "-bad" },
      { scope: "everything" },
    ]) {
      const res = await call("POST", `${wp()}/updates`, a.token, body);
      expect([body, res.status, res.body.error.code]).toEqual([body, 400, "VALIDATION_ERROR"]);
    }
    const unknownWithoutState = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "akismet" });
    expect([unknownWithoutState.status, reason(unknownWithoutState.body)]).toEqual([400, "item_unknown"]);

    await seedState();
    for (const body of [
      { scope: "plugin", name: "hello-dolly" },
      { scope: "plugin", name: "twentytwentyfive" },
      { scope: "theme", name: "akismet" },
    ]) {
      const res = await call("POST", `${wp()}/updates`, a.token, body);
      expect([body, res.status, res.body.error.code, reason(res.body)]).toEqual([body, 400, "VALIDATION_ERROR", "item_unknown"]);
    }
    expect(await wpOps()).toEqual([]);
    expect(await audits("site.wordpress.update")).toEqual([]);

    const theme = await call("POST", `${wp()}/updates`, a.token, { scope: "theme", name: "twentytwentyfive" });
    expect(theme.status).toBe(202);
  });

  it("GET answers the empty tab, then the stored state, the running operation and the backups flag", async () => {
    const empty = await call("GET", wp(), a.token);
    expect(empty).toEqual({
      status: 200,
      body: { data: { backupsConfigured: false, state: null, runningOperation: null, lastUpdate: null } },
    });

    await seedState();
    await saveSiteWordpressLastUpdate(dbClient.db, { organizationId: a.orgId, siteId: a.siteId, lastUpdate: LAST_UPDATE });
    await configureBackups();
    const stored = await call("GET", wp(), a.token);
    expect(stored.body.data).toEqual({ backupsConfigured: true, state: STATE, runningOperation: null, lastUpdate: LAST_UPDATE });

    const refresh = await call("POST", `${wp()}/refresh`, a.token, {});
    const running = await call("GET", wp(), a.token);
    expect(running.body.data.runningOperation).toEqual({
      id: refresh.body.data.operationId,
      kind: "site.wordpress.inspect",
      status: "queued",
      steps: [{ key: "inspect", status: "pending" }],
    });
    await finish(refresh.body.data.operationId as string);

    const update = await call("POST", `${wp()}/updates`, a.token, { scope: "core" });
    const updating = await call("GET", wp(), a.token);
    expect(updating.body.data.runningOperation).toEqual({
      id: update.body.data.operationId,
      kind: "site.wordpress.update",
      status: "queued",
      steps: [
        { key: "backup", status: "pending" },
        { key: "update", status: "pending" },
        { key: "settle", status: "pending" },
      ],
    });
    await finish(update.body.data.operationId as string);

    // A backup holds the site's lock, but it is not a WordPress operation.
    expect((await call("POST", `/v1/organizations/${a.orgId}/managed-sites/${a.siteId}/backups`, a.token, {})).status).toBe(202);
    expect((await call("GET", wp(), a.token)).body.data.runningOperation).toBeNull();

    // A stored row that no longer fits the schema reads as nothing.
    await seedState({ coreVersion: 7 });
    expect((await call("GET", wp(), a.token)).body.data.state).toBeNull();
  });

  describe("administrator password reset", () => {
    const reset = (userId: string | number) => call("POST", `${wp()}/administrators/${String(userId)}/password-reset`, a.token, {});
    const resets = async () => (await audits("site.wordpress.password_reset")).map((r) => r.details as Json);

    it("is refused while an operation runs and for a user who is not a known administrator", async () => {
      await seedState({ ...STATE, administrators: [{ id: 1, login: "admin" }, { id: 2, login: "editor" }] });
      const refresh = await call("POST", `${wp()}/refresh`, a.token, {});
      const busy = await reset(1);
      expect([busy.status, busy.body.error.code]).toEqual([409, "RESOURCE_LOCKED"]);
      await finish(refresh.body.data.operationId as string);

      for (const userId of ["0", "01", "abc", "12345678901", "7"]) {
        const res = await reset(userId);
        expect([userId, res.status, res.body.error.code, reason(res.body)]).toEqual([userId, 400, "VALIDATION_ERROR", "administrator_unknown"]);
      }
      expect(sim.jobs.filter((j) => j.kind === "wordpress.reset-password")).toEqual([]);

      // Stored as an administrator, but the site says otherwise (exit 40).
      const notAdmin = await reset(2);
      expect([notAdmin.status, reason(notAdmin.body)]).toEqual([400, "administrator_unknown"]);
      expect(notAdmin.body.data).toBeUndefined();
      expect(await resets()).toEqual([expect.objectContaining({ outcome: "failed", userId: 2, login: "editor", reason: "administrator_unknown" })]);
    });

    it("an administrator unknown without a stored state is refused", async () => {
      const res = await reset(1);
      expect([res.status, reason(res.body)]).toEqual([400, "administrator_unknown"]);
    });

    it("a job that exits with a failure answers 503 with its reason and no password", async () => {
      await seedState();
      for (const [exit, why] of [
        [21, "not_installed"],
        [22, "config_broken"],
        [23, "database_unreachable"],
        [1, "unavailable"],
        [70, "unavailable"],
        [124, "unavailable"],
        [137, "unavailable"],
      ] as const) {
        sim.failNextJob("wordpress.reset-password", exit, "tail");
        const res = await reset(1);
        expect([exit, res.status, res.body.error.code, res.body.error.retryable, reason(res.body)]).toEqual([
          exit,
          503,
          "DOCKER_ENGINE_UNAVAILABLE",
          true,
          why,
        ]);
        expect(res.body.data).toBeUndefined();
      }
      expect((await resets()).map((d) => [d["outcome"], d["reason"]])).toEqual([
        ["failed", "not_installed"],
        ["failed", "config_broken"],
        ["failed", "database_unreachable"],
        ["failed", "unavailable"],
        ["failed", "unavailable"],
        // R143: stopped at its limit or killed, the password may have changed.
        ["unknown", "unavailable"],
        ["unknown", "unavailable"],
      ]);
    });

    it("a job whose end was not seen answers 503 unavailable and is audited unknown", async () => {
      await seedState();
      vi.spyOn(sim, "runSiteJob").mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true }));
      const res = await reset(1);
      expect([res.status, res.body.error.code, reason(res.body)]).toEqual([503, "DOCKER_ENGINE_UNAVAILABLE", "unavailable"]);
      expect(res.body.data).toBeUndefined();
      expect(await resets()).toEqual([expect.objectContaining({ outcome: "unknown", userId: 1, login: "admin" })]);
    });

    it("a reset that exits 0 answers the new password once and stores it nowhere", async () => {
      await seedState();
      await setSite({ status: "stopped" });
      const res = await reset(1);
      expect(res.status).toBe(200);
      const password = SiteWordpressPasswordResetDtoSchema.parse(res.body.data).temporaryPassword;
      expect(password).toMatch(/^[A-Za-z0-9]{24}$/);

      const job = sim.jobs.find((j) => j.kind === "wordpress.reset-password") as SiteJobRequest;
      expect(job).toMatchObject({
        siteId: a.siteId,
        organizationId: a.orgId,
        params: { phpVersion: expect.any(String), userId: "1" },
        resolvedSecrets: { HP_ADMIN_PASSWORD: password },
      });
      expect(job.jobId).toMatch(/^job_[0-9a-f]+_pwreset$/);
      expect(JSON.stringify(job.params)).not.toContain(password);

      const audit = await resets();
      expect(audit).toEqual([expect.objectContaining({ outcome: "succeeded", userId: 1, login: "admin" })]);
      const rows = [
        ...(await dbClient.db.select().from(auditEvents)),
        ...(await dbClient.db.select().from(operations)),
        ...(await dbClient.db.select().from(operationSteps)),
        ...(await dbClient.db.select().from(outboxEvents)),
      ];
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(password);

      const again = await reset(1);
      expect(again.body.data.temporaryPassword).not.toBe(password);
    });
  });
});
