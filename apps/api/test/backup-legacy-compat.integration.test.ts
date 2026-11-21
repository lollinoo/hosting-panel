import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  BackupSettingsDtoSchema,
  PLATFORM_OPS_ORG_ID,
  findForbiddenPublicDtoKeys,
  type BackupsIpcRequest,
} from "@hosting-panel/contracts";
import {
  LEGACY_BACKUP_TARGET_ID,
  backupPolicies,
  backupPolicyTargets,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  eq,
  operations,
  organizations,
  outboxEvents,
  siteBackupCopies,
  siteBackups,
  sites,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { BackupSchedulerService } from "../src/backups/backup-scheduler.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 13);
const PW = "correct horse battery";
const SECRET = "canary-compat-s3-secret-DO-NOT-LEAK-41";
const ROTATED_SECRET = "canary-compat-rotated-secret-DO-NOT-LEAK-42";
const OLD_BUCKET = "legacy-bucket";
const NEW_BUCKET = "legacy-bucket-v2";
const SETTINGS = {
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: OLD_BUCKET,
  prefix: "panel",
  accessKeyId: "AKIACOMPATTEST1",
  secretAccessKey: SECRET,
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SITE = {
  name: "Hotel Roma",
  domain: "hotelroma-compat.it",
  title: "Hotel Roma",
  adminUser: "admin",
  adminEmail: "admin@hotelroma-compat.it",
  adminPassword: "canary-Pass-123456",
};
/** The keys of the legacy `GET /v1/admin/backups` answer (pinned by admin-backups.integration.test.ts T1). */
const LEGACY_DTO_KEYS = [
  "accessKeyId",
  "available",
  "bucket",
  "configured",
  "endpoint",
  "lastNightlyRunOn",
  "lastPanelBackup",
  "lastTest",
  "newestBackupsTotalBytes",
  "prefix",
  "region",
  "retentionDays",
  "scheduleHourUtc",
  "secretAccessKeySet",
  "updatedAt",
];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function httpJson(
  baseUrl: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; key?: string },
): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = {};
  if (options?.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options?.key) headers["Idempotency-Key"] = options.key;
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
}

describe("legacy /v1/admin/backups compatibility (BKP-01, BKP-02, BKP-03, BKP-11, BKP-19)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let calls: BackupsIpcRequest[];
  let adminToken: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;

  const base = () => app.baseUrl!;
  const admin = (method: string, path: string, body?: unknown) =>
    httpJson(base(), method, path, { token: adminToken, ...(body === undefined ? {} : { body }) });
  const sitePath = () => `/v1/organizations/${orgId}/managed-sites/${siteId}`;
  const customer = (method: string, path: string, body?: unknown, key: string = randomUUID()) =>
    httpJson(base(), method, `${sitePath()}${path}`, { token: ownerToken, key, ...(body === undefined ? {} : { body }) });
  const saveLegacy = (patch: Record<string, unknown> = {}) => admin("PATCH", "/v1/admin/backups", { ...SETTINGS, ...patch });
  const targetRows = () => dbClient.db.select().from(backupTargets);
  const copyRows = () => dbClient.db.select().from(siteBackupCopies);

  /** A customer backup through the API, finished by the real simulator. */
  async function backupNow(): Promise<string> {
    const res = await customer("POST", "/backups", {});
    expect(res.status, res.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.backupId as string;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Legacy Compat",
      hostHostname: "panel-compat.test",
      hostIpv4: "10.0.0.1",
    });
    const root = await createServerAdmin(dbClient.db, KEY, { email: "admin-compat@x.it", name: "Admin", password: PW });

    sim = new InMemoryDockerSimulatorAdapter();
    calls = [];
    const realBackups = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      return realBackups(req);
    }) as typeof sim.backups;

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

    const login = await httpJson(base(), "POST", "/v1/auth/login", {
      body: {
        email: "admin-compat@x.it",
        password: PW,
        totpCode: totpCodeAt(root.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    adminToken = login.body.data.accessToken as string;
    const created = await admin("POST", "/v1/admin/customer-account", {
      organizationName: "Hotel Roma Compat Org",
      ownerEmail: "mario-compat@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "mario-compat@hotel.it");
    const ownerLogin = await httpJson(base(), "POST", "/v1/auth/login", {
      body: { email: "mario-compat@hotel.it", password: created.body.data.temporaryPassword as string },
    });
    ownerToken = ownerLogin.body.data.accessToken as string;
    const site = await httpJson(base(), "POST", `/v1/organizations/${orgId}/managed-sites`, {
      token: ownerToken,
      body: SITE,
      key: randomUUID(),
    });
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  beforeEach(async () => {
    calls.length = 0;
    await dbClient.db.delete(siteBackups);
    await dbClient.db.delete(outboxEvents);
    await dbClient.db.delete(operations);
    await dbClient.db.delete(organizations).where(eq(organizations.id, PLATFORM_OPS_ORG_ID));
    // A fresh install: no S3 settings, no target, default schedule, no nightly cursor.
    await dbClient.db.delete(backupPolicies).where(eq(backupPolicies.scope, "site"));
    await dbClient.db.delete(backupSettings);
    await dbClient.db.delete(backupPolicyTargets);
    await dbClient.db.delete(backupTargets);
    await dbClient.db
      .update(backupPolicies)
      .set({
        scheduleHourUtc: sql`CASE WHEN ${backupPolicies.scope} = 'default_site' THEN 2 END`,
        retentionDays: 14,
        lastNightlyRunOn: null,
        nightlyRunStartedAt: null,
      })
      .where(sql`${backupPolicies.scope} <> 'site'`);
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: "http://hotelroma-compat.it" }).where(eq(sites.id, siteId));
  });

  it("BKP-19/BKP-03: an old client saves, reads and rotates S3 credentials; backups keep using the same repository", async () => {
    const empty = await admin("GET", "/v1/admin/backups");
    expect(Object.keys(empty.body.data).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(empty.body.data.configured).toBe(false);

    const saved = await saveLegacy();
    expect(saved.status, saved.raw).toBe(200);
    expect(Object.keys(BackupSettingsDtoSchema.parse(saved.body.data)).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(saved.body.data).toMatchObject({
      configured: true,
      endpoint: SETTINGS.endpoint,
      bucket: OLD_BUCKET,
      prefix: "panel",
      accessKeyId: SETTINGS.accessKeyId,
      secretAccessKeySet: true,
    });
    expect(saved.raw).not.toContain(SECRET);
    expect(findForbiddenPublicDtoKeys(saved.body.data)).toEqual([]);

    // The legacy target is the deterministic target of the settings row, named by both default policies.
    const [legacy] = await targetRows();
    expect(legacy).toMatchObject({ id: LEGACY_BACKUP_TARGET_ID, legacySettings: true, enabled: true, archivedAt: null });
    const policyTargets = await dbClient.db.select().from(backupPolicyTargets);
    expect(policyTargets).toHaveLength(2);
    expect(policyTargets.every((p) => p.targetId === LEGACY_BACKUP_TARGET_ID && p.priority === 1)).toBe(true);
    const listed = await admin("GET", "/v1/admin/backup-targets");
    expect(listed.body.data.targets).toHaveLength(1);
    expect(listed.body.data.targets[0]).toMatchObject({ id: LEGACY_BACKUP_TARGET_ID, legacy: true, kind: "s3" });

    // BKP-03: the executor gets the frozen six-key S3 object (same repository and backup key inputs as before 0022).
    const backupId = await backupNow();
    const start = calls.find((c) => c.action === "start");
    expect(start && "target" in start ? start.target : null).toEqual({
      endpoint: SETTINGS.endpoint,
      region: SETTINGS.region,
      bucket: OLD_BUCKET,
      prefix: "panel",
      accessKeyId: SETTINGS.accessKeyId,
      secretAccessKey: SECRET,
    });
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, backupId));
    expect(row?.status).toBe("succeeded");
    const [copy] = await copyRows();
    expect(copy).toMatchObject({ backupId, targetId: LEGACY_BACKUP_TARGET_ID, status: "succeeded", snapshotId: row?.snapshotId });

    // Credential-only PATCH: same target, same repository, rotated in place; the history is untouched.
    expect((await admin("POST", "/v1/admin/backups/test", {})).status).toBe(200);
    const rotated = await saveLegacy({ accessKeyId: "AKIACOMPATROTATED", secretAccessKey: ROTATED_SECRET });
    expect(rotated.status, rotated.raw).toBe(200);
    expect(rotated.body.data).toMatchObject({ accessKeyId: "AKIACOMPATROTATED", bucket: OLD_BUCKET, lastTest: null });
    expect(rotated.raw).not.toContain(ROTATED_SECRET);
    expect((await targetRows()).map((t) => [t.id, t.archivedAt])).toEqual([[LEGACY_BACKUP_TARGET_ID, null]]);
    expect(await copyRows()).toHaveLength(1);
    calls.length = 0;
    expect((await admin("POST", "/v1/admin/backups/test", {})).status).toBe(200);
    expect(calls.find((c) => c.action === "test")).toMatchObject({
      target: { bucket: OLD_BUCKET, accessKeyId: "AKIACOMPATROTATED", secretAccessKey: ROTATED_SECRET },
    });
  });

  it("BKP-01/BKP-11: a new bucket archives the old target and keeps the old backups listed and restorable from the old repository", async () => {
    expect((await saveLegacy()).status).toBe(200);
    const oldBackupId = await backupNow();
    const [oldCopy] = await copyRows();
    expect(oldCopy).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, status: "succeeded" });
    const oldSnapshot = oldCopy!.snapshotId!;

    const changed = await saveLegacy({ bucket: NEW_BUCKET, secretAccessKey: undefined });
    expect(changed.status, changed.raw).toBe(200);
    expect(changed.body.data).toMatchObject({ configured: true, bucket: NEW_BUCKET, secretAccessKeySet: true, lastTest: null });
    expect(changed.raw).not.toContain(SECRET);

    // One live non-legacy target; the legacy target is archived and its settings row is frozen at the old location.
    const targets = await targetRows();
    const live = targets.filter((t) => t.archivedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ legacySettings: false, kind: "s3", enabled: true });
    const legacy = targets.find((t) => t.id === LEGACY_BACKUP_TARGET_ID)!;
    expect(legacy.archivedAt).not.toBeNull();
    expect(legacy.enabled).toBe(false);
    const [frozen] = await dbClient.db.select().from(backupSettings);
    expect(frozen).toMatchObject({ bucket: OLD_BUCKET });
    const policyTargets = await dbClient.db.select().from(backupPolicyTargets);
    expect(policyTargets.map((p) => p.targetId)).toEqual([live[0]!.id, live[0]!.id]);

    // The old backup and its copy are still there, same snapshot id, on the old target.
    expect((await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, oldBackupId))).length).toBe(1);
    expect(await copyRows()).toEqual([expect.objectContaining({ backupId: oldBackupId, targetId: LEGACY_BACKUP_TARGET_ID, snapshotId: oldSnapshot })]);
    const listedBackups = await customer("GET", "/backups");
    expect(listedBackups.body.data.configured).toBe(true);
    expect((listedBackups.body.data.backups as Json[]).map((b) => b.id)).toEqual([oldBackupId]);

    // A new backup goes to the new target (the secret was re-encrypted under the new target's own key context).
    calls.length = 0;
    const newBackupId = await backupNow();
    const start = calls.find((c) => c.action === "start");
    expect(start && "target" in start ? start.target : null).toMatchObject({ bucket: NEW_BUCKET, secretAccessKey: SECRET });
    expect((await copyRows()).find((c) => c.backupId === newBackupId)?.targetId).toBe(live[0]!.id);

    // POST /test tests the current (new) target and the result is stored on it.
    calls.length = 0;
    expect((await admin("POST", "/v1/admin/backups/test", {})).status).toBe(200);
    expect(calls.find((c) => c.action === "test")).toMatchObject({ target: { bucket: NEW_BUCKET } });
    const [liveAfterTest] = (await targetRows()).filter((t) => t.archivedAt === null);
    expect(liveAfterTest?.lastTestOutcome).toBe("ok");

    // BKP-11: restoring the old backup reaches the OLD repository with the SAME snapshot id.
    calls.length = 0;
    const restore = await customer("POST", `/backups/${oldBackupId}/restore`, { confirmName: SITE.name });
    expect(restore.status, restore.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const sent = calls.find((c) => c.action === "restore");
    expect(sent).toMatchObject({ snapshotId: oldSnapshot, target: { bucket: OLD_BUCKET, secretAccessKey: SECRET } });
    const [restored] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, oldBackupId));
    expect(restored).toMatchObject({ restoreStatus: "succeeded", restoreTargetId: LEGACY_BACKUP_TARGET_ID });
  });

  it("DELETE archives the S3 targets and keeps the whole history; an archived repository stays restorable", async () => {
    expect((await saveLegacy()).status).toBe(200);
    const backupId = await backupNow();
    const [copy] = await copyRows();

    const cleared = await admin("DELETE", "/v1/admin/backups");
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ configured: false, bucket: null, secretAccessKeySet: false, lastTest: null });
    expect(Object.keys(cleared.body.data).sort()).toEqual(LEGACY_DTO_KEYS);

    expect((await targetRows()).every((t) => t.archivedAt !== null && !t.enabled)).toBe(true);
    expect(await dbClient.db.select().from(backupPolicyTargets)).toEqual([]);
    expect(await dbClient.db.select().from(backupSettings)).toHaveLength(1);
    expect((await dbClient.db.select().from(siteBackups)).map((r) => r.id)).toEqual([backupId]);
    expect(await copyRows()).toEqual([expect.objectContaining({ id: copy!.id, status: "succeeded" })]);

    // No destination any more: a new backup is refused, the old one is still restorable.
    const refused = await customer("POST", "/backups", {});
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.error.details)).toContain("not_configured");
    expect((await admin("POST", "/v1/admin/backups/test", {})).status).toBe(400);

    const restore = await customer("POST", `/backups/${backupId}/restore`, { confirmName: SITE.name });
    expect(restore.status, restore.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(calls.find((c) => c.action === "restore")).toMatchObject({ snapshotId: copy!.snapshotId, target: { bucket: OLD_BUCKET } });

    // A later save is a new target (the archived legacy target is never revived, its frozen settings never rewritten).
    const again = await saveLegacy({ bucket: "after-delete-bucket" });
    expect(again.status, again.raw).toBe(200);
    expect(again.body.data).toMatchObject({ configured: true, bucket: "after-delete-bucket" });
    const [stillFrozen] = await dbClient.db.select().from(backupSettings);
    expect(stillFrozen).toMatchObject({ bucket: OLD_BUCKET });
    const live = (await targetRows()).filter((t) => t.archivedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ legacySettings: false });
    expect((await dbClient.db.select().from(backupPolicyTargets)).map((p) => p.targetId)).toEqual([live[0]!.id, live[0]!.id]);
  });

  it("DELETE archives only the S3 target the legacy view shows; another live S3 target stays live", async () => {
    expect((await saveLegacy()).status).toBe(200);
    const extra = await admin("POST", "/v1/admin/backup-targets", {
      kind: "s3",
      name: "Off-site",
      endpoint: "https://other.example.com",
      region: "eu-south-1",
      bucket: "other-bucket",
      prefix: "",
      accessKeyId: "AKIAOTHERTEST0001",
      secretAccessKey: "canary-other-secret-DO-NOT-LEAK-43",
    });
    expect(extra.status, extra.raw).toBe(201);
    const extraId = extra.body.data.id as string;
    // The newest live S3 target is the one the legacy view shows.
    expect((await admin("GET", "/v1/admin/backups")).body.data).toMatchObject({ bucket: "other-bucket" });

    expect((await admin("DELETE", "/v1/admin/backups")).status).toBe(200);

    const rows = await targetRows();
    expect(rows.find((t) => t.id === extraId)?.archivedAt).not.toBeNull();
    expect(rows.find((t) => t.id === LEGACY_BACKUP_TARGET_ID)?.archivedAt).toBeNull();
  });

  it("BKP-02 (API side): without any S3 settings a local target alone gets the nightly backup", async () => {
    const created = await admin("POST", "/v1/admin/backup-targets", { kind: "local", name: "On this server" });
    expect(created.status, created.raw).toBe(201);
    const localId = created.body.data.id as string;
    const policy = await admin("PATCH", "/v1/admin/backup-policies/default", { targetIds: [localId] });
    expect(policy.status, policy.raw).toBe(200);

    // The legacy S3 view says "not configured" while the site itself can back up.
    const legacyGet = await admin("GET", "/v1/admin/backups");
    expect(legacyGet.body.data).toMatchObject({ configured: false, secretAccessKeySet: false });
    expect((await customer("GET", "/backups")).body.data.configured).toBe(true);
    expect(await dbClient.db.select().from(backupSettings)).toEqual([]);

    const scheduler = app.nestApp.get(BackupSchedulerService);
    await scheduler.tick(new Date("2026-11-15T02:00:00.000Z"));
    const queued = (await dbClient.db.select().from(operations)).filter((o) => o.kind === "site.backups.create");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ resourceId: siteId });
    await app.outboxWorker.processPendingOnce();

    const [row] = await dbClient.db.select().from(siteBackups);
    expect(row).toMatchObject({ siteId, kind: "nightly", status: "succeeded" });
    expect(await copyRows()).toEqual([expect.objectContaining({ backupId: row!.id, targetId: localId, status: "succeeded" })]);
    const start = calls.find((c) => c.action === "start");
    expect(start && "target" in start ? start.target : null).toEqual({ kind: "local", targetId: localId });
  });

  it("a fresh install with no target at all schedules nothing: no run state, no rows, no audit", async () => {
    const scheduler = app.nestApp.get(BackupSchedulerService);
    await scheduler.tick(new Date("2026-11-15T02:00:00.000Z"));
    expect(await dbClient.db.select().from(siteBackups)).toEqual([]);
    expect((await dbClient.db.select().from(operations)).filter((o) => o.kind.startsWith("site.backups"))).toEqual([]);
    const [policy] = await dbClient.db.select().from(backupPolicies).where(eq(backupPolicies.scope, "default_site"));
    expect(policy).toMatchObject({ lastNightlyRunOn: null, nightlyRunStartedAt: null });
  });
});
