import http from "node:http";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  BACKUP_FAILURE_CLASSES,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  backupSettings,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
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
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { BackupSchedulerService } from "../src/backups/backup-scheduler.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "qa-backups-password-123";
const SETUP = { installationName: "QA Backups", hostHostname: "qa-backups.test", hostIpv4: "10.0.0.10" };
const SENTINEL_SECRET = "qa-sentinel-s3-secret-DO-NOT-LEAK-2026";
const SNAP_HEX = "c".repeat(64);

const BASE_SETTINGS = {
  endpoint: "https://s3.qa-backups.test",
  region: "eu-south-1",
  bucket: "qa-backups-bucket",
  prefix: "panel/prod",
  accessKeyId: "AKIAQABACKUPS1",
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
  onStatus?: (
    req: Extract<BackupsIpcRequest, { action: "status" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onForget?: (
    req: Extract<BackupsIpcRequest, { action: "forget" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onTest?: (
    req: Extract<BackupsIpcRequest, { action: "test" }>,
  ) => BackupsResultByAction["test"] | Promise<BackupsResultByAction["test"]>;
}

interface BackupExecutorScript {
  readonly calls: BackupsIpcRequest[];
  reset(): void;
  setHandlers(handlers: ScriptedHandlers): void;
}

// Wraps sim.backups locally without importing another test file.
function scriptBackupExecutor(sim: InMemoryDockerSimulatorAdapter): BackupExecutorScript {
  const calls: BackupsIpcRequest[] = [];
  let handlers: ScriptedHandlers = {};

  sim.backups = (async <R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> => {
    calls.push(req);
    switch (req.action) {
      case "test":
        return (handlers.onTest
          ? await handlers.onTest(req)
          : { outcome: "ok", problem: null }) as BackupsResultByAction[R["action"]];
      case "start":
        return (handlers.onStart
          ? await handlers.onStart(req)
          : { jobId: req.jobId, state: "running", failure: null, snapshot: null }) as BackupsResultByAction[R["action"]];
      case "forget":
        return (handlers.onForget
          ? await handlers.onForget(req)
          : { jobId: req.jobId, state: "running", failure: null, snapshot: null }) as BackupsResultByAction[R["action"]];
      case "status": {
        if (handlers.onStatus) {
          return (await handlers.onStatus(req)) as BackupsResultByAction[R["action"]];
        }
        const isForget = req.jobId.endsWith("-forget");
        return {
          jobId: req.jobId,
          state: "succeeded",
          failure: null,
          snapshot: isForget
            ? null
            : {
                snapshotId: SNAP_HEX,
                bytesAdded: 512,
                totalBytes: 4096,
                fileCount: 10,
                durationMs: 50,
              },
        } as BackupsResultByAction[R["action"]];
      }
      case "restore":
      case "archive":
      case "readArchive":
      case "discardArchive":
      case "settle":
      case "panelStart":
      case "siteState":
        throw new Error(`Unexpected backup action in test stub: ${req.action}`);
    }
  }) as DockerExecutorPort["backups"];

  return {
    calls,
    reset() {
      calls.length = 0;
      handlers = {};
    },
    setHandlers(next) {
      handlers = { ...next };
    },
  };
}

// Sends a raw HTTP request without normalizing dot segments in the path.
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
): Promise<{ status: number; body: Json; raw: string }> {
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
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

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

describe("backups QA integration (tenancy, secrets, hostile input, problems, R60, nightly)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorScript: BackupExecutorScript;
  let app: ControlPlaneAppHandle;
  let adminUserId: string;
  let adminToken: string;
  let orgAId: string;
  let orgBId: string;
  let ownerAToken: string;
  let ownerBToken: string;
  let collabAToken: string;
  let siteAId: string;
  let siteBId: string;
  let baselineAuditIds: Set<string>;

  const customerUrl = (orgId: string, siteId: string) =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/backups`;

  async function snapshotAudits() {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-qa-bkp@test.local",
      name: "QA Admin",
      password: PW,
    });
    adminUserId = admin.userId;

    sim = new InMemoryDockerSimulatorAdapter();
    hostSim = new InMemoryHostSimulatorAdapter();
    executorScript = scriptBackupExecutor(sim);

    const jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
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

    adminToken = await login(app.baseUrl!, "admin-qa-bkp@test.local", PW, admin.totpSecretBase32);

    const createdA = await rawRequest(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "QA Alpha Org",
        ownerEmail: "owner-a-qa@test.local",
        ownerName: "Owner A",
      },
    });
    expect(createdA.status, createdA.raw).toBe(201);
    await skipPasswordChange(dbClient.db, "owner-a-qa@test.local");
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await login(
      app.baseUrl!,
      "owner-a-qa@test.local",
      createdA.body.data.temporaryPassword as string,
    );

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: inst!.id,
      name: "qa-host-b.test",
      hostname: "qa-host-b.test",
      ipv4Address: "10.0.0.22",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });

    orgBId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgBId,
      platformInstallationId: inst!.id,
      name: "QA Beta Org",
      slug: "qa-beta-org",
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
      email: "owner-b-qa@test.local",
      name: "Owner B",
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
    ownerBToken = await login(app.baseUrl!, "owner-b-qa@test.local", PW);

    // Collaborator in Org A lacks site.backups.manage
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-a-qa@test.local",
      name: "Collab A",
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
    collabAToken = await login(app.baseUrl!, "collab-a-qa@test.local", PW);

    const resSiteA = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          name: "Site Alpha",
          domain: "alpha-qa.test",
          title: "Site Alpha",
          adminUser: "admin",
          adminEmail: "admin@alpha-qa.test",
          adminPassword: "qa-WpPass-123456",
        },
      },
    );
    expect(resSiteA.status, resSiteA.raw).toBe(202);
    siteAId = resSiteA.body.data.siteId as string;

    const resSiteB = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgBId}/managed-sites`,
      {
        token: ownerBToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {
          name: "Site Beta",
          domain: "beta-qa.test",
          title: "Site Beta",
          adminUser: "admin",
          adminEmail: "admin@beta-qa.test",
          adminPassword: "qa-WpPass-123456",
        },
      },
    );
    expect(resSiteB.status, resSiteB.raw).toBe(202);
    siteBId = resSiteB.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    executorScript.reset();
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.delete(backupSettings);
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteAId));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteBId));
    await upsertBackupSettings(dbClient.db, KEY, {
      ...BASE_SETTINGS,
      updatedByUserId: adminUserId,
    });
    await snapshotAudits();
  });

  it("enforces tenancy (404 cross-org, 403 missing permission, 403 customer on admin, 401 unauthenticated) with zero side effects", async () => {
    const opsBefore = (await dbClient.db.select().from(operations)).length;
    const bkpsBefore = (await dbClient.db.select().from(siteBackups)).length;

    // 1. Cross-tenant GET & POST -> 404 and zero DB/audit/executor side effects
    const crossTenantRequests: Array<[string, string, unknown?]> = [
      ["GET", customerUrl(orgAId, siteBId)],
      ["POST", customerUrl(orgAId, siteBId), {}],
      ["GET", customerUrl(orgBId, siteBId)],
      ["POST", customerUrl(orgBId, siteBId), {}],
    ];
    for (const [method, path, body] of crossTenantRequests) {
      const res = await rawRequest(app.baseUrl!, method, path, {
        token: ownerAToken,
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect((await dbClient.db.select().from(siteBackups)).length).toBe(bkpsBefore);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await newAudits()).toHaveLength(0);
    expect(executorScript.calls).toHaveLength(0);

    // 2. Collaborator without site.backups.manage -> 403, zero backup/op/executor calls
    for (const [method, body] of [
      ["GET", undefined],
      ["POST", {}],
    ] as const) {
      const res = await rawRequest(app.baseUrl!, method, customerUrl(orgAId, siteAId), {
        token: collabAToken,
        body,
        headers: method === "POST" ? { "Idempotency-Key": randomUUID() } : undefined,
      });
      expect(res.status, `collab ${method}`).toBe(403);
    }
    expect((await dbClient.db.select().from(siteBackups)).length).toBe(bkpsBefore);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(executorScript.calls).toHaveLength(0);

    // 3. Customer on every admin route -> 403
    const adminRoutes: Array<[string, string, unknown?, Record<string, string>?]> = [
      ["GET", "/v1/admin/backups"],
      ["PATCH", "/v1/admin/backups", { ...BASE_SETTINGS, bucket: "stolen-bucket" }],
      ["DELETE", "/v1/admin/backups"],
      ["POST", "/v1/admin/backups/test"],
      ["GET", "/v1/admin/backups/sites"],
      ["POST", `/v1/admin/backups/sites/${siteAId}/run`, {}, { "Idempotency-Key": randomUUID() }],
    ];
    for (const [method, path, body, headers] of adminRoutes) {
      const res = await rawRequest(app.baseUrl!, method, path, {
        token: ownerAToken,
        body,
        headers,
      });
      expect(res.status, `customer on admin ${method} ${path}`).toBe(403);
    }
    expect((await dbClient.db.select().from(siteBackups)).length).toBe(bkpsBefore);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(executorScript.calls).toHaveLength(0);

    // 4. Unauthenticated on all customer & admin routes -> 401
    const allRoutes: Array<[string, string, unknown?, Record<string, string>?]> = [
      ["GET", customerUrl(orgAId, siteAId)],
      ["POST", customerUrl(orgAId, siteAId), {}, { "Idempotency-Key": randomUUID() }],
      ...adminRoutes,
    ];
    for (const [method, path, body, headers] of allRoutes) {
      const res = await rawRequest(app.baseUrl!, method, path, { body, headers });
      expect(res.status, `unauth ${method} ${path}`).toBe(401);
    }
    expect((await dbClient.db.select().from(siteBackups)).length).toBe(bkpsBefore);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(executorScript.calls).toHaveLength(0);
  });

  it("keeps sentinel secret out of every response, DB text column, audit event, and log line, passing it only to executor", async () => {
    const capturedLogs: string[] = [];
    const recordLog = (...args: unknown[]) => {
      capturedLogs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    for (const method of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => recordLog(...args));
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => recordLog(...args));
    }

    // Clear and re-save through PATCH with sentinel secret
    await rawRequest(app.baseUrl!, "DELETE", "/v1/admin/backups", { token: adminToken });
    const saveRes = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: BASE_SETTINGS,
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.raw).not.toContain(SENTINEL_SECRET);

    const testRes = await rawRequest(app.baseUrl!, "POST", "/v1/admin/backups/test", {
      token: adminToken,
    });
    expect(testRes.status).toBe(200);
    expect(testRes.raw).not.toContain(SENTINEL_SECRET);

    // Successful backup
    const okRun = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(okRun.status).toBe(202);
    expect(okRun.raw).not.toContain(SENTINEL_SECRET);
    await app.outboxWorker.processPendingOnce();

    // Failed backup
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
      `/v1/admin/backups/sites/${siteAId}/run`,
      {
        token: adminToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(failRun.status).toBe(202);
    expect(failRun.raw).not.toContain(SENTINEL_SECRET);
    await app.outboxWorker.processPendingOnce();

    // Read all backup & operation routes and ensure zero sentinel leakage
    const readPaths = [
      "/v1/admin/backups",
      "/v1/admin/backups/sites",
      customerUrl(orgAId, siteAId),
      `/v1/organizations/${orgAId}/operations/${okRun.body.data.operationId}`,
      `/v1/organizations/${orgAId}/operations/${failRun.body.data.operationId}`,
    ];
    for (const p of readPaths) {
      const token = p.startsWith("/v1/admin") ? adminToken : ownerAToken;
      const res = await rawRequest(app.baseUrl!, "GET", p, { token });
      expect(res.status, p).toBe(200);
      expect(res.raw, p).not.toContain(SENTINEL_SECRET);
    }

    // Walk every text/json column of every public table in the database
    const colsRes = await dbClient.db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'character varying', 'json', 'jsonb')
    `);
    const columns = colsRes.rows as Array<{ table_name: string; column_name: string }>;
    expect(columns.length).toBeGreaterThan(10);
    for (const { table_name, column_name } of columns) {
      const q = sql.raw(
        `SELECT "${column_name}"::text AS val FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`,
      );
      const result = await dbClient.db.execute(q);
      for (const row of result.rows as Array<{ val: string }>) {
        expect(row.val, `${table_name}.${column_name}`).not.toContain(SENTINEL_SECRET);
      }
    }

    // Check audit events and logs explicitly
    const audits = await dbClient.db.select().from(auditEvents);
    expect(JSON.stringify(audits)).not.toContain(SENTINEL_SECRET);
    expect(capturedLogs.join("\n")).not.toContain(SENTINEL_SECRET);

    // Confirm the only place it appears in clear is the executor IPC requests
    const testCall = executorScript.calls.find((c) => c.action === "test");
    const startCalls = executorScript.calls.filter((c) => c.action === "start");
    expect(testCall && "target" in testCall ? testCall.target.secretAccessKey : null).toBe(
      SENTINEL_SECRET,
    );
    expect(startCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of startCalls) {
      if ("target" in call) {
        expect(call.target.secretAccessKey).toBe(SENTINEL_SECRET);
      }
    }
  });

  it("rejects every hostile save payload with 400 and R56 message names and saves nothing", async () => {
    await dbClient.db.delete(backupSettings);

    const unknownKeyRes = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: { ...BASE_SETTINGS, extraKey: "evil" },
    });
    expect(unknownKeyRes.status).toBe(400);
    expect(unknownKeyRes.body.error.code).toBe("VALIDATION_ERROR");

    const hostileCases: Array<{ patch: Record<string, unknown>; expectedMsg: string }> = [
      { patch: { endpoint: "https://user:pass@s3.example.com" }, expectedMsg: "endpoint_invalid" },
      { patch: { endpoint: "http://127.0.0.1:9000" }, expectedMsg: "endpoint_invalid" },
      { patch: { endpoint: "http://localhost:9000" }, expectedMsg: "endpoint_invalid" },
      { patch: { endpoint: "http://[::1]:9000" }, expectedMsg: "endpoint_invalid" },
      { patch: { endpoint: "ftp://s3.example.com" }, expectedMsg: "endpoint_invalid" },
      { patch: { endpoint: "file:///etc/passwd" }, expectedMsg: "endpoint_invalid" },
      { patch: { bucket: "bad/bucket" }, expectedMsg: "bucket_invalid" },
      { patch: { prefix: "../escape" }, expectedMsg: "prefix_invalid" },
      { patch: { prefix: "/leading" }, expectedMsg: "prefix_invalid" },
      { patch: { scheduleHourUtc: 24 }, expectedMsg: "schedule_hour_invalid" },
      { patch: { scheduleHourUtc: -1 }, expectedMsg: "schedule_hour_invalid" },
      { patch: { scheduleHourUtc: 2.5 }, expectedMsg: "schedule_hour_invalid" },
      { patch: { scheduleHourUtc: "2" }, expectedMsg: "schedule_hour_invalid" },
      { patch: { retentionDays: 0 }, expectedMsg: "retention_days_invalid" },
      { patch: { retentionDays: 366 }, expectedMsg: "retention_days_invalid" },
      { patch: { retentionDays: 1.5 }, expectedMsg: "retention_days_invalid" },
      { patch: { secretAccessKey: "" }, expectedMsg: "secret_access_key_invalid" },
      { patch: { secretAccessKey: "x".repeat(257) }, expectedMsg: "secret_access_key_invalid" },
      { patch: { secretAccessKey: "has space" }, expectedMsg: "secret_access_key_invalid" },
    ];

    for (const { patch, expectedMsg } of hostileCases) {
      const res = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
        token: adminToken,
        body: { ...BASE_SETTINGS, ...patch },
      });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const details = (res.body.error.details ?? []) as Array<{ message?: string }>;
      expect(details.some((d) => d.message === expectedMsg), `${JSON.stringify(patch)} -> ${res.raw}`).toBe(
        true,
      );
    }

    const afterGet = await rawRequest(app.baseUrl!, "GET", "/v1/admin/backups", {
      token: adminToken,
    });
    expect(afterGet.status).toBe(200);
    expect(afterGet.body.data.configured).toBe(false);
    expect(await dbClient.db.select().from(backupSettings)).toHaveLength(0);
  });

  it("rejects bucket containing '..' with 400 bucket_invalid and saves nothing", async () => {
    await dbClient.db.delete(backupSettings);

    const res = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: { ...BASE_SETTINGS, bucket: "bad..bucket" },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const details = (res.body.error.details ?? []) as Array<{ message?: string }>;
    expect(details.some((d) => d.message === "bucket_invalid"), res.raw).toBe(true);
    expect(await dbClient.db.select().from(backupSettings)).toHaveLength(0);
  });

  it("refuses hostile run requests on both customer and admin routes, enforces idempotency, and allows only one concurrent run", async () => {
    const opsBefore = (await dbClient.db.select().from(operations)).length;
    const bkpsBefore = (await dbClient.db.select().from(siteBackups)).length;

    // 1. Bad siteId shapes
    const badSiteIds = ["../escape", "a%2Fb", "bad'quote", "bad%00nul", "x".repeat(200)];
    for (const badId of badSiteIds) {
      const expectedStatuses = badId.length > 100 ? [400, 404, 414] : [400, 404];
      const custRes = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, badId), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(expectedStatuses, `customer badId=${badId}`).toContain(custRes.status);

      const adminRes = await rawRequest(
        app.baseUrl!,
        "POST",
        `/v1/admin/backups/sites/${badId}/run`,
        {
          token: adminToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        },
      );
      expect(expectedStatuses, `admin badId=${badId}`).toContain(adminRes.status);
    }

    // 2. Non-empty / non-object bodies
    for (const badBody of [{ extra: 1 }, ["array"], "str", 123]) {
      const custRes = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: badBody,
      });
      expect(custRes.status).toBe(400);

      const adminRes = await rawRequest(
        app.baseUrl!,
        "POST",
        `/v1/admin/backups/sites/${siteAId}/run`,
        {
          token: adminToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: badBody,
        },
      );
      expect(adminRes.status).toBe(400);
    }

    // 3. Missing Idempotency-Key
    const custNoKey = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      body: {},
    });
    expect(custNoKey.status).toBe(400);
    const adminNoKey = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteAId}/run`,
      { token: adminToken, body: {} },
    );
    expect(adminNoKey.status).toBe(400);

    expect((await dbClient.db.select().from(siteBackups)).length).toBe(bkpsBefore);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(await newAudits()).toHaveLength(0);

    // 4. Same Idempotency-Key twice -> identical ids, 1 row, 1 audit event
    const sameKey = randomUUID();
    const first = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": sameKey },
    });
    const second = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": sameKey },
      body: {},
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data).toEqual(first.body.data);
    expect(await dbClient.db.select().from(siteBackups)).toHaveLength(1);
    expect(await newAudits()).toHaveLength(1);

    // Settle the first backup so we can test concurrent requests on siteB
    await app.outboxWorker.processPendingOnce();

    // 5. Two concurrent requests for the same site with different keys -> exactly one 202, one 409
    const [conc1, conc2] = await Promise.all([
      rawRequest(app.baseUrl!, "POST", customerUrl(orgBId, siteBId), {
        token: ownerBToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      }),
      rawRequest(app.baseUrl!, "POST", `/v1/admin/backups/sites/${siteBId}/run`, {
        token: adminToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      }),
    ]);
    const statuses = [conc1.status, conc2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 409]);
  });

  it("records all 16 R55 failure classes verbatim", async () => {
    for (const failureClass of BACKUP_FAILURE_CLASSES) {
      executorScript.setHandlers({
        onStatus: (req) => ({
          jobId: req.jobId,
          state: "failed",
          failure: failureClass,
          snapshot: null,
        }),
      });

      // Use the admin run route (exempt from M3b's 6/hr customer heavy-action quota) across the 20 classes.
      const accepted = await rawRequest(
        app.baseUrl!,
        "POST",
        `/v1/admin/backups/sites/${siteAId}/run`,
        {
          token: adminToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        },
      );
      expect(accepted.status, failureClass).toBe(202);
      await app.outboxWorker.processPendingOnce();

      const custList = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
        token: ownerAToken,
      });
      expect(custList.status).toBe(200);
      expect(custList.body.data.backups[0].status).toBe("failed");
      expect(custList.body.data.backups[0].problem).toBe(failureClass);

      const adminList = await rawRequest(app.baseUrl!, "GET", "/v1/admin/backups/sites", {
        token: adminToken,
      });
      const adminRow = (adminList.body.data as Array<Json>).find((r) => r.siteId === siteAId);
      expect(adminRow?.lastStatus).toBe("failed");
      expect(adminRow?.problem).toBe(failureClass);
    }
  });

  it("maps unknown problem tokens from the executor to 'other'", async () => {
    const unknownToken = "invented_problem_name";
    executorScript.setHandlers({
      onStatus: (req) =>
        ({
          jobId: req.jobId,
          state: "failed",
          failure: unknownToken,
          snapshot: null,
        }) as unknown as BackupJobStatus,
    });

    const accepted = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(accepted.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const custList = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
    });
    expect(custList.body.data.backups[0].status).toBe("failed");
    expect(custList.body.data.backups[0].problem).toBe("other");
    expect(custList.raw).not.toContain(unknownToken);

    const adminList = await rawRequest(app.baseUrl!, "GET", "/v1/admin/backups/sites", {
      token: adminToken,
    });
    const adminRow = (adminList.body.data as Array<Json>).find((r) => r.siteId === siteAId);
    expect(adminRow?.problem).toBe("other");
    expect(adminList.raw).not.toContain(unknownToken);
  });

  it("maps free-text failure strings from the executor to 'other' without leaking executor text", async () => {
    const rawExecutorText = "restic failed on /etc/hosting-panel/backup.key";
    executorScript.setHandlers({
      onStatus: (req) =>
        ({
          jobId: req.jobId,
          state: "failed",
          failure: rawExecutorText,
          snapshot: null,
        }) as unknown as BackupJobStatus,
    });

    const accepted = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(accepted.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const custList = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
    });
    expect(custList.body.data.backups[0].status).toBe("failed");
    expect(custList.body.data.backups[0].problem).toBe("other");
    expect(custList.raw).not.toContain(rawExecutorText);

    const adminList = await rawRequest(app.baseUrl!, "GET", "/v1/admin/backups/sites", {
      token: adminToken,
    });
    const adminRow = (adminList.body.data as Array<Json>).find((r) => r.siteId === siteAId);
    expect(adminRow?.problem).toBe("other");
    expect(adminList.raw).not.toContain(rawExecutorText);
  });

  it("preserves site status on failure, rejects deploying/maintenance with 409 not_ready, and enforces R60 limits and audit actions", async () => {
    // 1. Failed backup preserves site status across ready/stopped/degraded
    executorScript.setHandlers({
      onStatus: (req) => ({
        jobId: req.jobId,
        state: "failed",
        failure: "unreachable",
        snapshot: null,
      }),
    });
    for (const status of ["ready", "stopped", "degraded"] as const) {
      await dbClient.db.update(sites).set({ status }).where(eq(sites.id, siteAId));
      const res = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(res.status, status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      const [row] = await dbClient.db.select({ status: sites.status }).from(sites).where(eq(sites.id, siteAId));
      expect(row?.status).toBe(status);
    }

    // 2. Deploying / maintenance -> 409 RESOURCE_LOCKED with not_ready
    for (const status of ["deploying", "maintenance"] as const) {
      await dbClient.db.update(sites).set({ status }).where(eq(sites.id, siteAId));
      const custRes = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
        token: ownerAToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(custRes.status).toBe(409);
      expect(custRes.body.error.code).toBe("RESOURCE_LOCKED");
      expect(JSON.stringify(custRes.body.error.details)).toContain("not_ready");

      const adminRes = await rawRequest(
        app.baseUrl!,
        "POST",
        `/v1/admin/backups/sites/${siteAId}/run`,
        {
          token: adminToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        },
      );
      expect(adminRes.status).toBe(409);
      expect(adminRes.body.error.code).toBe("RESOURCE_LOCKED");
      expect(JSON.stringify(adminRes.body.error.details)).toContain("not_ready");
    }
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteAId));

    // 3. Audit actions for save, test, customer backup, admin backup, and clear (R60 bucket change + remove)
    executorScript.reset();
    await snapshotAudits();

    const saveRes = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: { ...BASE_SETTINGS },
    });
    expect(saveRes.status).toBe(200);

    const testRes = await rawRequest(app.baseUrl!, "POST", "/v1/admin/backups/test", {
      token: adminToken,
    });
    expect(testRes.status).toBe(200);

    const custRun = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(custRun.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const adminRun = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteAId}/run`,
      {
        token: adminToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(adminRun.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // R60: changing bucket empties list and records targetChanged: true
    const beforeBucketChange = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
    });
    expect(beforeBucketChange.body.data.backups.length).toBeGreaterThanOrEqual(2);

    const changeBucket = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: { ...BASE_SETTINGS, bucket: "qa-backups-bucket-new" },
    });
    expect(changeBucket.status).toBe(200);

    const afterBucketChange = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
    });
    expect(afterBucketChange.body.data.backups).toEqual([]);
    const adminSitesAfterBucket = await rawRequest(app.baseUrl!, "GET", "/v1/admin/backups/sites", {
      token: adminToken,
    });
    const siteRowAfterBucket = (adminSitesAfterBucket.body.data as Array<Json>).find(
      (r) => r.siteId === siteAId,
    );
    expect(siteRowAfterBucket?.lastStatus).toBeNull();

    // R60: DELETE clears settings -> configured: false and run returns 400 not_configured
    const delRes = await rawRequest(app.baseUrl!, "DELETE", "/v1/admin/backups", {
      token: adminToken,
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.configured).toBe(false);

    const custAfterDel = await rawRequest(app.baseUrl!, "GET", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
    });
    expect(custAfterDel.body.data.configured).toBe(false);

    const custPostAfterDel = await rawRequest(app.baseUrl!, "POST", customerUrl(orgAId, siteAId), {
      token: ownerAToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(custPostAfterDel.status).toBe(400);
    expect(custPostAfterDel.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(custPostAfterDel.body.error.details)).toContain("not_configured");

    const adminPostAfterDel = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteAId}/run`,
      {
        token: adminToken,
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      },
    );
    expect(adminPostAfterDel.status).toBe(400);
    expect(adminPostAfterDel.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(adminPostAfterDel.body.error.details)).toContain("not_configured");

    // Verify exact audit events
    const audits = await newAudits();
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual([
      "admin.backups.update",
      "admin.backups.test",
      "site.backups.create",
      "admin.site.backups.create",
      "admin.backups.update",
      "admin.backups.clear",
    ]);
    const bucketAudit = audits[4]!;
    expect((bucketAudit.details as Json).targetChanged).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(SENTINEL_SECRET);
  });

  it("never gives a site two nightly backups on the same UTC day across concurrent ticks and hour changes", async () => {
    const scheduler = app.nestApp.get(BackupSchedulerService);
    const dayTick = new Date("2026-11-15T02:10:00Z");

    await Promise.all([scheduler.tick(dayTick), scheduler.tick(dayTick)]);
    const rowsAfterFirst = await dbClient.db.select().from(siteBackups);
    expect(rowsAfterFirst.filter((r) => r.kind === "nightly")).toHaveLength(1);
    expect((await newAudits()).filter((a) => a.action === "backups.nightly_run")).toHaveLength(0);

    await app.outboxWorker.processPendingOnce();
    await Promise.all([
      scheduler.tick(new Date("2026-11-15T02:10:05Z")),
      scheduler.tick(new Date("2026-11-15T02:10:05Z")),
    ]);

    const rowsAfterConcurrent = await dbClient.db.select().from(siteBackups);
    const siteANightly = rowsAfterConcurrent.filter((r) => r.siteId === siteAId && r.kind === "nightly");
    const siteBNightly = rowsAfterConcurrent.filter((r) => r.siteId === siteBId && r.kind === "nightly");
    expect(siteANightly).toHaveLength(1);
    expect(siteBNightly).toHaveLength(1);

    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-15T02:10:10Z"));

    const nightlyAudits1 = (await newAudits()).filter((a) => a.action === "backups.nightly_run");
    expect(nightlyAudits1).toHaveLength(1);
    const [settingsAfterDay1] = await dbClient.db.select().from(backupSettings);
    expect(settingsAfterDay1?.nightlyRunStartedAt).toBeNull();

    // Change scheduled hour after the night's run and tick again the same UTC day
    const patchHour = await rawRequest(app.baseUrl!, "PATCH", "/v1/admin/backups", {
      token: adminToken,
      body: { ...BASE_SETTINGS, scheduleHourUtc: 5 },
    });
    expect(patchHour.status).toBe(200);

    await scheduler.tick(new Date("2026-11-15T05:10:00Z"));
    const rowsSameDayAfterChange = await dbClient.db.select().from(siteBackups);
    expect(rowsSameDayAfterChange.filter((r) => r.siteId === siteAId && r.kind === "nightly")).toHaveLength(1);
    expect(rowsSameDayAfterChange.filter((r) => r.siteId === siteBId && r.kind === "nightly")).toHaveLength(1);

    const nightlyAudits2 = (await newAudits()).filter((a) => a.action === "backups.nightly_run");
    expect(nightlyAudits2).toHaveLength(1);

    // Next UTC day runs once per site at the new hour across concurrent ticks
    await Promise.all([
      scheduler.tick(new Date("2026-11-16T05:10:00Z")),
      scheduler.tick(new Date("2026-11-16T05:10:00Z")),
    ]);
    await app.outboxWorker.processPendingOnce();
    await Promise.all([
      scheduler.tick(new Date("2026-11-16T05:10:05Z")),
      scheduler.tick(new Date("2026-11-16T05:10:05Z")),
    ]);
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-16T05:10:10Z"));

    const rowsNextDay = await dbClient.db.select().from(siteBackups);
    expect(rowsNextDay.filter((r) => r.siteId === siteAId && r.kind === "nightly")).toHaveLength(2);
    expect(rowsNextDay.filter((r) => r.siteId === siteBId && r.kind === "nightly")).toHaveLength(2);
    expect((await newAudits()).filter((a) => a.action === "backups.nightly_run")).toHaveLength(2);
  });

  it("returns available:false on reads and 422 NOT_SUPPORTED on all mutations when runtimeBackend is disabled", async () => {
    const disDb = createDatabaseClient({ mode: "pglite" });
    await disDb.migrate();
    await setupInstallation(disDb.db, SETUP);
    const disAdmin = await createServerAdmin(disDb.db, KEY, {
      email: "admin-dis-qa@test.local",
      name: "Disabled Admin",
      password: PW,
    });
    const disSim = new InMemoryDockerSimulatorAdapter();
    const disApp = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: disDb,
      secretsMasterKey: KEY,
      runtimeBackend: "disabled",
      dockerExecutor: disSim,
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

    try {
      const disAdminToken = await login(
        disApp.baseUrl!,
        "admin-dis-qa@test.local",
        PW,
        disAdmin.totpSecretBase32,
      );
      const custAcct = await rawRequest(disApp.baseUrl!, "POST", "/v1/admin/customer-account", {
        token: disAdminToken,
        body: {
          organizationName: "Disabled Org",
          ownerEmail: "owner-dis@test.local",
          ownerName: "Owner Dis",
        },
      });
      await skipPasswordChange(disDb.db, "owner-dis@test.local");
      const disOrgId = custAcct.body.data.organizationId as string;
      const disOwnerToken = await login(
        disApp.baseUrl!,
        "owner-dis@test.local",
        custAcct.body.data.temporaryPassword as string,
      );
      const disSiteRes = await rawRequest(
        disApp.baseUrl!,
        "POST",
        `/v1/organizations/${disOrgId}/managed-sites`,
        {
          token: disOwnerToken,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            name: "Disabled Site",
            domain: "dis-qa.test",
            title: "Disabled Site",
            adminUser: "admin",
            adminEmail: "admin@dis-qa.test",
            adminPassword: "qa-WpPass-123456",
          },
        },
      );
      const disSiteId = disSiteRes.body.data.siteId as string;

      const adminGet = await rawRequest(disApp.baseUrl!, "GET", "/v1/admin/backups", {
        token: disAdminToken,
      });
      expect(adminGet.status).toBe(200);
      expect(adminGet.body.data.available).toBe(false);

      const custGet = await rawRequest(disApp.baseUrl!, "GET", customerUrl(disOrgId, disSiteId), {
        token: disOwnerToken,
      });
      expect(custGet.status).toBe(200);
      expect(custGet.body.data.available).toBe(false);
      expect(custGet.body.data.backups).toEqual([]);

      const mutations: Array<[string, string, string, unknown?, Record<string, string>?]> = [
        ["PATCH", "/v1/admin/backups", disAdminToken, BASE_SETTINGS],
        ["DELETE", "/v1/admin/backups", disAdminToken],
        ["POST", "/v1/admin/backups/test", disAdminToken],
        [
          "POST",
          `/v1/admin/backups/sites/${disSiteId}/run`,
          disAdminToken,
          {},
          { "Idempotency-Key": randomUUID() },
        ],
        [
          "POST",
          customerUrl(disOrgId, disSiteId),
          disOwnerToken,
          {},
          { "Idempotency-Key": randomUUID() },
        ],
      ];
      for (const [method, path, token, body, headers] of mutations) {
        const res = await rawRequest(disApp.baseUrl!, method, path, { token, body, headers });
        expect(res.status, `${method} ${path}`).toBe(422);
        expect(res.body.error.code).toBe("NOT_SUPPORTED");
      }
    } finally {
      await disApp.close();
      await disDb.close();
    }
  });
});
