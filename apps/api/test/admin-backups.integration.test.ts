import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  AdminSiteBackupStatusDtoSchema,
  BackupSettingsDtoSchema,
  BackupSettingsInputSchema,
  BackupTestResultDtoSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  PLATFORM_OPS_ORG_ID,
  SiteBackupAcceptedDtoSchema,
  findForbiddenPublicDtoKeys,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  BACKUP_SECRET_AAD,
  LEGACY_BACKUP_TARGET_ID,
  auditEvents,
  backupPolicies,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  decryptSecretAesGcm,
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
  repairLegacyBackupCopies,
  settleSiteBackup,
  siteBackupCopies,
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
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { BackupSchedulerService } from "../src/backups/backup-scheduler.service.js";
import {
  BACKUP_LEASE_MS,
  BACKUP_POLL_GIVE_UP_MS,
  BACKUP_POLL_MS,
  SiteBackupsApplier,
} from "../src/backups/site-backups-applier.js";
import { SITE_BACKUP_PRUNE_STEPS } from "../src/backups/site-backups.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const SETUP = { installationName: "Admin Backups Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY_SECRET = "canary-admin-s3-secret-DO-NOT-LEAK-99";
const SECOND_SECRET = "canary-rotated-secret-DO-NOT-LEAK-77";
const SNAP_HEX_OK = "a".repeat(64);
const SNAP_HEX_OLD = "b".repeat(64);
const ADMIN_BACKUPS_BASE = "/v1/admin/backups";

const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "hotel-backups",
  prefix: "panel",
  accessKeyId: "AKIABACKUPADMIN1",
  secretAccessKey: CANARY_SECRET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};

const SITE_A1 = {
  name: "Hotel Roma",
  domain: "hotelroma-admin.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-admin.it",
  adminPassword: "canary-Pass-123456",
};

const SITE_A2 = {
  name: "Bar Napoli",
  domain: "barnapoli-admin.it",
  title: "Bar Napoli",
  adminUser: "admin",
  adminEmail: "admin@barnapoli-admin.it",
  adminPassword: "canary-Pass-123456",
};

const SITE_B = {
  name: "Caffe Milano",
  domain: "caffemilano-admin.it",
  title: "Caffe Milano",
  adminUser: "admin",
  adminEmail: "admin@caffemilano-admin.it",
  adminPassword: "canary-Pass-123456",
};

const SITE_DEPLOYING = {
  name: "Villa Firenze",
  domain: "villafirenze-admin.it",
  title: "Villa Firenze",
  adminUser: "admin",
  adminEmail: "admin@villafirenze-admin.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface ScriptedHandlers {
  onStart?: (req: Extract<BackupsIpcRequest, { action: "start" }>) => Promise<BackupJobStatus> | BackupJobStatus;
  onStatus?: (req: Extract<BackupsIpcRequest, { action: "status" }>) => Promise<BackupJobStatus> | BackupJobStatus;
  onForget?: (req: Extract<BackupsIpcRequest, { action: "forget" }>) => Promise<BackupJobStatus> | BackupJobStatus;
  onTest?: (
    req: Extract<BackupsIpcRequest, { action: "test" }>,
  ) => Promise<BackupsResultByAction["test"]> | BackupsResultByAction["test"];
}

interface BackupExecutorScript {
  readonly calls: BackupsIpcRequest[];
  reset(): void;
  setHandlers(handlers: ScriptedHandlers): void;
}

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
                snapshotId: SNAP_HEX_OK,
                bytesAdded: 1024,
                totalBytes: 8192,
                fileCount: 24,
                durationMs: 120,
              },
        } as BackupsResultByAction[R["action"]];
      }
      case "localInit":
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
    reset(): void {
      calls.length = 0;
      handlers = {};
    },
    setHandlers(next: ScriptedHandlers): void {
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

async function scanAllTablesForSecret(db: HostingPanelDatabase, secret: string): Promise<void> {
  const tableList = await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  for (const entry of tableList.rows) {
    const tableName = String(entry["table_name"]);
    if (!/^[a-z0-9_]+$/i.test(tableName)) {
      continue;
    }
    const rowsResult = await db.execute(sql.raw(`SELECT * FROM "${tableName}"`));
    expect(
      JSON.stringify(rowsResult.rows),
      `table ${tableName} leaked sentinel secret`,
    ).not.toContain(secret);
  }
}

/** Back to a fresh install: no target, no site policy, default schedule, no nightly cursor (history rows are deleted by the caller). */
async function resetBackupConfiguration(db: HostingPanelDatabase): Promise<void> {
  await db.delete(backupPolicies).where(eq(backupPolicies.scope, "site"));
  await db.delete(backupSettings);
  await db.execute(sql`DELETE FROM backup_policy_targets`);
  await db.delete(backupTargets);
  await db
    .update(backupPolicies)
    .set({
      scheduleHourUtc: sql`CASE WHEN ${backupPolicies.scope} = 'default_site' THEN ${DEFAULT_BACKUP_HOUR_UTC}::int END`,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
      lastNightlyRunOn: null,
      nightlyRunStartedAt: null,
    })
    .where(sql`${backupPolicies.scope} <> 'site'`);
}

describe("admin backups API, settings service, and nightly scheduler", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorScript: BackupExecutorScript;
  let app: ControlPlaneAppHandle;
  let applier: SiteBackupsApplier;
  let scheduler: BackupSchedulerService;
  let adminUserId: string;
  let adminToken: string;
  let orgAId: string;
  let orgBId: string;
  let ownerAToken: string;
  let collabToken: string;
  let siteA1Id: string;
  let siteA2Id: string;
  let siteBId: string;
  let siteDeployingId: string;
  let instId: string;
  let baselineAuditIds: Set<string>;
  const extraApps: ControlPlaneAppHandle[] = [];

  const callAdmin = (
    method: string,
    path: string = ADMIN_BACKUPS_BASE,
    options?: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: string | null;
    },
  ) => httpRequest(app.baseUrl!, method, path, { token: adminToken, ...options });

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
      email: "admin-backups-ops@x.it",
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
    scheduler = app.nestApp.get(BackupSchedulerService);

    adminToken = await login(app.baseUrl!, "admin-backups-ops@x.it", PW, admin.totpSecretBase32);

    const createdA = await httpRequest(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: {
        organizationName: "Hotel Roma Org",
        ownerEmail: "mario-admin-bak@hotel.it",
        ownerName: "Mario",
      },
    });
    expect(createdA.status).toBe(201);
    orgAId = createdA.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "mario-admin-bak@hotel.it");
    ownerAToken = await login(
      app.baseUrl!,
      "mario-admin-bak@hotel.it",
      createdA.body.data.temporaryPassword as string,
    );

    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    instId = inst!.id;

    // Second org on its own dedicated host
    const hostBId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostBId,
      platformInstallationId: instId,
      name: "panel-b-admin-bak.test",
      hostname: "panel-b-admin-bak.test",
      ipv4Address: "10.0.0.3",
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
      slug: "bar-sport-admin-bak-org",
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
      email: "luigi-admin-bak@barsport.it",
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
    const ownerBToken = await login(app.baseUrl!, "luigi-admin-bak@barsport.it", PW);

    // Collaborator in Org A
    const collabId = `usr_${randomUUID()}`;
    const collabMemId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({
      id: collabId,
      email: "collab-admin-bak@hotel.it",
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
    collabToken = await login(app.baseUrl!, "collab-admin-bak@hotel.it", PW);

    for (const [spec, assign] of [
      [SITE_A1, (id: string) => { siteA1Id = id; }],
      [SITE_A2, (id: string) => { siteA2Id = id; }],
      [SITE_DEPLOYING, (id: string) => { siteDeployingId = id; }],
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
    for (const extra of extraApps.splice(0)) {
      await extra.close();
    }
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    executorScript.reset();
    applier.leaseMs = BACKUP_LEASE_MS;
    applier.pollMs = BACKUP_POLL_MS;
    applier.pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;

    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operationSteps);
    await dbClient.db.delete(operations);
    await dbClient.db.delete(organizations).where(eq(organizations.id, PLATFORM_OPS_ORG_ID));
    await resetBackupConfiguration(dbClient.db);
    await dbClient.db.update(organizations).set({ status: "active" }).where(eq(organizations.id, orgAId));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA2Id));
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteBId));
    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteDeployingId));
    await snapshotAudits();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const extra of extraApps.splice(0)) {
      await extra.close();
    }
  });

  it("S1: validates BackupSettingsInputSchema with R56 keys, minimal defaults, and strict rejection", async () => {
    const minimal = BackupSettingsInputSchema.parse({
      endpoint: "https://s3.example.com",
      region: "eu-south-1",
      bucket: "hotel-backups",
      accessKeyId: "AKIA123456",
    });
    expect(minimal).toEqual({
      endpoint: "https://s3.example.com",
      region: "eu-south-1",
      bucket: "hotel-backups",
      prefix: "",
      accessKeyId: "AKIA123456",
      scheduleHourUtc: DEFAULT_BACKUP_HOUR_UTC,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    });

    const invalidCases: Array<[string, Record<string, unknown>, string]> = [
      ["endpoint", { endpoint: "http://127.0.0.1:9000" }, "endpoint_invalid"],
      ["region", { region: "EU_SOUTH" }, "region_invalid"],
      ["bucket", { bucket: "ab" }, "bucket_invalid"],
      ["prefix", { prefix: "/leading-slash" }, "prefix_invalid"],
      ["accessKeyId", { accessKeyId: "bad key" }, "access_key_id_invalid"],
      ["secretAccessKey", { secretAccessKey: "" }, "secret_access_key_invalid"],
      ["scheduleHourUtc", { scheduleHourUtc: 24 }, "schedule_hour_invalid"],
      ["retentionDays", { retentionDays: 0 }, "retention_days_invalid"],
    ];

    const validBase = {
      endpoint: SETTINGS.endpoint,
      region: SETTINGS.region,
      bucket: SETTINGS.bucket,
      accessKeyId: SETTINGS.accessKeyId,
    };

    for (const [field, override, messageKey] of invalidCases) {
      const parsed = BackupSettingsInputSchema.safeParse({ ...validBase, ...override });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe(messageKey);
      }

      const res = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
        body: { ...validBase, ...override },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ field, message: messageKey }),
      );
    }

    const extraField = BackupSettingsInputSchema.safeParse({ ...validBase, unexpected: true });
    expect(extraField.success).toBe(false);
    const strictHttp = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
      body: { ...validBase, unexpected: true },
    });
    expect(strictHttp.status).toBe(400);
  });

  it("T1: requires secretAccessKey on first save, encrypts at rest, omits secret from DTO/audit, and returns clean unconfigured defaults", async () => {
    const initial = await callAdmin("GET");
    expect(initial.status).toBe(200);
    expect(BackupSettingsDtoSchema.parse(initial.body.data)).toEqual({
      available: true,
      configured: false,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: "",
      accessKeyId: null,
      secretAccessKeySet: false,
      scheduleHourUtc: DEFAULT_BACKUP_HOUR_UTC,
      retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
      lastNightlyRunOn: null,
      lastTest: null,
      updatedAt: null,
      lastPanelBackup: null,
      newestBackupsTotalBytes: 0,
    });

    const { secretAccessKey: _omitted, ...withoutSecret } = SETTINGS;
    const missingSecret = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, { body: withoutSecret });
    expect(missingSecret.status).toBe(400);
    expect(missingSecret.body.error.code).toBe("VALIDATION_ERROR");
    expect(missingSecret.body.error.message).toBe("secret_access_key_required");
    expect(missingSecret.body.error.details).toEqual([
      { field: "secretAccessKey", message: "secret_access_key_required" },
    ]);

    const saved = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, { body: SETTINGS });
    expect(saved.status).toBe(200);
    const savedDto = BackupSettingsDtoSchema.parse(saved.body.data);
    expect(savedDto).toMatchObject({
      available: true,
      configured: true,
      endpoint: SETTINGS.endpoint,
      region: SETTINGS.region,
      bucket: SETTINGS.bucket,
      prefix: SETTINGS.prefix,
      accessKeyId: SETTINGS.accessKeyId,
      secretAccessKeySet: true,
      scheduleHourUtc: SETTINGS.scheduleHourUtc,
      retentionDays: SETTINGS.retentionDays,
      lastNightlyRunOn: null,
      lastTest: null,
    });
    expect(savedDto.updatedAt).not.toBeNull();
    expect(saved.raw).not.toContain(CANARY_SECRET);
    expect(findForbiddenPublicDtoKeys(saved.body.data)).toEqual([]);

    const got = await callAdmin("GET");
    expect(got.status).toBe(200);
    expect(BackupSettingsDtoSchema.parse(got.body.data).secretAccessKeySet).toBe(true);
    expect(got.raw).not.toContain(CANARY_SECRET);
    expect(findForbiddenPublicDtoKeys(got.body.data)).toEqual([]);

    const [row] = await dbClient.db.select().from(backupSettings);
    expect(row).toBeDefined();
    expect(row!.secretAccessKeyCiphertextBase64).not.toContain(CANARY_SECRET);
    expect(
      decryptSecretAesGcm({
        ciphertextBase64: row!.secretAccessKeyCiphertextBase64,
        ivBase64: row!.secretAccessKeyIvBase64,
        authTagBase64: row!.secretAccessKeyAuthTagBase64,
        masterKey: KEY,
        ...BACKUP_SECRET_AAD,
      }),
    ).toBe(CANARY_SECRET);

    const audits = await newAudits();
    const updateAudits = audits.filter((a) => a.action === "admin.backups.update");
    expect(updateAudits).toHaveLength(1);
    expect(updateAudits[0]!.targetType).toBe("backups");
    expect(updateAudits[0]!.targetId).toBeNull();
    expect(updateAudits[0]!.details).toEqual({
      secretChanged: true,
      targetChanged: false,
      scheduleHourUtc: SETTINGS.scheduleHourUtc,
      retentionDays: SETTINGS.retentionDays,
    });
    expect(JSON.stringify(audits)).not.toContain(CANARY_SECRET);
  });

  it("T2: keeps secret when omitted, resets lastTest, and (SPEC 7.2.5) a location change archives the old target and a DELETE archives, never deleting history", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    const tested = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`, { body: {} });
    expect(tested.status).toBe(200);
    expect((await callAdmin("GET")).body.data.lastTest).not.toBeNull();

    const { id: kept } = await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "manual",
      status: "running",
      operationId: null,
    });
    const keptIds = async () => (await dbClient.db.select({ id: siteBackups.id }).from(siteBackups)).map((r) => r.id);
    expect(await keptIds()).toEqual([kept]);

    // Update retention/hour without secret or target change: keeps key, test result, and backup rows
    const { secretAccessKey: _omitted, ...withoutSecret } = SETTINGS;
    const partial = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
      body: { ...withoutSecret, scheduleHourUtc: 4, retentionDays: 30 },
    });
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({
      secretAccessKeySet: true,
      scheduleHourUtc: 4,
      retentionDays: 30,
    });
    expect(partial.body.data.lastTest).not.toBeNull();
    expect(await keptIds()).toEqual([kept]);

    // Verify original canary secret is still preserved in IPC calls
    executorScript.reset();
    await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    const testCall = executorScript.calls.find((c) => c.action === "test");
    expect(testCall?.action === "test" && "secretAccessKey" in testCall.target && testCall.target.secretAccessKey).toBe(
      CANARY_SECRET,
    );

    // Bucket change without secret: a NEW target (secret re-encrypted under its own AAD), lastTest reset, history kept
    const targetChange = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
      body: { ...withoutSecret, bucket: "hotel-backups-v2" },
    });
    expect(targetChange.status).toBe(200);
    expect(targetChange.body.data).toMatchObject({
      bucket: "hotel-backups-v2",
      secretAccessKeySet: true,
      lastTest: null,
    });
    expect(await keptIds()).toEqual([kept]);
    const afterBucket = await dbClient.db.select().from(backupTargets);
    expect(afterBucket.filter((t) => t.archivedAt === null)).toHaveLength(1);
    const archivedLegacy = afterBucket.find((t) => t.id === LEGACY_BACKUP_TARGET_ID);
    expect(archivedLegacy).toMatchObject({ legacySettings: true, enabled: false });
    expect(archivedLegacy?.archivedAt).not.toBeNull();
    const [frozen] = await dbClient.db.select().from(backupSettings);
    expect(frozen).toMatchObject({ bucket: SETTINGS.bucket, prefix: SETTINGS.prefix });
    executorScript.reset();
    expect((await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`)).status).toBe(200);
    expect(executorScript.calls.find((c) => c.action === "test")).toMatchObject({
      target: { bucket: "hotel-backups-v2", prefix: SETTINGS.prefix, secretAccessKey: CANARY_SECRET },
    });

    const updateAudits = (await newAudits()).filter((a) => a.action === "admin.backups.update");
    expect(updateAudits.map((a) => a.details)).toEqual([
      { secretChanged: false, targetChanged: false, scheduleHourUtc: 4, retentionDays: 30 },
      { secretChanged: false, targetChanged: true, scheduleHourUtc: 2, retentionDays: 14 },
    ]);

    // Prefix change with a new secret: another new target, history still kept
    const prefixChange = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
      body: { ...withoutSecret, bucket: "hotel-backups-v2", prefix: "panel-2", secretAccessKey: SECOND_SECRET },
    });
    expect(prefixChange.status).toBe(200);
    expect(prefixChange.body.data).toMatchObject({ prefix: "panel-2", lastTest: null });
    expect(await keptIds()).toEqual([kept]);
    expect((await dbClient.db.select().from(backupTargets)).filter((t) => t.archivedAt === null)).toHaveLength(1);
    executorScript.reset();
    await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(executorScript.calls.find((c) => c.action === "test")).toMatchObject({
      target: { prefix: "panel-2", secretAccessKey: SECOND_SECRET },
    });

    // DELETE archives every S3 target; the settings row (frozen storage of the legacy target) and the history stay
    const deleted = await callAdmin("DELETE");
    expect(deleted.status).toBe(200);
    expect(BackupSettingsDtoSchema.parse(deleted.body.data)).toMatchObject({
      available: true,
      configured: false,
      secretAccessKeySet: false,
      bucket: null,
      lastTest: null,
    });
    expect((await dbClient.db.select().from(backupTargets)).every((t) => t.archivedAt !== null && !t.enabled)).toBe(true);
    expect(await dbClient.db.select().from(backupSettings)).toHaveLength(1);
    expect(await keptIds()).toEqual([kept]);

    const clearAudits = (await newAudits()).filter((a) => a.action === "admin.backups.clear");
    expect(clearAudits).toHaveLength(1);
    expect(clearAudits[0]!.targetType).toBe("backups");
    const liveBeforeClear = (await newAudits())
      .filter((a) => a.action === "admin.backup_target.create")
      .map((a) => (a.details as Json).targetId as string);
    expect(liveBeforeClear).toHaveLength(2);
    expect(clearAudits[0]!.details).toEqual({ archivedTargetIds: [liveBeforeClear[1]] });
  });

  it("T3: tests connectivity against decrypted target, records lastTest, handles not_configured and safe executor errors without leaking secrets", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }

    const unconfigured = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(unconfigured.status).toBe(400);
    expect(unconfigured.body.error.code).toBe("VALIDATION_ERROR");
    expect(unconfigured.body.error.message).toBe("not_configured");

    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });

    // 1. OK test
    const okRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(okRes.status).toBe(200);
    expect(BackupTestResultDtoSchema.parse(okRes.body.data)).toEqual({
      outcome: "ok",
      problem: null,
    });
    expect(okRes.raw).not.toContain(CANARY_SECRET);
    const ipcCall = executorScript.calls.find((c) => c.action === "test");
    expect(ipcCall).toEqual({
      action: "test",
      target: {
        endpoint: SETTINGS.endpoint,
        region: SETTINGS.region,
        bucket: SETTINGS.bucket,
        prefix: SETTINGS.prefix,
        accessKeyId: SETTINGS.accessKeyId,
        secretAccessKey: CANARY_SECRET,
      },
    });
    const afterOk = await callAdmin("GET");
    expect(afterOk.body.data.lastTest).toMatchObject({ outcome: "ok", problem: null });
    expect(typeof afterOk.body.data.lastTest.at).toBe("string");

    // 2. Failed connectivity test (auth_failed)
    executorScript.setHandlers({
      onTest: async () => ({ outcome: "failed", problem: "auth_failed" }),
    });
    const failRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(failRes.status).toBe(200);
    expect(BackupTestResultDtoSchema.parse(failRes.body.data)).toEqual({
      outcome: "failed",
      problem: "auth_failed",
    });
    const afterFail = await callAdmin("GET");
    expect(afterFail.body.data.lastTest).toMatchObject({ outcome: "failed", problem: "auth_failed" });

    // 3. Executor connection error & ambiguous timeout do not overwrite lastTest or leak host path/secret
    executorScript.setHandlers({
      onTest: async () => {
        throw Object.assign(
          new Error(`connect ECONNREFUSED /run/hp/docker.sock ${CANARY_SECRET}`),
          { code: "DOCKER_ENGINE_UNAVAILABLE" },
        );
      },
    });
    const downRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(downRes.status).toBe(503);
    expect(downRes.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(downRes.raw).not.toContain(CANARY_SECRET);
    expect(downRes.raw).not.toContain("/run/hp/");

    executorScript.setHandlers({
      onTest: async () => {
        throw Object.assign(
          new Error(`timeout /var/lib/secret ${CANARY_SECRET}`),
          { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true },
        );
      },
    });
    const ambRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(ambRes.body.error.code).toBe("OPERATION_AMBIGUOUS");
    expect(ambRes.raw).not.toContain(CANARY_SECRET);
    expect(ambRes.raw).not.toContain("/var/lib/");

    executorScript.setHandlers({
      onTest: async () => {
        throw Object.assign(new Error(`locked ${CANARY_SECRET}`), { code: "RESOURCE_LOCKED" });
      },
    });
    const lockedRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/test`);
    expect(lockedRes.status).toBe(409);
    expect(lockedRes.body.error.code).toBe("RESOURCE_LOCKED");
    expect(lockedRes.raw).not.toContain(CANARY_SECRET);

    const testAudits = (await newAudits()).filter((a) => a.action === "admin.backups.test");
    expect(testAudits.map((a) => a.details)).toEqual([
      { outcome: "ok", problem: null },
      { outcome: "failed", problem: "auth_failed" },
    ]);

    await scanAllTablesForSecret(dbClient.db, CANARY_SECRET);
    const renderedLogs = logs.map((args) => args.map(String).join(" ")).join("\n");
    expect(renderedLogs).not.toContain(CANARY_SECRET);
  });

  it("T8 (admin half): rejects unauthenticated calls with 401 and customer tokens with 403 on all admin backup routes", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["GET", ADMIN_BACKUPS_BASE],
      ["PATCH", ADMIN_BACKUPS_BASE, SETTINGS],
      ["DELETE", ADMIN_BACKUPS_BASE],
      ["POST", `${ADMIN_BACKUPS_BASE}/test`, {}],
      ["GET", `${ADMIN_BACKUPS_BASE}/sites`],
      ["POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {}],
    ];

    for (const [method, path, body] of routes) {
      const unauth = await httpRequest(app.baseUrl!, method, path, {
        ...(body !== undefined ? { body } : {}),
        headers: { "Idempotency-Key": randomUUID() },
      });
      expect(unauth.status, `${method} ${path} unauth`).toBe(401);

      for (const token of [ownerAToken, collabToken]) {
        const forbidden = await httpRequest(app.baseUrl!, method, path, {
          token,
          ...(body !== undefined ? { body } : {}),
          headers: { "Idempotency-Key": randomUUID() },
        });
        expect(forbidden.status, `${method} ${path} non-admin`).toBe(403);
      }
    }
  });

  it("T9 (admin half): checks runtimeBackend flag before validation and disables scheduler when backend is disabled", async () => {
    const disabledDb = createDatabaseClient({ mode: "pglite" });
    await disabledDb.migrate();
    await setupInstallation(disabledDb.db, SETUP);
    const disabledAdmin = await createServerAdmin(disabledDb.db, KEY, {
      email: "admin-disabled-bak@x.it",
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
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    try {
      const token = await login(
        disabledApp.baseUrl!,
        "admin-disabled-bak@x.it",
        PW,
        disabledAdmin.totpSecretBase32,
      );

      const got = await httpRequest(disabledApp.baseUrl!, "GET", ADMIN_BACKUPS_BASE, { token });
      expect(got.status).toBe(200);
      expect(BackupSettingsDtoSchema.parse(got.body.data).available).toBe(false);

      const sitesList = await httpRequest(disabledApp.baseUrl!, "GET", `${ADMIN_BACKUPS_BASE}/sites`, {
        token,
      });
      expect(sitesList.status).toBe(200);
      expect(sitesList.body.data).toEqual([]);

      // Invalid PATCH still returns 422 NOT_SUPPORTED first (flag checked before schema validation).
      const patchRes = await httpRequest(disabledApp.baseUrl!, "PATCH", ADMIN_BACKUPS_BASE, {
        token,
        body: { bad: "payload" },
      });
      expect(patchRes.status).toBe(422);
      expect(patchRes.body.error.code).toBe("NOT_SUPPORTED");

      const deleteRes = await httpRequest(disabledApp.baseUrl!, "DELETE", ADMIN_BACKUPS_BASE, {
        token,
      });
      expect(deleteRes.status).toBe(422);
      expect(deleteRes.body.error.code).toBe("NOT_SUPPORTED");

      const testRes = await httpRequest(disabledApp.baseUrl!, "POST", `${ADMIN_BACKUPS_BASE}/test`, {
        token,
      });
      expect(testRes.status).toBe(422);
      expect(testRes.body.error.code).toBe("NOT_SUPPORTED");

      // Missing Idempotency-Key still returns 422 NOT_SUPPORTED first.
      const runRes = await httpRequest(
        disabledApp.baseUrl!,
        "POST",
        `${ADMIN_BACKUPS_BASE}/sites/sit_missing/run`,
        { token, body: {} },
      );
      expect(runRes.status).toBe(422);
      expect(runRes.body.error.code).toBe("NOT_SUPPORTED");

      await upsertBackupSettings(disabledDb.db, KEY, { ...SETTINGS, updatedByUserId: disabledAdmin.userId });
      await disabledApp.nestApp.get(BackupSchedulerService).tick(new Date("2026-11-15T02:00:00Z"));
      expect(await disabledDb.db.select().from(operations)).toEqual([]);
    } finally {
      await disabledApp.close();
      await disabledDb.close();
    }
  });

  it("T10: scheduler runs nightly backups one site at a time, skips waiting locks, isolates busy sites, finishes overdue runs before starting next day, and keeps history and continues on the new target on a location change", async () => {
    const triggerSpy = vi.spyOn(app.outboxWorker, "triggerAsync");

    // 1. No target configured -> does nothing.
    await scheduler.tick(new Date("2026-11-15T02:00:00Z"));
    expect(await dbClient.db.select().from(operations)).toEqual([]);
    expect(triggerSpy).not.toHaveBeenCalled();

    // Configure settings with scheduleHourUtc = 2
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });

    // 2. Before schedule hour -> does nothing.
    await scheduler.tick(new Date("2026-11-15T01:59:59Z"));
    expect(await dbClient.db.select().from(operations)).toEqual([]);

    // 3. Put sites into ready / degraded / stopped / deploying states
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "degraded" }).where(eq(sites.id, siteA2Id));
    await dbClient.db.update(sites).set({ status: "stopped" }).where(eq(sites.id, siteBId));
    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteDeployingId));

    // Tick 1: starts the run and queues exactly ONE site.
    await scheduler.tick(new Date("2026-11-15T02:00:00Z"));
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    const opsAfterTick1 = await dbClient.db.select().from(operations);
    expect(opsAfterTick1).toHaveLength(1);
    expect(opsAfterTick1[0]?.kind).toBe("site.backups.create");
    const firstSiteId = opsAfterTick1[0]!.resourceId;
    expect([siteA1Id, siteA2Id, siteBId]).toContain(firstSiteId);

    const [settingsDuringRun] = await dbClient.db.select().from(backupSettings);
    expect(settingsDuringRun?.lastNightlyRunOn).toBe("2026-11-15");
    expect(settingsDuringRun?.nightlyRunStartedAt).not.toBeNull();
    expect((await newAudits()).filter((a) => a.action === "backups.nightly_run")).toEqual([]);

    // Tick 2 while 1st backup operation is active -> queues nothing; waiting sites stay unlocked.
    triggerSpy.mockClear();
    await scheduler.tick(new Date("2026-11-15T02:00:05Z"));
    expect(triggerSpy).not.toHaveBeenCalled();
    const activeOpsAfterTick2 = await dbClient.db.select().from(operations);
    expect(activeOpsAfterTick2).toHaveLength(1);
    const waitingSites = [siteA1Id, siteA2Id, siteBId].filter((id) => id !== firstSiteId);
    for (const waitingId of waitingSites) {
      expect(activeOpsAfterTick2.some((op) => op.lockKey === `site:${waitingId}`)).toBe(false);
    }

    // Prove a waiting site can actually take an operator action (used to fail with 409).
    const waitingSiteAId = [siteA1Id, siteA2Id].find((id) => id !== firstSiteId)!;
    const waitingRestart = await httpRequest(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgAId}/managed-sites/${waitingSiteAId}/actions`,
      {
        token: ownerAToken,
        body: { action: "restart" },
        headers: { "Idempotency-Key": randomUUID() },
      },
    );
    expect(waitingRestart.status).toBe(202);

    // Finish 1st backup + waiting restart, keeping siteA2 degraded before its own backup turn.
    await app.outboxWorker.processPendingOnce();
    if (waitingSiteAId === siteA2Id) {
      await dbClient.db.update(sites).set({ status: "degraded" }).where(eq(sites.id, siteA2Id));
    }

    // Tick 3 -> queues 2nd site; drain -> Tick 4 -> queues 3rd site; drain.
    triggerSpy.mockClear();
    await scheduler.tick(new Date("2026-11-15T02:00:10Z"));
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    await app.outboxWorker.processPendingOnce();

    triggerSpy.mockClear();
    await scheduler.tick(new Date("2026-11-15T02:00:15Z"));
    expect(triggerSpy).toHaveBeenCalledTimes(1);
    expect((await newAudits()).filter((a) => a.action === "backups.nightly_run")).toEqual([]);
    await app.outboxWorker.processPendingOnce();

    // Tick 5 -> all sites covered -> writes ONE audit event and clears nightlyRunStartedAt.
    triggerSpy.mockClear();
    await scheduler.tick(new Date("2026-11-15T02:00:20Z"));
    expect(triggerSpy).not.toHaveBeenCalled();

    const day1Rows = await dbClient.db.select().from(siteBackups);
    expect(day1Rows).toHaveLength(3);
    expect(day1Rows.map((r) => r.siteId).sort()).toEqual([siteA1Id, siteA2Id, siteBId].sort());
    expect(day1Rows.every((r) => r.kind === "nightly" && r.status === "succeeded")).toBe(true);
    const day1Order = [...day1Rows]
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .map((r) => r.siteId);

    const [settingsAfterDay1] = await dbClient.db.select().from(backupSettings);
    expect(settingsAfterDay1?.lastNightlyRunOn).toBe("2026-11-15");
    expect(settingsAfterDay1?.nightlyRunStartedAt).toBeNull();

    const runAudits = (await newAudits()).filter((a) => a.action === "backups.nightly_run");
    expect(runAudits).toHaveLength(1);
    expect(runAudits[0]).toMatchObject({
      actorId: null,
      actorType: "system",
      organizationId: null,
      targetType: "backups",
      targetId: null,
      details: { date: "2026-11-15", enqueued: 3, busy: 0, pruned: 0 },
    });

    // 4. Later tick on same UTC day -> no-op.
    triggerSpy.mockClear();
    await scheduler.tick(new Date("2026-11-15T03:00:00Z"));
    expect(await dbClient.db.select().from(siteBackups)).toHaveLength(3);
    expect(triggerSpy).not.toHaveBeenCalled();

    // 5. Next UTC day (2026-11-16): hold a non-backup lock on an early site and race Promise.all ticks.
    const busySiteId = day1Order[0] === siteBId ? day1Order[1]! : day1Order[0]!;
    const busyHold = await httpRequest(
      app.baseUrl!,
      "POST",
      `/v1/organizations/${orgAId}/managed-sites/${busySiteId}/actions`,
      {
        token: ownerAToken,
        body: { action: "restart" },
        headers: { "Idempotency-Key": randomUUID() },
      },
    );
    expect(busyHold.status).toBe(202);
    const busyOpId = busyHold.body.data.operationId as string;
    expect(busyOpId).toMatch(/^op_/);
    await dbClient.db
      .update(operations)
      .set({ status: "processing" })
      .where(eq(operations.id, busyOpId));
    await dbClient.db.delete(outboxEvents);

    const day2Start = new Date("2026-11-16T02:05:00Z");
    const opsCountBeforeDay2 = (await dbClient.db.select().from(operations)).length;
    await Promise.all([scheduler.tick(day2Start), scheduler.tick(day2Start)]);
    expect((await dbClient.db.select().from(operations)).length).toBe(opsCountBeforeDay2 + 1);

    let sawSameTickBusyAndNext = false;
    const checkBusySkip = async (previousCount: number) => {
      const day2Rows = (await dbClient.db.select().from(siteBackups)).filter(
        (r) => r.startedAt >= day2Start,
      );
      if (day2Rows.length - previousCount >= 2) {
        const recent = day2Rows.slice(previousCount);
        const busyRow = recent.find((r) => r.siteId === busySiteId);
        const queuedRow = recent.find((r) => r.siteId !== busySiteId && r.status === "running");
        if (busyRow?.problem === "site_busy" && busyRow.operationId === null && queuedRow) {
          sawSameTickBusyAndNext = true;
        }
      }
      return day2Rows.length;
    };

    let day2Seen = await checkBusySkip(0);
    await app.outboxWorker.processPendingOnce();
    for (let step = 1; step <= 4; step += 1) {
      await scheduler.tick(new Date(day2Start.getTime() + step * 5_000));
      day2Seen = await checkBusySkip(day2Seen);
      await app.outboxWorker.processPendingOnce();
    }

    expect(sawSameTickBusyAndNext).toBe(true);
    const day2Rows = (await dbClient.db.select().from(siteBackups)).filter(
      (r) => r.startedAt >= day2Start,
    );
    const busyRow = day2Rows.find((r) => r.siteId === busySiteId);
    expect(busyRow).toMatchObject({
      siteId: busySiteId,
      kind: "nightly",
      status: "failed",
      problem: "site_busy",
      operationId: null,
    });
    const queuedDay2 = day2Rows.filter((r) => r.siteId !== busySiteId);
    expect(queuedDay2).toHaveLength(2);
    expect(queuedDay2.every((r) => r.status === "succeeded" && r.operationId !== null)).toBe(true);

    const day2Audit = (await newAudits())
      .filter((a) => a.action === "backups.nightly_run")
      .at(-1);
    expect(day2Audit?.details).toEqual({
      date: "2026-11-16",
      enqueued: 2,
      busy: 1,
      pruned: 0,
    });

    await dbClient.db
      .update(operations)
      .set({ status: "succeeded" })
      .where(eq(operations.id, busyOpId));

    // 6. Late boot catch-up (09:15Z) starts Day 3; still active when Day 4 arrives -> finishes Day 3 first.
    const day3Start = new Date("2026-11-17T09:15:00Z");
    await scheduler.tick(day3Start);
    expect((await dbClient.db.select().from(backupSettings))[0]?.lastNightlyRunOn).toBe("2026-11-17");
    expect(
      (await dbClient.db.select().from(operations))
        .filter((o) => o.status === "queued" || o.status === "processing")
        .map((o) => o.kind),
    ).toEqual(["site.backups.create"]);
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-17T09:15:05Z"));
    expect(
      (await dbClient.db.select().from(operations))
        .filter((o) => o.status === "queued" || o.status === "processing")
        .map((o) => o.kind),
    ).toEqual(["site.backups.create"]);
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-17T09:15:10Z")); // 3rd site now active
    expect(
      (await dbClient.db.select().from(operations))
        .filter((o) => o.status === "queued" || o.status === "processing")
        .map((o) => o.kind),
    ).toEqual(["site.backups.create"]);
    expect((await dbClient.db.select().from(backupSettings))[0]?.nightlyRunStartedAt).not.toBeNull();

    await scheduler.tick(new Date("2026-11-18T02:00:00Z"));
    const [duringOverlap] = await dbClient.db.select().from(backupSettings);
    expect(duringOverlap?.lastNightlyRunOn).toBe("2026-11-17");
    expect(duringOverlap?.nightlyRunStartedAt).not.toBeNull();

    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-18T02:00:05Z")); // closes Day 3 first
    const day3Audit = (await newAudits())
      .filter((a) => a.action === "backups.nightly_run")
      .at(-1);
    expect(day3Audit?.details).toEqual({ date: "2026-11-17", enqueued: 3, busy: 0, pruned: 0 });
    const [betweenDays] = await dbClient.db.select().from(backupSettings);
    expect(betweenDays?.lastNightlyRunOn).toBe("2026-11-17");
    expect(betweenDays?.nightlyRunStartedAt).toBeNull();

    // Next tick starts Day 4 and queues its 1st site.
    await scheduler.tick(new Date("2026-11-18T02:00:10Z"));
    const [day4Started] = await dbClient.db.select().from(backupSettings);
    expect(day4Started?.lastNightlyRunOn).toBe("2026-11-18");
    expect(day4Started?.nightlyRunStartedAt).not.toBeNull();
    await app.outboxWorker.processPendingOnce();

    // 7. SPEC 7.2.5: a location change in the middle of a run keeps every row and copy (their target is archived, not
    //    deleted); the run goes on with the next site of the same night, whose copy is on the NEW target.
    const rowsBeforeChange = await dbClient.db.select().from(siteBackups);
    const patchTarget = await callAdmin("PATCH", ADMIN_BACKUPS_BASE, {
      body: { ...SETTINGS, bucket: "hotel-backups-v2" },
    });
    expect(patchTarget.status).toBe(200);

    await scheduler.tick(new Date("2026-11-18T02:00:15Z"));
    const rowsAfterTargetChange = await dbClient.db.select().from(siteBackups);
    expect(rowsAfterTargetChange).toHaveLength(rowsBeforeChange.length + 1);
    const before = new Set(rowsBeforeChange.map((r) => r.id));
    expect(rowsAfterTargetChange.filter((r) => before.has(r.id))).toHaveLength(rowsBeforeChange.length);
    const [fresh] = rowsAfterTargetChange.filter((r) => !before.has(r.id));
    expect(fresh).toMatchObject({ kind: "nightly", status: "running" });
    expect(fresh!.siteId).not.toBe(day1Order[0]);
    const targets = await dbClient.db.select().from(backupTargets);
    const live = targets.find((t) => t.archivedAt === null)!;
    expect(live.legacySettings).toBe(false);
    const copies = await dbClient.db.select().from(siteBackupCopies);
    expect(copies.find((c) => c.backupId === fresh!.id)?.targetId).toBe(live.id);
    expect(
      copies.filter((c) => before.has(c.backupId)).every((c) => c.targetId === LEGACY_BACKUP_TARGET_ID),
    ).toBe(true);
  });

  it("R74: after a forward clock jump is corrected, subsequent nights still queue the site and count only the new run", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteA1Id));
    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteA2Id));
    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteBId));

    const futureAt = new Date("2026-12-01T02:00:00.000Z");
    await insertSiteBackup(dbClient.db, {
      siteId: siteA1Id,
      kind: "nightly",
      status: "running",
      operationId: "op_r74_future_row",
      startedAt: futureAt,
    });
    await settleSiteBackup(dbClient.db, "op_r74_future_row", {
      status: "succeeded",
      snapshotId: SNAP_HEX_OLD,
      sizeBytes: 2048,
    });
    await dbClient.db
      .update(backupPolicies)
      .set({ lastNightlyRunOn: "2026-12-01" })
      .where(eq(backupPolicies.scope, "default_site"));

    // Night 1 after clock correction (2026-11-15): must queue siteA1Id and finish with enqueued: 1.
    await scheduler.tick(new Date("2026-11-15T02:00:00.000Z"));
    const opsNight1 = await dbClient.db.select().from(operations);
    expect(opsNight1).toHaveLength(1);
    expect(opsNight1[0]).toMatchObject({
      kind: "site.backups.create",
      resourceId: siteA1Id,
    });
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-15T02:00:05.000Z"));

    const night1Audit = (await newAudits())
      .filter((a) => a.action === "backups.nightly_run")
      .at(-1);
    expect(night1Audit?.details).toEqual({
      date: "2026-11-15",
      enqueued: 1,
      busy: 0,
      pruned: 0,
    });
    const [settingsAfterNight1] = await dbClient.db.select().from(backupSettings);
    expect(settingsAfterNight1?.lastNightlyRunOn).toBe("2026-11-15");
    expect(settingsAfterNight1?.nightlyRunStartedAt).toBeNull();

    // Night 2 after clock correction (2026-11-16): must queue siteA1Id again with enqueued: 1.
    await scheduler.tick(new Date("2026-11-16T02:00:00.000Z"));
    const opsNight2 = await dbClient.db.select().from(operations);
    expect(opsNight2).toHaveLength(2);
    await app.outboxWorker.processPendingOnce();
    await scheduler.tick(new Date("2026-11-16T02:00:05.000Z"));

    const nightlyAudits = (await newAudits()).filter((a) => a.action === "backups.nightly_run");
    expect(nightlyAudits).toHaveLength(2);
    expect(nightlyAudits[1]?.details).toEqual({
      date: "2026-11-16",
      enqueued: 1,
      busy: 0,
      pruned: 0,
    });

    const siteRows = await dbClient.db
      .select()
      .from(siteBackups)
      .where(eq(siteBackups.siteId, siteA1Id));
    expect(siteRows).toHaveLength(3);
    expect(siteRows.every((r) => r.kind === "nightly" && r.status === "succeeded")).toBe(true);
  });

  it("T12: scheduler queues site.backups.prune under org_platform_ops for deleted sites older than retention and outbox removes orphan rows", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }

    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });
    await dbClient.db.update(sites).set({ status: "deploying" }); // isolate orphan prune from site backups

    const orphanSiteId = `sit_${randomUUID()}`;
    const oldDate = new Date("2026-10-01T00:00:00Z");
    const { id: orphanRowId } = await insertSiteBackup(dbClient.db, {
      siteId: orphanSiteId,
      kind: "nightly",
      status: "running",
      operationId: null,
      startedAt: oldDate,
    });
    await dbClient.db
      .update(siteBackups)
      .set({ status: "succeeded", snapshotId: SNAP_HEX_OLD, sizeBytes: 4096, finishedAt: oldDate })
      .where(eq(siteBackups.id, orphanRowId));
    // Retention works per copy: the hand-seeded row gets its legacy copy, as the boot repair does after a rollback.
    await repairLegacyBackupCopies(dbClient.db);

    // Also add a recent orphan row within retention that must NOT trigger prune
    const recentOrphanSiteId = `sit_${randomUUID()}`;
    await insertSiteBackup(dbClient.db, {
      siteId: recentOrphanSiteId,
      kind: "nightly",
      status: "running",
      operationId: null,
      startedAt: new Date("2026-11-14T02:00:00Z"),
    });

    await scheduler.tick(new Date("2026-11-15T02:00:00Z"));

    const pruneOps = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.kind, "site.backups.prune"));
    expect(pruneOps).toHaveLength(1);
    expect(pruneOps[0]).toMatchObject({
      organizationId: PLATFORM_OPS_ORG_ID,
      resourceType: "site",
      resourceId: orphanSiteId,
      lockKey: `site:${orphanSiteId}`,
    });

    const pruneSteps = await dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, pruneOps[0]!.id));
    expect(pruneSteps.map((s) => ({ key: s.key, label: s.label }))).toEqual([...SITE_BACKUP_PRUNE_STEPS]);

    const runAudits = (await newAudits()).filter((a) => a.action === "backups.nightly_run");
    expect(runAudits[0]?.details).toEqual({
      date: "2026-11-15",
      enqueued: 0,
      busy: 0,
      pruned: 1,
    });
    const [settingsAfterPrune] = await dbClient.db.select().from(backupSettings);
    expect(settingsAfterPrune?.nightlyRunStartedAt).toBeNull();

    await app.outboxWorker.processPendingOnce();
    const [settledPrune] = await dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, pruneOps[0]!.id));
    expect(settledPrune?.status).toBe("succeeded");

    const forgetCall = executorScript.calls.find((c) => c.action === "forget");
    expect(forgetCall).toBeDefined();
    if (forgetCall?.action === "forget") {
      expect(forgetCall.snapshotIds).toEqual([SNAP_HEX_OLD]);
      expect("secretAccessKey" in forgetCall.target && forgetCall.target.secretAccessKey).toBe(CANARY_SECRET);
    }

    expect(
      await dbClient.db.select().from(siteBackups).where(eq(siteBackups.siteId, orphanSiteId)),
    ).toEqual([]);
    expect(
      await dbClient.db.select().from(siteBackups).where(eq(siteBackups.siteId, recentOrphanSiteId)),
    ).toHaveLength(1);

    await scanAllTablesForSecret(dbClient.db, CANARY_SECRET);
    expect(logs.map((args) => args.map(String).join(" ")).join("\n")).not.toContain(CANARY_SECRET);
  });

  it("T14: GET /sites joins only existing sites and POST /sites/:siteId/run queues with admin.site.backups.create", async () => {
    await upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: adminUserId });

    // Orphan backup rows for a deleted site must be excluded from GET /v1/admin/backups/sites.
    const orphanSiteId = `sit_${randomUUID()}`;
    await insertSiteBackup(dbClient.db, {
      siteId: orphanSiteId,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "unreachable",
    });

    // Insert a failed attempt row for siteA2 so lastAttemptAt/lastStatus/problem populate.
    await insertSiteBackup(dbClient.db, {
      siteId: siteA2Id,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "site_busy",
      startedAt: new Date("2026-11-14T02:00:00Z"),
    });

    // Missing Idempotency-Key or unexpected body fields -> 400
    const missingKey = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {
      body: {},
    });
    expect(missingKey.status).toBe(400);

    const extraField = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {
      headers: { "Idempotency-Key": "k-admin-extra" },
      body: { unexpected: true },
    });
    expect(extraField.status).toBe(400);

    // Unknown site -> 404
    const missingSite = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/sit_missing/run`, {
      headers: { "Idempotency-Key": "k-admin-missing" },
      body: {},
    });
    expect(missingSite.status).toBe(404);

    // Deploying site -> 409 not_ready
    const notReady = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteDeployingId}/run`, {
      headers: { "Idempotency-Key": "k-admin-not-ready" },
      body: {},
    });
    expect(notReady.status).toBe(409);

    // Trigger outbox spy and POST with completely empty body (no Content-Type/body)
    const triggerSpy = vi.spyOn(app.outboxWorker, "triggerAsync");
    const runRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {
      headers: { "Idempotency-Key": "k-admin-run-1" },
      rawBody: null,
    });
    expect(runRes.status).toBe(202);
    const accepted = SiteBackupAcceptedDtoSchema.parse(runRes.body.data);
    expect(accepted.siteId).toBe(siteA1Id);
    expect(runRes.body.links).toEqual({
      operation: `/v1/organizations/${orgAId}/operations/${accepted.operationId}`,
    });
    expect(triggerSpy).toHaveBeenCalledTimes(1);

    // Idempotent replay with {} body -> same ids, single audit event
    const replayRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {
      headers: { "Idempotency-Key": "k-admin-run-1" },
      body: {},
    });
    expect(replayRes.status).toBe(202);
    expect(replayRes.body.data).toEqual(runRes.body.data);

    // Second concurrent POST while running -> 409
    const busyRes = await callAdmin("POST", `${ADMIN_BACKUPS_BASE}/sites/${siteA1Id}/run`, {
      headers: { "Idempotency-Key": "k-admin-run-2" },
      body: {},
    });
    expect(busyRes.status).toBe(409);

    // GET /sites while siteA1 is running
    const listDuring = await callAdmin("GET", `${ADMIN_BACKUPS_BASE}/sites`);
    expect(listDuring.status).toBe(200);
    const itemsDuring = (listDuring.body.data as unknown[]).map((row) =>
      AdminSiteBackupStatusDtoSchema.parse(row),
    );
    expect(itemsDuring.some((r) => r.siteId === orphanSiteId)).toBe(false);
    const rowA1During = itemsDuring.find((r) => r.siteId === siteA1Id);
    expect(rowA1During).toMatchObject({
      siteId: siteA1Id,
      siteName: SITE_A1.name,
      organizationId: orgAId,
      lastStatus: "running",
      lastSuccessAt: null,
      problem: null,
      runningOperationId: accepted.operationId,
    });
    const rowA2During = itemsDuring.find((r) => r.siteId === siteA2Id);
    expect(rowA2During).toMatchObject({
      siteId: siteA2Id,
      lastStatus: "failed",
      lastSuccessAt: null,
      problem: "site_busy",
      runningOperationId: null,
    });

    // Execute outbox worker and verify completion on GET /sites and audit action prefix
    await app.outboxWorker.processPendingOnce();

    const listAfter = await callAdmin("GET", `${ADMIN_BACKUPS_BASE}/sites`);
    expect(listAfter.status).toBe(200);
    const rowA1After = (listAfter.body.data as Array<Record<string, unknown>>).find(
      (r) => r["siteId"] === siteA1Id,
    );
    expect(rowA1After).toMatchObject({
      siteId: siteA1Id,
      lastStatus: "succeeded",
      problem: null,
      runningOperationId: null,
    });
    expect(typeof rowA1After?.["lastSuccessAt"]).toBe("string");

    const adminCreateAudits = (await newAudits()).filter((a) => a.action === "admin.site.backups.create");
    expect(adminCreateAudits).toHaveLength(1);
    expect(adminCreateAudits[0]!.targetId).toBe(siteA1Id);
    expect(JSON.stringify(adminCreateAudits)).not.toContain(CANARY_SECRET);
  });

  it("wires HP_BACKUP_SCHEDULE_INTERVAL_MS default on linux-systemd when listening and stops scheduler before outbox", async () => {
    const prevEnv = process.env["HP_BACKUP_SCHEDULE_INTERVAL_MS"];
    const jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();

    try {
      delete process.env["HP_BACKUP_SCHEDULE_INTERVAL_MS"];
      const linuxApp = await createControlPlaneApp({
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
      extraApps.push(linuxApp);
      expect(
        linuxApp.nestApp.get<ControlPlaneRuntimeConfig>(CONTROL_PLANE_CONFIG_TOKEN)
          .backupScheduleIntervalMs,
      ).toBe(5_000);

      const stopOrder: string[] = [];
      const origSchedulerStop = linuxApp.backupScheduler.stop.bind(linuxApp.backupScheduler);
      const origOutboxStop = linuxApp.outboxWorker.stop.bind(linuxApp.outboxWorker);
      vi.spyOn(linuxApp.backupScheduler, "stop").mockImplementation(async () => {
        stopOrder.push("scheduler");
        return origSchedulerStop();
      });
      vi.spyOn(linuxApp.outboxWorker, "stop").mockImplementation(async () => {
        stopOrder.push("outbox");
        return origOutboxStop();
      });
      await linuxApp.close();
      expect(stopOrder).toEqual(["scheduler", "outbox"]);

      process.env["HP_BACKUP_SCHEDULE_INTERVAL_MS"] = "2500";
      const customApp = await createControlPlaneApp({
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
      extraApps.push(customApp);
      expect(
        customApp.nestApp.get<ControlPlaneRuntimeConfig>(CONTROL_PLANE_CONFIG_TOKEN)
          .backupScheduleIntervalMs,
      ).toBe(2500);
      await customApp.close();

      const nonListeningApp = await createControlPlaneApp({
        listen: false,
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
      extraApps.push(nonListeningApp);
      expect(
        nonListeningApp.nestApp.get<ControlPlaneRuntimeConfig>(CONTROL_PLANE_CONFIG_TOKEN)
          .backupScheduleIntervalMs,
      ).toBeNull();

      let releaseTick!: () => void;
      const tickGate = new Promise<void>((resolve) => {
        releaseTick = resolve;
      });
      const loopSpy = vi
        .spyOn(nonListeningApp.backupScheduler, "tick")
        .mockImplementation(() => tickGate);
      try {
        nonListeningApp.backupScheduler.startBackgroundLoop(10);
        await new Promise((resolve) => setTimeout(resolve, 45));
        expect(loopSpy).toHaveBeenCalledTimes(1);
      } finally {
        releaseTick();
        await nonListeningApp.close();
      }
    } finally {
      if (prevEnv === undefined) {
        delete process.env["HP_BACKUP_SCHEDULE_INTERVAL_MS"];
      } else {
        process.env["HP_BACKUP_SCHEDULE_INTERVAL_MS"] = prevEnv;
      }
    }
  });
});
