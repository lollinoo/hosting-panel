import http from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  BackupArchiveChunkDtoSchema,
  SiteBackupAcceptedDtoSchema,
  SiteBackupsDtoSchema,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  backupSettings,
  createDatabaseClient,
  deleteBackupSettings,
  eq,
  hostAllocations,
  hosts,
  insertSiteBackup,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  siteBackups,
  sites,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type {
  DockerExecutorPort,
  SiteJobRequest,
  SiteJobResult,
} from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import {
  BACKUP_LEASE_MS,
  BACKUP_POLL_GIVE_UP_MS,
  BACKUP_POLL_MS,
  SiteBackupsApplier,
} from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 11);
const PW = "qa-restore-password-123";
const SETUP = {
  installationName: "QA Restore",
  hostHostname: "qa-restore.test",
  hostIpv4: "10.0.0.12",
};
const SENTINEL_SECRET = "qa-restore-sentinel-secret-NEVER-LEAK-2026";

const BASE_SETTINGS = {
  endpoint: "https://s3.qa-restore.test",
  region: "eu-south-1",
  bucket: "qa-restore-bucket",
  prefix: "panel/restore",
  accessKeyId: "AKIAQARESTORE1",
  secretAccessKey: SENTINEL_SECRET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface ScriptedHandlers {
  onStart?: (
    req: Extract<BackupsIpcRequest, { action: "start" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onRestore?: (
    req: Extract<BackupsIpcRequest, { action: "restore" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onArchive?: (
    req: Extract<BackupsIpcRequest, { action: "archive" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onReadArchive?: (
    req: Extract<BackupsIpcRequest, { action: "readArchive" }>,
  ) => BackupsResultByAction["readArchive"] | Promise<BackupsResultByAction["readArchive"]>;
  onDiscardArchive?: (
    req: Extract<BackupsIpcRequest, { action: "discardArchive" }>,
  ) => BackupsResultByAction["discardArchive"] | Promise<BackupsResultByAction["discardArchive"]>;
  onStatus?: (
    req: Extract<BackupsIpcRequest, { action: "status" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onSettle?: (
    req: Extract<BackupsIpcRequest, { action: "settle" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onForget?: (
    req: Extract<BackupsIpcRequest, { action: "forget" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onRunSiteJob?: (req: SiteJobRequest) => SiteJobResult | Promise<SiteJobResult>;
}

interface BackupExecutorScript {
  readonly calls: BackupsIpcRequest[];
  readonly siteJobCalls: SiteJobRequest[];
  reset(): void;
  setHandlers(handlers: ScriptedHandlers): void;
}

// Wraps sim.backups and sim.runSiteJob locally without importing another test file.
function scriptBackupExecutor(sim: InMemoryDockerSimulatorAdapter): BackupExecutorScript {
  const calls: BackupsIpcRequest[] = [];
  const siteJobCalls: SiteJobRequest[] = [];
  let handlers: ScriptedHandlers = {};
  const origBackups = sim.backups.bind(sim);
  const origRunSiteJob = sim.runSiteJob.bind(sim);

  sim.backups = (async <R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> => {
    calls.push(req);
    switch (req.action) {
      case "start":
        if (handlers.onStart) return (await handlers.onStart(req)) as BackupsResultByAction[R["action"]];
        break;
      case "restore":
        if (handlers.onRestore) return (await handlers.onRestore(req)) as BackupsResultByAction[R["action"]];
        break;
      case "archive":
        if (handlers.onArchive) return (await handlers.onArchive(req)) as BackupsResultByAction[R["action"]];
        break;
      case "readArchive":
        if (handlers.onReadArchive) {
          return (await handlers.onReadArchive(req)) as BackupsResultByAction[R["action"]];
        }
        break;
      case "discardArchive":
        if (handlers.onDiscardArchive) {
          return (await handlers.onDiscardArchive(req)) as BackupsResultByAction[R["action"]];
        }
        break;
      case "status":
        if (handlers.onStatus) return (await handlers.onStatus(req)) as BackupsResultByAction[R["action"]];
        break;
      case "settle":
        if (handlers.onSettle) return (await handlers.onSettle(req)) as BackupsResultByAction[R["action"]];
        break;
      case "forget":
        if (handlers.onForget) return (await handlers.onForget(req)) as BackupsResultByAction[R["action"]];
        break;
      case "test":
        break;
    }
    return origBackups(req);
  }) as DockerExecutorPort["backups"];

  sim.runSiteJob = (async (req: SiteJobRequest): Promise<SiteJobResult> => {
    siteJobCalls.push(req);
    if (handlers.onRunSiteJob) {
      return handlers.onRunSiteJob(req);
    }
    return origRunSiteJob(req);
  }) as DockerExecutorPort["runSiteJob"];

  return {
    calls,
    siteJobCalls,
    reset() {
      calls.length = 0;
      siteJobCalls.length = 0;
      handlers = {};
    },
    setHandlers(next) {
      handlers = { ...next };
    },
  };
}

// Sends an HTTP request over 127.0.0.1 without normalizing dot segments.
function rawRequest(
  baseUrl: string,
  method: string,
  rawPath: string,
  opts: {
    token?: string;
    body?: unknown;
    rawBody?: string | null;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Json; raw: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(baseUrl);
  let payload: string | undefined;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  if (opts.rawBody !== undefined) {
    if (opts.rawBody !== null) {
      payload = opts.rawBody;
    }
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  if (payload !== undefined) {
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: Number(url.port), path: rawPath, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: Json = {};
          if (raw) {
            try {
              body = JSON.parse(raw) as Json;
            } catch {
              body = {};
            }
          }
          resolve({ status: res.statusCode ?? 0, body, raw, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Logs in a user and returns the bearer access token.
async function login(
  baseUrl: string,
  email: string,
  password: string,
  totpSecret?: string,
): Promise<string> {
  const res = await rawRequest(baseUrl, "POST", "/v1/auth/login", {
    body: {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    },
  });
  expect(res.status, res.raw).toBe(200);
  return res.body.data.accessToken as string;
}

describe("backups restore & download QA integration (tenancy, refusals, problems, recovery, E7, E9, secrets, audit, E11, list)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorScript: BackupExecutorScript;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let jwtSigningKeyPem: string;
  let adminUserId: string;
  let adminToken: string;
  let orgAId: string;
  let orgBId: string;
  let ownerAPassword: string;
  let ownerAToken: string;
  let ownerBToken: string;
  let collabAToken: string;
  let siteA1Id: string;
  let siteA2Id: string;
  let siteBId: string;
  let baselineAuditIds: Set<string>;

  const backupsUrl = (orgId: string, siteId: string) =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/backups`;
  const restoreUrl = (orgId: string, siteId: string, backupId: string) =>
    `${backupsUrl(orgId, siteId)}/${backupId}/restore`;
  const downloadUrl = (orgId: string, siteId: string, backupId: string) =>
    `${backupsUrl(orgId, siteId)}/${backupId}/download`;

  // Captures current audit IDs so each test can isolate newly emitted events.
  async function snapshotAudits() {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  // Returns audit events written since the last snapshotAudits() call.
  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  // Creates a real succeeded backup via the admin route (exempt from customer E11 quota).
  async function createSucceededBackup(siteId: string): Promise<string> {
    const res = await rawRequest(app.baseUrl!, "POST", `/v1/admin/backups/sites/${siteId}/run`, {
      token: adminToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(res.status, res.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const backupId = res.body.data.backupId as string;
    const [row] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId))
      .limit(1);
    expect(row?.status).toBe("succeeded");
    expect(row?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    return backupId;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-qa-restore@test.local",
      name: "QA Restore Admin",
      password: PW,
    });
    adminUserId = admin.userId;

    sim = new InMemoryDockerSimulatorAdapter();
    hostSim = new InMemoryHostSimulatorAdapter();
    executorScript = scriptBackupExecutor(sim);

    jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: hostSim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    applier = app.nestApp.get(SiteBackupsApplier);

    adminToken = await login(app.baseUrl!, "admin-qa-restore@test.local", PW, admin.totpSecretBase32);

    const createdA = await rawRequest(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "QA Restore Alpha Org",
        ownerEmail: "owner-a-restore@test.local",
        ownerName: "Owner Alpha",
      },
    });
    expect(createdA.status, createdA.raw).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAPassword = createdA.body.data.temporaryPassword as string;
    await skipPasswordChange(dbClient.db, "owner-a-restore@test.local");
    ownerAToken = await login(
      app.baseUrl!,
      "owner-a-restore@test.local",
      ownerAPassword,
    );

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: inst!.id,
      name: "qa-restore-host-b.test",
      hostname: "qa-restore-host-b.test",
      ipv4Address: "10.0.0.23",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });

    orgBId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgBId,
      platformInstallationId: inst!.id,
      name: "QA Restore Beta Org",
      slug: "qa-restore-beta-org",
    });
    await dbClient.db.insert(hostAllocations).values({
      id: `alloc_${randomUUID()}`,
      hostId: hostBId,
      organizationId: orgBId,
      status: "active",
    });
    const ownerBUserId = `usr_${randomUUID()}`;
    const ownerBMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: ownerBUserId,
      email: "owner-b-restore@test.local",
      name: "Owner Beta",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({
      id: ownerBMemId,
      organizationId: orgBId,
      userId: ownerBUserId,
    });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: ownerBMemId,
      roleId: "role_customer_owner",
    });
    ownerBToken = await login(app.baseUrl!, "owner-b-restore@test.local", PW);

    // Collaborator in Org A lacks site.backups.manage
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-a-restore@test.local",
      name: "Collab Alpha",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db.insert(memberships).values({
      id: collabMemId,
      organizationId: orgAId,
      userId: collabId,
    });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: collabMemId,
      roleId: "role_customer_collaborator",
    });
    collabAToken = await login(app.baseUrl!, "collab-a-restore@test.local", PW);

    const createSite = async (orgId: string, token: string, name: string, domain: string) => {
      const res = await rawRequest(
        app.baseUrl!,
        "POST",
        `/v1/organizations/${orgId}/managed-sites`,
        {
          token,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            name,
            domain,
            title: name,
            adminUser: "admin",
            adminEmail: `admin@${domain}`,
            adminPassword: "qa-WpPass-123456",
          },
        },
      );
      expect(res.status, res.raw).toBe(202);
      return res.body.data.siteId as string;
    };

    siteA1Id = await createSite(orgAId, ownerAToken, "Site Alpha", "alpha-restore-qa.test");
    siteA2Id = await createSite(orgAId, ownerAToken, "Site Alpha Two", "alpha2-restore-qa.test");
    siteBId = await createSite(orgBId, ownerBToken, "Site Beta", "beta-restore-qa.test");

    await app.outboxWorker.processPendingOnce();
    await app.outboxWorker.processPendingOnce();
    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sim.backupState.finishHeld();
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;
  });

  beforeEach(async () => {
    sim.backupState.finishHeld();
    sim.backupState.expireArchives();
    executorScript.reset();
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.delete(backupSettings);
    await dbClient.db
      .update(organizations)
      .set({ status: "active" })
      .where(eq(organizations.id, orgAId));
    await dbClient.db
      .update(sites)
      .set({ status: "ready", name: "Site Alpha", siteUrl: "https://alpha-restore-qa.test" })
      .where(eq(sites.id, siteA1Id));
    await dbClient.db
      .update(sites)
      .set({
        status: "ready",
        name: "Site Alpha Two",
        siteUrl: "https://alpha2-restore-qa.test",
      })
      .where(eq(sites.id, siteA2Id));
    await dbClient.db
      .update(sites)
      .set({ status: "ready", name: "Site Beta", siteUrl: "https://beta-restore-qa.test" })
      .where(eq(sites.id, siteBId));
    await upsertBackupSettings(dbClient.db, KEY, {
      ...BASE_SETTINGS,
      updatedByUserId: adminUserId,
    });
    await snapshotAudits();
  });

  it("enforces tenancy (404 cross-org and cross-site, 403 permission + 1 denied audit, 403 suspended org, 401 unauthenticated) with zero writes", async () => {
    const bkpA1 = await createSucceededBackup(siteA1Id);
    const bkpA2 = await createSucceededBackup(siteA2Id);
    const bkpB = await createSucceededBackup(siteBId);

    // Prepare archive on A1 so an unauthorized GET would otherwise hit a ready archive.
    const prepA1 = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkpA1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prepA1.status, prepA1.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();

    await snapshotAudits();
    executorScript.reset();
    const opsBefore = (await dbClient.db.select().from(operations)).length;
    const rowsBefore = await dbClient.db.select().from(siteBackups);

    // 1. Cross-org (Site B via orgA or orgB with ownerA token) & cross-site same org (bkpA2 on siteA1)
    const crossRequests: Array<[string, string, unknown?]> = [
      ["POST", restoreUrl(orgAId, siteBId, bkpB), { confirmName: "Site Beta" }],
      ["POST", downloadUrl(orgAId, siteBId, bkpB), {}],
      ["GET", downloadUrl(orgAId, siteBId, bkpB)],
      ["POST", restoreUrl(orgBId, siteBId, bkpB), { confirmName: "Site Beta" }],
      ["POST", downloadUrl(orgBId, siteBId, bkpB), {}],
      ["GET", downloadUrl(orgBId, siteBId, bkpB)],
      ["POST", restoreUrl(orgAId, siteA1Id, bkpA2), { confirmName: "Site Alpha" }],
      ["POST", downloadUrl(orgAId, siteA1Id, bkpA2), {}],
      ["GET", downloadUrl(orgAId, siteA1Id, bkpA2)],
    ];
    for (const [method, path, body] of crossRequests) {
      const res = await rawRequest(app.baseUrl!, method, path, {
        token: ownerAToken,
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }

    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await dbClient.db.select().from(siteBackups)).toEqual(rowsBefore);
    expect(await newAudits()).toHaveLength(0);
    expect(executorScript.calls).toHaveLength(0);

    // 2. Member without site.backups.manage -> 403 and exactly 1 denied audit event per request
    const forbiddenRequests: Array<[string, string, unknown?]> = [
      ["POST", restoreUrl(orgAId, siteA1Id, bkpA1), { confirmName: "Site Alpha" }],
      ["POST", downloadUrl(orgAId, siteA1Id, bkpA1), {}],
      ["GET", downloadUrl(orgAId, siteA1Id, bkpA1)],
    ];
    for (const [method, path, body] of forbiddenRequests) {
      await snapshotAudits();
      const res = await rawRequest(app.baseUrl!, method, path, {
        token: collabAToken,
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `collab ${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      const emitted = await newAudits();
      expect(emitted, `denied audit for ${method} ${path}`).toHaveLength(1);
      expect(JSON.stringify(emitted[0]!.details)).toContain("denied");
    }

    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await dbClient.db.select().from(siteBackups)).toEqual(rowsBefore);
    expect(executorScript.calls).toHaveLength(0);

    // 3. Unauthenticated (no session) -> 401 on all three with nothing written
    await snapshotAudits();
    for (const [method, path, body] of forbiddenRequests) {
      const res = await rawRequest(app.baseUrl!, method, path, {
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `unauth ${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await newAudits()).toHaveLength(0);
    expect(executorScript.calls).toHaveLength(0);

    // 4. Suspended organization -> 403 ORGANIZATION_SUSPENDED on all three
    await dbClient.db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, orgAId));
    for (const [method, path, body] of forbiddenRequests) {
      const res = await rawRequest(app.baseUrl!, method, path, {
        token: ownerAToken,
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `suspended ${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe("ORGANIZATION_SUSPENDED");
    }
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(executorScript.calls).toHaveLength(0);
  });

  it("enforces refusals, exact error shapes, idempotency, concurrency, and disabled backend (all three 422)", async () => {
    const goodBkp1 = await createSucceededBackup(siteA1Id);
    const goodBkp2 = await createSucceededBackup(siteA1Id);

    // Seed a failed backup and a running backup
    executorScript.setHandlers({
      onStatus: (req) => ({
        jobId: req.jobId,
        state: "failed",
        failure: "auth_failed",
        snapshot: null,
      }),
    });
    const failRun = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA1Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(failRun.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const failedBkp = failRun.body.data.backupId as string;

    executorScript.reset();
    sim.backupState.holdJobs(true);
    const runningRun = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA1Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(runningRun.status).toBe(202);

    // While runningRun is queued (not finished), test active site lock 409 RESOURCE_LOCKED
    await snapshotAudits();
    const opsBefore = (await dbClient.db.select().from(operations)).length;

    const lockedRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(lockedRestore.status).toBe(409);
    expect(lockedRestore.body.error.code).toBe("RESOURCE_LOCKED");

    const lockedDownload = await rawRequest(
      app.baseUrl!,
      "POST",
      downloadUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(lockedDownload.status).toBe(409);
    expect(lockedDownload.body.error.code).toBe("RESOURCE_LOCKED");
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await newAudits()).toHaveLength(0);

    // Finish the held runningRun backup (it succeeds, then we clear or test non-succeeded rows)
    sim.backupState.finishHeld();
    await app.outboxWorker.processPendingOnce();

    // Insert a running backup row directly without holding lock to test 404 on running backup
    const [runningRow] = await dbClient.db
      .insert(siteBackups)
      .values({
        id: `bkp_${randomUUID().replace(/-/g, "")}`,
        siteId: siteA1Id,
        kind: "manual",
        status: "running",
      })
      .returning();

    await snapshotAudits();
    const opsAfterSetup = (await dbClient.db.select().from(operations)).length;

    // 1. Failed / running / malformed backupId -> 404 on all three
    for (const badId of [failedBkp, runningRow!.id, "bad-id", "bkp_123", "../escape"]) {
      for (const [method, path, body] of [
        ["POST", restoreUrl(orgAId, siteA1Id, badId), { confirmName: "Site Alpha" }],
        ["POST", downloadUrl(orgAId, siteA1Id, badId), {}],
        ["GET", downloadUrl(orgAId, siteA1Id, badId)],
      ] as const) {
        const res = await rawRequest(app.baseUrl!, method, path, {
          token: ownerAToken,
          body,
          headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
      }
    }

    // 2. Wrong confirmName -> 400 with field: "confirmName"
    const wrongNameRes = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Wrong Name" },
      },
    );
    expect(wrongNameRes.status).toBe(400);
    expect(wrongNameRes.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      (wrongNameRes.body.error.details as Array<{ field?: string }>).some(
        (d) => d.field === "confirmName",
      ),
    ).toBe(true);

    // 3. Unknown key on restore, bad bodies on download POST, missing Idempotency-Key -> 400
    const badKeyRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha", extra: true },
      },
    );
    expect(badKeyRestore.status).toBe(400);
    expect(badKeyRestore.body.error.code).toBe("VALIDATION_ERROR");

    for (const badDlRawBody of ['{"extra":1}', "[]", '"str"', "123", "{not-json"]) {
      const res = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, goodBkp1), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID(), "Content-Type": "application/json" },
        rawBody: badDlRawBody,
      });
      expect(res.status, `download POST ${badDlRawBody}`).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }

    const noIdemRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      { token: ownerAToken, body: { confirmName: "Site Alpha" } },
    );
    expect(noIdemRestore.status).toBe(400);

    const noIdemDl = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, goodBkp1), {
      token: ownerAToken,
      body: {},
    });
    expect(noIdemDl.status).toBe(400);

    // 4. Site deploying or maintenance -> 409 RESOURCE_LOCKED with not_ready
    for (const badStatus of ["deploying", "maintenance"] as const) {
      await dbClient.db.update(sites).set({ status: badStatus }).where(eq(sites.id, siteA1Id));
      for (const [path, body] of [
        [restoreUrl(orgAId, siteA1Id, goodBkp1), { confirmName: "Site Alpha" }],
        [downloadUrl(orgAId, siteA1Id, goodBkp1), {}],
      ] as const) {
        const res = await rawRequest(app.baseUrl!, "POST", path, {
          token: ownerAToken,
          headers: { "Idempotency-Key": randomUUID() },
          body,
        });
        expect(res.status, `${badStatus} ${path}`).toBe(409);
        expect(res.body.error.code).toBe("RESOURCE_LOCKED");
        expect(JSON.stringify(res.body.error)).toContain("not_ready");
      }
    }
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));

    // 5. Storage settings removed -> 400 VALIDATION_ERROR not_configured
    await deleteBackupSettings(dbClient.db);
    for (const [path, body] of [
      [restoreUrl(orgAId, siteA1Id, goodBkp1), { confirmName: "Site Alpha" }],
      [downloadUrl(orgAId, siteA1Id, goodBkp1), {}],
    ] as const) {
      const res = await rawRequest(app.baseUrl!, "POST", path, {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body,
      });
      expect(res.status, `no settings ${path}`).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(JSON.stringify(res.body.error)).toContain("not_configured");
    }

    expect((await dbClient.db.select().from(operations)).length).toBe(opsAfterSetup);
    expect(await newAudits()).toHaveLength(0);

    // Restore settings for replay, whitespace-trimmed confirmName, and concurrency checks
    await upsertBackupSettings(dbClient.db, KEY, {
      ...BASE_SETTINGS,
      updatedByUserId: adminUserId,
    });

    // 6.confirmName with surrounding spaces accepted + idempotent replay + conflict on different backup
    const restoreKey = randomUUID();
    const accepted1 = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": restoreKey },
        body: { confirmName: "  Site Alpha  " },
      },
    );
    expect(accepted1.status, accepted1.raw).toBe(202);
    expect(SiteBackupAcceptedDtoSchema.safeParse(accepted1.body.data).success).toBe(true);

    const replay1 = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": restoreKey },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(replay1.status).toBe(202);
    expect(replay1.body.data.operationId).toBe(accepted1.body.data.operationId);

    const restoreAudits = (await newAudits()).filter((a) => a.action === "site.backups.restore");
    expect(restoreAudits).toHaveLength(1);

    const conflictOtherBkp = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, goodBkp2),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": restoreKey },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(conflictOtherBkp.status).toBe(409);
    expect(conflictOtherBkp.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    await app.outboxWorker.processPendingOnce();

    // 7. Concurrent restores for the same site with different keys -> exactly one 202, one 409
    const [concA, concB] = await Promise.all([
      rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, goodBkp1), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      }),
      rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, goodBkp2), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      }),
    ]);
    expect([concA.status, concB.status].sort()).toEqual([202, 409]);
    const winner = concA.status === 202 ? concA : concB;
    const loser = concA.status === 202 ? concB : concA;
    expect(loser.body.error.code).toBe("RESOURCE_LOCKED");
    expect(winner.body.data.operationId).toMatch(/^op_/);
    await app.outboxWorker.processPendingOnce();

    // 8. Download POST with empty body (no payload) works
    const dlEmptyBody = await rawRequest(
      app.baseUrl!,
      "POST",
      downloadUrl(orgAId, siteA1Id, goodBkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        rawBody: null,
      },
    );
    expect(dlEmptyBody.status, dlEmptyBody.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // 9. Backend disabled -> every one of the three routes answers 422 NOT_SUPPORTED
    const disabledApp = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "disabled",
      dockerExecutor: sim,
      hostAgent: hostSim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    try {
      for (const [method, path, body] of [
        ["POST", restoreUrl(orgAId, siteA1Id, goodBkp1), { confirmName: "Site Alpha" }],
        ["POST", downloadUrl(orgAId, siteA1Id, goodBkp1), {}],
        ["GET", downloadUrl(orgAId, siteA1Id, goodBkp1)],
      ] as const) {
        const res = await rawRequest(disabledApp.baseUrl!, method, path, {
          token: ownerAToken,
          body,
          headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
        });
        expect(res.status, `disabled ${method} ${path}`).toBe(422);
        expect(res.body.error.code, `disabled ${method} ${path}`).toBe("NOT_SUPPORTED");
      }
    } finally {
      await disabledApp.close();
    }
  });

  it("maps every restore problem class and unknown/free-text errors while preserving site status (R80) and allowing restore after undo_incomplete", async () => {
    const bkpA1 = await createSucceededBackup(siteA1Id);
    const bkpA2 = await createSucceededBackup(siteA2Id);

    // Split 10 customer restores across 2 sites (5 each) to stay within the 6/hr per-site quota.
    const cases: Array<{
      siteId: string;
      siteName: string;
      backupId: string;
      initialStatus: "ready" | "stopped";
      simFailure: string;
      expectedProblem: string;
    }> = [
      {
        siteId: siteA1Id,
        siteName: "Site Alpha",
        backupId: bkpA1,
        initialStatus: "ready",
        simFailure: "restore_prepare_failed",
        expectedProblem: "restore_prepare_failed",
      },
      {
        siteId: siteA1Id,
        siteName: "Site Alpha",
        backupId: bkpA1,
        initialStatus: "ready",
        simFailure: "switch_undone",
        expectedProblem: "switch_undone",
      },
      {
        siteId: siteA1Id,
        siteName: "Site Alpha",
        backupId: bkpA1,
        initialStatus: "ready",
        simFailure: "undo_incomplete",
        expectedProblem: "undo_incomplete",
      },
      {
        siteId: siteA1Id,
        siteName: "Site Alpha",
        backupId: bkpA1,
        initialStatus: "stopped",
        simFailure: "definer_missing",
        expectedProblem: "definer_missing",
      },
      {
        siteId: siteA1Id,
        siteName: "Site Alpha",
        backupId: bkpA1,
        initialStatus: "ready",
        simFailure: "no_space",
        expectedProblem: "no_space",
      },
      {
        siteId: siteA2Id,
        siteName: "Site Alpha Two",
        backupId: bkpA2,
        initialStatus: "ready",
        simFailure: "timeout",
        expectedProblem: "timeout",
      },
      {
        siteId: siteA2Id,
        siteName: "Site Alpha Two",
        backupId: bkpA2,
        initialStatus: "ready",
        simFailure: "wrong_key",
        expectedProblem: "wrong_key",
      },
      {
        siteId: siteA2Id,
        siteName: "Site Alpha Two",
        backupId: bkpA2,
        initialStatus: "stopped",
        simFailure: "unreachable",
        expectedProblem: "unreachable",
      },
      {
        siteId: siteA2Id,
        siteName: "Site Alpha Two",
        backupId: bkpA2,
        initialStatus: "ready",
        simFailure: "interrupted",
        expectedProblem: "interrupted",
      },
      {
        siteId: siteA2Id,
        siteName: "Site Alpha Two",
        backupId: bkpA2,
        initialStatus: "ready",
        simFailure: "free text leaked /var/lib/secret-path",
        expectedProblem: "other",
      },
    ];

    for (const c of cases) {
      executorScript.reset();
      await dbClient.db
        .update(sites)
        .set({ status: c.initialStatus })
        .where(eq(sites.id, c.siteId));

      if (c.expectedProblem === "other") {
        executorScript.setHandlers({
          onStatus: (req) => ({
            jobId: req.jobId,
            state: "failed",
            failure: c.simFailure as never,
            snapshot: null,
          }),
        });
      } else {
        sim.backupState.failNext(c.simFailure as never);
      }

      const postRes = await rawRequest(
        app.baseUrl!,
        "POST",
        restoreUrl(orgAId, c.siteId, c.backupId),
        {
          token: ownerAToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: { confirmName: c.siteName },
        },
      );
      expect(postRes.status, c.simFailure).toBe(202);
      const opId = postRes.body.data.operationId as string;

      await app.outboxWorker.processPendingOnce();
      sim.backupState.finishHeld();

      const listRes = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, c.siteId), {
        token: ownerAToken,
      });
      expect(listRes.status).toBe(200);
      expect(listRes.body.data.lastRestore).toMatchObject({
        backupId: c.backupId,
        status: "failed",
        problem: c.expectedProblem,
      });
      expect(listRes.body.data.lastRestore.finishedAt).toBeTruthy();
      expect(listRes.raw).not.toContain("/var/lib/secret-path");

      const opRes = await rawRequest(
        app.baseUrl!,
        "GET",
        `/v1/organizations/${orgAId}/operations/${opId}`,
        { token: ownerAToken },
      );
      expect(opRes.status).toBe(200);
      expect(opRes.body.data.status).toBe("failed");
      expect(opRes.raw).not.toContain("/var/lib/secret-path");

      const [siteAfter] = await dbClient.db
        .select({ status: sites.status })
        .from(sites)
        .where(eq(sites.id, c.siteId))
        .limit(1);
      expect(siteAfter?.status, `R80 status after ${c.simFailure}`).toBe(c.initialStatus);
    }

    // After undo_incomplete on siteA1, a new restore of siteA1 is accepted and succeeds
    executorScript.reset();
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    sim.backupState.failNext("undo_incomplete");
    const undoRes = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkpA1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(undoRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // 7th action would exceed limit on siteA1, so move clock forward 61 minutes before retry test
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    // Re-login under the advanced clock so JWT stays valid
    const freshToken = await login(app.baseUrl!, "owner-a-restore@test.local", ownerAPassword);

    executorScript.reset();
    const retryAfterUndo = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkpA1),
      {
        token: freshToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(retryAfterUndo.status, retryAfterUndo.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const listAfterRetry = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: freshToken,
    });
    expect(listAfterRetry.status).toBe(200);
    expect(listAfterRetry.body.data.lastRestore).toMatchObject({
      backupId: bkpA1,
      status: "succeeded",
      problem: null,
    });
  });

  it("never starts a restore twice across short-lease long polls, settle recovery outcomes, simulated restart, and download recovery", async () => {
    const bkp1 = await createSucceededBackup(siteA1Id);

    // 1. Short lease (60 ms), 12 running status polls -> never marked unknown, finishes once
    applier.leaseMs = 60;
    applier.pollMs = 15;
    applier.pollGiveUpMs = 5_000;
    let pollCount = 0;
    executorScript.setHandlers({
      onStatus: (req) => {
        pollCount += 1;
        if (pollCount < 12) {
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        return { jobId: req.jobId, state: "succeeded", failure: null, snapshot: null };
      },
    });
    const longRes = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(longRes.status).toBe(202);
    const longOpId = longRes.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();
    sim.backupState.finishHeld();

    expect(pollCount).toBe(12);
    expect(
      executorScript.calls.filter((c) => c.action === "restore" && c.jobId === longOpId),
    ).toHaveLength(1);
    const [longOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, longOpId))
      .limit(1);
    expect(longOp?.status).toBe("succeeded");

    // Helper to force a restore into 'unknown' after exactly 1 restore dispatch
    const startAndGoUnknown = async (settleOutcome: "succeeded" | "switch_undone" | "unknown") => {
      executorScript.reset();
      applier.leaseMs = 50;
      applier.pollMs = 10;
      applier.pollGiveUpMs = 25;
      sim.backupState.holdJobs(true);
      executorScript.setHandlers({
        onStatus: () => {
          throw new Error("status unreachable");
        },
      });

      const post = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      });
      expect(post.status).toBe(202);
      const opId = post.body.data.operationId as string;

      await app.outboxWorker.processPendingOnce();
      const [midOp] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, opId))
        .limit(1);
      expect(midOp?.status).toBe("unknown");
      expect(
        executorScript.calls.filter((c) => c.action === "restore" && c.jobId === opId),
      ).toHaveLength(1);

      // Recovery asks settle; running keeps it pending without restarting restore
      executorScript.setHandlers({
        onSettle: (req) => ({ jobId: req.jobId, state: "running", failure: null, snapshot: null }),
      });
      const recPending = await app.outboxWorker.recoverUnknownOperations();
      expect(recPending.convergedSucceeded + recPending.convergedFailed).toBe(0);
      expect(
        executorScript.calls.filter((c) => c.action === "restore" && c.jobId === opId),
      ).toHaveLength(1);

      executorScript.setHandlers({
        onSettle: (req) => {
          if (settleOutcome === "succeeded") {
            return { jobId: req.jobId, state: "succeeded", failure: null, snapshot: null };
          }
          if (settleOutcome === "switch_undone") {
            return { jobId: req.jobId, state: "failed", failure: "switch_undone", snapshot: null };
          }
          return { jobId: req.jobId, state: "unknown", failure: null, snapshot: null };
        },
      });
      const recFinal = await app.outboxWorker.recoverUnknownOperations();
      expect(recFinal.convergedSucceeded + recFinal.convergedFailed).toBe(1);
      // Restore was NEVER started a second time
      expect(
        executorScript.calls.filter((c) => c.action === "restore" && c.jobId === opId),
      ).toHaveLength(1);
      expect(
        executorScript.calls.filter((c) => c.action === "settle" && c.jobId === opId).length,
      ).toBeGreaterThanOrEqual(2);

      sim.backupState.finishHeld();
      return opId;
    };

    // 2. settle -> succeeded
    const opRecOk = await startAndGoUnknown("succeeded");
    const [rowAfterOk] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);
    expect(rowAfterOk?.restoreStatus).toBe("succeeded");
    expect(rowAfterOk?.restoreProblem).toBeNull();
    expect(executorScript.siteJobCalls.some((c) => c.kind === "wordpress.set-url")).toBe(true);
    const [dbOpOk] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, opRecOk))
      .limit(1);
    expect(dbOpOk?.status).toBe("succeeded");

    // 3. settle -> failed (switch_undone)
    const opRecFail = await startAndGoUnknown("switch_undone");
    const [rowAfterFail] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);
    expect(rowAfterFail?.restoreStatus).toBe("failed");
    expect(rowAfterFail?.restoreProblem).toBe("switch_undone");
    const [dbOpFail] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, opRecFail))
      .limit(1);
    expect(dbOpFail?.status).toBe("failed");

    // 4. settle -> unknown -> failed with interrupted
    const opRecUnk = await startAndGoUnknown("unknown");
    const [rowAfterUnk] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);
    expect(rowAfterUnk?.restoreStatus).toBe("failed");
    expect(rowAfterUnk?.restoreProblem).toBe("interrupted");
    const [dbOpUnk] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, opRecUnk))
      .limit(1);
    expect(dbOpUnk?.status).toBe("failed");
    expect(dbOpUnk?.errorCode).toBe("OPERATION_INTERRUPTED");

    // 5. Simulated executor restart settles in-flight restore as interrupted via settle
    const restartBkpA2 = await createSucceededBackup(siteA2Id);
    executorScript.reset();
    applier.leaseMs = 50;
    applier.pollMs = 10;
    applier.pollGiveUpMs = 25;
    sim.backupState.holdJobs(true);
    executorScript.setHandlers({
      onStatus: () => {
        throw new Error("status unreachable");
      },
    });

    const restartPost2 = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA2Id, restartBkpA2),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha Two" },
      },
    );
    expect(restartPost2.status).toBe(202);
    const restartOp2Id = restartPost2.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    sim.backupState.simulateRestart();
    sim.backupState.finishHeld();
    executorScript.reset();

    await app.outboxWorker.recoverUnknownOperations();
    expect(executorScript.calls.some((c) => c.action === "settle" && c.jobId === restartOp2Id)).toBe(
      true,
    );
    expect(executorScript.calls.some((c) => c.action === "restore")).toBe(false);
    const [restartedOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, restartOp2Id))
      .limit(1);
    expect(restartedOp?.status).toBe("failed");

    // 6. Download recovery: asks status, unknown -> archive failed with interrupted, new prepare accepted
    executorScript.reset();
    applier.leaseMs = 50;
    applier.pollMs = 10;
    applier.pollGiveUpMs = 25;
    sim.backupState.holdJobs(true);
    executorScript.setHandlers({
      onStatus: () => {
        throw new Error("status unreachable");
      },
    });

    const dlPrep = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(dlPrep.status).toBe(202);
    const dlOpId = dlPrep.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    sim.backupState.simulateRestart();
    sim.backupState.finishHeld();
    executorScript.reset();

    await app.outboxWorker.recoverUnknownOperations();
    expect(executorScript.calls.some((c) => c.action === "status" && c.jobId === dlOpId)).toBe(
      true,
    );
    expect(executorScript.calls.some((c) => c.action === "archive")).toBe(false);

    const [dlRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);
    expect(dlRow?.archiveStatus).toBe("failed");
    expect(dlRow?.archiveProblem).toBe("interrupted");

    // A new prepare is accepted after failed archive recovery
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;
    const dlRetry = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(dlRetry.status).toBe(202);
    expect(dlRetry.body.data.operationId).not.toBe(dlOpId);
    await app.outboxWorker.processPendingOnce();
  });

  it("runs wordpress.set-url once on success (E7), tolerates its failure as address_not_updated, and skips it on failed restore", async () => {
    // Backup taken while site URL was old-alpha.test
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://old-alpha.test" })
      .where(eq(sites.id, siteA1Id));
    const bkpOld = await createSucceededBackup(siteA1Id);

    // Site's current address changed to new-alpha.test
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://new-alpha.test" })
      .where(eq(sites.id, siteA1Id));

    // 1. Successful restore -> runs set-url once with old -> new and jobId job_<32hex>_rurl
    executorScript.reset();
    const okRestore = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkpOld), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(okRestore.status).toBe(202);
    const okOpId = okRestore.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    const setUrlCalls = executorScript.siteJobCalls.filter((c) => c.kind === "wordpress.set-url");
    expect(setUrlCalls).toHaveLength(1);
    expect(setUrlCalls[0]!.jobId).toBe(`job_${okOpId.replace(/^op_/, "")}_rurl`);
    expect(setUrlCalls[0]!.params).toMatchObject({
      previousUrl: "https://old-alpha.test",
      siteUrl: "https://new-alpha.test",
    });

    // 2. When set-url fails -> operation still succeeds, lastRestore succeeded + address_not_updated, step failed
    executorScript.reset();
    executorScript.setHandlers({
      onRunSiteJob: (req) => ({
        jobId: req.jobId,
        exitCode: req.kind === "wordpress.set-url" ? 1 : 0,
        outputTail: "wp-cli failed",
      }),
    });
    const addrFailRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkpOld),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(addrFailRestore.status).toBe(202);
    const addrFailOpId = addrFailRestore.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    const [addrOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, addrFailOpId))
      .limit(1);
    expect(addrOp?.status).toBe("succeeded");

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, addrFailOpId));
    expect(steps.find((s) => s.key === "update_address")?.status).toBe("failed");

    const listRes = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listRes.body.data.lastRestore).toMatchObject({
      backupId: bkpOld,
      status: "succeeded",
      problem: "address_not_updated",
    });

    // 3. Failed restore runs NO address job
    executorScript.reset();
    sim.backupState.failNext("switch_undone");
    const failRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkpOld),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(failRestore.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(executorScript.siteJobCalls.filter((c) => c.kind === "wordpress.set-url")).toHaveLength(
      0,
    );
  });

  it("handles download end-to-end (preparing, chunk joining, safe fileName, query limits, expiry, loss, replacement, retention discard)", async () => {
    // Use non-ASCII + quotes + slashes in site name to verify safe fileName sanitization
    const hostileSiteName = 'Café / "Roma" .. äöü';
    await dbClient.db
      .update(sites)
      .set({ name: hostileSiteName })
      .where(eq(sites.id, siteA1Id));

    const bkp1 = await createSucceededBackup(siteA1Id);
    const bkp2 = await createSucceededBackup(siteA1Id);

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);

    // 1. Prepare -> 202 while held in preparing
    sim.backupState.holdJobs(true);
    const prep1 = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prep1.status).toBe(202);
    const op1 = prep1.body.data.operationId as string;

    // Second prepare while preparing -> same op, no new audit
    await snapshotAudits();
    const prepWhilePreparing = await rawRequest(
      app.baseUrl!,
      "POST",
      downloadUrl(orgAId, siteA1Id, bkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(prepWhilePreparing.status).toBe(202);
    expect(prepWhilePreparing.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);

    // GET while preparing -> 409 archive_preparing
    const fetchPreparing = await rawRequest(
      app.baseUrl!,
      "GET",
      downloadUrl(orgAId, siteA1Id, bkp1),
      { token: ownerAToken },
    );
    expect(fetchPreparing.status).toBe(409);
    expect(fetchPreparing.body.error.code).toBe("RESOURCE_LOCKED");
    expect(JSON.stringify(fetchPreparing.body.error)).toContain("archive_preparing");

    // Settle preparation
    sim.backupState.finishHeld();
    await app.outboxWorker.processPendingOnce();

    // Second prepare while ready -> same op, no new audit
    await snapshotAudits();
    const prepWhileReady = await rawRequest(
      app.baseUrl!,
      "POST",
      downloadUrl(orgAId, siteA1Id, bkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(prepWhileReady.status).toBe(202);
    expect(prepWhileReady.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);

    // 2. Bad query params -> 400
    for (const badQs of [
      "?length=524289",
      "?offset=-1",
      "?unknown=1",
      "?path=wp-config.php",
    ]) {
      const badQueryRes = await rawRequest(
        app.baseUrl!,
        "GET",
        `${downloadUrl(orgAId, siteA1Id, bkp1)}${badQs}`,
        { token: ownerAToken },
      );
      expect(badQueryRes.status, badQs).toBe(400);
      expect(badQueryRes.body.error.code).toBe("VALIDATION_ERROR");
    }

    // 3. Read all chunks from offset 0 to eof and compare bytes with simulator
    const chunks: Buffer[] = [];
    let offset = 0;
    let totalSize: number | undefined;
    while (true) {
      const res = await rawRequest(
        app.baseUrl!,
        "GET",
        `${downloadUrl(orgAId, siteA1Id, bkp1)}?offset=${offset}&length=524288`,
        { token: ownerAToken },
      );
      expect(res.status).toBe(200);
      const parsed = BackupArchiveChunkDtoSchema.safeParse(res.body.data);
      expect(parsed.success, res.raw).toBe(true);
      const chunk = parsed.data!;
      totalSize = chunk.size;
      expect(chunk.fileName).toMatch(/^[A-Za-z0-9._-]{1,120}\.zip$/);
      const buf = Buffer.from(chunk.dataBase64, "base64");
      chunks.push(buf);
      offset += buf.length;
      if (chunk.eof) break;
    }
    expect(totalSize).toBeGreaterThan(0);
    const expectedSize = totalSize!;
    const joined = Buffer.concat(chunks);
    expect(joined.length).toBe(expectedSize);

    // Read directly from simulator and compare byte-for-byte
    const simChunks: Buffer[] = [];
    for (let o = 0; o < expectedSize; o += 524_288) {
      const s = await sim.backups({ action: "readArchive", jobId: op1, offset: o, length: 524_288 });
      simChunks.push(Buffer.from(s.dataBase64, "base64"));
    }
    expect(joined.equals(Buffer.concat(simChunks))).toBe(true);

    // 4. Past readyUntil on fixed clock -> 404 archive_gone and list drops archive
    vi.setSystemTime(t0 + 60 * 60_000 + 1_000);
    const expiredFetch = await rawRequest(
      app.baseUrl!,
      "GET",
      downloadUrl(orgAId, siteA1Id, bkp1),
      { token: ownerAToken },
    );
    expect(expiredFetch.status).toBe(404);
    expect(JSON.stringify(expiredFetch.body.error)).toContain("archive_gone");

    const listAfterExpiry = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listAfterExpiry.status).toBe(200);
    const row1Expired = (listAfterExpiry.body.data.backups as Array<{ id: string; archive: unknown }>).find(
      (b) => b.id === bkp1,
    );
    expect(row1Expired?.archive).toBeNull();

    // 5. Executor lost the archive (expireArchives & simulateRestart) -> 404 & row archive state cleared
    vi.setSystemTime(t0 + 61 * 60_000);
    const freshToken = await login(app.baseUrl!, "owner-a-restore@test.local", ownerAPassword);
    for (const lose of [
      () => sim.backupState.expireArchives(),
      () => sim.backupState.simulateRestart(),
    ]) {
      const prep = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
        token: freshToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(prep.status).toBe(202);
      await app.outboxWorker.processPendingOnce();

      lose();

      const lostFetch = await rawRequest(
        app.baseUrl!,
        "GET",
        downloadUrl(orgAId, siteA1Id, bkp1),
        { token: freshToken },
      );
      expect(lostFetch.status).toBe(404);
      expect(JSON.stringify(lostFetch.body.error)).toContain("archive_gone");

      const [clearedRow] = await dbClient.db
        .select()
        .from(siteBackups)
        .where(eq(siteBackups.id, bkp1))
        .limit(1);
      expect(clearedRow?.archiveStatus).toBeNull();
      expect(clearedRow?.archiveReadyUntil).toBeNull();
      expect(clearedRow?.archiveProblem).toBeNull();
    }

    // 6. Preparing another backup of the same site clears the first one's archive state
    const prepB1 = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: freshToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prepB1.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const prepB2 = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp2), {
      token: freshToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prepB2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const [row1Replaced] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);
    const [row2Ready] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp2))
      .limit(1);
    expect(row1Replaced?.archiveStatus).toBeNull();
    expect(row2Ready?.archiveStatus).toBe("ready");

    // 7. Retention removing a backup with a prepared download calls discardArchive once; failure doesn't stop retention
    vi.useRealTimers();
    await createSucceededBackup(siteA2Id);
    const bkpOld = await createSucceededBackup(siteA2Id);
    const prepOld = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA2Id, bkpOld), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prepOld.status).toBe(202);
    const oldArchiveOpId = prepOld.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    // Keep the first siteA2 backup newer than retention window and push bkpOld past 14 days
    const oldDate = new Date(Date.now() - 20 * 86_400_000);
    await dbClient.db
      .update(siteBackups)
      .set({ startedAt: oldDate, finishedAt: oldDate })
      .where(eq(siteBackups.id, bkpOld));
    // The newest retentionDays good copies stay whatever their age (R207 restore.3), so push the old copy out of them.
    for (let i = 0; i < BASE_SETTINGS.retentionDays; i++) {
      const { id } = await insertSiteBackup(dbClient.db, { siteId: siteA2Id, kind: "nightly", status: "running", operationId: null, startedAt: new Date(Date.now() - (i + 1) * 60_000) });
      await dbClient.db.update(siteBackups).set({ status: "succeeded", snapshotId: i.toString(16).padStart(64, "c"), finishedAt: new Date() }).where(eq(siteBackups.id, id));
    }

    executorScript.reset();
    // Run retention via a new admin backup run
    const retRun = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA2Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(retRun.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const discardCalls = executorScript.calls.filter(
      (c) => c.action === "discardArchive" && c.jobId === oldArchiveOpId,
    );
    expect(discardCalls).toHaveLength(1);
    const [deletedOld] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkpOld))
      .limit(1);
    expect(deletedOld).toBeUndefined();

    // Repeat with discardArchive throwing: retention still removes the row
    const bkpOld2 = await createSucceededBackup(siteA2Id);
    const prepOld2 = await rawRequest(
      app.baseUrl!,
      "POST",
      downloadUrl(orgAId, siteA2Id, bkpOld2),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(prepOld2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    await dbClient.db
      .update(siteBackups)
      .set({ startedAt: oldDate, finishedAt: oldDate })
      .where(eq(siteBackups.id, bkpOld2));

    executorScript.reset();
    executorScript.setHandlers({
      onDiscardArchive: () => {
        throw new Error("disk error during discard");
      },
    });
    const retRun2 = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA2Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(retRun2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const [deletedOld2] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, bkpOld2))
      .limit(1);
    expect(deletedOld2).toBeUndefined();
  });

  it("never leaks the sentinel secret across responses, DB columns, outbox payloads, steps, audits, or logs; outbox payload holds only site & backup", async () => {
    const capturedLogs: string[] = [];
    const recordLog = (...args: unknown[]) => {
      capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) =>
        recordLog(...args),
      );
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => recordLog(...args));
    }

    await rawRequest(app.baseUrl!, "DELETE", "/v1/admin/backups", { token: adminToken });
    const saveRes = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: BASE_SETTINGS,
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.raw).not.toContain(SENTINEL_SECRET);

    const bkp1 = await createSucceededBackup(siteA1Id);

    // 1. Successful restore
    const restoreOk = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(restoreOk.status).toBe(202);
    expect(restoreOk.raw).not.toContain(SENTINEL_SECRET);

    // Verify outbox payload for site.backups.restore holds only site & backup (+ standard envelope ids)
    const [restoreOutbox] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, siteA1Id),
          sql`${outboxEvents.payload}->>'operationId' = ${restoreOk.body.data.operationId as string}`,
        ),
      )
      .limit(1);
    expect(Object.keys((restoreOutbox?.payload ?? {}) as Json).sort()).toEqual([
      "backupId",
      "kind",
      "operationId",
      "organizationId",
      "resourceId",
      "resourceType",
      "siteId",
    ]);

    await app.outboxWorker.processPendingOnce();

    // 2. Failed restore
    sim.backupState.failNext("wrong_key");
    const restoreFail = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkp1),
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(restoreFail.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // 3. Download prepare + fetch
    const dlPrep = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(dlPrep.status).toBe(202);
    expect(dlPrep.raw).not.toContain(SENTINEL_SECRET);

    const [dlOutbox] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, siteA1Id),
          sql`${outboxEvents.payload}->>'operationId' = ${dlPrep.body.data.operationId as string}`,
        ),
      )
      .limit(1);
    expect(Object.keys((dlOutbox?.payload ?? {}) as Json).sort()).toEqual([
      "backupId",
      "kind",
      "operationId",
      "organizationId",
      "resourceId",
      "resourceType",
      "siteId",
    ]);

    await app.outboxWorker.processPendingOnce();

    const dlFetch = await rawRequest(app.baseUrl!, "GET", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
    });
    expect(dlFetch.status).toBe(200);
    expect(dlFetch.raw).not.toContain(SENTINEL_SECRET);

    const listRes = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listRes.status).toBe(200);
    expect(listRes.raw).not.toContain(SENTINEL_SECRET);

    for (const opId of [
      restoreOk.body.data.operationId,
      restoreFail.body.data.operationId,
      dlPrep.body.data.operationId,
    ]) {
      const opRes = await rawRequest(
        app.baseUrl!,
        "GET",
        `/v1/organizations/${orgAId}/operations/${opId}`,
        { token: ownerAToken },
      );
      expect(opRes.status).toBe(200);
      expect(opRes.raw).not.toContain(SENTINEL_SECRET);
    }

    // Check every text/json column across every public table
    const colsRes = await dbClient.db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'character varying', 'json', 'jsonb')
    `);
    for (const { table_name, column_name } of colsRes.rows as Array<{
      table_name: string;
      column_name: string;
    }>) {
      const q = sql.raw(
        `SELECT "${column_name}"::text AS val FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`,
      );
      const result = await dbClient.db.execute(q);
      for (const row of result.rows as Array<{ val: string }>) {
        if (table_name === "backup_settings" && column_name === "secret_access_key_ciphertext") {
          expect(row.val).not.toContain(SENTINEL_SECRET);
        } else {
          expect(row.val, `${table_name}.${column_name}`).not.toContain(SENTINEL_SECRET);
        }
      }
    }

    expect(capturedLogs.join("\n")).not.toContain(SENTINEL_SECRET);
  });

  it("writes exact audit events for restore, download prepare, chunk-0 fetch only, and recovery", async () => {
    const bkp1 = await createSucceededBackup(siteA1Id);

    // 1. Normal restore -> 1 site.backups.restore + 1 site.backups.restore.finished
    await snapshotAudits();
    const res1 = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(res1.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const restoreAudits = await newAudits();
    expect(restoreAudits.filter((a) => a.action === "site.backups.restore")).toHaveLength(1);
    const finished1 = restoreAudits.filter((a) => a.action === "site.backups.restore.finished");
    expect(finished1).toHaveLength(1);
    expect(finished1[0]!.actorType).toBe("system");
    expect(finished1[0]!.details).toMatchObject({
      backupId: bkp1,
      operationId: res1.body.data.operationId,
      outcome: "succeeded",
      problem: null,
    });

    // 2. Download prepare + 3-chunk fetch -> 1 site.backups.download + 1 site.backups.download.fetched (offset 0 only)
    await snapshotAudits();
    const prepRes = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prepRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    for (const offset of [0, 524_288, 1_048_576]) {
      const fetchRes = await rawRequest(
        app.baseUrl!,
        "GET",
        `${downloadUrl(orgAId, siteA1Id, bkp1)}?offset=${offset}&length=524288`,
        { token: ownerAToken },
      );
      expect(fetchRes.status).toBe(200);
    }

    const dlAudits = await newAudits();
    expect(dlAudits.filter((a) => a.action === "site.backups.download")).toHaveLength(1);
    expect(dlAudits.filter((a) => a.action === "site.backups.download.fetched")).toHaveLength(1);

    // 3. Recovery restore -> still exactly 1 site.backups.restore and 1 site.backups.restore.finished
    await snapshotAudits();
    applier.leaseMs = 50;
    applier.pollMs = 10;
    applier.pollGiveUpMs = 25;
    sim.backupState.holdJobs(true);
    executorScript.setHandlers({
      onStatus: () => {
        throw new Error("status unreachable");
      },
    });

    const recPost = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(recPost.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    executorScript.reset();
    sim.backupState.finishHeld();
    await app.outboxWorker.recoverUnknownOperations();

    const recAudits = await newAudits();
    expect(recAudits.filter((a) => a.action === "site.backups.restore")).toHaveLength(1);
    expect(recAudits.filter((a) => a.action === "site.backups.restore.finished")).toHaveLength(1);
  });

  it("enforces the 6-per-hour heavy action limit (E11) with fixed clock, Retry-After, and admin/nightly/replay/other-site exemptions", async () => {
    const bkp1 = await createSucceededBackup(siteA1Id);
    const bkp2 = await createSucceededBackup(siteA1Id);
    const bkpSiteA2 = await createSucceededBackup(siteA2Id);

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const tokenAtT0 = await login(app.baseUrl!, "owner-a-restore@test.local", ownerAPassword);

    // Seed a nightly operation (requestedByUserId: null) — must NOT count toward customer limit
    await dbClient.db.insert(operations).values({
      id: `op_${randomUUID().replace(/-/g, "")}`,
      organizationId: orgAId,
      kind: "site.backups.create",
      status: "succeeded",
      resourceType: "site",
      resourceId: siteA1Id,
      requestedByUserId: null,
      submittedAt: new Date(t0),
    });

    // Perform a refused request (wrong confirmName) — must NOT count toward limit
    const refusedConfirm = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkp1),
      {
        token: tokenAtT0,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Nope" },
      },
    );
    expect(refusedConfirm.status).toBe(400);

    // Perform 6 mixed customer actions on siteA1: 2 create, 2 restore, 2 download (bkp1 before pruning, then bkp2)
    const actionKeys: Array<{ path: string; body: unknown; key: string }> = [
      { path: backupsUrl(orgAId, siteA1Id), body: {}, key: randomUUID() },
      { path: restoreUrl(orgAId, siteA1Id, bkp2), body: { confirmName: "Site Alpha" }, key: randomUUID() },
      { path: downloadUrl(orgAId, siteA1Id, bkp1), body: {}, key: randomUUID() },
      { path: backupsUrl(orgAId, siteA1Id), body: {}, key: randomUUID() },
      { path: restoreUrl(orgAId, siteA1Id, bkp2), body: { confirmName: "Site Alpha" }, key: randomUUID() },
      { path: downloadUrl(orgAId, siteA1Id, bkp2), body: {}, key: randomUUID() },
    ];

    let firstOpId = "";
    for (let i = 0; i < actionKeys.length; i++) {
      vi.setSystemTime(t0 + i * 10_000);
      const item = actionKeys[i]!;
      const res = await rawRequest(app.baseUrl!, "POST", item.path, {
        token: tokenAtT0,
        headers: { "Idempotency-Key": item.key },
        body: item.body,
      });
      expect(res.status, `action #${i + 1} ${item.path}`).toBe(202);
      if (i === 0) firstOpId = res.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();
    }

    const [firstOp] = await dbClient.db
      .select({ submittedAt: operations.submittedAt })
      .from(operations)
      .where(eq(operations.id, firstOpId))
      .limit(1);
    const expectedRetryAtMs = firstOp!.submittedAt.getTime() + 60 * 60_000;

    // 7th customer action at t0 + 120s -> 409 QUOTA_EXCEEDED with retryAt and Retry-After, no op left
    vi.setSystemTime(t0 + 120_000);
    await snapshotAudits();
    const opsBefore7th = (await dbClient.db.select().from(operations)).length;

    const seventhRestore = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkp2),
      {
        token: tokenAtT0,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(seventhRestore.status).toBe(409);
    expect(seventhRestore.body.error.code).toBe("QUOTA_EXCEEDED");
    const detail = (seventhRestore.body.error.details as Array<{ field?: string; message?: string }>)[0];
    expect(detail?.field).toBe("retryAt");
    expect(Date.parse(detail!.message!)).toBe(expectedRetryAtMs);
    expect(Number(seventhRestore.headers["retry-after"])).toBeGreaterThan(0);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore7th);
    expect(await newAudits()).toHaveLength(0);

    // Replayed key past the limit still returns the replay (202)
    const replayPastLimit = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, bkp2),
      {
        token: tokenAtT0,
        headers: { "Idempotency-Key": actionKeys[4]!.key },
        body: actionKeys[4]!.body,
      },
    );
    expect(replayPastLimit.status).toBe(202);

    // Admin run route is neither refused nor counted
    const adminAtLimit = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA1Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(adminAtLimit.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // Another site of the same customer is not affected
    const otherSite = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA2Id, bkpSiteA2),
      {
        token: tokenAtT0,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha Two" },
      },
    );
    expect(otherSite.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // 1 second after expectedRetryAtMs -> allowed again!
    vi.setSystemTime(expectedRetryAtMs + 1_000);
    const freshToken = await login(app.baseUrl!, "owner-a-restore@test.local", ownerAPassword);
    const afterWindow = await rawRequest(
      app.baseUrl!,
      "POST",
      restoreUrl(orgAId, siteA1Id, adminAtLimit.body.data.backupId as string),
      {
        token: freshToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "Site Alpha" },
      },
    );
    expect(afterWindow.status, afterWindow.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
  });

  it("projects lastRestore and archive accurately on GET backups without leaking host paths, executor ids, or snapshot ids", async () => {
    const bkp1 = await createSucceededBackup(siteA1Id);
    const bkp2 = await createSucceededBackup(siteA1Id);

    const [row1Snap] = await dbClient.db
      .select({ snapshotId: siteBackups.snapshotId })
      .from(siteBackups)
      .where(eq(siteBackups.id, bkp1))
      .limit(1);

    // 1. Running restore
    sim.backupState.holdJobs(true);
    const res1 = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(res1.status).toBe(202);

    const listRunning = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listRunning.status).toBe(200);
    expect(SiteBackupsDtoSchema.safeParse(listRunning.body.data).success).toBe(true);
    expect(listRunning.body.data.lastRestore).toMatchObject({
      backupId: bkp1,
      status: "running",
      finishedAt: null,
      problem: null,
    });

    // 2. Succeeded restore on bkp1
    sim.backupState.finishHeld();
    await app.outboxWorker.processPendingOnce();

    const listOk = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listOk.body.data.lastRestore).toMatchObject({
      backupId: bkp1,
      status: "succeeded",
      problem: null,
    });

    // 3. Failed restore on bkp2 later -> lastRestore switches to bkp2
    await new Promise((r) => setTimeout(r, 15));
    sim.backupState.failNext("timeout");
    const res2 = await rawRequest(app.baseUrl!, "POST", restoreUrl(orgAId, siteA1Id, bkp2), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Site Alpha" },
    });
    expect(res2.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const listFailed = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    expect(listFailed.body.data.lastRestore).toMatchObject({
      backupId: bkp2,
      status: "failed",
      problem: "timeout",
    });

    // 4. Archive states: preparing -> ready -> failed -> no leaked internal ids/paths
    sim.backupState.holdJobs(true);
    const prep2 = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp2), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prep2.status).toBe(202);

    const listPrep = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    const b2Prep = (listPrep.body.data.backups as Json[]).find((b) => b.id === bkp2);
    expect(b2Prep?.archive).toEqual({ status: "preparing", readyUntil: null, problem: null });

    sim.backupState.finishHeld();
    await app.outboxWorker.processPendingOnce();

    const listReady = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    const b2Ready = (listReady.body.data.backups as Json[]).find((b) => b.id === bkp2);
    expect(b2Ready?.archive?.status).toBe("ready");
    expect(b2Ready?.archive?.readyUntil).toBeTruthy();

    // Failed archive on bkp1
    sim.backupState.failNext("no_space");
    const prep1Fail = await rawRequest(app.baseUrl!, "POST", downloadUrl(orgAId, siteA1Id, bkp1), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prep1Fail.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const listArchiveFail = await rawRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id), {
      token: ownerAToken,
    });
    const b1Fail = (listArchiveFail.body.data.backups as Json[]).find((b) => b.id === bkp1);
    expect(b1Fail?.archive).toEqual({
      status: "failed",
      readyUntil: null,
      problem: "no_space",
    });

    // Ensure no host path, executor id, or snapshot id appears anywhere in list response
    expect(listArchiveFail.raw).not.toContain("/var/");
    expect(listArchiveFail.raw).not.toContain("/run/");
    expect(listArchiveFail.raw).not.toContain("serviceInstanceId");
    expect(listArchiveFail.raw).not.toContain(row1Snap!.snapshotId!);
  });
});
