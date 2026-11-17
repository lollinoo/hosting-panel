import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  BACKUP_FAILURE_CLASSES,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  insertSiteBackup,
  markSiteArchivePreparing,
  markSiteRestoreRunning,
  operationSteps,
  operations,
  outboxEvents,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import {
  BACKUP_LEASE_MS,
  BACKUP_POLL_GIVE_UP_MS,
  BACKUP_POLL_MS,
  SiteBackupsApplier,
} from "../src/backups/site-backups-applier.js";
import {
  SITE_BACKUP_PRUNE_STEPS,
  SITE_BACKUP_STEPS,
} from "../src/backups/site-backups.service.js";
import {
  SITE_ARCHIVE_STEPS,
  SITE_RESTORE_STEPS,
} from "../src/backups/site-restore-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { SITE_STEP_LEASE_MS } from "../src/runtime/site-provisioner.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

let beforeResolveSiteFilesServiceId: (() => Promise<void>) | null = null;
let onRenewOperationLease:
  | ((...args: Parameters<typeof import("@hosting-panel/database").renewOperationLease>) => Promise<void>)
  | null = null;

vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    renewOperationLease: async (
      ...args: Parameters<typeof actual.renewOperationLease>
    ) => {
      if (onRenewOperationLease) {
        await onRenewOperationLease(...args);
      }
      return actual.renewOperationLease(...args);
    },
  };
});

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
const SETUP = {
  installationName: "Test Restore Applier",
  hostHostname: "panel-restore.test",
  hostIpv4: "10.0.0.1",
};
const CANARY_SECRET = "canary-s3-secret-DO-NOT-LEAK-RESTORE-42";
const TARGET = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hotel-backups",
  prefix: "panel",
  accessKeyId: "AKIARESTORETEST1",
  secretAccessKey: CANARY_SECRET,
};
const SETTINGS = {
  ...TARGET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SITE_A1 = {
  name: "Hotel Roma",
  domain: "hotelroma-restore.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-restore.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface ScriptedBackupHandlers {
  onRestore?: (
    req: Extract<BackupsIpcRequest, { action: "restore" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onArchive?: (
    req: Extract<BackupsIpcRequest, { action: "archive" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onStatus?: (
    req: Extract<BackupsIpcRequest, { action: "status" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onSettle?: (
    req: Extract<BackupsIpcRequest, { action: "settle" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
  onDiscardArchive?: (
    req: Extract<BackupsIpcRequest, { action: "discardArchive" }>,
  ) => BackupsResultByAction["discardArchive"] | Promise<BackupsResultByAction["discardArchive"]>;
  onForget?: (
    req: Extract<BackupsIpcRequest, { action: "forget" }>,
  ) => BackupJobStatus | Promise<BackupJobStatus>;
}

type ScriptedStatusStep =
  | BackupJobStatus
  | Error
  | ((
      req: Extract<BackupsIpcRequest, { action: "status" | "settle" }>,
    ) => BackupJobStatus | Promise<BackupJobStatus>);

interface BackupExecutorScript {
  readonly calls: BackupsIpcRequest[];
  reset(): void;
  setStatusSequence(jobId: string, sequence: readonly ScriptedStatusStep[]): void;
  setHandlers(handlers: ScriptedBackupHandlers): void;
}

/** Records all backups() IPC calls and delegates to the real InMemoryDockerSimulatorAdapter unless scripted. */
function scriptBackupExecutor(sim: InMemoryDockerSimulatorAdapter): BackupExecutorScript {
  const realBackups = sim.backups.bind(sim);
  const calls: BackupsIpcRequest[] = [];
  const statusSequences = new Map<string, ScriptedStatusStep[]>();
  let handlers: ScriptedBackupHandlers = {};

  sim.backups = (async <R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> => {
    calls.push(req);
    switch (req.action) {
      case "restore":
        if (handlers.onRestore) {
          return (await handlers.onRestore(req)) as BackupsResultByAction[R["action"]];
        }
        return realBackups(req);
      case "archive":
        if (handlers.onArchive) {
          return (await handlers.onArchive(req)) as BackupsResultByAction[R["action"]];
        }
        return realBackups(req);
      case "forget":
        if (handlers.onForget) {
          return (await handlers.onForget(req)) as BackupsResultByAction[R["action"]];
        }
        return realBackups(req);
      case "discardArchive":
        if (handlers.onDiscardArchive) {
          return (await handlers.onDiscardArchive(req)) as BackupsResultByAction[R["action"]];
        }
        return realBackups(req);
      case "status":
      case "settle": {
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
        if (req.action === "settle" && handlers.onSettle) {
          return (await handlers.onSettle(req)) as BackupsResultByAction[R["action"]];
        }
        if (req.action === "status" && handlers.onStatus) {
          return (await handlers.onStatus(req)) as BackupsResultByAction[R["action"]];
        }
        return realBackups(req);
      }
      default:
        return realBackups(req);
    }
  }) as DockerExecutorPort["backups"];

  return {
    calls,
    reset() {
      calls.length = 0;
      statusSequences.clear();
      handlers = {};
    },
    setStatusSequence(jobId: string, sequence: readonly ScriptedStatusStep[]) {
      statusSequences.set(jobId, [...sequence]);
    },
    setHandlers(next: ScriptedBackupHandlers) {
      handlers = { ...next };
    },
  };
}

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

function newOpHex(): string {
  return `op_${randomUUID().replaceAll("-", "")}`;
}

describe("site restore and download applier (M3b)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorScript: BackupExecutorScript;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let adminUserId: string;
  let orgAId: string;
  let ownerAUserId: string;
  let siteA1Id: string;
  let siteA1ServiceId: string;
  let baselineAuditIds: Set<string>;

  async function snapshotAudits(): Promise<void> {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  /** Seeds a succeeded backup row (and registers a real snapshot in the simulator). */
  async function seedSucceededBackup(opts?: {
    siteUrl?: string | null;
    startedAt?: Date;
    kind?: "nightly" | "manual";
  }): Promise<{ backupId: string; snapshotId: string }> {
    const seedJobId = newOpHex();
    await sim.backupState.handle({
      action: "start",
      jobId: seedJobId,
      siteId: siteA1Id,
      serviceInstanceId: siteA1ServiceId,
      target: TARGET,
    });
    const status = await sim.backupState.handle({ action: "status", jobId: seedJobId });
    const snapshotId = status.snapshot!.snapshotId;
    const startedAt = opts?.startedAt ?? new Date(Date.now() - 60_000);
    const seedOpId = newOpHex();
    const { id: backupId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: opts?.kind ?? "manual",
      status: "running",
      operationId: seedOpId,
      siteUrl: opts?.siteUrl !== undefined ? opts.siteUrl : "http://hotelroma-restore.it",
      startedAt,
    });
    await dbClient.db
      .update(siteBackups)
      .set({
        status: "succeeded",
        snapshotId,
        sizeBytes: 4096,
        finishedAt: startedAt,
      })
      .where(eq(siteBackups.id, backupId));
    return { backupId, snapshotId };
  }

  /** Enqueues a site.backups.restore operation and marks the backup row running. */
  async function enqueueRestore(backupId: string): Promise<{ operationId: string }> {
    const { operation } = await dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgAId,
        kind: "site.backups.restore",
        resourceType: "site",
        resourceId: siteA1Id,
        requestedByUserId: ownerAUserId,
        lockKey: `site:${siteA1Id}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_RESTORE_STEPS,
        outboxPayload: { siteId: siteA1Id, backupId },
      });
      await markSiteRestoreRunning(tx, backupId, enqueued.operation.id);
      return enqueued;
    });
    return { operationId: operation.id };
  }

  /** Enqueues a site.backups.download operation and marks the backup row preparing. */
  async function enqueueDownload(backupId: string): Promise<{ operationId: string }> {
    const { operation } = await dbClient.db.transaction(async (tx) => {
      const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgAId,
        kind: "site.backups.download",
        resourceType: "site",
        resourceId: siteA1Id,
        requestedByUserId: ownerAUserId,
        lockKey: `site:${siteA1Id}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_ARCHIVE_STEPS,
        outboxPayload: { siteId: siteA1Id, backupId },
      });
      await markSiteArchivePreparing(tx, siteA1Id, backupId, enqueued.operation.id);
      return enqueued;
    });
    return { operationId: operation.id };
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-restore@x.it",
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
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    applier = app.nestApp.get(SiteBackupsApplier);

    const loginAdmin = await httpJson(app.baseUrl!, "POST", "/v1/auth/login", {
      body: {
        email: "admin-restore@x.it",
        password: PW,
        totpCode: totpCodeAt(admin.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    expect(loginAdmin.status).toBe(200);
    const adminToken = loginAdmin.body.data.accessToken as string;

    const createdOrg = await httpJson(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "Hotel Roma Restore Org",
        ownerEmail: "mario-restore@hotel.it",
        ownerName: "Mario",
      },
    });
    expect(createdOrg.status).toBe(201);
    orgAId = createdOrg.body.data.organizationId as string;

    const loginOwner = await httpJson(app.baseUrl!, "POST", "/v1/auth/login", {
      body: {
        email: "mario-restore@hotel.it",
        password: createdOrg.body.data.temporaryPassword as string,
      },
    });
    expect(loginOwner.status).toBe(200);
    const ownerToken = loginOwner.body.data.accessToken as string;

    const [ownerRow] = await dbClient.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "mario-restore@hotel.it"));
    ownerAUserId = ownerRow!.id;

    const createSite = await httpJson(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgAId}/managed-sites`,
      {
        token: ownerToken,
        body: SITE_A1,
        headers: { "Idempotency-Key": randomUUID() },
      },
    );
    expect(createSite.status).toBe(202);
    siteA1Id = createSite.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();
    expect(sim.deployedSpecs.length).toBeGreaterThan(0);
    siteA1ServiceId = sim.deployedSpecs[0]!.serviceInstanceId;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    beforeResolveSiteFilesServiceId = null;
    onRenewOperationLease = null;
    vi.restoreAllMocks();
    executorScript.reset();
    sim.backupState.holdJobs(false);
    sim.backupState.expireArchives();
    sim.jobs.length = 0;
    sim.onJob = undefined;
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;

    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db
      .update(sites)
      .set({
        status: "ready",
        siteUrl: "http://hotelroma-restore.it",
        phpVersion: "8.4",
      })
      .where(eq(sites.id, siteA1Id));
    await upsertBackupSettings(dbClient.db, KEY, {
      ...SETTINGS,
      updatedByUserId: adminUserId,
    });
    await snapshotAudits();
  });

  afterEach(() => {
    beforeResolveSiteFilesServiceId = null;
    onRenewOperationLease = null;
    sim.backupState.finishHeld();
    sim.backupState.expireArchives();
    sim.onJob = undefined;
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;
    vi.restoreAllMocks();
  });

  it("applies a restore that succeeds, runs wordpress.set-url with previous and current URLs, settles row/steps/op, and writes one system audit", async () => {
    const { backupId, snapshotId } = await seedSucceededBackup({
      siteUrl: "http://old.hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://hotelroma-restore.it" })
      .where(eq(sites.id, siteA1Id));

    const { operationId } = await enqueueRestore(backupId);
    const outboxRes = await app.outboxWorker.processPendingOnce();
    expect(outboxRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    // R78: jobId is op.id directly (no -restore suffix).
    const restoreCalls = executorScript.calls.filter((c) => c.action === "restore");
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toMatchObject({
      action: "restore",
      jobId: operationId,
      siteId: siteA1Id,
      serviceInstanceId: siteA1ServiceId,
      snapshotId,
    });

    const urlJobs = sim.jobs.filter((j) => j.kind === "wordpress.set-url");
    expect(urlJobs).toHaveLength(1);
    expect(urlJobs[0]).toMatchObject({
      jobId: `job_${operationId.replace(/^op_/, "")}_rurl`,
      kind: "wordpress.set-url",
      siteId: siteA1Id,
      organizationId: orgAId,
      serviceInstanceId: siteA1ServiceId,
      params: {
        phpVersion: "8.4",
        siteUrl: "https://hotelroma-restore.it",
        previousUrl: "http://old.hotelroma-restore.it",
      },
    });

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.restoreStatus).toBe("succeeded");
    expect(bakRow?.restoreProblem).toBeNull();
    expect(bakRow?.restoredAt).not.toBeNull();

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(opRow?.status).toBe("succeeded");
    expect(opRow?.errorCode).toBeNull();

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId));
    expect(steps.find((s) => s.key === "restore")?.status).toBe("succeeded");
    expect(steps.find((s) => s.key === "update_address")?.status).toBe("succeeded");

    const finishedAudits = (await newAudits()).filter(
      (a) => a.action === "site.backups.restore.finished",
    );
    expect(finishedAudits).toHaveLength(1);
    expect(finishedAudits[0]).toMatchObject({
      actorId: null,
      actorType: "system",
      organizationId: orgAId,
      targetType: "site",
      targetId: siteA1Id,
      details: {
        operationId,
        backupId,
        outcome: "succeeded",
        problem: null,
      },
    });

    // Equal addresses (previous === current) must still invoke wordpress.set-url.
    const { backupId: equalBackupId } = await seedSucceededBackup({
      siteUrl: "https://hotelroma-restore.it",
    });
    const { operationId: equalOpId } = await enqueueRestore(equalBackupId);
    sim.jobs.length = 0;
    const equalRes = await app.outboxWorker.processPendingOnce();
    expect(equalRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const equalUrlJobs = sim.jobs.filter((j) => j.kind === "wordpress.set-url");
    expect(equalUrlJobs).toHaveLength(1);
    expect(equalUrlJobs[0]?.params).toEqual({
      phpVersion: "8.4",
      siteUrl: "https://hotelroma-restore.it",
      previousUrl: "https://hotelroma-restore.it",
    });
    expect(equalUrlJobs[0]?.jobId).toBe(`job_${equalOpId.replace(/^op_/, "")}_rurl`);
  });

  it("keeps restore succeeded with address_not_updated when wordpress.set-url fails or throws", async () => {
    const { backupId } = await seedSucceededBackup({
      siteUrl: "http://old.hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://hotelroma-restore.it" })
      .where(eq(sites.id, siteA1Id));

    sim.failNextJob("wordpress.set-url", 1, "wp cli failed");
    const { operationId } = await enqueueRestore(backupId);
    const outboxRes = await app.outboxWorker.processPendingOnce();
    expect(outboxRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.restoreStatus).toBe("succeeded");
    expect(bakRow?.restoreProblem).toBe("address_not_updated");

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(opRow?.status).toBe("succeeded");

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId));
    expect(steps.find((s) => s.key === "restore")?.status).toBe("succeeded");
    expect(steps.find((s) => s.key === "update_address")?.status).toBe("failed");

    const auditsAfterExit = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === operationId,
    );
    expect(auditsAfterExit).toHaveLength(1);
    expect(auditsAfterExit[0]?.details).toEqual({
      operationId,
      backupId,
      outcome: "succeeded",
      problem: "address_not_updated",
    });

    // A thrown error from runSiteJob also yields address_not_updated and keeps the restore succeeded.
    sim.onJob = async () => {
      throw new Error("executor timeout");
    };
    const { backupId: thrownBackupId } = await seedSucceededBackup();
    const { operationId: thrownOpId } = await enqueueRestore(thrownBackupId);
    const thrownRes = await app.outboxWorker.processPendingOnce();
    expect(thrownRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const [thrownBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, thrownBackupId));
    expect(thrownBak?.restoreStatus).toBe("succeeded");
    expect(thrownBak?.restoreProblem).toBe("address_not_updated");

    const [thrownOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, thrownOpId));
    expect(thrownOp?.status).toBe("succeeded");

    const thrownSteps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, thrownOpId));
    expect(thrownSteps.find((s) => s.key === "update_address")?.status).toBe("failed");
  });

  it("skips update_address and does not call runSiteJob when site wordpressUrl is null", async () => {
    const { backupId } = await seedSucceededBackup({
      siteUrl: "http://hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: null })
      .where(eq(sites.id, siteA1Id));

    const { operationId } = await enqueueRestore(backupId);
    const outboxRes = await app.outboxWorker.processPendingOnce();
    expect(outboxRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toEqual([]);

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.restoreStatus).toBe("succeeded");
    expect(bakRow?.restoreProblem).toBeNull();

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId));
    expect(steps.find((s) => s.key === "restore")?.status).toBe("succeeded");
    expect(steps.find((s) => s.key === "update_address")?.status).toBe("skipped");
  });

  it("fails restore for each executor failure class without ever changing sites.status (R80)", async () => {
    const failureClasses: readonly BackupFailureClass[] = [
      "restore_prepare_failed",
      "switch_undone",
      "definer_missing",
      "undo_incomplete",
      "no_space",
    ];

    for (const failureClass of failureClasses) {
      const { backupId } = await seedSucceededBackup();
      sim.backupState.failNext(failureClass);
      const { operationId } = await enqueueRestore(backupId);
      const outboxRes = await app.outboxWorker.processPendingOnce();
      expect(outboxRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

      const [bakRow] = await dbClient.db
        .select()
        .from(siteBackups)
        .where(eq(siteBackups.id, backupId));
      expect(bakRow?.restoreStatus).toBe("failed");
      expect(bakRow?.restoreProblem).toBe(failureClass);
      expect(bakRow?.restoredAt).not.toBeNull();

      const [opRow] = await dbClient.db
        .select()
        .from(operations)
        .where(eq(operations.id, operationId));
      expect(opRow?.status).toBe("failed");
      expect(opRow?.errorCode).toBe("INTERNAL_ERROR");

      const steps = await dbClient.db
        .select()
        .from(operationSteps)
        .where(eq(operationSteps.operationId, operationId));
      expect(steps.find((s) => s.key === "restore")?.status).toBe("failed");
      expect(steps.find((s) => s.key === "update_address")?.status).toBe("skipped");

      const [siteRow] = await dbClient.db
        .select({ status: sites.status })
        .from(sites)
        .where(eq(sites.id, siteA1Id));
      expect(siteRow?.status).toBe("ready");

      const audits = (await newAudits()).filter(
        (a) =>
          a.action === "site.backups.restore.finished" &&
          (a.details as Record<string, unknown>)["operationId"] === operationId,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toEqual({
        operationId,
        backupId,
        outcome: "failed",
        problem: failureClass,
      });
    }

    // Stopped sites also remain stopped after restore failure (including undo_incomplete).
    await dbClient.db
      .update(sites)
      .set({ status: "stopped" })
      .where(eq(sites.id, siteA1Id));
    const { backupId: stoppedBakId } = await seedSucceededBackup();
    sim.backupState.failNext("undo_incomplete");
    await enqueueRestore(stoppedBakId);
    await app.outboxWorker.processPendingOnce();
    const [stoppedSite] = await dbClient.db
      .select({ status: sites.status })
      .from(sites)
      .where(eq(sites.id, siteA1Id));
    expect(stoppedSite?.status).toBe("stopped");
  });

  it("aborts with interrupted and never calls executor when the backup row is no longer running for this operation", async () => {
    // 1. Row check before reading site/target.
    const { backupId: b1 } = await seedSucceededBackup();
    const { operationId: op1 } = await enqueueRestore(b1);
    await dbClient.db
      .update(siteBackups)
      .set({ restoreStatus: "failed", restoreProblem: "other" })
      .where(eq(siteBackups.id, b1));

    const res1 = await app.outboxWorker.processPendingOnce();
    expect(res1).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(executorScript.calls).toEqual([]);
    expect(sim.jobs).toEqual([]);

    const [opRow1] = await dbClient.db.select().from(operations).where(eq(operations.id, op1));
    expect(opRow1?.status).toBe("failed");
    expect(opRow1?.errorCode).toBe("OPERATION_INTERRUPTED");

    const steps1 = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op1));
    expect(steps1.find((s) => s.key === "restore")?.status).toBe("failed");
    expect(steps1.find((s) => s.key === "update_address")?.status).toBe("skipped");

    // 2. Second row check right before executor start.
    const { backupId: b2 } = await seedSucceededBackup();
    const { operationId: op2 } = await enqueueRestore(b2);
    beforeResolveSiteFilesServiceId = async () => {
      await dbClient.db
        .update(siteBackups)
        .set({ restoreOperationId: newOpHex() })
        .where(eq(siteBackups.id, b2));
    };

    const res2 = await app.outboxWorker.processPendingOnce();
    expect(res2).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(executorScript.calls).toEqual([]);

    const [opRow2] = await dbClient.db.select().from(operations).where(eq(operations.id, op2));
    expect(opRow2?.status).toBe("failed");
    expect(opRow2?.errorCode).toBe("OPERATION_INTERRUPTED");
  });

  it("records site_busy without leaking raw executor message when restore start throws RESOURCE_LOCKED", async () => {
    const { backupId } = await seedSucceededBackup();
    const { operationId } = await enqueueRestore(backupId);

    executorScript.setHandlers({
      onRestore: () => {
        throw Object.assign(new Error("another backup running for site on /var/lib/secret"), {
          code: "RESOURCE_LOCKED",
        });
      },
    });

    const outboxRes = await app.outboxWorker.processPendingOnce();
    expect(outboxRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.restoreStatus).toBe("failed");
    expect(bakRow?.restoreProblem).toBe("site_busy");

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(opRow?.status).toBe("failed");
    expect(opRow?.errorCode).toBe("RESOURCE_LOCKED");
    expect(opRow?.errorMessage).not.toContain("/var/lib/secret");

    const finishedAudits = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === operationId,
    );
    expect(finishedAudits).toHaveLength(1);
    expect(finishedAudits[0]?.details).toEqual({
      operationId,
      backupId,
      outcome: "failed",
      problem: "site_busy",
    });
  });

  it("renews operation lease across many running polls during a long restore and succeeds once", async () => {
    applier.leaseMs = 150;
    applier.pollMs = 25;

    const { backupId } = await seedSucceededBackup();
    const { operationId } = await enqueueRestore(backupId);

    let running = true;
    let pollCount = 0;
    executorScript.setHandlers({
      onStatus: (req) => {
        pollCount += 1;
        return {
          jobId: req.jobId,
          state: running ? "running" : "succeeded",
          failure: null,
          snapshot: null,
        };
      },
    });

    const runPromise = app.outboxWorker.processPendingOnce();
    await new Promise((resolve) => setTimeout(resolve, 240));

    const midRecovery = await app.outboxWorker.recoverUnknownOperations();
    expect(midRecovery.markedUnknown).toBe(0);

    const [midOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(midOp?.status).toBe("processing");
    expect(pollCount).toBeGreaterThanOrEqual(4);

    running = false;
    const res = await runPromise;
    expect(res).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const [finalOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [finalBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(finalOp?.status).toBe("succeeded");
    expect(finalBak?.restoreStatus).toBe("succeeded");
    expect(executorScript.calls.filter((c) => c.action === "restore")).toHaveLength(1);
    expect(sim.jobs.find((j) => j.kind === "wordpress.set-url")?.params).toMatchObject({
      siteUrl: "http://hotelroma-restore.it",
      previousUrl: "http://hotelroma-restore.it",
    });

    const audits = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === operationId,
    );
    expect(audits).toHaveLength(1);
  });

  it("recovers unknown restore ops via settle without calling restore again (running -> pending -> succeeded, unknown -> interrupted)", async () => {
    // 1. Apply times out polling -> moves op to unknown; recovery calls settle (running -> pending, throw -> pending, succeeded -> settled).
    applier.pollMs = 15;
    applier.pollGiveUpMs = 45;

    const { backupId: b1 } = await seedSucceededBackup({
      siteUrl: "http://before.hotelroma-restore.it",
    });
    const { operationId: op1 } = await enqueueRestore(b1);

    executorScript.setStatusSequence(op1, [new Error("status timeout")]);
    const applyRes = await app.outboxWorker.processPendingOnce();
    expect(applyRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const [unknownOp1] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, op1));
    expect(unknownOp1?.status).toBe("unknown");
    expect(unknownOp1?.errorCode).toBe("OPERATION_AMBIGUOUS");

    const [runningBak1] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, b1));
    expect(runningBak1?.restoreStatus).toBe("running");
    expect(
      (await newAudits()).filter((a) => a.action === "site.backups.restore.finished"),
    ).toEqual([]);

    // Settle returns running -> pending.
    executorScript.setStatusSequence(op1, [
      { jobId: op1, state: "running", failure: null, snapshot: null },
    ]);
    const recRunning = await app.outboxWorker.recoverUnknownOperations();
    expect(recRunning).toEqual({ markedUnknown: 0, convergedSucceeded: 0, convergedFailed: 0 });
    expect((await dbClient.db.select().from(operations).where(eq(operations.id, op1)))[0]?.status).toBe("unknown");

    // Settle throws -> pending.
    executorScript.setStatusSequence(op1, [new Error("executor unavailable")]);
    const recErr = await app.outboxWorker.recoverUnknownOperations();
    expect(recErr).toEqual({ markedUnknown: 0, convergedSucceeded: 0, convergedFailed: 0 });
    expect((await dbClient.db.select().from(operations).where(eq(operations.id, op1)))[0]?.status).toBe("unknown");

    // Settle returns succeeded -> settled with address update and one audit.
    executorScript.setStatusSequence(op1, [
      { jobId: op1, state: "succeeded", failure: null, snapshot: null },
    ]);
    const recOk = await app.outboxWorker.recoverUnknownOperations();
    expect(recOk).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });

    expect(executorScript.calls.filter((c) => c.action === "restore")).toHaveLength(1);
    expect(executorScript.calls.filter((c) => c.action === "settle")).toHaveLength(3);
    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(1);

    const [settledOp1] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, op1));
    const [settledBak1] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, b1));
    expect(settledOp1?.status).toBe("succeeded");
    expect(settledBak1?.restoreStatus).toBe("succeeded");
    expect(settledBak1?.restoreProblem).toBeNull();

    const audits1 = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === op1,
    );
    expect(audits1).toHaveLength(1);

    // 2. settle answering unknown -> failed with interrupted and OPERATION_INTERRUPTED.
    sim.backupState.finishHeld();
    const { backupId: b2 } = await seedSucceededBackup();
    const { operationId: op2 } = await enqueueRestore(b2);
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, op2));
    executorScript.setStatusSequence(op2, [
      { jobId: op2, state: "unknown", failure: null, snapshot: null },
    ]);

    const recUnknown = await app.outboxWorker.recoverUnknownOperations();
    expect(recUnknown.convergedFailed).toBe(1);

    const [settledOp2] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, op2));
    const [settledBak2] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, b2));
    expect(settledOp2?.status).toBe("failed");
    expect(settledOp2?.errorCode).toBe("OPERATION_INTERRUPTED");
    expect(settledBak2?.restoreStatus).toBe("failed");
    expect(settledBak2?.restoreProblem).toBe("interrupted");
    expect(executorScript.calls.filter((c) => c.action === "restore")).toHaveLength(1);

    const audits2 = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === op2,
    );
    expect(audits2).toHaveLength(1);
    expect(audits2[0]?.details).toEqual({
      operationId: op2,
      backupId: b2,
      outcome: "failed",
      problem: "interrupted",
    });
  });

  it("runs only the address step when recovering a restore whose restore step already succeeded", async () => {
    const { backupId } = await seedSucceededBackup({
      siteUrl: "http://pre-crash.hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://post-crash.hotelroma-restore.it" })
      .where(eq(sites.id, siteA1Id));

    const { operationId } = await enqueueRestore(backupId);
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, operationId));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "succeeded", message: "Backup restored" })
      .where(and(eq(operationSteps.operationId, operationId), eq(operationSteps.key, "restore")));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "unknown" })
      .where(
        and(
          eq(operationSteps.operationId, operationId),
          eq(operationSteps.key, "update_address"),
        ),
      );

    executorScript.reset();
    const rec = await app.outboxWorker.recoverUnknownOperations();
    expect(rec).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });

    // Neither restore nor settle is called when restore step already succeeded.
    expect(executorScript.calls).toEqual([]);
    expect(sim.jobs).toHaveLength(1);
    expect(sim.jobs[0]).toMatchObject({
      jobId: `job_${operationId.replace(/^op_/, "")}_rurl`,
      kind: "wordpress.set-url",
      params: {
        phpVersion: "8.4",
        siteUrl: "https://post-crash.hotelroma-restore.it",
        previousUrl: "http://pre-crash.hotelroma-restore.it",
      },
    });

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(opRow?.status).toBe("succeeded");
    expect(bakRow?.restoreStatus).toBe("succeeded");
    expect(bakRow?.restoreProblem).toBeNull();

    const audits = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === operationId,
    );
    expect(audits).toHaveLength(1);

    // Crash after row settle / before succeedOperation -> recovery finishes op without double audit or second set-url.
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, operationId));
    const rec2 = await app.outboxWorker.recoverUnknownOperations();
    expect(rec2).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });
    expect(sim.jobs).toHaveLength(1);
    const auditsAfter = (await newAudits()).filter(
      (a) =>
        a.action === "site.backups.restore.finished" &&
        (a.details as Record<string, unknown>)["operationId"] === operationId,
    );
    expect(auditsAfter).toHaveLength(1);
  });

  it("handles download prepare apply (ready with readyUntil, failed with class) and recovery (status unknown -> interrupted)", async () => {
    // 1. Succeeded download preparation via simulator.
    const { backupId: okBakId } = await seedSucceededBackup();
    const { operationId: okOpId } = await enqueueDownload(okBakId);
    const okRes = await app.outboxWorker.processPendingOnce();
    expect(okRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const archiveCalls = executorScript.calls.filter((c) => c.action === "archive");
    expect(archiveCalls).toHaveLength(1);
    expect(archiveCalls[0]?.jobId).toBe(okOpId);

    const [okBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, okBakId));
    expect(okBak?.archiveStatus).toBe("ready");
    expect(okBak?.archiveProblem).toBeNull();
    expect(okBak?.archiveReadyUntil).not.toBeNull();

    const [okOp] = await dbClient.db.select().from(operations).where(eq(operations.id, okOpId));
    expect(okOp?.status).toBe("succeeded");

    // 2. Failed download preparation with executor failure class.
    const { backupId: failBakId } = await seedSucceededBackup();
    sim.backupState.failNext("no_space");
    const { operationId: failOpId } = await enqueueDownload(failBakId);
    const failRes = await app.outboxWorker.processPendingOnce();
    expect(failRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const [failBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, failBakId));
    expect(failBak?.archiveStatus).toBe("failed");
    expect(failBak?.archiveReadyUntil).toBeNull();
    expect(failBak?.archiveProblem).toBe("no_space");

    const [failOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, failOpId));
    expect(failOp?.status).toBe("failed");
    expect(failOp?.errorCode).toBe("INTERNAL_ERROR");

    // 3. Recovery of unknown download op when executor restarted -> status answers unknown -> interrupted.
    const { backupId: recBakId } = await seedSucceededBackup();
    const { operationId: recOpId } = await enqueueDownload(recBakId);
    sim.backupState.holdJobs(true);
    await sim.backupState.handle({
      action: "archive",
      jobId: recOpId,
      siteId: siteA1Id,
      target: TARGET,
      snapshotId: (
        await dbClient.db
          .select({ snapshotId: siteBackups.snapshotId })
          .from(siteBackups)
          .where(eq(siteBackups.id, recBakId))
      )[0]!.snapshotId!,
    });
    sim.backupState.holdJobs(false);
    sim.backupState.simulateRestart();

    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, recOpId));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "unknown" })
      .where(and(eq(operationSteps.operationId, recOpId), eq(operationSteps.key, "prepare")));

    executorScript.reset();
    const recRes = await app.outboxWorker.recoverUnknownOperations();
    expect(recRes.convergedFailed).toBe(1);
    expect(executorScript.calls.filter((c) => c.action === "status" && c.jobId === recOpId)).toHaveLength(1);
    expect(executorScript.calls.filter((c) => c.action === "archive")).toEqual([]);

    const [recBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, recBakId));
    expect(recBak?.archiveStatus).toBe("failed");
    expect(recBak?.archiveReadyUntil).toBeNull();
    expect(recBak?.archiveProblem).toBe("interrupted");

    const [recOp] = await dbClient.db.select().from(operations).where(eq(operations.id, recOpId));
    expect(recOp?.status).toBe("failed");
    expect(recOp?.errorCode).toBe("OPERATION_INTERRUPTED");

    const [siteRow] = await dbClient.db
      .select({ status: sites.status })
      .from(sites)
      .where(eq(sites.id, siteA1Id));
    expect(siteRow?.status).toBe("ready");

    // 4. Recovery of unknown download op when status answers running -> pending, then succeeded -> ready.
    const expiresIso = new Date(Date.now() + 3_600_000).toISOString();
    const { backupId: recOkBakId } = await seedSucceededBackup();
    const { operationId: recOkOpId } = await enqueueDownload(recOkBakId);
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, recOkOpId));
    executorScript.reset();
    executorScript.setStatusSequence(recOkOpId, [
      { jobId: recOkOpId, state: "running", failure: null, snapshot: null, archive: null },
      {
        jobId: recOkOpId,
        state: "succeeded",
        failure: null,
        snapshot: null,
        archive: {
          sizeBytes: 4096,
          readyAt: new Date().toISOString(),
          expiresAt: expiresIso,
        },
      },
    ]);
    const recPending = await app.outboxWorker.recoverUnknownOperations();
    expect(recPending).toEqual({ markedUnknown: 0, convergedSucceeded: 0, convergedFailed: 0 });
    const recReady = await app.outboxWorker.recoverUnknownOperations();
    expect(recReady).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });
    expect(executorScript.calls.filter((c) => c.action === "archive")).toEqual([]);
    const [recOkBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, recOkBakId));
    expect(recOkBak?.archiveStatus).toBe("ready");
    expect(recOkBak?.archiveReadyUntil?.toISOString()).toBe(expiresIso);
  });

  it("retention discards archives of deleted/forgotten rows once and ignores discardArchive errors", async () => {
    const oldDate = new Date(Date.now() - 20 * 86_400_000);
    const newerDate = new Date(Date.now() - 1 * 86_400_000);

    // Newer backup kept as latest.
    await seedSucceededBackup({ startedAt: newerDate, kind: "nightly" });

    // Expired succeeded backup with a ready archive -> must call discardArchive once before delete.
    const { backupId: oldForgottenId } = await seedSucceededBackup({
      startedAt: oldDate,
      kind: "nightly",
    });
    const oldArchiveOpId = newOpHex();
    await dbClient.db
      .update(siteBackups)
      .set({
        archiveOperationId: oldArchiveOpId,
        archiveStatus: "ready",
        archiveReadyUntil: new Date(Date.now() + 3_600_000),
      })
      .where(eq(siteBackups.id, oldForgottenId));

    // Expired failed backup with an archive status -> must call discardArchive once before drop.
    const oldFailedArchiveOpId = newOpHex();
    const { id: oldFailedId } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "timeout",
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({
        archiveOperationId: oldFailedArchiveOpId,
        archiveStatus: "failed",
        archiveProblem: "other",
      })
      .where(eq(siteBackups.id, oldFailedId));

    // Expired succeeded backup whose archive was replaced (archiveStatus null, archiveOperationId still set) -> must NOT call discardArchive.
    const { backupId: replacedBakId } = await seedSucceededBackup({
      startedAt: new Date(oldDate.getTime() - 10_000),
      kind: "nightly",
    });
    await dbClient.db
      .update(siteBackups)
      .set({
        archiveOperationId: newOpHex(),
        archiveStatus: null,
      })
      .where(eq(siteBackups.id, replacedBakId));

    // Trigger retention via site.backups.create.
    const { operation: createOp } = await dbClient.db.transaction(async (tx) => {
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

    executorScript.reset();
    const firstRun = await app.outboxWorker.processPendingOnce();
    expect(firstRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect((await dbClient.db.select().from(operations).where(eq(operations.id, createOp.id)))[0]?.status).toBe("succeeded");

    const discardCalls = executorScript.calls.filter((c) => c.action === "discardArchive");
    expect(discardCalls.map((c) => c.jobId).sort()).toEqual(
      [oldArchiveOpId, oldFailedArchiveOpId].sort(),
    );

    const remainingIds = (
      await dbClient.db.select({ id: siteBackups.id }).from(siteBackups)
    ).map((r) => r.id);
    expect(remainingIds).not.toContain(oldForgottenId);
    expect(remainingIds).not.toContain(oldFailedId);
    expect(remainingIds).not.toContain(replacedBakId);

    // Throwing discardArchive must not stop retention from deleting rows or failing the op.
    const { backupId: throwBakId } = await seedSucceededBackup({
      startedAt: oldDate,
      kind: "nightly",
    });
    const throwArchiveOpId = newOpHex();
    await dbClient.db
      .update(siteBackups)
      .set({
        archiveOperationId: throwArchiveOpId,
        archiveStatus: "ready",
        archiveReadyUntil: new Date(Date.now() + 3_600_000),
      })
      .where(eq(siteBackups.id, throwBakId));

    executorScript.reset();
    executorScript.setHandlers({
      onDiscardArchive: () => {
        throw new Error("executor temporarily down");
      },
    });

    const { operation: secondCreateOp } = await dbClient.db.transaction(async (tx) => {
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

    const secondRun = await app.outboxWorker.processPendingOnce();
    expect(secondRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect((await dbClient.db.select().from(operations).where(eq(operations.id, secondCreateOp.id)))[0]?.status).toBe("succeeded");
    expect(
      await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, throwBakId)),
    ).toEqual([]);
  });

  it("never stores or logs the sentinel S3 secret across outbox, steps, audits, operation errors, or logs", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }

    const { backupId } = await seedSucceededBackup();
    const { operationId: restoreOpId } = await enqueueRestore(backupId);
    await app.outboxWorker.processPendingOnce();

    const { operationId: downloadOpId } = await enqueueDownload(backupId);
    await app.outboxWorker.processPendingOnce();

    const restoreCall = executorScript.calls.find(
      (c) => c.action === "restore" && c.jobId === restoreOpId,
    );
    const archiveCall = executorScript.calls.find(
      (c) => c.action === "archive" && c.jobId === downloadOpId,
    );
    expect(restoreCall?.action === "restore" && restoreCall.target.secretAccessKey).toBe(CANARY_SECRET);
    expect(archiveCall?.action === "archive" && archiveCall.target.secretAccessKey).toBe(CANARY_SECRET);

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
      const rowsResult = await dbClient.db.execute(sql.raw(`SELECT * FROM "${tableName}"`));
      expect(
        JSON.stringify(rowsResult.rows),
        `table ${tableName} leaked sentinel secret`,
      ).not.toContain(CANARY_SECRET);
    }

    const renderedLogs = logs.map((args) => args.map(String).join(" ")).join("\n");
    expect(renderedLogs).not.toContain(CANARY_SECRET);
    expect(BACKUP_FAILURE_CLASSES).toContain("undo_incomplete");
  });

  it("R93: holds SITE_STEP_LEASE_MS during wordpress.set-url so recovery does not re-run it or free the site lock", async () => {
    applier.leaseMs = 80;
    applier.pollMs = 10;

    const { backupId } = await seedSucceededBackup({
      siteUrl: "http://old.hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://hotelroma-restore.it" })
      .where(eq(sites.id, siteA1Id));

    const { operationId } = await enqueueRestore(backupId);

    let setUrlCalls = 0;
    let releaseFirstSetUrl!: () => void;
    const firstSetUrlEntered = new Promise<void>((resolve) => {
      const firstSetUrlGate = new Promise<void>((release) => {
        releaseFirstSetUrl = release;
      });
      sim.onJob = async (req) => {
        if (req.kind !== "wordpress.set-url") {
          return;
        }
        setUrlCalls += 1;
        if (setUrlCalls === 1) {
          resolve();
          await firstSetUrlGate;
        } else {
          // Mimic executor rejecting duplicate active jobId while first job still runs.
          throw Object.assign(new Error("Site job already running"), { code: "RESOURCE_LOCKED" });
        }
      };
    });

    const runPromise = app.outboxWorker.processPendingOnce();
    try {
      await firstSetUrlEntered;

      // Wait longer than the short applier lease while wordpress.set-url is still running.
      await new Promise((resolve) => setTimeout(resolve, 140));

      const midRecovery = await app.outboxWorker.recoverUnknownOperations();
      expect(midRecovery.markedUnknown).toBe(0);
      expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(1);

      // Site lock must stay held while wordpress.set-url runs.
      await expect(
        dbClient.db.transaction((tx) =>
          enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
            organizationId: orgAId,
            kind: "site.domains",
            resourceType: "site",
            resourceId: siteA1Id,
            lockKey: `site:${siteA1Id}`,
          }),
        ),
      ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    } finally {
      releaseFirstSetUrl();
      await runPromise.catch(() => undefined);
    }

    const outboxRes = await runPromise;
    expect(outboxRes).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(1);

    const [bakRow] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(bakRow?.restoreStatus).toBe("succeeded");
    expect(bakRow?.restoreProblem).toBeNull();

    const [opRow] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(opRow?.status).toBe("succeeded");
  });

  it("R95: marks a restore operation unknown on a lease-renewal DB error during polling and settles it via recovery", async () => {
    applier.pollMs = 15;

    const { backupId } = await seedSucceededBackup();
    const { operationId } = await enqueueRestore(backupId);

    sim.backupState.holdJobs(true);
    let renewCount = 0;
    onRenewOperationLease = async () => {
      renewCount += 1;
      // Call 1 is applyRestore's initial renewal; call 2 is inside pollJobStatus; call 3 is after pollMs.
      if (renewCount === 3) {
        onRenewOperationLease = null;
        throw new Error("simulated transient database failure");
      }
    };

    const applyRes = await app.outboxWorker.processPendingOnce();
    expect(applyRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const [unknownOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(unknownOp?.status).toBe("unknown");
    expect(unknownOp?.errorCode).toBe("OPERATION_AMBIGUOUS");

    const [runningBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(runningBak?.restoreStatus).toBe("running");

    sim.backupState.finishHeld();
    const recRes = await app.outboxWorker.recoverUnknownOperations();
    expect(recRes).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });

    const [settledOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [settledBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(settledOp?.status).toBe("succeeded");
    expect(settledBak?.restoreStatus).toBe("succeeded");
    expect(settledBak?.restoreProblem).toBeNull();
    expect(executorScript.calls.filter((c) => c.action === "restore")).toHaveLength(1);
  });

  it("R104: marks a restore unknown on a DB error in the address step after the executor restored, and finishes it via recovery", async () => {
    const { backupId } = await seedSucceededBackup({
      siteUrl: "http://old.hotelroma-restore.it",
    });
    await dbClient.db
      .update(sites)
      .set({ siteUrl: "https://hotelroma-restore.it" })
      .where(eq(sites.id, siteA1Id));
    const { operationId } = await enqueueRestore(backupId);

    // Only the address step renews with SITE_STEP_LEASE_MS; fail it once.
    onRenewOperationLease = async (_db, _id, leaseMs) => {
      if (leaseMs === SITE_STEP_LEASE_MS) {
        onRenewOperationLease = null;
        throw new Error("simulated transient database failure");
      }
    };

    const applyRes = await app.outboxWorker.processPendingOnce();
    expect(applyRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });

    const [unknownOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    expect(unknownOp?.status).toBe("unknown");
    expect(unknownOp?.errorCode).toBe("OPERATION_AMBIGUOUS");
    const [runningBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(runningBak?.restoreStatus).toBe("running");
    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(0);

    // The same error during recovery leaves the operation unknown for the next tick.
    onRenewOperationLease = async (_db, _id, leaseMs) => {
      if (leaseMs === SITE_STEP_LEASE_MS) {
        onRenewOperationLease = null;
        throw new Error("simulated transient database failure");
      }
    };
    await expect(app.outboxWorker.recoverUnknownOperations()).resolves.toEqual({
      markedUnknown: 0,
      convergedSucceeded: 0,
      convergedFailed: 0,
      recoveryErrors: [{ kind: "site.backups.restore", operationId, errorCode: "INTERNAL_ERROR" }],
    });
    const [stillUnknownOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [stillRunningBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(stillUnknownOp?.status).toBe("unknown");
    expect(stillRunningBak?.restoreStatus).toBe("running");

    const recRes = await app.outboxWorker.recoverUnknownOperations();
    expect(recRes).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });

    const [settledOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operationId));
    const [settledBak] = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.id, backupId));
    expect(settledOp?.status).toBe("succeeded");
    expect(settledBak?.restoreStatus).toBe("succeeded");
    expect(settledBak?.restoreProblem).toBeNull();
    expect(executorScript.calls.filter((c) => c.action === "restore")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(1);
  });

  it("R105: marks a prune unknown on a lease-renewal DB error while the forget job is polled, and settles it via recovery without forgetting again", async () => {
    applier.pollMs = 15;
    await seedSucceededBackup({ startedAt: new Date(Date.now() - 86_400_000), kind: "nightly" });
    await seedSucceededBackup({
      startedAt: new Date(Date.now() - 20 * 86_400_000),
      kind: "nightly",
    });

    const { operation } = await dbClient.db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgAId,
        kind: "site.backups.prune",
        resourceType: "site",
        resourceId: siteA1Id,
        lockKey: `site:${siteA1Id}`,
        leaseDurationMs: BACKUP_LEASE_MS,
        steps: SITE_BACKUP_PRUNE_STEPS,
        outboxPayload: { siteId: siteA1Id },
      }),
    );

    executorScript.reset();
    executorScript.setHandlers({
      onForget: (req) => ({ jobId: req.jobId, state: "running", failure: null, snapshot: null }),
    });
    onRenewOperationLease = async () => {
      if (executorScript.calls.some((c) => c.action === "forget")) {
        onRenewOperationLease = null;
        throw new Error("simulated transient database failure");
      }
    };

    const applyRes = await app.outboxWorker.processPendingOnce();
    expect(applyRes).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    const [unknownOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operation.id));
    expect(unknownOp?.status).toBe("unknown");
    expect(unknownOp?.errorCode).toBe("OPERATION_AMBIGUOUS");

    const recRes = await app.outboxWorker.recoverUnknownOperations();
    expect(recRes).toEqual({ markedUnknown: 0, convergedSucceeded: 1, convergedFailed: 0 });
    const [settledOp] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, operation.id));
    expect(settledOp?.status).toBe("succeeded");
    expect(executorScript.calls.filter((c) => c.action === "forget")).toHaveLength(1);
  });
});
