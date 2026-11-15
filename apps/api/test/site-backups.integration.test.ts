import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  BACKUP_FAILURE_CLASSES,
  MANUAL_BACKUPS_KEPT,
  PLATFORM_OPS_ORG_ID,
  SiteBackupAcceptedDtoSchema,
  SiteBackupsDtoSchema,
  findForbiddenPublicDtoKeys,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  claimPendingOutboxEvents,
  createDatabaseClient,
  deleteBackupSettings,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  inArray,
  insertSiteBackup,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  settleSiteBackup,
  siteBackups,
  sites,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { FastifyRequest } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthzContextService } from "../src/auth/authz-context.service.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { BackupSettingsService } from "../src/backups/backup-settings.service.js";
import {
  BACKUP_LEASE_MS,
  BACKUP_POLL_GIVE_UP_MS,
  BACKUP_POLL_MS,
  SITE_BACKUPS_INTERRUPTED,
  SiteBackupsApplier,
} from "../src/backups/site-backups-applier.js";
import {
  SITE_BACKUP_PRUNE_STEPS,
  SITE_BACKUP_STEPS,
  SiteBackupsService,
} from "../src/backups/site-backups.service.js";
import { SITE_ARCHIVE_STEPS, SITE_RESTORE_STEPS } from "../src/backups/site-restore-applier.js";
import { assertHeavyActionAllowed } from "../src/backups/site-restore.service.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { BACKUP_OPERATION_KINDS } from "../src/runtime/outbox-worker.service.js";

let beforeResolveSiteFilesServiceId: (() => Promise<void>) | null = null;

vi.mock("../src/sites/site-files.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sites/site-files.service.js")>();
  return {
    ...actual,
    resolveSiteFilesServiceId: async (
      ...args: Parameters<typeof actual.resolveSiteFilesServiceId>
    ) => {
      if (beforeResolveSiteFilesServiceId) {
        const hook = beforeResolveSiteFilesServiceId;
        beforeResolveSiteFilesServiceId = null;
        await hook();
      }
      return actual.resolveSiteFilesServiceId(...args);
    },
  };
});

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const SETUP = { installationName: "Test Backups", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY_SECRET = "canary-s3-secret-DO-NOT-LEAK-42";
const SNAP_HEX_OK = "a".repeat(64);
const SNAP_HEX_OLD = "b".repeat(64);
const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hotel-backups",
  prefix: "panel",
  accessKeyId: "AKIABACKUPTEST1",
  secretAccessKey: CANARY_SECRET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SITE_A1 = {
  name: "Hotel Roma",
  domain: "hotelroma.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_A2 = {
  name: "Bar Napoli",
  domain: "barnapoli.it",
  title: "Bar Napoli",
  adminUser: "admin",
  adminEmail: "admin@barnapoli.it",
  adminPassword: "canary-Pass-123456",
};
const SITE_B = {
  name: "Caffe Milano",
  domain: "caffemilano.it",
  title: "Caffe Milano",
  adminUser: "admin",
  adminEmail: "admin@caffemilano.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ScriptedBackupHandlers {
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

export type ScriptedStatusStep =
  | BackupJobStatus
  | Error
  | ((
      req: Extract<BackupsIpcRequest, { action: "status" }>,
    ) => BackupJobStatus | Promise<BackupJobStatus>);

export interface BackupExecutorScript {
  readonly calls: BackupsIpcRequest[];
  reset(): void;
  setStatusSequence(jobId: string, sequence: readonly ScriptedStatusStep[]): void;
  setHandlers(handlers: ScriptedBackupHandlers): void;
}

/** Wraps an InMemoryDockerSimulatorAdapter with controllable scripted backup job outcomes. */
export function scriptBackupExecutor(sim: InMemoryDockerSimulatorAdapter): BackupExecutorScript {
  const calls: BackupsIpcRequest[] = [];
  const statusSequences = new Map<string, ScriptedStatusStep[]>();
  let handlers: ScriptedBackupHandlers = {};

  sim.backups = (async <R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> => {
    calls.push(req);
    switch (req.action) {
      case "test": {
        if (handlers.onTest) {
          return (await handlers.onTest(req)) as BackupsResultByAction[R["action"]];
        }
        return { outcome: "ok", problem: null } as BackupsResultByAction[R["action"]];
      }
      case "start": {
        if (handlers.onStart) {
          return (await handlers.onStart(req)) as BackupsResultByAction[R["action"]];
        }
        return {
          jobId: req.jobId,
          state: "running",
          failure: null,
          snapshot: null,
        } as BackupsResultByAction[R["action"]];
      }
      case "forget": {
        if (handlers.onForget) {
          return (await handlers.onForget(req)) as BackupsResultByAction[R["action"]];
        }
        return {
          jobId: req.jobId,
          state: "running",
          failure: null,
          snapshot: null,
        } as BackupsResultByAction[R["action"]];
      }
      case "status": {
        const queue = statusSequences.get(req.jobId) ?? statusSequences.get("*");
        if (queue && queue.length > 0) {
          const next = queue.length > 1 ? queue.shift()! : queue[0]!;
          if (next instanceof Error) {
            throw next;
          }
          if (typeof next === "function") {
            return (await next(req)) as BackupsResultByAction[R["action"]];
          }
          return next as BackupsResultByAction[R["action"]];
        }
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
                snapshotId: SNAP_HEX_OK,
                bytesAdded: 1024,
                totalBytes: 8192,
                fileCount: 24,
                durationMs: 120,
              },
        } as BackupsResultByAction[R["action"]];
      }
      case "restore":
      case "archive":
      case "readArchive":
      case "discardArchive":
      case "settle":
        throw new Error(`Unexpected backup action in test stub: ${req.action}`);
    }
  }) as DockerExecutorPort["backups"];

  return {
    calls,
    reset(): void {
      calls.length = 0;
      statusSequences.clear();
      handlers = {};
    },
    setStatusSequence(jobId: string, sequence: readonly ScriptedStatusStep[]): void {
      statusSequences.set(jobId, [...sequence]);
    },
    setHandlers(next: ScriptedBackupHandlers): void {
      handlers = { ...next };
    },
  };
}

interface HttpResult {
  readonly status: number;
  readonly body: Json;
  readonly raw: string;
}

async function httpRequest(
  baseUrl: string,
  method: string,
  path: string,
  options?: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string | null;
  },
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  let bodyPayload: string | undefined;
  if (options?.rawBody !== undefined) {
    if (options.rawBody !== null) {
      bodyPayload = options.rawBody;
    }
  } else if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyPayload = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyPayload,
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw ? (JSON.parse(raw) as Json) : {},
    raw,
  };
}

async function login(baseUrl: string, email: string, password: string, totpSecret?: string): Promise<string> {
  const res = await httpRequest(baseUrl, "POST", "/v1/auth/login", {
    body: {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    },
  });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${email}: ${res.status} ${res.raw}`);
  }
  return res.body.data.accessToken as string;
}

describe("site backups API and outbox execution", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorScript: BackupExecutorScript;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let adminUserId: string;
  let adminToken: string;
  let orgAId: string;
  let orgBId: string;
  let ownerAUserId: string;
  let ownerAToken: string;
  let ownerBToken: string;
  let collabToken: string;
  let siteA1Id: string;
  let siteA2Id: string;
  let siteBId: string;
  let baselineAuditIds: Set<string>;
  let instId: string;

  const backupsUrl = (orgId: string, siteId: string) =>
    `/v1/organizations/${orgId}/managed-sites/${siteId}/backups`;

  const call = (
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string | null;
    },
  ) => httpRequest(app.baseUrl!, method, path, { token: ownerAToken, ...options });

  async function snapshotAudits(): Promise<void> {
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
      email: "admin-backups@x.it",
      name: "Admin",
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
      recoverUnknownOnStart: false,
    });
    applier = app.nestApp.get(SiteBackupsApplier);

    adminToken = await login(app.baseUrl!, "admin-backups@x.it", PW, admin.totpSecretBase32);

    const createdA = await httpRequest(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "Hotel Roma Org",
        ownerEmail: "mario-backups@hotel.it",
        ownerName: "Mario",
      },
    });
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await login(
      app.baseUrl!,
      "mario-backups@hotel.it",
      createdA.body.data.temporaryPassword as string,
    );
    const [ownerARow] = await dbClient.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "mario-backups@hotel.it"));
    ownerAUserId = ownerARow!.id;

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    instId = inst!.id;

    // Organization B with dedicated host and owner
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: instId,
      name: "panel-b-backups.test",
      hostname: "panel-b-backups.test",
      ipv4Address: "10.0.0.2",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    orgBId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({
      id: orgBId,
      platformInstallationId: instId,
      name: "Bar Sport Org",
      slug: "bar-sport-backups-org",
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
      email: "luigi-backups@barsport.it",
      name: "Luigi",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db
      .insert(memberships)
      .values({ id: ownerBMemId, organizationId: orgBId, userId: ownerBUserId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: ownerBMemId,
      roleId: "role_customer_owner",
    });
    ownerBToken = await login(app.baseUrl!, "luigi-backups@barsport.it", PW);

    // Collaborator in Org A
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-backups@hotel.it",
      name: "Collab",
      passwordHash: await hashPassword(PW),
    });
    await dbClient.db
      .insert(memberships)
      .values({ id: collabMemId, organizationId: orgAId, userId: collabId });
    await dbClient.db.insert(membershipRoles).values({
      id: `mrl_${randomUUID()}`,
      membershipId: collabMemId,
      roleId: "role_customer_collaborator",
    });
    collabToken = await login(app.baseUrl!, "collab-backups@hotel.it", PW);

    // Provision two sites in Org A and one in Org B
    for (const [spec, assign] of [
      [SITE_A1, (id: string) => { siteA1Id = id; }],
      [SITE_A2, (id: string) => { siteA2Id = id; }],
    ] as const) {
      const res = await httpRequest(app.baseUrl!, "POST", `/v1/organizations/${orgAId}/managed-sites`, {
        token: ownerAToken,
        body: spec,
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(res.status).toBe(202);
      assign(res.body.data.siteId as string);
    }
    const resB = await httpRequest(app.baseUrl!, "POST", `/v1/organizations/${orgBId}/managed-sites`, {
      token: ownerBToken,
      body: SITE_B,
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(resB.status).toBe(202);
    siteBId = resB.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    beforeResolveSiteFilesServiceId = null;
    vi.restoreAllMocks();
    executorScript.reset();
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;

    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgAId));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA2Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteBId));
    await upsertBackupSettings(dbClient.db, KEY, {
      ...SETTINGS,
      updatedByUserId: adminUserId,
    });
    await snapshotAudits();
  });

  afterEach(() => {
    beforeResolveSiteFilesServiceId = null;
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;
    vi.restoreAllMocks();
  });

  it("exposes frozen step/kind constants and SiteBackupsService.enqueueBackupTx/admin prefix", async () => {
    expect(SITE_BACKUP_STEPS).toHaveLength(2);
    expect(SITE_BACKUP_PRUNE_STEPS).toHaveLength(1);
    expect(SITE_RESTORE_STEPS.map((s) => s.key)).toEqual(["restore", "update_address"]);
    expect(SITE_ARCHIVE_STEPS.map((s) => s.key)).toEqual(["prepare"]);
    expect(BACKUP_OPERATION_KINDS).toEqual([
      "site.backups.create",
      "site.backups.prune",
      "site.backups.restore",
      "site.backups.download",
    ]);

    const [siteRow] = await dbClient.db.select().from(sites).where(eq(sites.id, siteA1Id)).limit(1);
    const service = app.nestApp.get(SiteBackupsService);
    const txRes = await dbClient.db.transaction((tx) =>
      SiteBackupsService.enqueueBackupTx(tx, siteRow!, { kind: "nightly" }),
    );
    expect(txRes.idempotentReplay).toBe(false);
    expect(txRes.backupId).toMatch(/^bkp_/);
    expect(txRes.operationId).toMatch(/^op_/);

    await app.outboxWorker.processPendingOnce();
    const [row] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, txRes.backupId));
    expect(row?.kind).toBe("nightly");
    expect(row?.status).toBe("succeeded");

    const fakeReq = {
      headers: { authorization: `Bearer ${adminToken}` },
      ip: "127.0.0.1",
    } as unknown as FastifyRequest;
    const authzService = app.nestApp.get(AuthzContextService);
    const adminAuth = await authzService.authenticateRequest(fakeReq);
    const accepted = await service.create(
      siteRow!,
      {
        auth: adminAuth,
        req: fakeReq,
        actionPrefix: "admin.site.backups",
      },
      randomUUID(),
    );
    expect(accepted.siteId).toBe(siteA1Id);
    const audits = await newAudits();
    expect(audits.map((a) => a.action)).toContain("admin.site.backups.create");
  });

  it("T4: customer POST 202 queues running backup, outbox completes immediately with 2 steps, and GET lists it cleanly", async () => {
    // Empty HTTP body (no Content-Type and no JSON body) must succeed.
    const postRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t4-empty" },
      rawBody: null,
    });
    expect(postRes.status).toBe(202);
    const accepted = SiteBackupAcceptedDtoSchema.parse(postRes.body.data);
    expect(accepted.siteId).toBe(siteA1Id);
    expect(postRes.body.links).toEqual({
      operation: `/v1/organizations/${orgAId}/operations/${accepted.operationId}`,
    });

    const duringRes = await call("GET", backupsUrl(orgAId, siteA1Id));
    expect(duringRes.status).toBe(200);
    const duringDto = SiteBackupsDtoSchema.parse(duringRes.body.data);
    expect(duringDto.available).toBe(true);
    expect(duringDto.configured).toBe(true);
    expect(duringDto.retentionDays).toBe(14);
    expect(duringDto.manualKept).toBe(MANUAL_BACKUPS_KEPT);
    expect(duringDto.runningOperationId).toBe(accepted.operationId);
    expect(duringDto.backups).toHaveLength(1);
    expect(duringDto.backups[0]).toMatchObject({
      id: accepted.backupId,
      kind: "manual",
      status: "running",
      finishedAt: null,
      sizeBytes: null,
      problem: null,
    });

    const t0 = Date.now();
    const outboxResult = await app.outboxWorker.processPendingOnce();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(outboxResult.succeeded).toBe(1);

    const afterRes = await call("GET", backupsUrl(orgAId, siteA1Id));
    expect(afterRes.status).toBe(200);
    expect(findForbiddenPublicDtoKeys(afterRes.body.data)).toEqual([]);
    const afterDto = SiteBackupsDtoSchema.parse(afterRes.body.data);
    expect(afterDto.runningOperationId).toBeNull();
    expect(afterDto.backups).toHaveLength(1);
    expect(afterDto.backups[0]).toMatchObject({
      id: accepted.backupId,
      kind: "manual",
      status: "succeeded",
      sizeBytes: 8192,
      problem: null,
    });
    expect(afterDto.backups[0]!.finishedAt).not.toBeNull();

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, accepted.operationId));
    expect(opRow?.status).toBe("succeeded");

    const stepRows = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, accepted.operationId));
    expect(stepRows).toHaveLength(2);
    expect(stepRows.map((s) => [s.key, s.status])).toEqual([
      ["backup", "succeeded"],
      ["retention", "succeeded"],
    ]);

    const audits = await newAudits();
    expect(audits.map((a) => a.action)).toContain("site.backups.create");

    // Empty `{}` JSON body is also accepted.
    const postJsonRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t4-json" },
      body: {},
    });
    expect(postJsonRes.status).toBe(202);
  });

  it("T5: scripted executor failures settle row with problem and fail op without changing site status", async () => {
    const startRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t5-keys" },
      body: {},
    });
    expect(startRes.status).toBe(202);
    const opId = startRes.body.data.operationId as string;

    executorScript.setStatusSequence(opId, [
      { jobId: opId, state: "failed", failure: "auth_failed", snapshot: null },
    ]);
    await app.outboxWorker.processPendingOnce();

    const [row] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opId));
    expect(row?.status).toBe("failed");
    expect(row?.problem).toBe("auth_failed");

    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
    expect(op?.status).toBe("failed");

    const [siteRow] = await dbClient.db.select().from(sites).where(eq(sites.id, siteA1Id));
    expect(siteRow?.status).toBe("ready");

    // Catch-all executor throw settles row with problem 'other' (R55) and never degrades site.
    const throwRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t5-throw" },
      body: {},
    });
    expect(throwRes.status).toBe(202);
    const opIdThrow = throwRes.body.data.operationId as string;

    executorScript.setHandlers({
      onStart: () => {
        throw new Error("unexpected executor error");
      },
    });
    await app.outboxWorker.processPendingOnce();

    const [rowThrow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opIdThrow));
    expect(rowThrow?.status).toBe("failed");
    expect(rowThrow?.problem).toBe("other");
    expect(BACKUP_FAILURE_CLASSES).toContain("other");

    const [siteAfterThrow] = await dbClient.db.select().from(sites).where(eq(sites.id, siteA1Id));
    expect(siteAfterThrow?.status).toBe("ready");

    // Missing target answers 400 VALIDATION_ERROR not_configured.
    await deleteBackupSettings(dbClient.db);
    const unconfiguredRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t5-unconfigured" },
      body: {},
    });
    expect(unconfiguredRes.status).toBe(400);
    expect(unconfiguredRes.body.error.code).toBe("VALIDATION_ERROR");
    expect(unconfiguredRes.body.error.message).toBe("not_configured");
  });

  it("T6: rejects contention, non-ready sites, missing idempotency key, bad body, and replays idempotently", async () => {
    const missingKey = await call("POST", backupsUrl(orgAId, siteA1Id), { body: {} });
    expect(missingKey.status).toBe(400);

    const badBody = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-bad-body" },
      body: { extra: true },
    });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.code).toBe("VALIDATION_ERROR");

    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteA1Id));
    const deployingRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-deploying" },
      body: {},
    });
    expect(deployingRes.status).toBe(409);
    expect(deployingRes.body.error.code).toBe("RESOURCE_LOCKED");
    expect(deployingRes.body.error.message).toBe("not_ready");

    await dbClient.db.update(sites).set({ status: "maintenance" }).where(eq(sites.id, siteA1Id));
    const maintRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-maint" },
      body: {},
    });
    expect(maintRes.status).toBe(409);
    expect(maintRes.body.error.code).toBe("RESOURCE_LOCKED");
    expect(maintRes.body.error.message).toBe("not_ready");

    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));

    const idemKey = "k-t6-replay";
    const first = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": idemKey },
      body: {},
    });
    expect(first.status).toBe(202);

    const secondDifferentKey = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t6-concurrent" },
      body: {},
    });
    expect(secondDifferentKey.status).toBe(409);
    expect(secondDifferentKey.body.error.code).toBe("RESOURCE_LOCKED");

    const replayRunning = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": idemKey },
      body: {},
    });
    expect(replayRunning.status).toBe(202);
    expect(replayRunning.body.data).toEqual(first.body.data);

    const wrongTargetReplay = await call("POST", backupsUrl(orgAId, siteA2Id), {
      headers: { "Idempotency-Key": idemKey },
      body: {},
    });
    expect(wrongTargetReplay.status).toBe(409);

    await app.outboxWorker.processPendingOnce();
    const replayDone = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": idemKey },
      body: {},
    });
    expect(replayDone.status).toBe(202);
    expect(replayDone.body.data).toEqual(first.body.data);

    const audits = (await newAudits()).filter((a) => a.action === "site.backups.create");
    expect(audits).toHaveLength(1);
  });

  it("T7: stores only { siteId } in outbox payload and keeps sentinel secret and snapshotId out of DB, DTOs, and logs", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }

    const postRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t7-secret" },
      body: {},
    });
    expect(postRes.status).toBe(202);
    const opId = postRes.body.data.operationId as string;

    const [outboxRow] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${opId}`);
    expect(outboxRow?.payload).toEqual({
      operationId: opId,
      organizationId: orgAId,
      kind: "site.backups.create",
      resourceType: "site",
      resourceId: siteA1Id,
      siteId: siteA1Id,
    });

    await app.outboxWorker.processPendingOnce();

    // Decrypted secret only went into the executor IPC start request.
    const startCall = executorScript.calls.find((c) => c.action === "start");
    expect(startCall).toBeDefined();
    if (startCall?.action === "start") {
      expect(startCall.target.secretAccessKey).toBe(CANARY_SECRET);
    }

    const getRes = await call("GET", backupsUrl(orgAId, siteA1Id));
    expect(getRes.status).toBe(200);
    for (const text of [postRes.raw, getRes.raw]) {
      expect(text).not.toContain(CANARY_SECRET);
      expect(text).not.toContain(SNAP_HEX_OK);
    }

    // Scan every public table in Postgres for the plaintext sentinel secret.
    const tableList = await dbClient.db.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    for (const entry of tableList.rows) {
      const tableName = String(entry["table_name"]);
      if (!/^[a-z0-9_]+$/i.test(tableName)) {
        continue;
      }
      const rowsResult = await dbClient.db.execute(
        sql.raw(`SELECT * FROM "${tableName}"`),
      );
      expect(
        JSON.stringify(rowsResult.rows),
        `table ${tableName} leaked sentinel secret`,
      ).not.toContain(CANARY_SECRET);
    }

    const stepsDump = JSON.stringify(
      await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId)),
    );
    const auditsDump = JSON.stringify(await newAudits());
    expect(stepsDump).not.toContain(SNAP_HEX_OK);
    expect(auditsDump).not.toContain(SNAP_HEX_OK);
    expect(JSON.stringify(outboxRow)).not.toContain(SNAP_HEX_OK);

    const renderedLogs = logs.map((args) => args.map(String).join(" ")).join("\n");
    expect(renderedLogs).not.toContain(CANARY_SECRET);
    expect(renderedLogs).not.toContain(SNAP_HEX_OK);
  });

  it("T8: enforces auth, cross-tenant 404, collaborator 403, and suspended org 403", async () => {
    const unauthGet = await httpRequest(app.baseUrl!, "GET", backupsUrl(orgAId, siteA1Id));
    expect(unauthGet.status).toBe(401);

    const foreignGet = await call("GET", backupsUrl(orgAId, siteA1Id), { token: ownerBToken });
    expect(foreignGet.status).toBe(404);
    const foreignPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      token: ownerBToken,
      headers: { "Idempotency-Key": "k-t8-foreign" },
      body: {},
    });
    expect(foreignPost.status).toBe(404);

    const collabGet = await call("GET", backupsUrl(orgAId, siteA1Id), { token: collabToken });
    expect(collabGet.status).toBe(403);
    const collabPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      token: collabToken,
      headers: { "Idempotency-Key": "k-t8-collab" },
      body: {},
    });
    expect(collabPost.status).toBe(403);

    await dbClient.db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, orgAId));

    const suspendedGet = await call("GET", backupsUrl(orgAId, siteA1Id));
    expect(suspendedGet.status).toBe(403);
    const suspendedPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t8-suspended" },
      body: {},
    });
    expect(suspendedPost.status).toBe(403);
  });

  it("T9: returns available:false on GET and 422 NOT_SUPPORTED on POST when runtimeBackend is disabled", async () => {
    const disabledDb = createDatabaseClient({ mode: "pglite" });
    await disabledDb.migrate();
    await setupInstallation(disabledDb.db, SETUP);
    const disabledAdmin = await createServerAdmin(disabledDb.db, KEY, {
      email: "admin-disabled@x.it",
      name: "Admin",
      password: PW,
    });
    const jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    const disabledApp = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: disabledDb,
      secretsMasterKey: KEY,
      jwtSigningKeyPem,
      runtimeBackend: "disabled",
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    try {
      const tokenAdmin = await login(
        disabledApp.baseUrl!,
        "admin-disabled@x.it",
        PW,
        disabledAdmin.totpSecretBase32,
      );
      const cust = await httpRequest(disabledApp.baseUrl!, "POST", "/v1/admin/customer-account", {
        token: tokenAdmin,
        body: {
          organizationName: "Disabled Org",
          ownerEmail: "owner-disabled@hotel.it",
          ownerName: "Owner",
        },
      });
      expect(cust.status).toBe(201);
      const disabledOrgId = cust.body.data.organizationId as string;
      const disabledOwnerToken = await login(
        disabledApp.baseUrl!,
        "owner-disabled@hotel.it",
        cust.body.data.temporaryPassword as string,
      );
      const [alloc] = await disabledDb.db
        .select({ id: hostAllocations.id })
        .from(hostAllocations)
        .where(eq(hostAllocations.organizationId, disabledOrgId))
        .limit(1);
      const siteId = `sit_${randomUUID()}`;
      await disabledDb.db.insert(sites).values({
        id: siteId,
        organizationId: disabledOrgId,
        hostAllocationId: alloc!.id,
        name: "Disabled Site",
        slug: "disabled-site",
        status: "ready",
      });

      const getRes = await httpRequest(disabledApp.baseUrl!, "GET", backupsUrl(disabledOrgId, siteId), {
        token: disabledOwnerToken,
      });
      expect(getRes.status).toBe(200);
      const dto = SiteBackupsDtoSchema.parse(getRes.body.data);
      expect(dto.available).toBe(false);
      expect(dto.backups).toEqual([]);
      expect(dto.runningOperationId).toBeNull();

      const postRes = await httpRequest(disabledApp.baseUrl!, "POST", backupsUrl(disabledOrgId, siteId), {
        token: disabledOwnerToken,
        headers: { "Idempotency-Key": "k-t9-disabled" },
        body: {},
      });
      expect(postRes.status).toBe(422);
      expect(postRes.body.error.code).toBe("NOT_SUPPORTED");
    } finally {
      await disabledApp.close();
      await disabledDb.close();
    }
  });

  it("T11: recovers unknown backup ops from executor status without replaying start or degrading the site", async () => {
    const createUnknownOp = async () => {
      const { operation, steps } = await dbClient.db.transaction(async (tx) => {
        const res = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
          organizationId: orgAId,
          kind: "site.backups.create",
          resourceType: "site",
          resourceId: siteA1Id,
          requestedByUserId: ownerAUserId,
          lockKey: `site:${siteA1Id}`,
          leaseDurationMs: BACKUP_LEASE_MS,
          steps: SITE_BACKUP_STEPS,
          outboxPayload: { siteId: siteA1Id },
        });
        await insertSiteBackup(tx, {
          siteId: siteA1Id,
          kind: "manual",
          status: "running",
          operationId: res.operation.id,
        });
        return res;
      });
      await dbClient.db
        .update(operations)
        .set({
          status: "processing",
          leaseExpiresAt: new Date(Date.now() - 10_000),
        })
        .where(eq(operations.id, operation.id));
      await dbClient.db
        .update(operationSteps)
        .set({ status: "running" })
        .where(eq(operationSteps.id, steps[0]!.id));
      return operation.id;
    };

    // 1. Running on executor -> op stays unknown; 2. Executor throws -> op stays unknown; 3. Unknown -> failed/interrupted.
    const opA = await createUnknownOp();
    executorScript.setStatusSequence(opA, [
      { jobId: opA, state: "running", failure: null, snapshot: null },
    ]);
    await app.outboxWorker.recoverUnknownOperations();
    let [opRowA] = await dbClient.db.select().from(operations).where(eq(operations.id, opA));
    expect(opRowA?.status).toBe("unknown");

    executorScript.setStatusSequence(opA, [new Error("executor down")]);
    await app.outboxWorker.recoverUnknownOperations();
    [opRowA] = await dbClient.db.select().from(operations).where(eq(operations.id, opA));
    expect(opRowA?.status).toBe("unknown");

    executorScript.setStatusSequence(opA, [
      { jobId: opA, state: "unknown", failure: null, snapshot: null },
    ]);
    const recUnknown = await app.outboxWorker.recoverUnknownOperations();
    expect(recUnknown.convergedFailed).toBe(1);
    [opRowA] = await dbClient.db.select().from(operations).where(eq(operations.id, opA));
    expect(opRowA?.status).toBe("failed");
    const [bakRowA] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opA));
    expect(bakRowA?.status).toBe("failed");
    expect(bakRowA?.problem).toBe("interrupted");
    expect(executorScript.calls.filter((c) => c.action === "start")).toEqual([]);
    const [siteAfterA] = await dbClient.db.select().from(sites).where(eq(sites.id, siteA1Id));
    expect(siteAfterA?.status).toBe("ready");

    // 4. Executor succeeded during crash -> settles row + op succeeded, zero start replays.
    const opB = await createUnknownOp();
    executorScript.setStatusSequence(opB, [
      {
        jobId: opB,
        state: "succeeded",
        failure: null,
        snapshot: {
          snapshotId: SNAP_HEX_OK,
          bytesAdded: 512,
          totalBytes: 4096,
          fileCount: 10,
          durationMs: 90,
        },
      },
    ]);
    const recOk = await app.outboxWorker.recoverUnknownOperations();
    expect(recOk.convergedSucceeded).toBe(1);
    const [opRowB] = await dbClient.db.select().from(operations).where(eq(operations.id, opB));
    expect(opRowB?.status).toBe("succeeded");
    const [bakRowB] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opB));
    expect(bakRowB?.status).toBe("succeeded");
    expect(bakRowB?.snapshotId).toBe(SNAP_HEX_OK);
    expect(bakRowB?.sizeBytes).toBe(4096);

    // 5. Executor failed with no_space -> settles failed with no_space, site ready.
    const opC = await createUnknownOp();
    executorScript.setStatusSequence(opC, [
      { jobId: opC, state: "failed", failure: "no_space", snapshot: null },
    ]);
    await app.outboxWorker.recoverUnknownOperations();
    const [opRowC] = await dbClient.db.select().from(operations).where(eq(operations.id, opC));
    expect(opRowC?.status).toBe("failed");
    const [bakRowC] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opC));
    expect(bakRowC?.status).toBe("failed");
    expect(bakRowC?.problem).toBe("no_space");

    // 6. Crash during retention step (backup already succeeded) -> settles op succeeded.
    const opD = await createUnknownOp();
    await dbClient.db
      .update(operationSteps)
      .set({ status: "succeeded", message: "Backup uploaded" })
      .where(and(eq(operationSteps.operationId, opD), eq(operationSteps.key, "backup")));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "running" })
      .where(and(eq(operationSteps.operationId, opD), eq(operationSteps.key, "retention")));
    await settleSiteBackup(dbClient.db, opD, {
      status: "succeeded",
      snapshotId: SNAP_HEX_OK,
      sizeBytes: 2048,
      problem: null,
    });
    const recRet = await app.outboxWorker.recoverUnknownOperations();
    expect(recRet.convergedSucceeded).toBe(1);
    const [opRowD] = await dbClient.db.select().from(operations).where(eq(operations.id, opD));
    expect(opRowD?.status).toBe("succeeded");

    const [siteFinal] = await dbClient.db.select().from(sites).where(eq(sites.id, siteA1Id));
    expect(siteFinal?.status).toBe("ready");
  });

  it("T13 & prune: ignores forget failures (keeps rows and succeeds op) and runs site.backups.prune for deleted sites", async () => {
    const oldDate = new Date(Date.now() - 20 * 86_400_000);
    const newerDate = new Date(Date.now() - 1 * 86_400_000);
    const { id: oldId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "nightly",
      status: "running",
      operationId: `op_${randomUUID().replaceAll("-", "")}`,
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OLD, sizeBytes: 1000, finishedAt: oldDate })
      .where(eq(siteBackups.id, oldId));

    const { id: newerId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "nightly",
      status: "running",
      operationId: `op_${randomUUID().replaceAll("-", "")}`,
      startedAt: newerDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OK, sizeBytes: 2000, finishedAt: newerDate })
      .where(eq(siteBackups.id, newerId));

    executorScript.setHandlers({
      onForget: () => {
        throw new Error("s3 temporarily unavailable");
      },
    });
    const postRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t13-forget-fail" },
      body: {},
    });
    expect(postRes.status).toBe(202);
    const opId = postRes.body.data.operationId as string;
    await app.outboxWorker.processPendingOnce();

    const [opRow] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
    expect(opRow?.status).toBe("succeeded");
    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, opId));
    expect(steps.find((s) => s.key === "retention")).toMatchObject({
      status: "succeeded",
      message: "Will retry next night",
    });
    const remaining = await dbClient.db
      .select()
      .from(siteBackups)
      .where(and(eq(siteBackups.siteId, siteA1Id), eq(siteBackups.id, oldId)));
    expect(remaining).toHaveLength(1);

    // Next phase queues site.backups.prune for deleted sites: enqueue manually and prove prune removes orphan rows.
    const orphanSiteId = `sit_${randomUUID()}`;
    const { id: orphanBackupId } = await insertSiteBackup(dbClient.db, {
      siteId: orphanSiteId,
      kind: "nightly",
      status: "running",
      operationId: null,
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OLD, sizeBytes: 1200, finishedAt: oldDate })
      .where(eq(siteBackups.id, orphanBackupId));

    await dbClient.db
      .insert(organizations)
      .values({
        id: PLATFORM_OPS_ORG_ID,
        platformInstallationId: instId,
        name: "Platform Operations",
        slug: "platform-operations",
      })
      .onConflictDoNothing();

    executorScript.reset();
    const { operation: pruneOp } = await dbClient.db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: "site.backups.prune",
        resourceType: "site",
        resourceId: orphanSiteId,
        lockKey: `site:${orphanSiteId}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_PRUNE_STEPS,
        outboxPayload: { siteId: orphanSiteId },
      }),
    );

    await app.outboxWorker.processPendingOnce();
    const [pruneOpRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, pruneOp.id));
    expect(pruneOpRow?.status).toBe("succeeded");

    const forgetCall = executorScript.calls.find(
      (c) => c.action === "forget" && c.jobId === `${pruneOp.id}-forget`,
    );
    expect(forgetCall).toBeDefined();
    if (forgetCall?.action === "forget") {
      expect(forgetCall.snapshotIds).toEqual([SNAP_HEX_OLD]);
    }
    const orphanAfter = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.siteId, orphanSiteId));
    expect(orphanAfter).toEqual([]);

    // Normal site.backups.create forgets expired site rows, drops old failed rows, and leaves other sites alone.
    const { id: oldFailedId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "timeout",
      startedAt: oldDate,
    });
    const { id: siteA2OldId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA2Id,
      kind: "nightly",
      status: "running",
      operationId: null,
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OLD, sizeBytes: 1111, finishedAt: oldDate })
      .where(eq(siteBackups.id, siteA2OldId));

    const postCleanup = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-t13-cleanup-ok" },
      body: {},
    });
    expect(postCleanup.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const siteA1RemainingIds = (
      await dbClient.db.select().from(siteBackups).where(eq(siteBackups.siteId, siteA1Id))
    ).map((r) => r.id);
    expect(siteA1RemainingIds).not.toContain(oldId);
    expect(siteA1RemainingIds).not.toContain(oldFailedId);
    expect(siteA1RemainingIds).toContain(newerId);
    expect(siteA1RemainingIds).toContain(postCleanup.body.data.backupId as string);

    const siteA2RemainingIds = (
      await dbClient.db.select().from(siteBackups).where(eq(siteBackups.siteId, siteA2Id))
    ).map((r) => r.id);
    expect(siteA2RemainingIds).toContain(siteA2OldId);
  });

  it("renews operation lease across multiple poll rounds while running beyond one lease duration, then settles", async () => {
    applier.leaseMs = 180;
    applier.pollMs = 35;

    let running = true;
    let pollCount = 0;
    executorScript.setHandlers({
      onStatus: (req) => {
        pollCount += 1;
        if (running) {
          return { jobId: req.jobId, state: "running", failure: null, snapshot: null };
        }
        return {
          jobId: req.jobId,
          state: "succeeded",
          failure: null,
          snapshot: {
            snapshotId: SNAP_HEX_OK,
            bytesAdded: 256,
            totalBytes: 2048,
            fileCount: 5,
            durationMs: 300,
          },
        };
      },
    });

    const postRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-lease-renewal" },
      body: {},
    });
    expect(postRes.status).toBe(202);
    const { backupId, operationId } = postRes.body.data as {
      backupId: string;
      operationId: string;
    };

    const runPromise = app.outboxWorker.processPendingOnce();

    // Wait longer than a single 180ms lease before checking recovery.
    await new Promise((resolve) => setTimeout(resolve, 260));
    const midRecovery = await app.outboxWorker.recoverUnknownOperations();
    expect(midRecovery.markedUnknown).toBe(0);

    const [midOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(midOp?.status).toBe("processing");
    expect(midOp?.leaseExpiresAt).not.toBeNull();
    expect(pollCount).toBeGreaterThanOrEqual(3);

    running = false;
    await runPromise;

    const [finalOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [finalBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(finalOp?.status).toBe("succeeded");
    expect(finalBak?.status).toBe("succeeded");
    expect(finalBak?.sizeBytes).toBe(2048);

    // Transient status error followed by running then succeeded settles without ambiguity.
    let transientThrown = false;
    applier.pollMs = 20;
    applier.pollGiveUpMs = 500;
    executorScript.setHandlers({
      onStatus: (req) => {
        if (!transientThrown) {
          transientThrown = true;
          throw new Error("brief hiccup");
        }
        return {
          jobId: req.jobId,
          state: "succeeded",
          failure: null,
          snapshot: {
            snapshotId: SNAP_HEX_OK,
            bytesAdded: 64,
            totalBytes: 512,
            fileCount: 2,
            durationMs: 25,
          },
        };
      },
    });
    const transientPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-poll-transient" },
      body: {},
    });
    expect(transientPost.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const [transientOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, transientPost.body.data.operationId as string));
    expect(transientOp?.status).toBe("succeeded");

    // Continuous status errors past pollGiveUpMs move op to unknown without failing backup row.
    applier.pollMs = 20;
    applier.pollGiveUpMs = 50;
    const ambigPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-poll-ambiguous" },
      body: {},
    });
    expect(ambigPost.status).toBe(202);
    const { backupId: ambigBakId, operationId: ambigOpId } = ambigPost.body.data as {
      backupId: string;
      operationId: string;
    };
    executorScript.setStatusSequence(ambigOpId, [new Error("status network timeout")]);
    await app.outboxWorker.processPendingOnce();
    const [ambigOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, ambigOpId));
    const [ambigBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, ambigBakId));
    expect(ambigOp?.status).toBe("unknown");
    expect(ambigOp?.errorCode).toBe("OPERATION_AMBIGUOUS");
    expect(ambigBak?.status).toBe("running");
  });

  it("R68(a): recovers processing outbox events for still-queued operations only after lease expiry and frees site locks", async () => {
    const r1 = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r68-a1" },
      body: {},
    });
    const r2 = await call("POST", backupsUrl(orgAId, siteA2Id), {
      headers: { "Idempotency-Key": "k-r68-a2" },
      body: {},
    });
    const r3 = await httpRequest(app.baseUrl!, "POST", backupsUrl(orgBId, siteBId), {
      token: ownerBToken,
      headers: { "Idempotency-Key": "k-r68-b" },
      body: {},
    });
    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);

    const opIds = [
      r1.body.data.operationId as string,
      r2.body.data.operationId as string,
      r3.body.data.operationId as string,
    ];

    const claimed = await claimPendingOutboxEvents(dbClient.db, 10, undefined, {
      includeKinds: BACKUP_OPERATION_KINDS,
    });
    expect(claimed).toHaveLength(3);
    const eventIds = claimed.map((e) => e.id);

    const opsAfterClaim = await dbClient.db
      .select()
      .from(operations)
      .where(inArray(operations.id, opIds));
    expect(opsAfterClaim).toHaveLength(3);
    expect(opsAfterClaim.every((o) => o.status === "queued" && o.leaseExpiresAt !== null)).toBe(true);

    const leaseTimes = opsAfterClaim.map((o) => o.leaseExpiresAt!.getTime());
    const minLeaseMs = Math.min(...leaseTimes);
    const maxLeaseMs = Math.max(...leaseTimes);

    // Recovery before lease expiry leaves processing outbox events untouched.
    const earlyRec = await app.outboxWorker.recoverUnknownOperations(new Date(minLeaseMs - 5_000));
    expect(earlyRec).toEqual({ markedUnknown: 0, convergedSucceeded: 0, convergedFailed: 0 });
    const eventsBeforeExpiry = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(inArray(outboxEvents.id, eventIds));
    expect(eventsBeforeExpiry.every((e) => e.status === "processing" && e.lockedAt !== null)).toBe(true);

    // Recovery after lease expiry returns them to pending with cleared claim timestamp.
    const lateRec = await app.outboxWorker.recoverUnknownOperations(new Date(maxLeaseMs + 5_000));
    expect(lateRec).toEqual({ markedUnknown: 0, convergedSucceeded: 0, convergedFailed: 0 });
    const eventsAfterExpiry = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(inArray(outboxEvents.id, eventIds));
    expect(eventsAfterExpiry.every((e) => e.status === "pending" && e.lockedAt === null)).toBe(true);

    const opsBeforeProcess = await dbClient.db
      .select()
      .from(operations)
      .where(inArray(operations.id, opIds));
    expect(opsBeforeProcess.every((o) => o.status === "queued")).toBe(true);

    const processed = await app.outboxWorker.processPendingOnce();
    expect(processed.succeeded).toBe(3);

    const opsAfterProcess = await dbClient.db
      .select()
      .from(operations)
      .where(inArray(operations.id, opIds));
    expect(opsAfterProcess.every((o) => o.status === "succeeded")).toBe(true);

    const rowsAfterProcess = await dbClient.db
      .select()
      .from(siteBackups)
      .where(inArray(siteBackups.operationId, opIds));
    expect(rowsAfterProcess).toHaveLength(3);
    expect(rowsAfterProcess.every((row) => row.status === "succeeded")).toBe(true);

    // Site locks are released so new backups are accepted on all three sites.
    const next1 = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r68-next-a1" },
      body: {},
    });
    const next2 = await call("POST", backupsUrl(orgAId, siteA2Id), {
      headers: { "Idempotency-Key": "k-r68-next-a2" },
      body: {},
    });
    const next3 = await httpRequest(app.baseUrl!, "POST", backupsUrl(orgBId, siteBId), {
      token: ownerBToken,
      headers: { "Idempotency-Key": "k-r68-next-b" },
      body: {},
    });
    expect([next1.status, next2.status, next3.status]).toEqual([202, 202, 202]);
  });

  it("R68(b): does not reset processing outbox events when operation already left queued, and resets null lease on queued ops", async () => {
    const rDone = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r68-b-done" },
      body: {},
    });
    const rActive = await call("POST", backupsUrl(orgAId, siteA2Id), {
      headers: { "Idempotency-Key": "k-r68-b-active" },
      body: {},
    });
    const rNullLease = await httpRequest(app.baseUrl!, "POST", backupsUrl(orgBId, siteBId), {
      token: ownerBToken,
      headers: { "Idempotency-Key": "k-r68-b-null" },
      body: {},
    });
    expect([rDone.status, rActive.status, rNullLease.status]).toEqual([202, 202, 202]);

    const opDoneId = rDone.body.data.operationId as string;
    const opActiveId = rActive.body.data.operationId as string;
    const opNullLeaseId = rNullLease.body.data.operationId as string;

    const claimed = await claimPendingOutboxEvents(dbClient.db, 10, undefined, {
      includeKinds: BACKUP_OPERATION_KINDS,
    });
    expect(claimed).toHaveLength(3);

    const eventByOpId = new Map(
      claimed.map((e) => [String((e.payload as Record<string, unknown>)["operationId"]), e.id]),
    );

    await dbClient.db
      .update(operations)
      .set({ status: "succeeded", leaseExpiresAt: null, completedAt: new Date() })
      .where(eq(operations.id, opDoneId));
    await dbClient.db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() + 120_000) })
      .where(eq(operations.id, opActiveId));
    await dbClient.db
      .update(operations)
      .set({ leaseExpiresAt: null })
      .where(eq(operations.id, opNullLeaseId));

    await app.outboxWorker.recoverUnknownOperations(new Date(Date.now() + 65_000));

    const [evtDone] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventByOpId.get(opDoneId)!));
    const [evtActive] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventByOpId.get(opActiveId)!));
    const [evtNullLease] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventByOpId.get(opNullLeaseId)!));

    expect(evtDone?.status).toBe("processing");
    expect(evtDone?.lockedAt).not.toBeNull();
    expect(evtActive?.status).toBe("processing");
    expect(evtActive?.lockedAt).not.toBeNull();
    expect(evtNullLease?.status).toBe("pending");
    expect(evtNullLease?.lockedAt).toBeNull();
  });

  it("R70(1): fails queued create backup without calling executor after target change, and prune ends without calling executor when no row remains", async () => {
    const queuedRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r70-target-change" },
      body: {},
    });
    expect(queuedRes.status).toBe(202);
    const opId = queuedRes.body.data.operationId as string;

    // Also queue an orphan prune operation whose backup row will be cleared by the target change.
    const orphanSiteId = `sit_${randomUUID()}`;
    const oldDate = new Date(Date.now() - 20 * 86_400_000);
    const { id: orphanRowId } = await insertSiteBackup(dbClient.db, {
      siteId: orphanSiteId,
      kind: "nightly",
      status: "running",
      operationId: null,
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OLD, sizeBytes: 500, finishedAt: oldDate })
      .where(eq(siteBackups.id, orphanRowId));

    await dbClient.db
      .insert(organizations)
      .values({
        id: PLATFORM_OPS_ORG_ID,
        platformInstallationId: instId,
        name: "Platform Operations",
        slug: "platform-operations",
      })
      .onConflictDoNothing();

    const { operation: pruneOp } = await dbClient.db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: "site.backups.prune",
        resourceType: "site",
        resourceId: orphanSiteId,
        lockKey: `site:${orphanSiteId}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_PRUNE_STEPS,
        outboxPayload: { siteId: orphanSiteId },
      }),
    );

    const settingsService = app.nestApp.get(BackupSettingsService);
    await settingsService.save({ ...SETTINGS, bucket: "hotel-backups-v2" }, adminUserId);
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);

    await app.outboxWorker.processPendingOnce();

    expect(executorScript.calls.filter((c) => c.action === "start")).toEqual([]);
    expect(executorScript.calls.filter((c) => c.action === "forget")).toEqual([]);

    const [createOp] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
    expect(createOp?.status).toBe("failed");
    expect(createOp?.errorCode).toBe("OPERATION_INTERRUPTED");
    expect(createOp?.errorMessage).toBe(SITE_BACKUPS_INTERRUPTED);

    const createSteps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, opId));
    expect(createSteps.find((s) => s.key === "backup")?.status).toBe("failed");
    expect(createSteps.find((s) => s.key === "retention")?.status).toBe("skipped");

    const [pruneOpRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, pruneOp.id));
    expect(pruneOpRow?.status).toBe("succeeded");
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);

    const afterNext = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r70-target-change-next" },
      body: {},
    });
    expect(afterNext.status).toBe(202);
  });

  it("R70(2): stores executor RESOURCE_LOCKED on start as site_busy without leaking executor message", async () => {
    executorScript.setHandlers({
      onStart: () => {
        throw Object.assign(new Error("another backup running for site on /var/lib/secret"), {
          code: "RESOURCE_LOCKED",
        });
      },
    });

    const postRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r70-locked" },
      body: {},
    });
    expect(postRes.status).toBe(202);
    const { backupId, operationId } = postRes.body.data as {
      backupId: string;
      operationId: string;
    };

    await app.outboxWorker.processPendingOnce();

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.status).toBe("failed");
    expect(bakRow?.problem).toBe("site_busy");

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(opRow?.status).toBe("failed");
    expect(opRow?.errorCode).toBe("RESOURCE_LOCKED");
    expect(opRow?.errorMessage).not.toContain("/var/lib/secret");
  });

  it("R70(3): maps unrecognized failure strings in recover() to 'other' without leaking executor text", async () => {
    const rawExecutorText = "invented_recover_token /etc/hosting-panel/backup.key";
    const { operation } = await dbClient.db.transaction(async (tx) => {
      const res = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgAId,
        kind: "site.backups.create",
        resourceType: "site",
        resourceId: siteA1Id,
        requestedByUserId: ownerAUserId,
        lockKey: `site:${siteA1Id}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_STEPS,
        outboxPayload: { siteId: siteA1Id },
      });
      await insertSiteBackup(tx, {
        siteId: siteA1Id,
        kind: "manual",
        status: "running",
        operationId: res.operation.id,
      });
      return res;
    });

    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, operation.id));

    executorScript.setStatusSequence(operation.id, [
      {
        jobId: operation.id,
        state: "failed",
        failure: rawExecutorText as unknown as (typeof BACKUP_FAILURE_CLASSES)[number],
        snapshot: null,
      },
    ]);

    const rec = await app.outboxWorker.recoverUnknownOperations();
    expect(rec.convergedFailed).toBe(1);

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.operationId, operation.id));
    expect(bakRow?.status).toBe("failed");
    expect(bakRow?.problem).toBe("other");

    const listRes = await call("GET", backupsUrl(orgAId, siteA1Id));
    expect(listRes.status).toBe(200);
    expect(listRes.raw).not.toContain(rawExecutorText);
  });

  it("R70(4): rolls back queued backup, operation, steps, and outbox if manual audit insert fails", async () => {
    await dbClient.db.execute(sql`
      CREATE OR REPLACE FUNCTION test_fail_manual_backup_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'site.backups.create' THEN
          RAISE EXCEPTION 'simulated audit insert failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbClient.db.execute(sql`
      CREATE TRIGGER trg_fail_manual_backup_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      EXECUTE FUNCTION test_fail_manual_backup_audit();
    `);

    try {
      const failedPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
        headers: { "Idempotency-Key": "k-r70-audit-fail" },
        body: {},
      });
      expect(failedPost.status).toBe(500);

      expect(await dbClient.db.select().from(siteBackups)).toEqual([]);
      expect(await dbClient.db.select().from(operations)).toEqual([]);
      expect(await dbClient.db.select().from(operationSteps)).toEqual([]);
      expect(await dbClient.db.select().from(outboxEvents)).toEqual([]);
      expect((await newAudits()).filter((a) => a.action === "site.backups.create")).toEqual([]);
    } finally {
      await dbClient.db.execute(sql`
        DROP TRIGGER IF EXISTS trg_fail_manual_backup_audit ON audit_events;
      `);
      await dbClient.db.execute(sql`
        DROP FUNCTION IF EXISTS test_fail_manual_backup_audit();
      `);
    }

    // Retrying with the same key after transient audit failure now queues cleanly.
    const retryPost = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r70-audit-fail" },
      body: {},
    });
    expect(retryPost.status).toBe(202);
    expect(await dbClient.db.select().from(siteBackups)).toHaveLength(1);
    expect((await newAudits()).filter((a) => a.action === "site.backups.create")).toHaveLength(1);
  });

  it("R75: aborts before calling executor start if target changes between first row check and start", async () => {
    const queuedRes = await call("POST", backupsUrl(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": "k-r75-mid-flight-target-change" },
      body: {},
    });
    expect(queuedRes.status).toBe(202);
    const opId = queuedRes.body.data.operationId as string;

    const settingsService = app.nestApp.get(BackupSettingsService);
    beforeResolveSiteFilesServiceId = async () => {
      await settingsService.save({ ...SETTINGS, bucket: "hotel-backups-v3" }, adminUserId);
    };

    try {
      await app.outboxWorker.processPendingOnce();
    } finally {
      beforeResolveSiteFilesServiceId = null;
    }

    expect(executorScript.calls.filter((c) => c.action === "start")).toEqual([]);
    expect(executorScript.calls.filter((c) => c.action === "forget")).toEqual([]);

    const [opRow] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
    expect(opRow?.status).toBe("failed");
    expect(opRow?.errorCode).toBe("OPERATION_INTERRUPTED");
    expect(opRow?.errorMessage).toBe(SITE_BACKUPS_INTERRUPTED);

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, opId));
    expect(steps.find((s) => s.key === "backup")?.status).toBe("failed");
    expect(steps.find((s) => s.key === "retention")?.status).toBe("skipped");
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);
  });

  it("M3b assertHeavyActionAllowed: exempts admins and refuses a customer's seventh action inside 60 minutes with QUOTA_EXCEEDED and retryAt", async () => {
    const authzService = app.nestApp.get(AuthzContextService);
    const fakeAdminReq = {
      headers: { authorization: `Bearer ${adminToken}` },
      ip: "127.0.0.1",
    } as unknown as FastifyRequest;
    const fakeOwnerReq = {
      headers: { authorization: `Bearer ${ownerAToken}` },
      ip: "127.0.0.1",
    } as unknown as FastifyRequest;
    const adminAuth = await authzService.authenticateRequest(fakeAdminReq);
    const ownerAuth = await authzService.authenticateRequest(fakeOwnerReq);

    const t0 = new Date("2026-11-15T12:00:00.000Z");
    const min = 60_000;
    const kinds = [
      "site.backups.create",
      "site.backups.restore",
      "site.backups.download",
      "site.backups.create",
      "site.backups.restore",
      "site.backups.download",
    ] as const;

    // Seed 5 customer actions first: 6th action must be allowed.
    for (let i = 0; i < 5; i++) {
      await dbClient.db.insert(operations).values({
        id: `op_heavy_${i}_${randomUUID().slice(0, 8)}`,
        organizationId: orgAId,
        requestedByUserId: ownerAUserId,
        kind: kinds[i]!,
        status: "succeeded",
        resourceType: "site",
        resourceId: siteA1Id,
        submittedAt: new Date(t0.getTime() - (50 - i * 10) * min),
      });
    }

    const sixthOpId = `op_heavy_6_${randomUUID().slice(0, 8)}`;
    await dbClient.db.insert(operations).values({
      id: sixthOpId,
      organizationId: orgAId,
      requestedByUserId: ownerAUserId,
      kind: kinds[5]!,
      status: "queued",
      resourceType: "site",
      resourceId: siteA1Id,
      submittedAt: new Date(t0.getTime() - 5 * min),
    });

    await expect(
      assertHeavyActionAllowed(
        dbClient.db,
        siteA1Id,
        { auth: ownerAuth, req: fakeOwnerReq },
        { id: sixthOpId, submittedAt: new Date(t0.getTime() - 5 * min) },
      ),
    ).resolves.toBeUndefined();

    // 7th action at t0 (6 earlier actions at -50, -40, -30, -20, -10, -5 min) is refused.
    const seventhOpId = `op_heavy_7_${randomUUID().slice(0, 8)}`;
    await dbClient.db.insert(operations).values({
      id: seventhOpId,
      organizationId: orgAId,
      requestedByUserId: ownerAUserId,
      kind: "site.backups.restore",
      status: "queued",
      resourceType: "site",
      resourceId: siteA1Id,
      submittedAt: t0,
    });

    // Administrator bypasses the heavy-action limit completely.
    await expect(
      assertHeavyActionAllowed(
        dbClient.db,
        siteA1Id,
        { auth: adminAuth, req: fakeAdminReq, actionPrefix: "admin.site.backups" },
        { id: seventhOpId, submittedAt: t0 },
      ),
    ).resolves.toBeUndefined();

    const expectedRetryAt = new Date(t0.getTime() - 50 * min + 60 * 60_000);
    let caught: unknown;
    try {
      await assertHeavyActionAllowed(
        dbClient.db,
        siteA1Id,
        { auth: ownerAuth, req: fakeOwnerReq },
        { id: seventhOpId, submittedAt: t0 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ControlPlaneError);
    const err = caught as ControlPlaneError;
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.message).toContain(expectedRetryAt.toISOString());
    expect(err.details).toEqual([
      {
        field: "retryAt",
        reason: "too_many_requests",
        message: expectedRetryAt.toISOString(),
      },
    ]);
    expect(err.retryAfterMs).toBe(10 * min);
  });
});
