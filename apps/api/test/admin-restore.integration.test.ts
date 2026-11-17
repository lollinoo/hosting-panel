import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { BackupsIpcRequest } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  insertSiteBackup,
  operationSteps,
  operations,
  outboxEvents,
  serviceInstances,
  siteBackups,
  sites,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { ADMIN_SITE_RESTORE_STEPS } from "../src/backups/site-restore-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const TARGET = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hotel-backups",
  prefix: "panel",
  accessKeyId: "AKIAADMINRESTORE1",
  secretAccessKey: "canary-s3-secret-ADMIN-RESTORE-7",
};
const SETTINGS = {
  ...TARGET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SITE = {
  name: "Hotel Roma",
  domain: "hotelroma-admin.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-admin.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function request(
  baseUrl: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
}

async function login(baseUrl: string, email: string, password: string, totp?: string): Promise<string> {
  const res = await request(baseUrl, "POST", "/v1/auth/login", {
    body: { email, password, ...(totp ? { totpCode: totpCodeAt(totp, Math.floor(Date.now() / 30_000)) } : {}) },
  });
  if (res.status !== 200) throw new Error(`login ${email}: ${res.status}`);
  return res.body.data.accessToken as string;
}

describe("administrator's restore of a site where nothing may exist", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let adminId: string;
  let adminToken: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;
  let svcId: string;
  let auditBaseline: Set<string>;
  let log: string[];
  let backupCalls: BackupsIpcRequest[];
  let statusDown: boolean;
  let origBackups: InMemoryDockerSimulatorAdapter["backups"];

  const restorePath = (id: string) => `/v1/admin/backups/sites/${id}/restore`;
  const adminRestore = (body: unknown, key: string = randomUUID(), id: string = siteId) =>
    request(app.baseUrl!, "POST", restorePath(id), {
      token: adminToken,
      body,
      headers: { "Idempotency-Key": key },
    });

  async function seedBackup(startedAt = new Date()): Promise<string> {
    const jobId = `op_${randomUUID().replace(/-/g, "")}`;
    await origBackups({
      action: "start",
      jobId,
      siteId,
      serviceInstanceId: svcId,
      target: TARGET,
    } as BackupsIpcRequest);
    const status = await origBackups({ action: "status", jobId });
    const { id } = await insertSiteBackup(dbClient.db, {
      siteId,
      kind: "manual",
      status: "running",
      operationId: null,
      startedAt,
      finishedAt: null,
      problem: null,
      siteUrl: "http://hotelroma-admin.it",
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: status.snapshot!.snapshotId, sizeBytes: 4096, finishedAt: startedAt })
      .where(eq(siteBackups.id, id));
    return id;
  }

  async function stepsOf(opId: string): Promise<Record<string, string>> {
    const rows = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
    return Object.fromEntries(rows.map((r) => [r.key, r.status]));
  }

  async function stateOf(opId: string, backupId: string) {
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    const [site] = await dbClient.db.select().from(sites).where(eq(sites.id, siteId));
    return { op: op!, row: row!, site: site!, steps: await stepsOf(opId) };
  }

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !auditBaseline.has(r.id));
  }

  /** Starts an admin restore of the newest copy and returns its ids. */
  async function startRestore(arm?: () => void): Promise<{ operationId: string; backupId: string }> {
    const backupId = await seedBackup();
    arm?.();
    const res = await adminRestore({ confirmName: SITE.name });
    expect(res.status).toBe(202);
    return { operationId: res.body.data.operationId as string, backupId };
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Admin Restore",
      hostHostname: "panel-admin-restore.test",
      hostIpv4: "10.0.0.1",
    });
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-restore@x.it",
      name: "Admin",
      password: PW,
    });
    adminId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    origBackups = sim.backups.bind(sim);
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
    applier = app.nestApp.get(SiteBackupsApplier);
    adminToken = await login(app.baseUrl!, "admin-restore@x.it", PW, admin.totpSecretBase32);

    const created = await request(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Hotel Roma Org", ownerEmail: "owner-admin-restore@hotel.it", ownerName: "Mario" },
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    ownerToken = await login(
      app.baseUrl!,
      "owner-admin-restore@hotel.it",
      created.body.data.temporaryPassword as string,
    );
    const site = await request(app.baseUrl!, "POST", `/v1/organizations/${orgId}/managed-sites`, {
      token: ownerToken,
      body: SITE,
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
    svcId = sim.deployedSpecs[0]!.serviceInstanceId;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    applier.pollMs = 0;
    applier.pollGiveUpMs = 120_000;
    sim.backupState.holdJobs(false);
    sim.backupState.finishHeld();
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: true });
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.id, svcId));
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminId });
    auditBaseline = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));

    log = [];
    backupCalls = [];
    statusDown = false;
    sim.jobs.length = 0;
    sim.deployedSpecs.length = 0;
    sim.onJob = async (req) => {
      log.push(`job:${req.kind}`);
    };
    sim.onDeploy = async () => {
      log.push("deploy");
    };
    vi.spyOn(sim, "backups").mockImplementation(async (req) => {
      backupCalls.push(req);
      if (req.action !== "status") log.push(req.action);
      else if (statusDown) throw Object.assign(new Error("executor unreachable"), { code: "DOCKER_ENGINE_UNAVAILABLE" });
      return origBackups(req);
    });
  });

  it("puts back a site of which nothing exists: database, files, start, address, file access, in that order", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    await dbClient.db.update(sites).set({ status: "degraded" }).where(eq(sites.id, siteId));
    const { operationId, backupId } = await startRestore();

    const [op0] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    expect(op0).toMatchObject({ kind: "site.backups.restore", lockKey: `site:${siteId}`, requestedByUserId: adminId });
    const stepRows = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId));
    expect(stepRows.map((s) => s.key)).toEqual(ADMIN_SITE_RESTORE_STEPS.map((s) => s.key));

    await app.outboxWorker.processPendingOnce();

    expect(log).toEqual([
      "siteState",
      "job:db.provision",
      "restore",
      "job:wordpress.settle",
      "siteState",
      "deploy",
      "job:wordpress.set-url",
    ]);
    const restoreReq = backupCalls.find((c) => c.action === "restore");
    expect(restoreReq).toMatchObject({ createVolume: true, serviceInstanceId: svcId });
    const provision = sim.jobs.find((j) => j.kind === "db.provision")!;
    expect(provision.params).toEqual(expect.objectContaining({ dbName: expect.any(String), dbUser: expect.any(String) }));
    expect(Object.keys(provision.resolvedSecrets ?? {})).toEqual(["HP_DB_PASSWORD"]);
    expect(sim.jobs.some((j) => j.kind === "wordpress.install")).toBe(false);
    expect(sim.deployedSpecs).toHaveLength(1);

    const s = await stateOf(operationId, backupId);
    expect(s.steps).toEqual({
      provision_database: "succeeded",
      restore: "succeeded",
      start_site: "succeeded",
      update_address: "succeeded",
      sftp: applier.sftp ? "succeeded" : "skipped",
    });
    expect(s.op.status).toBe("succeeded");
    expect(s.row).toMatchObject({ restoreStatus: "succeeded", restoreProblem: null });
    expect(s.site.status).toBe("ready");

    const audits = await newAudits();
    expect(audits.map((a) => a.action).sort()).toEqual([
      "admin.site.backups.restore.finished",
      "admin.site.backups.restore.requested",
    ]);
    expect(audits.find((a) => a.action.endsWith("requested"))).toMatchObject({
      actorId: adminId,
      actorType: "user",
      organizationId: orgId,
      targetId: siteId,
      details: expect.objectContaining({ backupId, operationId }),
    });
    expect(audits.find((a) => a.action.endsWith("finished"))).toMatchObject({
      organizationId: orgId,
      details: expect.objectContaining({ outcome: "succeeded", problem: null }),
    });
  });

  it("runs the database step when the files exist and sends no createVolume (R119)", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: false });
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    expect(log).toEqual([
      "siteState",
      "job:db.provision",
      "restore",
      "job:wordpress.settle",
      "siteState",
      "deploy",
      "job:wordpress.set-url",
    ]);
    expect(backupCalls.find((c) => c.action === "restore")).not.toHaveProperty("createVolume");
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ provision_database: "succeeded", restore: "succeeded", start_site: "succeeded" });
    expect(s.op.status).toBe("succeeded");
  });

  it("makes sure the database user exists when files and site both exist (R119)", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: true });
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    expect(sim.jobs.filter((j) => j.kind === "db.provision")).toHaveLength(1);
    expect(backupCalls.find((c) => c.action === "restore")).not.toHaveProperty("createVolume");
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ provision_database: "succeeded", restore: "succeeded", start_site: "skipped" });
    expect(s.op.status).toBe("succeeded");
  });

  it("never deploys when the site is running (CP-01)", async () => {
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    expect(log).not.toContain("deploy");
    expect(sim.deployedSpecs).toHaveLength(0);
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ provision_database: "succeeded", restore: "succeeded", start_site: "skipped" });
    expect(s.op.status).toBe("succeeded");
    expect(s.site.status).toBe("ready");
  });

  it("never starts a site its owner stopped, even when its container is gone", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: false });
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.id, svcId));
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    expect(log).not.toContain("deploy");
    expect(sim.deployedSpecs).toHaveLength(0);
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ provision_database: "succeeded", restore: "succeeded", start_site: "skipped" });
    expect(s.op.status).toBe("succeeded");
  });

  it("a failed database step restores nothing and fails with restore_prepare_failed", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    sim.failNextJob("db.provision", 1);
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    expect(log).toEqual(["siteState", "job:db.provision"]);
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toEqual({
      provision_database: "failed",
      restore: "skipped",
      start_site: "skipped",
      update_address: "skipped",
      sftp: "skipped",
    });
    expect(s.op.status).toBe("failed");
    expect(s.row).toMatchObject({ restoreStatus: "failed", restoreProblem: "restore_prepare_failed" });
    expect(s.site.status).toBe("ready");
    const finished = (await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]!.details).toMatchObject({ outcome: "failed", problem: "restore_prepare_failed" });
  });

  it("a failed restore starts nothing and leaves the site status alone", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    const { operationId, backupId } = await startRestore(() => sim.backupState.failNext("switch_undone"));
    await app.outboxWorker.processPendingOnce();

    expect(log).not.toContain("deploy");
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ provision_database: "succeeded", restore: "failed", start_site: "skipped", sftp: "skipped" });
    expect(s.op.status).toBe("failed");
    expect(s.row).toMatchObject({ restoreStatus: "failed", restoreProblem: "switch_undone" });
    expect(s.site.status).toBe("ready");
  });

  it("a start that fails for a known reason leaves the files back, the site degraded and the operation failed", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: false });
    sim.failNextDeploy();
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();

    const s = await stateOf(operationId, backupId);
    expect(s.steps).toEqual({
      provision_database: "succeeded",
      restore: "succeeded",
      start_site: "failed",
      update_address: "skipped",
      sftp: "skipped",
    });
    expect(s.op.status).toBe("failed");
    expect(s.row).toMatchObject({ restoreStatus: "succeeded", restoreProblem: "site_not_started" });
    expect(s.site.status).toBe("degraded");
    const finished = (await newAudits()).filter((a) => a.action === "admin.site.backups.restore.finished");
    expect(finished[0]!.details).toMatchObject({ outcome: "succeeded", problem: "site_not_started" });
  });

  it("an ambiguous start goes to recovery, which asks again and never deploys twice", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: true, container: false });
    sim.onDeploy = async () => {
      log.push("deploy");
      // The container came up but the answer was lost.
      sim.backupState.setSiteState(svcId, { filesVolume: true, container: true });
      throw Object.assign(new Error("lost"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
    };
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();
    expect((await stateOf(operationId, backupId)).op.status).toBe("unknown");

    await app.outboxWorker.recoverUnknownOperations();
    expect(log.filter((l) => l === "deploy")).toHaveLength(1);
    expect(log.filter((l) => l === "restore" || l === "settle")).toEqual(["restore"]);
    const s = await stateOf(operationId, backupId);
    expect(s.steps.start_site).toBe("skipped");
    expect(s.op.status).toBe("succeeded");
    expect(s.row.restoreStatus).toBe("succeeded");
  });

  it("a failed file-access step leaves the operation succeeded; without the service it is skipped", async () => {
    if (applier.sftp) {
      vi.spyOn(applier.sftp, "ensureApplied").mockRejectedValueOnce(new Error("host agent down"));
      const first = await startRestore();
      await app.outboxWorker.processPendingOnce();
      const s = await stateOf(first.operationId, first.backupId);
      expect(s.steps.sftp).toBe("failed");
      expect(s.op.status).toBe("succeeded");
      await dbClient.db.delete(siteBackups);
    }
    const saved = applier.sftp;
    (applier as { sftp: unknown }).sftp = null;
    try {
      const second = await startRestore();
      await app.outboxWorker.processPendingOnce();
      const s = await stateOf(second.operationId, second.backupId);
      expect(s.steps.sftp).toBe("skipped");
      expect(s.op.status).toBe("succeeded");
    } finally {
      (applier as { sftp: unknown }).sftp = saved;
    }
  });

  it("refuses customers with 403 and the denied audit, unknown sites with 404, and leaves no row", async () => {
    await seedBackup();
    const asCustomer = await request(app.baseUrl!, "POST", restorePath(siteId), {
      token: ownerToken,
      body: { confirmName: SITE.name },
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(asCustomer.status).toBe(403);
    const denied = await newAudits();
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ action: "platform.users.manage", targetType: "backups" });
    expect(denied[0]!.details).toMatchObject({ outcome: "denied" });

    const unknown = await adminRestore({ confirmName: SITE.name }, randomUUID(), "site_doesnotexist");
    expect(unknown.status).toBe(404);
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
  });

  it("answers 400 with the field for a wrong name and for no usable copy, and writes nothing", async () => {
    const none = await adminRestore({ confirmName: SITE.name });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("VALIDATION_ERROR");
    expect(none.body.error.details).toEqual([{ field: "backupId", message: "no_succeeded_backup" }]);

    const unknownBackup = await adminRestore({ backupId: `bkp_${"a".repeat(32)}`, confirmName: SITE.name });
    expect(unknownBackup.status).toBe(400);
    expect(unknownBackup.body.error.details).toEqual([{ field: "backupId", message: "no_succeeded_backup" }]);

    const backupId = await seedBackup();
    const wrongName = await adminRestore({ backupId, confirmName: "Hotel Napoli" });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.details[0]).toMatchObject({ field: "confirmName" });

    const extra = await adminRestore({ confirmName: SITE.name, force: true });
    expect(extra.status).toBe(400);
    const noKey = await request(app.baseUrl!, "POST", restorePath(siteId), {
      token: adminToken,
      body: { confirmName: SITE.name },
    });
    expect(noKey.status).toBe(400);

    expect(await dbClient.db.select().from(operations)).toHaveLength(0);
    expect(await newAudits()).toHaveLength(0);
  });

  it("answers 409 when the site is busy", async () => {
    await startRestore();
    const busy = await adminRestore({ confirmName: SITE.name });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("RESOURCE_LOCKED");
  });

  it("a replay without backupId answers the first operation even after a newer copy exists", async () => {
    const older = await seedBackup(new Date(Date.now() - 60_000));
    const key = randomUUID();
    const first = await adminRestore({ confirmName: SITE.name }, key);
    expect(first.status).toBe(202);
    expect(first.body.data.backupId).toBe(older);
    expect(first.body.links).toEqual({ operation: `/v1/organizations/${orgId}/operations/${first.body.data.operationId}` });

    await seedBackup(new Date());
    const replay = await adminRestore({ confirmName: SITE.name }, key);
    expect(replay.status).toBe(202);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await dbClient.db.select().from(operations)).toHaveLength(1);
  });

  it("recovery fails a run stopped before the restore began, with no executor call", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    sim.onJob = async (req) => {
      log.push(`job:${req.kind}`);
      if (req.kind === "db.provision") {
        throw Object.assign(new Error("lost"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
      }
    };
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();
    expect((await stateOf(operationId, backupId)).op.status).toBe("unknown");

    log.length = 0;
    await app.outboxWorker.recoverUnknownOperations();
    expect(log).toEqual([]);
    const s = await stateOf(operationId, backupId);
    expect(s.op.status).toBe("failed");
    expect(s.row).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
    expect(s.steps.restore).not.toBe("succeeded");
  });

  it("recovery of a run stopped during the restore settles it and starts the site once", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    applier.pollGiveUpMs = 0;
    const { operationId, backupId } = await startRestore(() => {
      sim.backupState.holdJobs(true);
      statusDown = true;
    });
    await app.outboxWorker.processPendingOnce();
    expect((await stateOf(operationId, backupId)).op.status).toBe("unknown");

    statusDown = false;
    sim.backupState.finishHeld();
    sim.backupState.holdJobs(false);
    await app.outboxWorker.recoverUnknownOperations();
    expect(log.filter((l) => l === "restore")).toHaveLength(1);
    expect(log.filter((l) => l === "deploy")).toHaveLength(1);
    const s = await stateOf(operationId, backupId);
    expect(s.steps).toMatchObject({ restore: "succeeded", start_site: "succeeded" });
    expect(s.op.status).toBe("succeeded");

    // A second recovery pass changes nothing.
    await app.outboxWorker.recoverUnknownOperations();
    expect(log.filter((l) => l === "deploy" || l === "restore")).toHaveLength(2);
  });

  it("recovery of a run stopped after the start neither restores nor deploys again", async () => {
    sim.backupState.setSiteState(svcId, { filesVolume: false, container: false });
    const { operationId, backupId } = await startRestore();
    await app.outboxWorker.processPendingOnce();
    expect(sim.deployedSpecs).toHaveLength(1);

    // Rewind to "stopped at update_address" with the row still running.
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", completedAt: null })
      .where(eq(operations.id, operationId));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "running" })
      .where(eq(operationSteps.operationId, operationId));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "succeeded" })
      .where(eq(operationSteps.key, "restore"));
    await dbClient.db
      .update(operationSteps)
      .set({ status: "succeeded" })
      .where(eq(operationSteps.key, "start_site"));
    await dbClient.db
      .update(siteBackups)
      .set({ restoreStatus: "running", restoredAt: null })
      .where(eq(siteBackups.id, backupId));
    log.length = 0;

    await app.outboxWorker.recoverUnknownOperations();
    expect(log).toEqual(["job:wordpress.set-url"]);
    const s = await stateOf(operationId, backupId);
    expect(s.op.status).toBe("succeeded");
    expect(s.row.restoreStatus).toBe("succeeded");
    expect(sim.deployedSpecs).toHaveLength(1);
  });

  it("the administrator is not held to the customers' limit on heavy actions", async () => {
    const backupId = await seedBackup();
    for (let i = 0; i < 8; i += 1) {
      const res = await adminRestore({ backupId, confirmName: SITE.name });
      expect(res.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
    }
    expect(await dbClient.db.select().from(operations)).toHaveLength(8);
  });
});
