import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  SiteBackupAcceptedDtoSchema,
  SiteBackupsDtoSchema,
  BackupArchiveChunkDtoSchema,
  backupArchiveFileName,
  findForbiddenPublicDtoKeys,
  type SiteBackupAcceptedDto,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  deleteBackupSettings,
  enqueueOperationTransactional,
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
  settleSiteArchive,
  settleSiteRestore,
  siteBackups,
  sites,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import {
  SITE_ARCHIVE_STEPS,
  SITE_RESTORE_STEPS,
} from "../src/backups/site-restore-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const SETUP = { installationName: "Test Restore", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY_SECRET = "canary-s3-secret-DO-NOT-LEAK-99";
const SNAP_HEX_1 = "1".repeat(64);
const SNAP_HEX_2 = "2".repeat(64);

const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hotel-backups",
  prefix: "panel",
  accessKeyId: "AKIARESTORETEST1",
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

interface HttpResult {
  readonly status: number;
  readonly body: Json;
  readonly raw: string;
  readonly headers: Headers;
}

async function rawRequest(
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
    headers: response.headers,
  };
}

async function login(baseUrl: string, email: string, password: string, totpSecret?: string): Promise<string> {
  const res = await rawRequest(baseUrl, "POST", "/v1/auth/login", {
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

describe("M3b site restore & download routes and service", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let app: ControlPlaneAppHandle;
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
  let jwtSigningKeyPem: string;

  const baseUrlOf = (orgId: string, siteId: string) =>
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
  ) => rawRequest(app.baseUrl!, method, path, { token: ownerAToken, ...options });

  async function snapshotAudits(): Promise<void> {
    const rows = await dbClient.db.select({ id: auditEvents.id }).from(auditEvents);
    baselineAuditIds = new Set(rows.map((r) => r.id));
  }

  async function newAudits() {
    const rows = await dbClient.db.select().from(auditEvents);
    return rows.filter((r) => !baselineAuditIds.has(r.id));
  }

  async function seedBackup(opts: {
    siteId?: string;
    status?: "running" | "succeeded" | "failed";
    snapshotId?: string | null;
    startedAt?: Date;
    sizeBytes?: number | null;
    problem?: "other" | null;
    siteUrl?: string | null;
  } = {}): Promise<string> {
    const siteId = opts.siteId ?? siteA1Id;
    const status = opts.status ?? "succeeded";
    const startedAt = opts.startedAt ?? new Date();
    const { id } = await insertSiteBackup(dbClient.db, {
      siteId,
      kind: "manual",
      status: status === "failed" ? "failed" : "running",
      operationId: null,
      startedAt,
      finishedAt: status === "failed" ? new Date(startedAt.getTime() + 1000) : null,
      problem: opts.problem ?? null,
      siteUrl: opts.siteUrl ?? "https://hotelroma.it",
    });
    if (status === "succeeded") {
      await dbClient.db
        .update(siteBackups)
        .set({
          status: "succeeded",
          snapshotId: opts.snapshotId === undefined ? SNAP_HEX_1 : opts.snapshotId,
          sizeBytes: opts.sizeBytes ?? 8192,
          finishedAt: new Date(startedAt.getTime() + 5_000),
          problem: null,
        })
        .where(eq(siteBackups.id, id));
    }
    return id;
  }

  async function seedSimulatorSnapshot(siteId: string, jobId: string): Promise<string> {
    const start = await sim.backups({
      action: "start",
      jobId,
      siteId,
      serviceInstanceId: "svc_sim",
      target: {
        endpoint: SETTINGS.endpoint,
        region: SETTINGS.region,
        bucket: SETTINGS.bucket,
        prefix: SETTINGS.prefix,
        accessKeyId: SETTINGS.accessKeyId,
        secretAccessKey: CANARY_SECRET,
      },
    });
    const status = await sim.backups({ action: "status", jobId: start.jobId });
    return status.snapshot!.snapshotId;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, {
      email: "admin-restore-routes@x.it",
      name: "Admin",
      password: PW,
    });
    adminUserId = admin.userId;

    sim = new InMemoryDockerSimulatorAdapter();
    hostSim = new InMemoryHostSimulatorAdapter();
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

    adminToken = await login(app.baseUrl!, "admin-restore-routes@x.it", PW, admin.totpSecretBase32);

    const createdA = await rawRequest(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "Hotel Roma Org",
        ownerEmail: "mario-restore@hotel.it",
        ownerName: "Mario",
      },
    });
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    ownerAToken = await login(
      app.baseUrl!,
      "mario-restore@hotel.it",
      createdA.body.data.temporaryPassword as string,
    );
    const [ownerARow] = await dbClient.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "mario-restore@hotel.it"));
    ownerAUserId = ownerARow!.id;

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    instId = inst!.id;

    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: instId,
      name: "panel-b-restore.test",
      hostname: "panel-b-restore.test",
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
      slug: "bar-sport-restore-org",
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
      email: "luigi-restore@barsport.it",
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
    ownerBToken = await login(app.baseUrl!, "luigi-restore@barsport.it", PW);

    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-restore@hotel.it",
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
    collabToken = await login(app.baseUrl!, "collab-restore@hotel.it", PW);

    for (const [spec, assign] of [
      [SITE_A1, (id: string) => { siteA1Id = id; }],
      [SITE_A2, (id: string) => { siteA2Id = id; }],
    ] as const) {
      const res = await rawRequest(app.baseUrl!, "POST", `/v1/organizations/${orgAId}/managed-sites`, {
        token: ownerAToken,
        body: spec,
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(res.status).toBe(202);
      assign(res.body.data.siteId as string);
    }
    const resB = await rawRequest(app.baseUrl!, "POST", `/v1/organizations/${orgBId}/managed-sites`, {
      token: ownerBToken,
      body: SITE_B,
      headers: { "Idempotency-Key": randomUUID() },
    });
    expect(resB.status).toBe(202);
    siteBId = resB.body.data.siteId as string;

    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sim.backupState.holdJobs(false);
    sim.backupState.expireArchives();

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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("POST restore queues restore operation, updates row, records audit, triggers worker, and validates body/confirmName", async () => {
    const backupId = await seedBackup();
    const triggerSpy = vi.spyOn(app.outboxWorker, "triggerAsync");

    // Bad body cases
    const missingKey = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${backupId}/restore`, {
      body: { confirmName: SITE_A1.name },
    });
    expect(missingKey.status).toBe(400);

    const extraField = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${backupId}/restore`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: SITE_A1.name, force: true },
    });
    expect(extraField.status).toBe(400);

    const wrongName = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${backupId}/restore`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "Wrong Name" },
    });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe("VALIDATION_ERROR");
    expect(wrongName.body.error.message).toBe("Type the exact name of the site to restore it.");
    expect(wrongName.body.error.details[0]).toMatchObject({ field: "confirmName" });
    expect(await newAudits()).toHaveLength(0);

    // Accepted with surrounding whitespace in confirmName
    const res = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${backupId}/restore`, {
      headers: { "Idempotency-Key": "k-restore-1", "X-Request-Id": "req-restore-1" },
      body: { confirmName: `  ${SITE_A1.name}  ` },
    });
    expect(res.status).toBe(202);
    expect(findForbiddenPublicDtoKeys(res.body.data)).toEqual([]);
    const accepted: SiteBackupAcceptedDto = SiteBackupAcceptedDtoSchema.parse(res.body.data);
    expect(accepted.siteId).toBe(siteA1Id);
    expect(accepted.backupId).toBe(backupId);
    expect(res.body.links).toEqual({
      operation: `/v1/organizations/${orgAId}/operations/${accepted.operationId}`,
    });
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, accepted.operationId));
    expect(op).toMatchObject({
      kind: "site.backups.restore",
      status: "queued",
      resourceType: "site",
      resourceId: siteA1Id,
      lockKey: `site:${siteA1Id}`,
      requestedByUserId: ownerAUserId,
    });
    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, accepted.operationId));
    expect(steps.map((s) => s.key).sort()).toEqual(
      SITE_RESTORE_STEPS.map((s) => s.key).sort(),
    );
    const [evt] = await dbClient.db
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${accepted.operationId}`);
    expect(evt?.payload).toEqual({
      operationId: accepted.operationId,
      organizationId: orgAId,
      kind: "site.backups.restore",
      resourceType: "site",
      resourceId: siteA1Id,
      siteId: siteA1Id,
      backupId,
    });

    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    expect(row?.restoreOperationId).toBe(accepted.operationId);
    expect(row?.restoreStatus).toBe("running");
    expect(row?.restoreProblem).toBeNull();
    expect(row?.restoredAt).toBeNull();

    const audits = await newAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "site.backups.restore",
      actorType: "user",
      actorId: ownerAUserId,
      targetType: "site",
      targetId: siteA1Id,
      details: {
        outcome: "succeeded",
        requestId: "req-restore-1",
        backupId,
        operationId: accepted.operationId,
      },
    });
  });

  it("enforces exact check order on POST restore and POST download (404 -> 422 -> 400 not_configured -> 409 not_ready -> confirmName)", async () => {
    const failedId = await seedBackup({ status: "failed", problem: "other" });
    const runningId = await seedBackup({ status: "running", snapshotId: null });
    const noSnapId = await seedBackup({ status: "succeeded", snapshotId: null });
    const otherSiteBkpId = await seedBackup({ siteId: siteA2Id });
    const goodId = await seedBackup();

    // Put site in maintenance, remove settings, pass wrong confirmName: step 1 (backup lookup) MUST win with 404
    await dbClient.db.update(sites).set({ status: "maintenance" }).where(eq(sites.id, siteA1Id));
    await deleteBackupSettings(dbClient.db);

    for (const badId of [
      "not-a-backup-id",
      "bkp_1234",
      `bkp_${randomUUID()}`, // contains dashes, does not match ^bkp_[0-9a-f]{32}$
      `bkp_${"f".repeat(32)}`,
      failedId,
      runningId,
      noSnapId,
      otherSiteBkpId,
    ]) {
      const r1 = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${badId}/restore`, {
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "wrong" },
      });
      expect(r1.status, `restore ${badId}`).toBe(404);
      expect(r1.body.error.code).toBe("NOT_FOUND");
      expect(r1.body.error.message).toBe("Backup not found");

      const r2 = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${badId}/download`, {
        headers: { "Idempotency-Key": randomUUID() },
        body: {},
      });
      expect(r2.status, `download ${badId}`).toBe(404);
      expect(r2.body.error.message).toBe("Backup not found");

      const r3 = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${badId}/download`);
      expect(r3.status, `get download ${badId}`).toBe(404);
      expect(r3.body.error.message).toBe("Backup not found");
    }

    // Step 3: not_configured beats maintenance & wrong confirmName
    const notCfgRestore = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/restore`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: "wrong" },
    });
    expect(notCfgRestore.status).toBe(400);
    expect(notCfgRestore.body.error.code).toBe("VALIDATION_ERROR");
    expect(notCfgRestore.body.error.message).toBe("not_configured");

    const notCfgDl = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/download`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(notCfgDl.status).toBe(400);
    expect(notCfgDl.body.error.message).toBe("not_configured");

    // Step 4: deploying / maintenance beat wrong confirmName
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    for (const busyStatus of ["deploying", "maintenance"] as const) {
      await dbClient.db.update(sites).set({ status: busyStatus }).where(eq(sites.id, siteA1Id));
      const busyRestore = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/restore`, {
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: "wrong" },
      });
      expect(busyRestore.status).toBe(409);
      expect(busyRestore.body.error.code).toBe("RESOURCE_LOCKED");
      expect(busyRestore.body.error.message).toBe("not_ready");

      const busyDl = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/download`, {
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(busyDl.status).toBe(409);
      expect(busyDl.body.error.message).toBe("not_ready");
    }

    // Step 5: ready / stopped / degraded (after undo_incomplete per R80) allow restore without altering sites.status
    for (const allowedStatus of ["ready", "stopped", "degraded"] as const) {
      await dbClient.db.delete(operations);
      const bkp = await seedBackup();
      if (allowedStatus === "degraded") {
        const prevRestoreId = await seedBackup();
        const opId = `op_${randomUUID().replace(/-/g, "")}`;
        await dbClient.db.insert(operations).values({
          id: opId,
          organizationId: orgAId,
          kind: "site.backups.restore",
          status: "failed",
          resourceType: "site",
          resourceId: siteA1Id,
          lockKey: `site:${siteA1Id}`,
        });
        await insertSiteBackup(dbClient.db, {
          siteId: siteA1Id,
          kind: "manual",
          status: "running",
          operationId: null,
        });
        await dbClient.db
          .update(siteBackups)
          .set({
            restoreOperationId: opId,
            restoreStatus: "failed",
            restoreProblem: "undo_incomplete",
            restoredAt: new Date(),
          })
          .where(eq(siteBackups.id, prevRestoreId));
      }
      await dbClient.db.update(sites).set({ status: allowedStatus }).where(eq(sites.id, siteA1Id));
      const okRes = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp}/restore`, {
        headers: { "Idempotency-Key": randomUUID() },
        body: { confirmName: SITE_A1.name },
      });
      expect(okRes.status, `allowed site status ${allowedStatus}`).toBe(202);
      const [siteAfter] = await dbClient.db.select({ status: sites.status }).from(sites).where(eq(sites.id, siteA1Id));
      expect(siteAfter?.status).toBe(allowedStatus);
    }

    // Step 2: unsupported runtimeBackend beats missing settings, maintenance, wrong confirmName
    await deleteBackupSettings(dbClient.db);
    await dbClient.db.update(sites).set({ status: "maintenance" }).where(eq(sites.id, siteA1Id));
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
      const rDisabledRestore = await rawRequest(
        disabledApp.baseUrl!,
        "POST",
        `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/restore`,
        { token: ownerAToken, headers: { "Idempotency-Key": randomUUID() }, body: { confirmName: "wrong" } },
      );
      expect(rDisabledRestore.status).toBe(422);
      expect(rDisabledRestore.body.error.code).toBe("NOT_SUPPORTED");

      const rDisabledDl = await rawRequest(
        disabledApp.baseUrl!,
        "POST",
        `${baseUrlOf(orgAId, siteA1Id)}/${goodId}/download`,
        { token: ownerAToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
      );
      expect(rDisabledDl.status).toBe(422);
      expect(rDisabledDl.body.error.code).toBe("NOT_SUPPORTED");
    } finally {
      await disabledApp.close();
    }
  });

  it("handles idempotency replays, cross-backup / cross-kind conflicts, and site lock contention", async () => {
    const bkp1 = await seedBackup();
    const bkp2 = await seedBackup();

    const first = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": "k-idem-restore" },
      body: { confirmName: SITE_A1.name },
    });
    expect(first.status).toBe(202);
    const op1 = first.body.data.operationId as string;

    // Different key while site lock is held -> 409 RESOURCE_LOCKED
    const locked = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/restore`, {
      headers: { "Idempotency-Key": "k-other-key" },
      body: { confirmName: SITE_A1.name },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("RESOURCE_LOCKED");

    await snapshotAudits();

    // Replay same key on same backup while lock is still held -> 202 with same op, 0 audits, 0 ops
    const replaySame = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": "k-idem-restore" },
      body: { confirmName: SITE_A1.name },
    });
    expect(replaySame.status).toBe(202);
    expect(replaySame.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);

    // Same key on different backup -> 409 IDEMPOTENCY_CONFLICT
    const replayOtherBkp = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/restore`, {
      headers: { "Idempotency-Key": "k-idem-restore" },
      body: { confirmName: SITE_A1.name },
    });
    expect(replayOtherBkp.status).toBe(409);
    expect(replayOtherBkp.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // Same key on download -> 409 IDEMPOTENCY_CONFLICT
    const replayOtherKind = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-idem-restore" },
      body: {},
    });
    expect(replayOtherKind.status).toBe(409);
    expect(replayOtherKind.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("POST download queues prepare, reuses active preparing/ready archives, clears peer archive state, and rejects wrong-backup replay", async () => {
    const bkp1 = await seedBackup();
    const bkp2 = await seedBackup();
    const triggerSpy = vi.spyOn(app.outboxWorker, "triggerAsync");

    // Empty body (no JSON body at all) is accepted
    const prep1 = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp1" },
    });
    expect(prep1.status).toBe(202);
    const op1 = prep1.body.data.operationId as string;
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    const [row1AfterPrep] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, bkp1));
    expect(row1AfterPrep?.archiveOperationId).toBe(op1);
    expect(row1AfterPrep?.archiveStatus).toBe("preparing");

    const steps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op1));
    expect(steps.map((s) => s.key)).toEqual(SITE_ARCHIVE_STEPS.map((s) => s.key));

    // Reuse while preparing EVEN with a brand new key -> 202 existing op, 0 new audits, 0 new ops
    await snapshotAudits();
    const reusePreparing = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp1-second" },
      body: {},
    });
    expect(reusePreparing.status).toBe(202);
    expect(reusePreparing.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);

    // Mark op1 settled & bkp1 archive ready in future
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op1));
    await settleSiteArchive(dbClient.db, op1, {
      status: "ready",
      readyUntil: new Date(Date.now() + 30 * 60_000),
      problem: null,
    });

    // Reuse while ready and unexpired -> 202 existing op, 0 audits
    const reuseReady = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp1-third" },
      body: {},
    });
    expect(reuseReady.status).toBe(202);
    expect(reuseReady.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);

    // Unknown body key rejected with 400
    const badBody = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { extra: true },
    });
    expect(badBody.status).toBe(400);

    // Prepare backup 2: clears backup 1 archiveStatus/readyUntil/problem, retains archiveOperationId
    const prep2 = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp2" },
      body: {},
    });
    expect(prep2.status).toBe(202);
    const op2 = prep2.body.data.operationId as string;
    expect(op2).not.toBe(op1);

    const [row1Cleared] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, bkp1));
    expect(row1Cleared?.archiveOperationId).toBe(op1);
    expect(row1Cleared?.archiveStatus).toBeNull();
    expect(row1Cleared?.archiveReadyUntil).toBeNull();
    expect(row1Cleared?.archiveProblem).toBeNull();

    // Replaying backup 1's key on backup 2 (after op2 is done / anytime) fails with IDEMPOTENCY_CONFLICT
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op2));
    await settleSiteArchive(dbClient.db, op2, { status: "failed", readyUntil: null, problem: "other" });

    const conflictReplay = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp1" },
      body: {},
    });
    expect(conflictReplay.status).toBe(409);
    expect(conflictReplay.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    // Replaying backup 1's key on backup 1 (now cleared) succeeds cleanly with op1 & 0 new audits
    await snapshotAudits();
    const replayOk = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-dl-bkp1" },
      body: {},
    });
    expect(replayOk.status).toBe(202);
    expect(replayOk.body.data.operationId).toBe(op1);
    expect(await newAudits()).toHaveLength(0);
  });

  it("GET download enforces strict query, streams real simulator archive chunks with EOCD, audits offset=0 only, handles expiry and executor gone", async () => {
    const startedAt = new Date("2026-11-15T03:04:05.000Z");
    const snapId = await seedSimulatorSnapshot(siteA1Id, `op_${"a".repeat(32)}`);
    const bkpId = await seedBackup({ snapshotId: snapId, startedAt });

    // Null archive state -> 404 archive_gone
    const nullGet = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(nullGet.status).toBe(404);
    expect(nullGet.body.error.details[0]).toMatchObject({ reason: "archive_gone", message: "archive_gone" });

    // Strict query schema validation: SiteFileReadQuerySchema.omit({ path: true })
    for (const qs of ["?extra=1", "?path=wp-config.php", "?offset=-1", "?length=0", "?length=524289"]) {
      const badQ = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download${qs}`);
      expect(badQ.status, qs).toBe(400);
      expect(badQ.body.error.code).toBe("VALIDATION_ERROR");
    }

    // Queue prepare -> preparing -> 409 archive_preparing (executor must NOT be called)
    const prep = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(prep.status).toBe(202);
    const archiveOpId = prep.body.data.operationId as string;

    const simSpy = vi.spyOn(sim, "backups");
    const prepGet = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(prepGet.status).toBe(409);
    expect(prepGet.body.error.code).toBe("RESOURCE_LOCKED");
    expect(prepGet.body.error.details[0]).toMatchObject({ reason: "archive_preparing", message: "archive_preparing" });
    expect(simSpy).not.toHaveBeenCalled();

    // Prepare actual archive in simulator under plain archiveOpId (R78, no -archive suffix)
    await sim.backups({
      action: "archive",
      jobId: archiveOpId,
      siteId: siteA1Id,
      target: {
        endpoint: SETTINGS.endpoint,
        region: SETTINGS.region,
        bucket: SETTINGS.bucket,
        prefix: SETTINGS.prefix,
        accessKeyId: SETTINGS.accessKeyId,
        secretAccessKey: CANARY_SECRET,
      },
      snapshotId: snapId,
    });
    const simStatus = await sim.backups({ action: "status", jobId: archiveOpId });
    expect(simStatus.state).toBe("succeeded");
    const expiresAt = new Date(simStatus.archive!.expiresAt);
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, archiveOpId));
    await settleSiteArchive(dbClient.db, archiveOpId, {
      status: "ready",
      readyUntil: expiresAt,
      problem: null,
    });

    await snapshotAudits();
    simSpy.mockClear();

    // Read all chunks starting with default query on first chunk (offset=0, length=524288)
    const collected: Buffer[] = [];
    let offset = 0;
    const chunkSizes: number[] = [];
    for (;;) {
      const qs = offset === 0 ? "" : `?offset=${offset}&length=524288`;
      const res = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download${qs}`, {
        headers: { "X-Request-Id": `req-chunk-${chunkSizes.length}` },
      });
      expect(res.status).toBe(200);
      expect(findForbiddenPublicDtoKeys(res.body.data)).toEqual([]);
      const chunk = BackupArchiveChunkDtoSchema.parse(res.body.data);
      expect(chunk.fileName).toBe(backupArchiveFileName(SITE_A1.name, startedAt));
      const buf = Buffer.from(chunk.dataBase64, "base64");
      collected.push(buf);
      chunkSizes.push(chunk.size);
      offset += buf.byteLength;
      if (chunk.eof) {
        break;
      }
    }
    expect(chunkSizes).toEqual([1_048_577, 1_048_577, 1_048_577]);
    const fullArchive = Buffer.concat(collected);
    expect(fullArchive.byteLength).toBe(1_048_577);
    // Verify canonical 22-byte empty-zip EOCD at end of archive
    expect(fullArchive.subarray(fullArchive.byteLength - 22, fullArchive.byteLength - 18)).toEqual(
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    );
    expect(simSpy).toHaveBeenCalledWith({
      action: "readArchive",
      jobId: archiveOpId,
      offset: 0,
      length: 524_288,
    });

    // Audit written ONLY once for offset === 0
    const audits = await newAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "site.backups.download.fetched",
      actorType: "user",
      actorId: ownerAUserId,
      targetType: "site",
      targetId: siteA1Id,
      details: {
        outcome: "succeeded",
        requestId: "req-chunk-0",
        backupId: bkpId,
        operationId: archiveOpId,
        size: 1_048_577,
      },
    });

    // Executor drops archive while DB still thinks it is ready -> clears DB archive fields and returns 404 archive_gone
    sim.backupState.expireArchives();
    const goneFromExec = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(goneFromExec.status).toBe(404);
    expect(goneFromExec.body.error.details[0]).toMatchObject({ reason: "archive_gone" });

    const [clearedRow] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, bkpId));
    expect(clearedRow?.archiveStatus).toBeNull();
    expect(clearedRow?.archiveReadyUntil).toBeNull();

    // Executor RESOURCE_LOCKED -> 409 archive_preparing without leaking raw executor text
    await dbClient.db
      .update(siteBackups)
      .set({ archiveStatus: "ready", archiveReadyUntil: new Date(Date.now() + 60_000) })
      .where(eq(siteBackups.id, bkpId));
    sim.backupState.holdJobs(true);
    const heldOp = `op_${"b".repeat(32)}`;
    await sim.backups({
      action: "archive",
      jobId: heldOp,
      siteId: siteA1Id,
      target: {
        endpoint: SETTINGS.endpoint,
        region: SETTINGS.region,
        bucket: SETTINGS.bucket,
        prefix: SETTINGS.prefix,
        accessKeyId: SETTINGS.accessKeyId,
        secretAccessKey: CANARY_SECRET,
      },
      snapshotId: snapId,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ archiveOperationId: heldOp, archiveStatus: "ready", archiveReadyUntil: new Date(Date.now() + 60_000) })
      .where(eq(siteBackups.id, bkpId));
    const heldGet = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(heldGet.status).toBe(409);
    expect(heldGet.body.error.details[0]).toMatchObject({ reason: "archive_preparing" });

    // DB readyUntil expiry hides archive on GET without calling executor
    await dbClient.db
      .update(siteBackups)
      .set({ archiveOperationId: archiveOpId, archiveStatus: "ready", archiveReadyUntil: new Date(Date.now() - 1000) })
      .where(eq(siteBackups.id, bkpId));
    simSpy.mockClear();
    const expiredGet = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(expiredGet.status).toBe(404);
    expect(expiredGet.body.error.details[0]).toMatchObject({ reason: "archive_gone" });
    expect(simSpy).not.toHaveBeenCalled();

    // Executor generic failure never leaks host paths or internal messages
    await dbClient.db
      .update(siteBackups)
      .set({ archiveStatus: "ready", archiveReadyUntil: new Date(Date.now() + 60_000) })
      .where(eq(siteBackups.id, bkpId));
    simSpy.mockRejectedValueOnce(new Error("boom at /var/lib/hosting-panel/secret-socket"));
    const leakCheck = await call("GET", `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`);
    expect(leakCheck.status).toBe(503);
    expect(leakCheck.raw).not.toContain("/var/lib");
    expect(leakCheck.raw).not.toContain("secret-socket");
  });

  it("enforces auth, cross-tenant 404, collaborator 403 + denied audit, and suspended org 403 on all 3 new routes", async () => {
    const bkpId = await seedBackup();
    const routes = [
      { method: "POST", path: `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/restore`, body: { confirmName: SITE_A1.name } },
      { method: "POST", path: `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download`, body: {} },
      { method: "GET", path: `${baseUrlOf(orgAId, siteA1Id)}/${bkpId}/download` },
    ] as const;

    for (const r of routes) {
      const noAuth = await rawRequest(app.baseUrl!, r.method, r.path, {
        headers: { "Idempotency-Key": randomUUID() },
        ...(r.method === "POST" ? { body: r.body } : {}),
      });
      expect(noAuth.status).toBe(401);

      const crossOrg = await call(r.method, r.path, {
        token: ownerBToken,
        headers: { "Idempotency-Key": randomUUID() },
        ...(r.method === "POST" ? { body: r.body } : {}),
      });
      expect(crossOrg.status).toBe(404);

      await snapshotAudits();
      const collab = await call(r.method, r.path, {
        token: collabToken,
        headers: { "Idempotency-Key": randomUUID() },
        ...(r.method === "POST" ? { body: r.body } : {}),
      });
      expect(collab.status).toBe(403);
      const audits = await newAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toMatchObject({ outcome: "denied" });
    }

    await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgAId));
    for (const r of routes) {
      const susp = await call(r.method, r.path, {
        headers: { "Idempotency-Key": randomUUID() },
        ...(r.method === "POST" ? { body: r.body } : {}),
      });
      expect(susp.status).toBe(403);
      expect(susp.body.error.code).toBe("ORGANIZATION_SUSPENDED");
    }
  });

  it("populates siteUrl on enqueueBackupTx and computes lastRestore and archive visibility in GET /backups", async () => {
    const fixedNow = new Date("2026-11-15T10:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: fixedNow });

    // Create a manual backup via route and verify site_url copied from sites.wordpress_url
    const created = await call("POST", baseUrlOf(orgAId, siteA1Id), {
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(created.status).toBe(202);
    const createdId = created.body.data.backupId as string;
    const [siteRow] = await dbClient.db.select({ wordpressUrl: sites.wordpressUrl }).from(sites).where(eq(sites.id, siteA1Id));
    const [bkpRow] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, createdId));
    expect(bkpRow?.siteUrl).toBe(siteRow?.wordpressUrl);

    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(operations);

    const tOldStart = new Date("2026-11-15T01:00:00.000Z");
    const tNewStart = new Date("2026-11-15T02:00:00.000Z");
    const bkpOld = await seedBackup({ startedAt: tOldStart, snapshotId: SNAP_HEX_1 });
    const bkpNew = await seedBackup({ startedAt: tNewStart, snapshotId: SNAP_HEX_2 });

    // Initially lastRestore is null and archives are null
    const list1 = await call("GET", baseUrlOf(orgAId, siteA1Id));
    expect(list1.status).toBe(200);
    const dto1 = SiteBackupsDtoSchema.parse(list1.body.data);
    expect(dto1.lastRestore).toBeNull();
    expect(dto1.backups.map((b) => b.archive)).toEqual([null, null]);

    // Older backup finished restoring AFTER newer backup failed restore -> greatest restoredAt wins
    const restoreOldDone = new Date("2026-11-15T09:30:00.000Z");
    const restoreNewDone = new Date("2026-11-15T08:00:00.000Z");
    await dbClient.db
      .update(siteBackups)
      .set({
        restoreOperationId: "op_old_restore",
        restoreStatus: "succeeded",
        restoreProblem: "address_not_updated",
        restoredAt: restoreOldDone,
        archiveOperationId: "op_arch_ready",
        archiveStatus: "ready",
        archiveReadyUntil: new Date(fixedNow.getTime() + 60_000),
      })
      .where(eq(siteBackups.id, bkpOld));
    await dbClient.db
      .update(siteBackups)
      .set({
        restoreOperationId: "op_new_restore",
        restoreStatus: "failed",
        restoreProblem: "undo_incomplete",
        restoredAt: restoreNewDone,
        archiveOperationId: "op_arch_expired",
        archiveStatus: "ready",
        archiveReadyUntil: new Date(fixedNow.getTime() - 1),
      })
      .where(eq(siteBackups.id, bkpNew));

    const list2 = await call("GET", baseUrlOf(orgAId, siteA1Id));
    const dto2 = SiteBackupsDtoSchema.parse(list2.body.data);
    expect(dto2.lastRestore).toEqual({
      backupId: bkpOld,
      backupStartedAt: tOldStart.toISOString(),
      status: "succeeded",
      finishedAt: restoreOldDone.toISOString(),
      problem: "address_not_updated",
    });
    const oldItem = dto2.backups.find((b) => b.id === bkpOld)!;
    const newItem = dto2.backups.find((b) => b.id === bkpNew)!;
    expect(oldItem.archive).toEqual({
      status: "ready",
      readyUntil: new Date(fixedNow.getTime() + 60_000).toISOString(),
      problem: null,
    });
    // Expired archive is hidden as null
    expect(newItem.archive).toBeNull();

    // A currently running restore ALWAYS takes precedence over finished ones
    await dbClient.db
      .update(siteBackups)
      .set({
        restoreOperationId: "op_running_now",
        restoreStatus: "running",
        restoreProblem: null,
        restoredAt: null,
        archiveOperationId: "op_arch_failed",
        archiveStatus: "failed",
        archiveProblem: "no_space",
        archiveReadyUntil: null,
      })
      .where(eq(siteBackups.id, bkpNew));

    const list3 = await call("GET", baseUrlOf(orgAId, siteA1Id));
    const dto3 = SiteBackupsDtoSchema.parse(list3.body.data);
    expect(dto3.lastRestore).toEqual({
      backupId: bkpNew,
      backupStartedAt: tNewStart.toISOString(),
      status: "running",
      finishedAt: null,
      problem: null,
    });
    expect(dto3.backups.find((b) => b.id === bkpNew)?.archive).toEqual({
      status: "failed",
      readyUntil: null,
      problem: "no_space",
    });
  });

  it("enforces E11 limit of 6 customer heavy actions per site per hour, preserves rollback/replays/admin/nightly/other-site, and allows again after window", async () => {
    const startMs = new Date("2026-11-15T12:00:00.000Z").getTime();
    vi.useFakeTimers({ toFake: ["Date"], now: startMs });

    const bkp1 = await seedBackup({ startedAt: new Date(startMs - 10_000), snapshotId: SNAP_HEX_1 });
    const bkp2 = await seedBackup({ startedAt: new Date(startMs - 5_000), snapshotId: SNAP_HEX_2 });
    const otherSiteBkp = await seedBackup({ siteId: siteA2Id, startedAt: new Date(startMs - 5_000) });

    // Uncounted operations: 1 admin manual backup + 1 nightly backup on siteA1
    const adminRun = await rawRequest(app.baseUrl!, "POST", `/v1/admin/backups/sites/${siteA1Id}/run`, {
      token: adminToken,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    });
    expect(adminRun.status).toBe(202);
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null });
    await dbClient.db.transaction((tx) =>
      enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: orgAId,
        kind: "site.backups.create",
        resourceType: "site",
        resourceId: siteA1Id,
        lockKey: `site:${siteA1Id}`,
      }),
    );
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null });

    // 6 customer heavy actions spaced 5 minutes apart: create, create, restore, restore, download, download
    let firstCustomerSubmittedAtMs = 0;
    const keys: string[] = [];
    const actions: Array<() => Promise<HttpResult>> = [
      () => call("POST", baseUrlOf(orgAId, siteA1Id), { headers: { "Idempotency-Key": keys[0]! }, body: {} }),
      () => call("POST", baseUrlOf(orgAId, siteA1Id), { headers: { "Idempotency-Key": keys[1]! }, body: {} }),
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
          headers: { "Idempotency-Key": keys[2]! },
          body: { confirmName: SITE_A1.name },
        }),
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
          headers: { "Idempotency-Key": keys[3]! },
          body: { confirmName: SITE_A1.name },
        }),
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
          headers: { "Idempotency-Key": keys[4]! },
          body: {},
        }),
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
          headers: { "Idempotency-Key": keys[5]! },
          body: {},
        }),
    ];

    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(startMs + (i + 1) * 5 * 60_000);
      keys.push(`k-e11-${i}`);
      const res = await actions[i]!();
      expect(res.status, `customer action ${i}`).toBe(202);
      const opId = res.body.data.operationId as string;
      const [opRow] = await dbClient.db.select().from(operations).where(eq(operations.id, opId));
      if (i === 0) {
        firstCustomerSubmittedAtMs = opRow!.submittedAt.getTime();
      }
      // Settle lock & prepare/restore row states cleanly for the next step
      await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, opId));
      await settleSiteRestore(dbClient.db, opId, { status: "succeeded", problem: null });
      await settleSiteArchive(dbClient.db, opId, { status: "failed", readyUntil: null, problem: "other" });
    }

    // 7th action at T0 + 35 min -> refused across restore, create, AND prepareDownload on siteA1
    const checkMs = startMs + 35 * 60_000;
    vi.setSystemTime(checkMs);
    const expectedRetryAt = new Date(firstCustomerSubmittedAtMs + 60 * 60_000);
    const expectedIso = expectedRetryAt.toISOString();
    const expectedRetryAfter = String(Math.ceil((expectedRetryAt.getTime() - checkMs) / 1000));

    const opsBeforeRefusal = await dbClient.db.select().from(operations);
    const [bkp2Before] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, bkp2));
    await snapshotAudits();

    for (const req of [
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
          headers: { "Idempotency-Key": randomUUID() },
          body: { confirmName: SITE_A1.name },
        }),
      () =>
        call("POST", baseUrlOf(orgAId, siteA1Id), {
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        }),
      () =>
        call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        }),
    ]) {
      const refused = await req();
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(refused.body.error.message).toBe(
        `Too many backup actions on this site; try again at ${expectedIso}`,
      );
      expect(refused.body.error.details[0]).toEqual({
        field: "retryAt",
        reason: "too_many_requests",
        message: expectedIso,
      });
      expect(refused.headers.get("retry-after")).toBe(expectedRetryAfter);
    }

    // Rollback proof: 0 new ops, 0 new audits, bkp2 untouched
    expect(await dbClient.db.select().from(operations)).toHaveLength(opsBeforeRefusal.length);
    expect(await newAudits()).toHaveLength(0);
    const [bkp2After] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, bkp2));
    expect(bkp2After).toEqual(bkp2Before);

    // Idempotent replay STILL succeeds past the limit
    const replayRestore = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": keys[3]! },
      body: { confirmName: SITE_A1.name },
    });
    expect(replayRestore.status).toBe(202);

    // Different site (siteA2) is NOT blocked
    const otherSite = await call("POST", `${baseUrlOf(orgAId, siteA2Id)}/${otherSiteBkp}/restore`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: SITE_A2.name },
    });
    expect(otherSite.status).toBe(202);

    // Admin is exempt on siteA1 AND does not extend customer lock window
    const adminAllowed = await rawRequest(
      app.baseUrl!,
      "POST",
      `/v1/admin/backups/sites/${siteA1Id}/run`,
      { token: adminToken, headers: { "Idempotency-Key": randomUUID() }, body: {} },
    );
    expect(adminAllowed.status).toBe(202);
    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null });

    // Once window passes (> firstCustomerSubmittedAtMs + 60m), customer can act again
    vi.setSystemTime(expectedRetryAt.getTime() + 1000);
    const afterWindow = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": randomUUID() },
      body: { confirmName: SITE_A1.name },
    });
    expect(afterWindow.status).toBe(202);
  });

  it("R97: replays restore idempotency key by outbox backupId after a newer restore on the same backup, and rejects another backup with 409", async () => {
    const bkp1 = await seedBackup();
    const bkp2 = await seedBackup();

    const first = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": "k-r97-restore-1" },
      body: { confirmName: SITE_A1.name },
    });
    expect(first.status).toBe(202);
    const op1 = first.body.data.operationId as string;

    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op1));
    await settleSiteRestore(dbClient.db, op1, { status: "succeeded", problem: null });

    const second = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": "k-r97-restore-2" },
      body: { confirmName: SITE_A1.name },
    });
    expect(second.status).toBe(202);
    const op2 = second.body.data.operationId as string;
    expect(op2).not.toBe(op1);

    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op2));
    await settleSiteRestore(dbClient.db, op2, { status: "succeeded", problem: null });

    await snapshotAudits();

    // Same key + same backup after newer restore on that backup -> 202 with first operationId, 0 new audits.
    const replaySameBackup = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/restore`, {
      headers: { "Idempotency-Key": "k-r97-restore-1" },
      body: { confirmName: SITE_A1.name },
    });
    expect(replaySameBackup.status).toBe(202);
    expect(replaySameBackup.body.data.operationId).toBe(op1);
    expect(replaySameBackup.body.data.backupId).toBe(bkp1);
    expect(await newAudits()).toHaveLength(0);

    // Same key + another backup -> 409 IDEMPOTENCY_CONFLICT.
    const replayOtherBackup = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/restore`, {
      headers: { "Idempotency-Key": "k-r97-restore-1" },
      body: { confirmName: SITE_A1.name },
    });
    expect(replayOtherBackup.status).toBe(409);
    expect(replayOtherBackup.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("R97: replays download prepare idempotency key by outbox backupId after a newer preparation on the same backup, and rejects another backup with 409", async () => {
    const bkp1 = await seedBackup();
    const bkp2 = await seedBackup();

    const first = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-r97-dl-1" },
      body: {},
    });
    expect(first.status).toBe(202);
    const op1 = first.body.data.operationId as string;

    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op1));
    await settleSiteArchive(dbClient.db, op1, { status: "failed", readyUntil: null, problem: "timeout" });

    const second = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-r97-dl-2" },
      body: {},
    });
    expect(second.status).toBe(202);
    const op2 = second.body.data.operationId as string;
    expect(op2).not.toBe(op1);

    await dbClient.db.update(operations).set({ status: "succeeded", leaseExpiresAt: null }).where(eq(operations.id, op2));
    await settleSiteArchive(dbClient.db, op2, {
      status: "ready",
      readyUntil: new Date(Date.now() - 1_000),
      problem: null,
    });

    await snapshotAudits();

    // Same key + same backup after newer download preparation -> 202 with first operationId, 0 new audits.
    const replaySameBackup = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp1}/download`, {
      headers: { "Idempotency-Key": "k-r97-dl-1" },
      body: {},
    });
    expect(replaySameBackup.status).toBe(202);
    expect(replaySameBackup.body.data.operationId).toBe(op1);
    expect(replaySameBackup.body.data.backupId).toBe(bkp1);
    expect(await newAudits()).toHaveLength(0);

    // Same key + another backup -> 409 IDEMPOTENCY_CONFLICT.
    const replayOtherBackup = await call("POST", `${baseUrlOf(orgAId, siteA1Id)}/${bkp2}/download`, {
      headers: { "Idempotency-Key": "k-r97-dl-1" },
      body: {},
    });
    expect(replayOtherBackup.status).toBe(409);
    expect(replayOtherBackup.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
