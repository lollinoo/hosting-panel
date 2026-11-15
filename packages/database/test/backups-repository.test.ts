import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  BACKUP_SECRET_AAD,
  countNightlyRunResults,
  createDatabaseClient,
  createSiteTransactional,
  decryptSecretAesGcm,
  deleteAllSiteBackups,
  deleteBackupSettings,
  deleteSiteBackups,
  ensurePresetRolesAndPermissions,
  findNextNightlySite,
  finishNightlyRun,
  getBackupSettingsPublic,
  getBackupTarget,
  hostAllocations,
  hosts,
  insertSiteBackup,
  listAdminBackupStatus,
  listOrphanSiteIdsWithBackupsBefore,
  listSiteBackups,
  lockNightlyRunState,
  organizations,
  permissions,
  platformInstallations,
  recordBackupTest,
  rolePermissions,
  settleSiteBackup,
  sites,
  sql,
  startNightlyRun,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "b".repeat(64);
const SECRET_1 = "canary-Backup:S3-Secret#1";
const SECRET_2 = "canary-Backup:S3-Secret#2";

describe("@hosting-panel/database — 0009 backups repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;

  const orgId = "org_bkp_1";
  let liveSiteId = "";
  let deletedSiteId = "";

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await ensurePresetRolesAndPermissions(db());

    await db().insert(platformInstallations).values({ id: "pin_bkp", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_bkp",
      platformInstallationId: "pin_bkp",
      name: "backup-host",
      hostname: "backup-host.local",
      ipv4Address: "10.0.0.20",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({
      id: orgId,
      platformInstallationId: "pin_bkp",
      name: "Backup Org",
      slug: "backup-org",
    });
    await db().insert(hostAllocations).values({
      id: "alloc_bkp",
      hostId: "hst_bkp",
      organizationId: orgId,
      status: "active",
    });
    await db().insert(users).values({
      id: "usr_bkp_admin",
      email: "bkp-admin@example.com",
      name: "Backup Admin",
      passwordHash: "hash",
    });

    const live = await createSiteTransactional(db(), {
      organizationId: orgId,
      hostAllocationId: "alloc_bkp",
      name: "Live Site",
      slug: "live-site",
      phpVersion: "8.4",
    });
    liveSiteId = live.site.id;

    const doomed = await createSiteTransactional(db(), {
      organizationId: orgId,
      hostAllocationId: "alloc_bkp",
      name: "Doomed Site",
      slug: "doomed-site",
      phpVersion: "8.4",
    });
    deletedSiteId = doomed.site.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it("returns null before configuration and rejects initial save without a secret", async () => {
    expect(await getBackupSettingsPublic(db())).toBeNull();
    expect(await getBackupTarget(db(), KEY)).toBeNull();
    expect(await db().transaction((tx) => lockNightlyRunState(tx))).toBeNull();
    expect(await startNightlyRun(db(), "2026-11-15", 10)).toBeNull();

    await expect(
      upsertBackupSettings(db(), KEY, {
        endpoint: "https://s3.example.com",
        region: "eu-central-1",
        bucket: "panel-backups",
        prefix: "prod",
        accessKeyId: "AKIA1234",
        scheduleHourUtc: 2,
        retentionDays: 14,
        updatedByUserId: "usr_bkp_admin",
      }),
    ).rejects.toThrow();
  });

  it("encrypts secret with AAD, hides plaintext from raw rows and public reads, and enforces singleton id", async () => {
    const first = await upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      secretAccessKey: SECRET_1,
      scheduleHourUtc: 3,
      retentionDays: 14,
      updatedByUserId: "usr_bkp_admin",
    });
    expect(first).toEqual({ targetChanged: false });

    const pub = await getBackupSettingsPublic(db());
    expect(pub).toMatchObject({
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      scheduleHourUtc: 3,
      retentionDays: 14,
      lastNightlyRunOn: null,
      lastTestAt: null,
      lastTestOutcome: null,
      lastTestProblem: null,
    });
    expect(pub).not.toHaveProperty("secretAccessKey");
    expect(pub).not.toHaveProperty("secretAccessKeyCiphertextBase64");

    const target = await getBackupTarget(db(), KEY);
    expect(target).toEqual({
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      secretAccessKey: SECRET_1,
    });

    const raw = await db().execute(sql`SELECT row_to_json(b)::text AS j FROM backup_settings b`);
    expect(JSON.stringify(raw.rows)).not.toContain(SECRET_1);

    const enc = await db().execute(
      sql`SELECT secret_access_key_ciphertext_base64 c, secret_access_key_iv_base64 i, secret_access_key_auth_tag_base64 t FROM backup_settings`,
    );
    const row = enc.rows[0] as { c: string; i: string; t: string };
    expect(
      decryptSecretAesGcm({
        ciphertextBase64: row.c,
        ivBase64: row.i,
        authTagBase64: row.t,
        masterKey: KEY,
        ...BACKUP_SECRET_AAD,
      }),
    ).toBe(SECRET_1);
    expect(() =>
      decryptSecretAesGcm({
        ciphertextBase64: row.c,
        ivBase64: row.i,
        authTagBase64: row.t,
        masterKey: KEY,
        ...BACKUP_SECRET_AAD,
        secretKey: "OTHER_KEY",
      }),
    ).toThrow();

    await expect(
      db().execute(
        sql`INSERT INTO backup_settings (id, endpoint, region, bucket, prefix, access_key_id, secret_access_key_ciphertext_base64, secret_access_key_iv_base64, secret_access_key_auth_tag_base64) VALUES ('other', 'https://x.com', 'us-east-1', 'bkt', '', 'k', 'c', 'i', 't')`,
      ),
    ).rejects.toThrow();
  });

  it("preserves secret when omitted, tracks targetChanged strictly, and clears last test result on target/credential edits", async () => {
    const testedAt = new Date("2026-11-15T01:00:00.000Z");
    await recordBackupTest(db(), testedAt, "ok", null);
    expect((await getBackupSettingsPublic(db()))?.lastTestOutcome).toBe("ok");

    // Schedule / retention edit only: keeps secret and keeps lastTest*
    const schedOnly = await upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      scheduleHourUtc: 4,
      retentionDays: 21,
      updatedByUserId: "usr_bkp_admin",
    });
    expect(schedOnly).toEqual({ targetChanged: false });
    expect((await getBackupTarget(db(), KEY))?.secretAccessKey).toBe(SECRET_1);
    expect((await getBackupSettingsPublic(db()))?.lastTestOutcome).toBe("ok");

    // Region / accessKeyId / secret changes: targetChanged=false, clears lastTest*
    await recordBackupTest(db(), testedAt, "ok", null);
    const regionOnly = await upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      scheduleHourUtc: 4,
      retentionDays: 21,
      updatedByUserId: "usr_bkp_admin",
    });
    expect(regionOnly).toEqual({ targetChanged: false });
    expect((await getBackupSettingsPublic(db()))?.lastTestAt).toBeNull();
    expect((await getBackupSettingsPublic(db()))?.lastTestOutcome).toBeNull();
    expect((await getBackupTarget(db(), KEY))?.secretAccessKey).toBe(SECRET_1);

    await recordBackupTest(db(), testedAt, "failed", "auth_failed");
    const accessKeyOnly = await upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA9999",
      scheduleHourUtc: 4,
      retentionDays: 21,
      updatedByUserId: "usr_bkp_admin",
    });
    expect(accessKeyOnly).toEqual({ targetChanged: false });
    expect((await getBackupSettingsPublic(db()))?.lastTestOutcome).toBeNull();
    expect((await getBackupSettingsPublic(db()))?.lastTestProblem).toBeNull();

    await recordBackupTest(db(), testedAt, "ok", null);
    const secretOnly = await upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-west-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA9999",
      secretAccessKey: SECRET_2,
      scheduleHourUtc: 4,
      retentionDays: 21,
      updatedByUserId: "usr_bkp_admin",
    });
    expect(secretOnly).toEqual({ targetChanged: false });
    expect((await getBackupSettingsPublic(db()))?.lastTestAt).toBeNull();
    expect((await getBackupTarget(db(), KEY))?.secretAccessKey).toBe(SECRET_2);

    // Endpoint / bucket / prefix changes: targetChanged=true AND clears lastTest*
    const base = {
      endpoint: "https://s3-2.example.com",
      region: "eu-west-1",
      bucket: "panel-backups-2",
      prefix: "prod/v2",
      accessKeyId: "AKIA9999",
      scheduleHourUtc: 4,
      retentionDays: 21,
      updatedByUserId: "usr_bkp_admin",
    };
    await recordBackupTest(db(), testedAt, "ok", null);
    expect(await upsertBackupSettings(db(), KEY, { ...base, endpoint: "https://s3-3.example.com" })).toEqual({
      targetChanged: true,
    });
    expect((await getBackupSettingsPublic(db()))?.lastTestAt).toBeNull();

    await recordBackupTest(db(), testedAt, "ok", null);
    expect(
      await upsertBackupSettings(db(), KEY, {
        ...base,
        endpoint: "https://s3-3.example.com",
        bucket: "panel-backups-3",
      }),
    ).toEqual({ targetChanged: true });
    expect((await getBackupSettingsPublic(db()))?.lastTestAt).toBeNull();

    await recordBackupTest(db(), testedAt, "ok", null);
    expect(
      await upsertBackupSettings(db(), KEY, {
        ...base,
        endpoint: "https://s3-3.example.com",
        bucket: "panel-backups-3",
        prefix: "prod/v3",
      }),
    ).toEqual({ targetChanged: true });
    expect((await getBackupSettingsPublic(db()))?.lastTestAt).toBeNull();
  });

  it("locks, starts, finishes nightly runs cleanly by UTC hour, date, and clock correction", async () => {
    // scheduleHourUtc is currently 4, retentionDays is 21
    const initialLocked = await db().transaction((tx) => lockNightlyRunState(tx));
    expect(initialLocked).toEqual({
      scheduleHourUtc: 4,
      retentionDays: 21,
      lastNightlyRunOn: null,
      nightlyRunStartedAt: null,
    });

    const tDay1 = new Date("2026-11-15T04:00:00.000Z");
    expect(await startNightlyRun(db(), "2026-11-15", 3, tDay1)).toBeNull();
    expect(await startNightlyRun(db(), "2026-11-15", 4, tDay1)).toEqual({
      scheduleHourUtc: 4,
      retentionDays: 21,
      lastNightlyRunOn: "2026-11-15",
      nightlyRunStartedAt: tDay1,
    });

    // While nightlyRunStartedAt is non-null, a new run cannot start even on a later day
    const tDay2 = new Date("2026-11-16T04:00:00.000Z");
    expect(await startNightlyRun(db(), "2026-11-16", 4, tDay2)).toBeNull();
    expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toEqual(
      tDay1,
    );

    // Finishing clears nightly_run_started_at while keeping last_nightly_run_on
    await finishNightlyRun(db());
    expect(await db().transaction((tx) => lockNightlyRunState(tx))).toEqual({
      scheduleHourUtc: 4,
      retentionDays: 21,
      lastNightlyRunOn: "2026-11-15",
      nightlyRunStartedAt: null,
    });

    // Same UTC day remains blocked; next UTC day starts normally
    expect(await startNightlyRun(db(), "2026-11-15", 10, tDay1)).toBeNull();
    expect(await startNightlyRun(db(), "2026-11-16", 3, tDay2)).toBeNull();
    expect(await startNightlyRun(db(), "2026-11-16", 4, tDay2)).toEqual({
      scheduleHourUtc: 4,
      retentionDays: 21,
      lastNightlyRunOn: "2026-11-16",
      nightlyRunStartedAt: tDay2,
    });
    await finishNightlyRun(db());
    expect((await getBackupSettingsPublic(db()))?.lastNightlyRunOn).toBe("2026-11-16");

    // Clock correction: a future date recorded when the clock was ahead must not block today's run.
    const tDay3 = new Date("2026-11-17T04:00:00.000Z");
    await db().execute(
      sql`UPDATE backup_settings SET last_nightly_run_on = '2026-12-01' WHERE id = 'default'`,
    );
    expect(await startNightlyRun(db(), "2026-11-17", 4, tDay3)).toEqual({
      scheduleHourUtc: 4,
      retentionDays: 21,
      lastNightlyRunOn: "2026-11-17",
      nightlyRunStartedAt: tDay3,
    });
    await finishNightlyRun(db());
    expect((await getBackupSettingsPublic(db()))?.lastNightlyRunOn).toBe("2026-11-17");
  });

  it("starts nightly runs after any existing nightly row when clock was corrected (R74)", async () => {
    try {
      // 1. With no nightly rows (even if a manual row lies in the future), startNightlyRun uses now.
      await insertSiteBackup(db(), {
        siteId: liveSiteId,
        kind: "manual",
        status: "running",
        operationId: "op_r74_manual_future",
        startedAt: new Date("2026-12-10T02:00:00.000Z"),
      });
      const tNoNightly = new Date("2026-11-18T04:00:00.000Z");
      const startedNoNightly = await startNightlyRun(db(), "2026-11-18", 4, tNoNightly);
      expect(startedNoNightly?.nightlyRunStartedAt).toEqual(tNoNightly);
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toEqual(
        tNoNightly,
      );
      await finishNightlyRun(db());

      // 2. With only nightly rows in the past, startNightlyRun still uses now.
      await insertSiteBackup(db(), {
        siteId: liveSiteId,
        kind: "nightly",
        status: "running",
        operationId: "op_r74_past",
        startedAt: new Date("2026-11-14T04:00:00.000Z"),
      });
      const tPastOnly = new Date("2026-11-19T04:00:00.000Z");
      const startedPastOnly = await startNightlyRun(db(), "2026-11-19", 4, tPastOnly);
      expect(startedPastOnly?.nightlyRunStartedAt).toEqual(tPastOnly);
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toEqual(
        tPastOnly,
      );
      await finishNightlyRun(db());

      // 3. With a future nightly row from an ahead clock, startNightlyRun starts strictly after it.
      const futureNightlyAt = new Date("2026-12-01T04:00:00.000Z");
      await insertSiteBackup(db(), {
        siteId: liveSiteId,
        kind: "nightly",
        status: "running",
        operationId: "op_r74_future",
        startedAt: futureNightlyAt,
      });
      await db().execute(
        sql`UPDATE backup_settings SET last_nightly_run_on = '2026-12-01' WHERE id = 'default'`,
      );
      const tCorrected = new Date("2026-11-20T04:00:00.000Z");
      const startedAfterFuture = await startNightlyRun(db(), "2026-11-20", 4, tCorrected);
      expect(startedAfterFuture).not.toBeNull();
      expect(startedAfterFuture!.nightlyRunStartedAt!.getTime()).toBeGreaterThan(
        futureNightlyAt.getTime(),
      );
      expect(startedAfterFuture!.nightlyRunStartedAt).toEqual(
        new Date(futureNightlyAt.getTime() + 1),
      );
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toEqual(
        startedAfterFuture!.nightlyRunStartedAt,
      );
    } finally {
      await finishNightlyRun(db());
      await deleteAllSiteBackups(db());
    }
  });

  it("finds next eligible site without a nightly row since run start and counts run outcomes", async () => {
    const third = await createSiteTransactional(db(), {
      organizationId: orgId,
      hostAllocationId: "alloc_bkp",
      name: "Deploying Site",
      slug: "deploying-site",
      phpVersion: "8.4",
    });

    await db().update(sites).set({ status: "ready" }).where(eq(sites.id, liveSiteId));
    await db().update(sites).set({ status: "stopped" }).where(eq(sites.id, deletedSiteId));
    await db().update(sites).set({ status: "deploying" }).where(eq(sites.id, third.site.id));

    const runStartedAt = new Date("2026-11-17T04:00:00.000Z");
    const beforeRun = new Date("2026-11-16T04:00:00.000Z");
    const expectedOrder = [liveSiteId, deletedSiteId].sort();

    expect(await countNightlyRunResults(db(), runStartedAt)).toEqual({ enqueued: 0, busy: 0 });

    // Older nightly rows and manual rows in the current window do not satisfy or count for this run
    await insertSiteBackup(db(), {
      siteId: expectedOrder[0]!,
      kind: "nightly",
      status: "running",
      operationId: "op_old_n",
      startedAt: beforeRun,
    });
    await settleSiteBackup(db(), "op_old_n", { status: "succeeded", snapshotId: "snap_old" });
    await insertSiteBackup(db(), {
      siteId: expectedOrder[0]!,
      kind: "manual",
      status: "running",
      operationId: "op_man_cur",
      startedAt: runStartedAt,
    });
    await settleSiteBackup(db(), "op_man_cur", { status: "succeeded", snapshotId: "snap_man" });

    expect((await findNextNightlySite(db(), runStartedAt))?.id).toBe(expectedOrder[0]);
    expect(await countNightlyRunResults(db(), runStartedAt)).toEqual({ enqueued: 0, busy: 0 });

    // Mark first site busy (operationId: null) -> findNextNightlySite advances to second site
    await insertSiteBackup(db(), {
      siteId: expectedOrder[0]!,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "site_busy",
      startedAt: new Date("2026-11-17T04:00:05.000Z"),
    });
    expect((await findNextNightlySite(db(), runStartedAt))?.id).toBe(expectedOrder[1]);

    // Enqueue second site and simulate executor RESOURCE_LOCKED settled as site_busy (operationId !== null)
    await insertSiteBackup(db(), {
      siteId: expectedOrder[1]!,
      kind: "nightly",
      status: "running",
      operationId: "op_cur_2",
      startedAt: new Date("2026-11-17T04:00:10.000Z"),
    });
    await settleSiteBackup(db(), "op_cur_2", { status: "failed", problem: "site_busy" });

    // Deploying site is excluded, so no site remains
    expect(await findNextNightlySite(db(), runStartedAt)).toBeNull();
    expect(await countNightlyRunResults(db(), runStartedAt)).toEqual({ enqueued: 1, busy: 1 });

    // Clean up temporary rows so downstream tests start with clean site_backups
    await deleteAllSiteBackups(db());
    await db().delete(sites).where(eq(sites.id, third.site.id));
    await db().update(sites).set({ status: "deploying" }).where(eq(sites.id, liveSiteId));
    await db().update(sites).set({ status: "deploying" }).where(eq(sites.id, deletedSiteId));
  });

  it("inserts, settles only running rows, lists newest first, and computes admin status", async () => {
    const t1 = new Date("2026-11-10T02:00:00.000Z");
    const t2 = new Date("2026-11-12T02:00:00.000Z");
    const t3 = new Date("2026-11-14T10:00:00.000Z");
    const t4 = new Date("2026-11-15T02:00:00.000Z");

    const b1 = await insertSiteBackup(db(), {
      siteId: liveSiteId,
      kind: "nightly",
      status: "running",
      operationId: "op_bkp_1",
      startedAt: t1,
    });
    expect(b1.id).toMatch(/^bkp_[0-9a-f]{32}$/);
    await settleSiteBackup(db(), "op_bkp_1", {
      status: "succeeded",
      snapshotId: "snap_01",
      sizeBytes: 1024,
    });
    // Settling again when no longer running must be a no-op
    await settleSiteBackup(db(), "op_bkp_1", {
      status: "failed",
      snapshotId: "snap_other",
      sizeBytes: 0,
      problem: "other",
    });

    await insertSiteBackup(db(), {
      siteId: liveSiteId,
      kind: "manual",
      status: "running",
      operationId: "op_bkp_2",
      startedAt: t2,
    });
    await settleSiteBackup(db(), "op_bkp_2", {
      status: "failed",
      problem: "timeout",
    });

    await insertSiteBackup(db(), {
      siteId: liveSiteId,
      kind: "manual",
      status: "running",
      operationId: "op_bkp_3",
      startedAt: t3,
    });
    await insertSiteBackup(db(), {
      siteId: liveSiteId,
      kind: "nightly",
      status: "failed",
      operationId: null,
      problem: "site_busy",
      startedAt: t4,
    });

    const list = await listSiteBackups(db(), liveSiteId);
    expect(list.map((r) => r.operationId)).toEqual([null, "op_bkp_3", "op_bkp_2", "op_bkp_1"]);
    expect(list[3]).toMatchObject({
      status: "succeeded",
      snapshotId: "snap_01",
      sizeBytes: 1024,
      problem: null,
    });
    expect(list[2]).toMatchObject({
      status: "failed",
      problem: "timeout",
    });

    const adminRows = await listAdminBackupStatus(db());
    const liveAdmin = adminRows.find((r) => r.siteId === liveSiteId);
    expect(liveAdmin).toMatchObject({
      siteId: liveSiteId,
      siteName: "Live Site",
      organizationId: orgId,
      organizationName: "Backup Org",
      lastAttemptAt: t4.toISOString(),
      lastStatus: "failed",
      problem: "site_busy",
      runningOperationId: "op_bkp_3",
    });
    expect(liveAdmin?.lastSuccessAt).toBeTruthy();

    const doomedAdmin = adminRows.find((r) => r.siteId === deletedSiteId);
    expect(doomedAdmin).toMatchObject({
      siteId: deletedSiteId,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastStatus: null,
      problem: null,
      runningOperationId: null,
    });
  });

  it("keeps backup rows when a site is deleted, lists orphan sites before cutoff, and supports deletes", async () => {
    const oldDate = new Date("2026-10-01T02:00:00.000Z");
    const newDate = new Date("2026-11-15T02:00:00.000Z");
    const cutoff = new Date("2026-11-01T00:00:00.000Z");

    const oldDooomed = await insertSiteBackup(db(), {
      siteId: deletedSiteId,
      kind: "nightly",
      status: "running",
      operationId: "op_doomed_1",
      startedAt: oldDate,
    });
    await settleSiteBackup(db(), "op_doomed_1", { status: "succeeded", snapshotId: "snap_d1", sizeBytes: 512 });

    await insertSiteBackup(db(), {
      siteId: deletedSiteId,
      kind: "manual",
      status: "running",
      operationId: "op_doomed_2",
      startedAt: newDate,
    });
    await settleSiteBackup(db(), "op_doomed_2", { status: "succeeded", snapshotId: "snap_d2", sizeBytes: 768 });

    // Even liveSiteId gets a backup older than cutoff; it must NOT be reported as an orphan
    const oldLive = await insertSiteBackup(db(), {
      siteId: liveSiteId,
      kind: "nightly",
      status: "running",
      operationId: "op_live_old",
      startedAt: oldDate,
    });
    await settleSiteBackup(db(), "op_live_old", { status: "succeeded", snapshotId: "snap_l0", sizeBytes: 256 });

    await db().delete(sites).where(eq(sites.id, deletedSiteId));

    expect(await listSiteBackups(db(), deletedSiteId)).toHaveLength(2);
    expect((await listAdminBackupStatus(db())).map((r) => r.siteId)).toEqual([liveSiteId]);

    expect(await listOrphanSiteIdsWithBackupsBefore(db(), cutoff)).toEqual([deletedSiteId]);

    await deleteSiteBackups(db(), []);
    await deleteSiteBackups(db(), [oldDooomed.id, oldLive.id]);
    expect(await listOrphanSiteIdsWithBackupsBefore(db(), cutoff)).toEqual([]);
    expect(await listSiteBackups(db(), deletedSiteId)).toHaveLength(1);

    await deleteAllSiteBackups(db());
    expect(await listSiteBackups(db(), liveSiteId)).toEqual([]);
    expect(await listSiteBackups(db(), deletedSiteId)).toEqual([]);

    await deleteBackupSettings(db());
    expect(await getBackupSettingsPublic(db())).toBeNull();
  });

  it("idempotently provisions site.backups.manage on pre-existing installations via ensurePresetRolesAndPermissions", async () => {
    // Simulate an installation upgraded from prior code where permissions table lacked site.backups.manage
    await db().delete(rolePermissions).where(eq(rolePermissions.permissionKey, "site.backups.manage"));
    await db().delete(permissions).where(eq(permissions.key, "site.backups.manage"));

    await ensurePresetRolesAndPermissions(db());

    const rows = await db()
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.permissionKey, "site.backups.manage"));
    const grantedRoleIds = rows.map((r) => r.roleId).sort();
    expect(grantedRoleIds).toEqual(["role_customer_owner", "role_hosting_admin"]);
  });
});
