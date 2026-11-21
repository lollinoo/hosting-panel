import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BackupSettingsDtoSchema,
  PLATFORM_OPS_ORG_ID,
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
  resolveMigrationsDirectory,
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

// QA of the legacy backup contract after M3 (HCP-SPEC-004 BKP-01, BKP-03, BKP-11, BKP-19, BKP-02 API side). The
// settings below are the ones of the frozen pins (fixtures/site-type-pins/backup-requests.json, restore-requests.json),
// so a request the executor gets can be compared to the pin value for value.
const KEY = Buffer.alloc(32, 29);
const PW = "correct horse battery";
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "pins-bucket",
  prefix: "panel/pins",
  accessKeyId: "SENTINELACCESSKEY01",
  secretAccessKey: "sentinel-secret-access-key-0001",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SITE = {
  name: "Hotel Napoli",
  domain: "hotelnapoli-qa.it",
  title: "Hotel Napoli",
  adminUser: "admin",
  adminEmail: "admin@hotelnapoli-qa.it",
  adminPassword: "canary-Pass-123456",
};
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

const pinArgs = (file: string, index: number): Json => {
  const pin = JSON.parse(readFileSync(new URL(`./fixtures/site-type-pins/${file}`, import.meta.url), "utf8")) as {
    calls: Array<{ args: Json[] }>;
  };
  return pin.calls[index]!.args[0]!;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Json)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
};
/** The pin tokens for the values that are random by design (the pins test tokenizes them the same way). */
function pinForm(request: unknown): Json {
  const out = JSON.parse(JSON.stringify(request)) as Json;
  // The pins test strips siteType (added after the pins were frozen); it is the site's own type, not target data.
  delete out.siteType;
  if (typeof out.jobId === "string") out.jobId = "op_<id:1>";
  if (typeof out.serviceInstanceId === "string") out.serviceInstanceId = "svc_<id:2>";
  if (typeof out.siteId === "string") out.siteId = "site_<id:3>";
  if (typeof out.snapshotId === "string") out.snapshotId = "<id:4>";
  if (out.target && typeof out.target === "object") {
    if (typeof out.target.accessKeyId === "string") out.target.accessKeyId = "<secret:1>";
    if (typeof out.target.secretAccessKey === "string") out.target.secretAccessKey = "<secret:2>";
  }
  return out;
}

async function httpJson(
  baseUrl: string,
  method: string,
  p: string,
  options?: { token?: string; body?: unknown; key?: string },
): Promise<{ status: number; body: Json; raw: string }> {
  const headers: Record<string, string> = {};
  if (options?.token) headers["Authorization"] = `Bearer ${options.token}`;
  if (options?.key) headers["Idempotency-Key"] = options.key;
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
}

describe("QA: an install with S3 history keeps working through the legacy contract (BKP-01/03/11/19)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let calls: BackupsIpcRequest[];
  let adminToken: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;

  const base = () => app.baseUrl!;
  const admin = (method: string, p: string, body?: unknown) =>
    httpJson(base(), method, p, { token: adminToken, ...(body === undefined ? {} : { body }) });
  const sitePath = () => `/v1/organizations/${orgId}/managed-sites/${siteId}`;
  const customer = (method: string, p: string, body?: unknown) =>
    httpJson(base(), method, `${sitePath()}${p}`, { token: ownerToken, key: randomUUID(), ...(body === undefined ? {} : { body }) });
  const saveLegacy = (patch: Record<string, unknown> = {}) => admin("PATCH", "/v1/admin/backups", { ...SETTINGS, ...patch });
  const targetRows = () => dbClient.db.select().from(backupTargets);
  const copyRows = () => dbClient.db.select().from(siteBackupCopies);
  const callsOf = <A extends BackupsIpcRequest["action"]>(action: A) =>
    calls.filter((c): c is Extract<BackupsIpcRequest, { action: A }> => c.action === action);

  async function backupNow(): Promise<string> {
    const res = await customer("POST", "/backups", {});
    expect(res.status, res.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.backupId as string;
  }

  /**
   * Takes the database back to what an install had before 0022 ran: backup_settings and site_backups only (no target,
   * no policy target, no copy). Then runs the backfill part of the real migration file, statement by statement.
   */
  async function backfillLikeMigration0022(): Promise<void> {
    await dbClient.db.delete(siteBackupCopies);
    await dbClient.db.delete(backupPolicyTargets);
    await dbClient.db.delete(backupTargets);
    expect(await targetRows()).toEqual([]);
    const text = readFileSync(path.join(resolveMigrationsDirectory(), "0022_backup_targets_and_copies.sql"), "utf8");
    const tail = text.slice(text.indexOf("-- Legacy S3 backfill"));
    expect(tail.length).toBeGreaterThan(100);
    const statements = tail
      .split(/;[ \t]*\n/)
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, "").trim() !== "");
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) await dbClient.db.execute(sql.raw(statement));
  }

  /**
   * S3 history of an old install: two real backups (the second one re-labelled 'partial', a status the previous release
   * could write) and an old failed row without snapshot.
   */
  async function seedLegacyHistory(): Promise<{ first: string; second: string; failed: string; snapshots: Map<string, string | null> }> {
    expect((await saveLegacy()).status).toBe(200);
    const first = await backupNow();
    const second = await backupNow();
    await dbClient.db.update(siteBackups).set({ status: "partial" as never }).where(eq(siteBackups.id, second));
    const failed = `bkp_${randomBytes(16).toString("hex")}`;
    await dbClient.db.insert(siteBackups).values({
      id: failed,
      siteId,
      kind: "manual",
      status: "failed",
      problem: "backup_failed" as never,
      startedAt: new Date("2026-11-02T01:00:00Z"),
      finishedAt: new Date("2026-11-02T01:05:00Z"),
    });
    await backfillLikeMigration0022();
    const snapshots = new Map((await dbClient.db.select().from(siteBackups)).map((r) => [r.id, r.snapshotId]));
    return { first, second, failed, snapshots };
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, {
      installationName: "Legacy Compat QA",
      hostHostname: "panel-compat-qa.test",
      hostIpv4: "10.0.0.2",
    });
    const root = await createServerAdmin(dbClient.db, KEY, { email: "admin-compat-qa@x.it", name: "Admin", password: PW });

    sim = new InMemoryDockerSimulatorAdapter();
    calls = [];
    const realBackups = sim.backups.bind(sim);
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(JSON.parse(JSON.stringify(req)) as BackupsIpcRequest);
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
        email: "admin-compat-qa@x.it",
        password: PW,
        totpCode: totpCodeAt(root.totpSecretBase32, Math.floor(Date.now() / 30_000)),
      },
    });
    adminToken = login.body.data.accessToken as string;
    const created = await admin("POST", "/v1/admin/customer-account", {
      organizationName: "Hotel Napoli Compat Org",
      ownerEmail: "mario-compat-qa@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "mario-compat-qa@hotel.it");
    const ownerLogin = await httpJson(base(), "POST", "/v1/auth/login", {
      body: { email: "mario-compat-qa@hotel.it", password: created.body.data.temporaryPassword as string },
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
    await dbClient.db.update(sites).set({ status: "ready", siteUrl: "http://hotelnapoli-qa.it" }).where(eq(sites.id, siteId));
  });

  it("BKP-01: the 0022 backfill of an S3 install keeps every backup listed with the same snapshot id; running it twice adds nothing", async () => {
    const { first, second, failed, snapshots } = await seedLegacyHistory();
    expect(snapshots.get(first)).toMatch(/\S/);
    expect(snapshots.get(second)).toMatch(/\S/);
    expect(snapshots.get(first)).not.toBe(snapshots.get(second));

    const targets = await targetRows();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: LEGACY_BACKUP_TARGET_ID, legacySettings: true, kind: "s3", enabled: true, archivedAt: null });
    expect((await dbClient.db.select().from(backupPolicyTargets)).map((p) => [p.targetId, p.priority]).sort()).toEqual([
      [LEGACY_BACKUP_TARGET_ID, 1],
      [LEGACY_BACKUP_TARGET_ID, 1],
    ]);

    // One copy per backup that has a snapshot (the old 'partial' second backup becomes a succeeded copy); the failed row has none.
    const copies = await copyRows();
    expect(copies.map((c) => c.backupId).sort()).toEqual([first, second].sort());
    for (const copy of copies) {
      expect(copy).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, status: "succeeded", snapshotId: snapshots.get(copy.backupId) });
    }
    expect(copies.find((c) => c.backupId === failed)).toBeUndefined();

    // The history API still shows all three rows.
    const listed = await customer("GET", "/backups");
    expect(listed.status, listed.raw).toBe(200);
    expect(listed.body.data.configured).toBe(true);
    expect((listed.body.data.backups as Json[]).map((b) => b.id).sort()).toEqual([first, second, failed].sort());
    const failedDto = (listed.body.data.backups as Json[]).find((b) => b.id === failed)!;
    expect(failedDto).toMatchObject({ status: "failed", problem: "backup_failed", copies: [] });
    const okDto = (listed.body.data.backups as Json[]).find((b) => b.id === first)!;
    expect(okDto).toMatchObject({ status: "succeeded", copies: [expect.objectContaining({ targetId: LEGACY_BACKUP_TARGET_ID, kind: "s3", status: "succeeded" })] });
    expect(JSON.stringify(listed.body)).not.toContain(snapshots.get(first)!);

    // Second run of the backfill (and the boot repair): nothing new, nothing changed.
    const before = JSON.stringify([await targetRows(), await copyRows(), await dbClient.db.select().from(backupPolicyTargets)]);
    await backfillLikeMigrationOnTop();
    expect(JSON.stringify([await targetRows(), await copyRows(), await dbClient.db.select().from(backupPolicyTargets)])).toBe(before);
  });

  /** The backfill again, without first emptying the tables (the "run it twice" case). */
  async function backfillLikeMigrationOnTop(): Promise<void> {
    const text = readFileSync(path.join(resolveMigrationsDirectory(), "0022_backup_targets_and_copies.sql"), "utf8");
    const tail = text.slice(text.indexOf("-- Legacy S3 backfill"));
    for (const statement of tail.split(/;[ \t]*\n/).map((s) => s.trim()).filter((s) => s.replace(/^--.*$/gm, "").trim() !== "")) {
      await dbClient.db.execute(sql.raw(statement));
    }
  }

  it("BKP-03: backup, restore and download of a legacy copy reach the executor with the byte-identical S3 request of the frozen pins", async () => {
    const { first } = await seedLegacyHistory();
    const [firstCopy] = (await copyRows()).filter((c) => c.backupId === first);

    // A new backup from the backfilled legacy target: pin backup-requests.json (start, then status).
    calls.length = 0;
    const fresh = await backupNow();
    const start = callsOf("start")[0]!;
    expect(canonical(pinForm(start))).toBe(canonical(pinArgs("backup-requests.json", 0)));
    expect(start.target).toEqual({ ...SETTINGS, scheduleHourUtc: undefined, retentionDays: undefined });
    expect(Object.keys(start.target as object).sort()).toEqual(["accessKeyId", "bucket", "endpoint", "prefix", "region", "secretAccessKey"]);
    const status = callsOf("status")[0]!;
    expect(canonical(pinForm(status))).toBe(canonical(pinArgs("backup-requests.json", 1)));
    const [freshCopy] = (await copyRows()).filter((c) => c.backupId === fresh);
    expect(freshCopy).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, status: "succeeded", jobId: start.jobId });

    // Restore of the backfilled copy: pin restore-requests.json.
    calls.length = 0;
    const restore = await customer("POST", `/backups/${first}/restore`, { confirmName: SITE.name });
    expect(restore.status, restore.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const sent = callsOf("restore")[0]!;
    expect(sent.snapshotId).toBe(firstCopy!.snapshotId);
    expect(canonical(pinForm(sent))).toBe(canonical(pinArgs("restore-requests.json", 0)));
    expect(canonical(pinForm(callsOf("status")[0]!))).toBe(canonical(pinArgs("restore-requests.json", 1)));
    expect(JSON.stringify(sent.target)).not.toContain("kind");

    // Download of the same copy: the archive request is the restore pin without the service instance, same target bytes.
    calls.length = 0;
    const prepared = await customer("POST", `/backups/${first}/download`, {});
    expect(prepared.status, prepared.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const archive = callsOf("archive")[0]!;
    const { serviceInstanceId: _drop, ...restorePin } = pinArgs("restore-requests.json", 0);
    void _drop;
    expect(canonical(pinForm(archive))).toBe(canonical({ ...restorePin, action: "archive" }));
    expect(archive.snapshotId).toBe(firstCopy!.snapshotId);
    const [row] = await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, first));
    expect(row).toMatchObject({ restoreStatus: "succeeded", restoreTargetId: LEGACY_BACKUP_TARGET_ID, archiveTargetId: LEGACY_BACKUP_TARGET_ID, archiveStatus: "ready" });
  });

  it("BKP-11: a location change through the legacy PATCH keeps the whole history restorable from the old repository, also after a second change", async () => {
    const { first, second, failed, snapshots } = await seedLegacyHistory();
    const NEW1 = "pins-bucket-v2";
    const NEW2 = "pins-bucket-v3";

    const changed = await saveLegacy({ bucket: NEW1, secretAccessKey: undefined });
    expect(changed.status, changed.raw).toBe(200);
    expect(Object.keys(BackupSettingsDtoSchema.parse(changed.body.data)).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(changed.body.data).toMatchObject({ bucket: NEW1, configured: true, secretAccessKeySet: true, lastTest: null });
    const afterOne = await targetRows();
    expect(afterOne).toHaveLength(2);
    const live1 = afterOne.find((t) => t.archivedAt === null)!;
    expect(live1).toMatchObject({ legacySettings: false, kind: "s3", enabled: true });
    expect(afterOne.find((t) => t.id === LEGACY_BACKUP_TARGET_ID)).toMatchObject({ enabled: false });
    expect(afterOne.find((t) => t.id === LEGACY_BACKUP_TARGET_ID)!.archivedAt).not.toBeNull();

    // Second change: the first new target is archived too, three targets, one live.
    const changedAgain = await saveLegacy({ bucket: NEW2, accessKeyId: "AKIAROTATEDKEY0002", secretAccessKey: "rotated-secret-after-archive-0002" });
    expect(changedAgain.status, changedAgain.raw).toBe(200);
    const afterTwo = await targetRows();
    expect(afterTwo).toHaveLength(3);
    expect(afterTwo.filter((t) => t.archivedAt === null)).toHaveLength(1);
    expect(afterTwo.find((t) => t.id === live1.id)!.archivedAt).not.toBeNull();

    // History is intact: every row, every copy, same snapshot ids, still on the target that wrote them.
    expect((await dbClient.db.select().from(siteBackups)).map((r) => r.id).sort()).toEqual([first, second, failed].sort());
    for (const copy of await copyRows()) {
      expect(copy).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, snapshotId: snapshots.get(copy.backupId) });
    }
    expect((await customer("GET", "/backups")).body.data.backups).toHaveLength(3);

    // A backup written after the changes lands on the live target with the rotated credentials.
    calls.length = 0;
    const newest = await backupNow();
    expect(callsOf("start")[0]!.target).toEqual({
      endpoint: SETTINGS.endpoint,
      region: SETTINGS.region,
      bucket: NEW2,
      prefix: SETTINGS.prefix,
      accessKeyId: "AKIAROTATEDKEY0002",
      secretAccessKey: "rotated-secret-after-archive-0002",
    });
    const liveId = afterTwo.find((t) => t.archivedAt === null)!.id;
    expect((await copyRows()).find((c) => c.backupId === newest)).toMatchObject({ targetId: liveId });

    // Restore of the old backup reaches the OLD repository: the original bucket and the original credentials, the
    // same snapshot id, the exact pin shape (not the rotated credentials of the live target).
    calls.length = 0;
    const restore = await customer("POST", `/backups/${first}/restore`, { confirmName: SITE.name });
    expect(restore.status, restore.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const sent = callsOf("restore")[0]!;
    expect(sent.snapshotId).toBe(snapshots.get(first));
    expect(canonical(pinForm(sent))).toBe(canonical(pinArgs("restore-requests.json", 0)));
    expect(sent.target).toMatchObject({ bucket: SETTINGS.bucket, accessKeyId: SETTINGS.accessKeyId, secretAccessKey: SETTINGS.secretAccessKey });
    expect((await dbClient.db.select().from(siteBackups).where(eq(siteBackups.id, first)))[0]).toMatchObject({ restoreTargetId: LEGACY_BACKUP_TARGET_ID, restoreStatus: "succeeded" });

    // Download of the old backup comes from the old repository too.
    calls.length = 0;
    expect((await customer("POST", `/backups/${second}/download`, {})).status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(callsOf("archive")[0]).toMatchObject({ snapshotId: snapshots.get(second), target: { bucket: SETTINGS.bucket, secretAccessKey: SETTINGS.secretAccessKey } });
  });

  it("BKP-11: saving the original location again after a change makes a new target; the archived one keeps serving its copies", async () => {
    const { first, snapshots } = await seedLegacyHistory();
    expect((await saveLegacy({ bucket: "elsewhere-bucket", secretAccessKey: undefined })).status).toBe(200);
    const back = await saveLegacy({ secretAccessKey: SETTINGS.secretAccessKey });
    expect(back.status, back.raw).toBe(200);
    expect(back.body.data).toMatchObject({ bucket: SETTINGS.bucket, configured: true });
    const targets = await targetRows();
    expect(targets.filter((t) => t.archivedAt === null)).toHaveLength(1);
    expect(targets.find((t) => t.id === LEGACY_BACKUP_TARGET_ID)!.archivedAt).not.toBeNull();

    calls.length = 0;
    expect((await customer("POST", `/backups/${first}/restore`, { confirmName: SITE.name })).status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(canonical(pinForm(callsOf("restore")[0]!))).toBe(canonical(pinArgs("restore-requests.json", 0)));
    expect(callsOf("restore")[0]!.snapshotId).toBe(snapshots.get(first));
  });

  it("BKP-19: the legacy GET keeps its exact 15-key shape and value types in every state", async () => {
    const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
    const shape = (data: Json) => Object.fromEntries(Object.keys(data).sort().map((k) => [k, typeOf(data[k])]));

    const fresh = (await admin("GET", "/v1/admin/backups")).body.data as Json;
    expect(Object.keys(fresh).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(fresh).toMatchObject({ configured: false, endpoint: null, region: null, bucket: null, prefix: "", accessKeyId: null, secretAccessKeySet: false, scheduleHourUtc: 2, retentionDays: 14, lastTest: null, lastPanelBackup: null, newestBackupsTotalBytes: 0 });

    await seedLegacyHistory();
    const configured = (await admin("GET", "/v1/admin/backups")).body.data as Json;
    expect(Object.keys(configured).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(shape(configured)).toMatchObject({
      available: "boolean",
      configured: "boolean",
      endpoint: "string",
      region: "string",
      bucket: "string",
      prefix: "string",
      accessKeyId: "string",
      secretAccessKeySet: "boolean",
      scheduleHourUtc: "number",
      retentionDays: "number",
      newestBackupsTotalBytes: "number",
    });
    expect(configured).toMatchObject({ configured: true, endpoint: SETTINGS.endpoint, bucket: SETTINGS.bucket, prefix: SETTINGS.prefix, accessKeyId: SETTINGS.accessKeyId, secretAccessKeySet: true });
    expect(JSON.stringify(configured)).not.toContain(SETTINGS.secretAccessKey);
    BackupSettingsDtoSchema.parse(configured);

    const tested = await admin("POST", "/v1/admin/backups/test", {});
    expect(tested.status, tested.raw).toBe(200);
    const afterTest = (await admin("GET", "/v1/admin/backups")).body.data as Json;
    expect(Object.keys(afterTest).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(afterTest.lastTest).toMatchObject({ outcome: "ok", problem: null });
    expect(typeof afterTest.lastTest.at).toBe("string");
    BackupSettingsDtoSchema.parse(afterTest);

    // The schedule fields of the legacy PATCH still move the default policy and read back through the legacy GET.
    const moved = await saveLegacy({ scheduleHourUtc: 5, retentionDays: 30, secretAccessKey: undefined });
    expect(moved.status, moved.raw).toBe(200);
    expect(moved.body.data).toMatchObject({ scheduleHourUtc: 5, retentionDays: 30 });
    const [policy] = await dbClient.db.select().from(backupPolicies).where(eq(backupPolicies.scope, "default_site"));
    expect(policy).toMatchObject({ scheduleHourUtc: 5, retentionDays: 30 });

    const cleared = (await admin("DELETE", "/v1/admin/backups")).body.data as Json;
    expect(Object.keys(cleared).sort()).toEqual(LEGACY_DTO_KEYS);
    expect(cleared).toMatchObject({ configured: false, bucket: null, endpoint: null, accessKeyId: null, secretAccessKeySet: false });
    BackupSettingsDtoSchema.parse(cleared);
  });

  it("BKP-19: DELETE archives instead of deleting: backups, copies and snapshot ids stay, a second DELETE is harmless, restore still reaches the old repository", async () => {
    const { first, second, failed, snapshots } = await seedLegacyHistory();
    const copiesBefore = (await copyRows()).map((c) => [c.id, c.backupId, c.targetId, c.snapshotId, c.status]).sort();

    for (let i = 0; i < 2; i++) {
      const res = await admin("DELETE", "/v1/admin/backups");
      expect(res.status, res.raw).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(LEGACY_DTO_KEYS);
      expect(res.body.data.configured).toBe(false);
    }
    expect((await dbClient.db.select().from(siteBackups)).map((r) => r.id).sort()).toEqual([first, second, failed].sort());
    expect((await copyRows()).map((c) => [c.id, c.backupId, c.targetId, c.snapshotId, c.status]).sort()).toEqual(copiesBefore);
    const targets = await targetRows();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: LEGACY_BACKUP_TARGET_ID, enabled: false });
    expect(targets[0]!.archivedAt).not.toBeNull();

    // No policy target is left, so new backups are refused; the history is still listed and restorable.
    const refused = await customer("POST", "/backups", {});
    expect(refused.status).toBe(400);
    expect((await customer("GET", "/backups")).body.data.backups).toHaveLength(3);
    calls.length = 0;
    expect((await customer("POST", `/backups/${second}/restore`, { confirmName: SITE.name })).status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(canonical(pinForm(callsOf("restore")[0]!))).toBe(canonical(pinArgs("restore-requests.json", 0)));
    expect(callsOf("restore")[0]!.snapshotId).toBe(snapshots.get(second));
  });

  it("BKP-02 (API side): after DELETE of the S3 settings a local target gets the nightly backup next to the untouched S3 history", async () => {
    const { first, second } = await seedLegacyHistory();
    expect((await admin("DELETE", "/v1/admin/backups")).status).toBe(200);
    const local = await admin("POST", "/v1/admin/backup-targets", { kind: "local", name: "On this server" });
    expect(local.status, local.raw).toBe(201);
    const localId = local.body.data.id as string;
    expect((await admin("PATCH", "/v1/admin/backup-policies/default", { targetIds: [localId] })).status).toBe(200);

    calls.length = 0;
    await app.nestApp.get(BackupSchedulerService).tick(new Date("2026-11-15T02:00:00.000Z"));
    await app.outboxWorker.processPendingOnce();
    const nightly = (await dbClient.db.select().from(siteBackups)).filter((r) => r.kind === "nightly");
    expect(nightly).toHaveLength(1);
    expect(nightly[0]).toMatchObject({ status: "succeeded" });
    expect((await copyRows()).find((c) => c.backupId === nightly[0]!.id)).toMatchObject({ targetId: localId, status: "succeeded" });
    expect(callsOf("start")[0]!.target).toEqual({ kind: "local", targetId: localId });

    // The cursor moved on the policy row (the nightly state of the legacy settings row is a write-only mirror).
    const [policy] = await dbClient.db.select().from(backupPolicies).where(eq(backupPolicies.scope, "default_site"));
    expect(policy!.lastNightlyRunOn).toBe("2026-11-15");

    // History of both repositories in one list; the legacy S3 backups keep their legacy copies.
    const listed = (await customer("GET", "/backups")).body.data.backups as Json[];
    expect(listed.map((b) => b.id)).toEqual(expect.arrayContaining([first, second, nightly[0]!.id]));
    const kinds = Object.fromEntries(listed.map((b) => [b.id, (b.copies as Json[]).map((c) => c.kind)]));
    expect(kinds[first]).toEqual(["s3"]);
    expect(kinds[nightly[0]!.id]).toEqual(["local"]);
    // The legacy GET still reports "not configured" (S3 only) and never shows the local target as S3.
    expect((await admin("GET", "/v1/admin/backups")).body.data).toMatchObject({ configured: false, bucket: null });
  });

  it("BKP-02/BKP-03: an upgraded S3 install runs its nightly backup on the legacy target with the pinned S3 request and keeps the old cursor semantics", async () => {
    await seedLegacyHistory();
    await dbClient.db.update(backupPolicies).set({ lastNightlyRunOn: "2026-11-14" }).where(eq(backupPolicies.scope, "default_site"));
    calls.length = 0;
    const scheduler = app.nestApp.get(BackupSchedulerService);
    await scheduler.tick(new Date("2026-11-15T01:59:59.000Z"));
    expect(callsOf("start")).toHaveLength(0);
    await scheduler.tick(new Date("2026-11-15T02:00:00.000Z"));
    await app.outboxWorker.processPendingOnce();
    const start = callsOf("start")[0]!;
    expect(canonical(pinForm(start))).toBe(canonical(pinArgs("backup-requests.json", 0)));
    const nightly = (await dbClient.db.select().from(siteBackups)).filter((r) => r.kind === "nightly");
    expect(nightly).toHaveLength(1);
    expect((await copyRows()).find((c) => c.backupId === nightly[0]!.id)).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, status: "succeeded" });
    // A second tick the same day queues nothing.
    calls.length = 0;
    await scheduler.tick(new Date("2026-11-15T02:30:00.000Z"));
    expect(callsOf("start")).toHaveLength(0);
    expect((await dbClient.db.select().from(siteBackups)).filter((r) => r.kind === "nightly")).toHaveLength(1);
  });
});
