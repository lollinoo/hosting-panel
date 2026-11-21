import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_SECRET_AAD,
  LEGACY_BACKUP_COPIES_BACKFILL_SQL,
  LEGACY_BACKUP_TARGET_ID,
  backupPolicies,
  backupPolicyTargets,
  backupSettings,
  backupTargetS3SecretAad,
  backupTargets,
  createDatabaseClient,
  createSiteTransactional,
  decryptSecretAesGcm,
  encryptSecretAesGcm,
  eq,
  hostAllocations,
  hosts,
  insertSiteBackup,
  organizations,
  platformInstallations,
  repairLegacyBackupCopies,
  resolveMigrationsDirectory,
  settleSiteBackup,
  siteBackupCopies,
  siteBackups,
  sql,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "b".repeat(64);
const SNAP = "a".repeat(64);
const PANEL_POLICY_ID = `bpl_${createHash("md5").update("hp:backup-policy:panel").digest("hex")}`;

describe("@hosting-panel/database — backup targets repository (M1: legacy copy repair)", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let siteId = "";

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_bt", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_bt",
      platformInstallationId: "pin_bt",
      name: "bt-host",
      hostname: "bt-host.local",
      ipv4Address: "10.0.0.30",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: "org_bt", platformInstallationId: "pin_bt", name: "BT", slug: "bt" });
    await db().insert(hostAllocations).values({ id: "alloc_bt", hostId: "hst_bt", organizationId: "org_bt", status: "active" });
    const site = await createSiteTransactional(db(), {
      organizationId: "org_bt",
      hostAllocationId: "alloc_bt",
      name: "Site",
      slug: "bt-site",
      phpVersion: "8.4",
      siteType: "wordpress",
    });
    siteId = site.site.id;
  });

  afterAll(async () => {
    await client.close();
  });

  const copies = () => db().select().from(siteBackupCopies);
  const targets = () => db().select().from(backupTargets);

  /** What a release older than 0022 does: configures S3, then writes backup rows with no copies. */
  async function oldReleaseBackup(operationId: string, status: "succeeded" | "failed" | "running", snapshotId: string | null) {
    await insertSiteBackup(db(), { siteId, kind: "manual", status: "running", operationId });
    if (status !== "running") await settleSiteBackup(db(), operationId, { status, snapshotId, sizeBytes: snapshotId ? 42 : null });
  }

  it("pins the legacy target id and the S3 AAD of a new target", () => {
    expect(LEGACY_BACKUP_TARGET_ID).toBe(
      `bkt_${createHash("md5").update("hp:backup-target:s3_legacy_default").digest("hex")}`,
    );
    const aad = backupTargetS3SecretAad("bkt_abc");
    expect(aad).toEqual({ organizationId: "platform", siteId: null, secretKey: "HP_BACKUP_TARGET_S3_SECRET:bkt_abc" });
    expect(aad).not.toEqual(BACKUP_SECRET_AAD);

    const envelope = encryptSecretAesGcm({ plaintext: "s3-secret", masterKey: KEY, ...aad });
    const fields = {
      masterKey: KEY,
      ciphertextBase64: envelope.ciphertextBase64,
      ivBase64: envelope.ivBase64,
      authTagBase64: envelope.authTagBase64,
    };
    expect(decryptSecretAesGcm({ ...fields, ...aad })).toBe("s3-secret");
    expect(() => decryptSecretAesGcm({ ...fields, ...BACKUP_SECRET_AAD })).toThrow();
    expect(() => decryptSecretAesGcm({ ...fields, ...backupTargetS3SecretAad("bkt_other") })).toThrow();
  });

  it("keeps LEGACY_BACKUP_COPIES_BACKFILL_SQL byte-equal to the last statement of migration 0022", () => {
    const migration = readFileSync(path.join(resolveMigrationsDirectory(), "0022_backup_targets_and_copies.sql"), "utf8");
    const start = migration.lastIndexOf("INSERT INTO site_backup_copies");
    expect(start).toBeGreaterThan(0);
    expect(migration.slice(start).trimEnd()).toBe(LEGACY_BACKUP_COPIES_BACKFILL_SQL);
  });

  it("does nothing on an install without S3 settings", async () => {
    await oldReleaseBackup("op_bt_nosettings", "succeeded", SNAP);
    expect(await repairLegacyBackupCopies(db())).toBe(0);
    expect(await targets()).toHaveLength(0);
    expect(await copies()).toHaveLength(0);
  });

  const configureS3 = () =>
    upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      secretAccessKey: "canary-secret",
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: null,
    });

  it("re-creates the legacy target and gives each copy-less backup with a snapshot or running exactly one copy", async () => {
    await configureS3();
    await oldReleaseBackup("op_bt_running", "running", null);
    await oldReleaseBackup("op_bt_failed_nosnap", "failed", null);

    // the succeeded row of the previous test and the running one; the failed row without a snapshot gets none
    expect(await repairLegacyBackupCopies(db())).toBe(2);

    const rows = await targets();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: LEGACY_BACKUP_TARGET_ID,
      kind: "s3",
      legacySettings: true,
      enabled: true,
      customerSelectable: false,
      configJson: {},
      s3SecretCiphertextBase64: null,
    });

    const written = await copies();
    expect(written.map((c) => [c.jobId, c.status, c.snapshotId, c.targetId, c.priority, c.required]).sort()).toEqual(
      [
        ["op_bt_nosettings", "succeeded", SNAP, LEGACY_BACKUP_TARGET_ID, 1, true],
        ["op_bt_running", "running", null, LEGACY_BACKUP_TARGET_ID, 1, true],
      ].sort(),
    );
    expect(written.find((c) => c.status === "succeeded")?.sizeBytes).toBe(42);

    const attached = await db().select().from(backupPolicyTargets);
    const policies = await db().select().from(backupPolicies);
    expect(policies.map((p) => p.scope).sort()).toEqual(["default_site", "panel"]);
    expect(attached).toHaveLength(2);
    for (const a of attached) expect(a).toMatchObject({ targetId: LEGACY_BACKUP_TARGET_ID, priority: 1, required: true });
  });

  it("is idempotent: a second call inserts nothing", async () => {
    expect(await repairLegacyBackupCopies(db())).toBe(0);
    expect(await copies()).toHaveLength(2);
    expect(await targets()).toHaveLength(1);
  });

  it("gives no legacy copy to a backup that already has one (new release rows)", async () => {
    await db().insert(backupTargets).values({ id: "bkt_local_1", kind: "local", name: "Local" });
    await oldReleaseBackup("op_bt_multi", "succeeded", SNAP);
    const [backup] = await db().select({ id: siteBackups.id }).from(siteBackups).where(eq(siteBackups.operationId, "op_bt_multi"));
    await db().insert(siteBackupCopies).values({
      id: "bcp_local_1",
      backupId: String(backup?.id),
      targetId: "bkt_local_1",
      status: "succeeded",
      snapshotId: SNAP,
    });
    expect(await repairLegacyBackupCopies(db())).toBe(0);
    expect((await copies()).filter((c) => c.backupId === String(backup?.id)).map((c) => c.targetId)).toEqual(["bkt_local_1"]);
  });

  it("never re-attaches the legacy target to a policy once the target exists, and never deletes it", async () => {
    await db().delete(backupPolicyTargets).where(eq(backupPolicyTargets.policyId, PANEL_POLICY_ID));
    await db().delete(backupSettings); // a "clear": the legacy target stays
    expect(await repairLegacyBackupCopies(db())).toBe(0);
    expect((await targets()).filter((t) => t.legacySettings)).toHaveLength(1);
    expect(await db().select().from(backupPolicyTargets)).toHaveLength(1);
  });

  it("re-creates an absent legacy target and attaches it only to the policies that have no target", async () => {
    await db().delete(siteBackupCopies);
    await db().delete(backupPolicyTargets);
    await db().delete(backupTargets).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID));
    await configureS3();

    // the succeeded + running + multi rows now all lack a copy (the multi row's local copy was deleted above)
    expect(await repairLegacyBackupCopies(db())).toBe(3);
    expect((await targets()).filter((t) => t.legacySettings).map((t) => t.id)).toEqual([LEGACY_BACKUP_TARGET_ID]);
    expect(await db().select().from(backupPolicyTargets)).toHaveLength(2);
    expect(await repairLegacyBackupCopies(db())).toBe(0);
  });

  it("keys the re-created legacy target by its location and carries the last test and the editing user of backup_settings", async () => {
    await db().insert(users).values({ id: "usr_bt", email: "bt@example.test", name: "BT" });
    const testedAt = new Date("2026-11-18T08:30:00.000Z");
    await db()
      .update(backupSettings)
      .set({ lastTestAt: testedAt, lastTestOutcome: "failed", lastTestProblem: "unreachable", updatedByUserId: "usr_bt" })
      .where(eq(backupSettings.id, "default"));
    await db().delete(siteBackupCopies);
    await db().delete(backupPolicyTargets);
    await db().delete(backupTargets).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID));

    await repairLegacyBackupCopies(db());

    const [legacy] = await db().select().from(backupTargets).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID));
    expect(legacy).toMatchObject({
      legacySettings: true,
      s3LocationKey: "https://s3.example.com/panel-backups/prod",
      lastTestOutcome: "failed",
      lastTestProblem: "unreachable",
      updatedByUserId: "usr_bt",
    });
    expect(legacy?.lastTestAt?.toISOString()).toBe(testedAt.toISOString());
  });

  it("never throws at boot on a copy-less 'partial' backup: with a snapshot it gets a succeeded copy, without one it gets none", async () => {
    await oldReleaseBackup("op_bt_partial_snap", "succeeded", SNAP);
    await oldReleaseBackup("op_bt_partial_nosnap", "failed", null);
    await db().execute(sql`UPDATE site_backups SET status = 'partial' WHERE operation_id IN ('op_bt_partial_snap', 'op_bt_partial_nosnap')`);
    await db().execute(sql`UPDATE site_backups SET snapshot_id = NULL WHERE operation_id = 'op_bt_partial_nosnap'`);

    expect(await repairLegacyBackupCopies(db())).toBe(1);

    const written = (await copies()).filter((c) => c.jobId === "op_bt_partial_snap" || c.jobId === "op_bt_partial_nosnap");
    expect(written.map((c) => [c.jobId, c.status, c.snapshotId])).toEqual([["op_bt_partial_snap", "succeeded", SNAP]]);
    expect(await repairLegacyBackupCopies(db())).toBe(0);
  });
  describe("the legacy target's location key follows backup_settings (trigger in 0022), whichever release writes it", () => {
    const settingsInput = (endpoint: string, bucket: string, prefix: string, extra: { accessKeyId?: string; secretAccessKey?: string } = {}) => ({
      endpoint,
      region: "eu-central-1",
      bucket,
      prefix,
      accessKeyId: extra.accessKeyId ?? "AKIA1234",
      ...(extra.secretAccessKey === undefined ? {} : { secretAccessKey: extra.secretAccessKey }),
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: null,
    });
    const legacyRow = async () => (await targets()).find((t) => t.legacySettings);
    // drizzle wraps the driver error: the constraint name is on the cause
    const messageOf = (error: unknown): string =>
      error instanceof Error ? `${error.message} ${messageOf((error as { cause?: unknown }).cause)}` : "";
    const insertLiveS3 = (id: string, endpoint: string, bucket: string, prefix: string) =>
      db().execute(sql`INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64,
          s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
        SELECT ${id}, 's3', 'S', c.cfg, hp_s3_location_key(c.cfg->>'endpoint', c.cfg->>'bucket', c.cfg->>'prefix'), 'c', 'i', 't', 'v1'
        FROM (SELECT jsonb_build_object('endpoint', ${endpoint}::text, 'region', 'r', 'bucket', ${bucket}::text, 'prefix', ${prefix}::text,
          'accessKeyId', 'A') AS cfg) c`);

    it("moves the key when the settings route changes the location, and a new target on the new location is refused", async () => {
      const before = await legacyRow();
      expect(before?.archivedAt).toBeNull();
      expect(before?.s3LocationKey).toBe("https://s3.example.com/panel-backups/prod");

      await upsertBackupSettings(db(), KEY, settingsInput("https://S3.Moved.example:443", "moved", "m"));

      expect((await legacyRow())?.s3LocationKey).toBe("https://s3.moved.example/moved/m");
      await expect(insertLiveS3("bkt_dup_new", "https://s3.moved.example", "moved", "m")).rejects.toSatisfy((e) =>
        messageOf(e).includes("uq_backup_targets_s3_location"),
      );
      // the abandoned location is free for a regular target
      await insertLiveS3("bkt_old_loc", "https://s3.example.com", "panel-backups", "prod");
      await db().delete(backupTargets).where(eq(backupTargets.id, "bkt_old_loc"));
    });

    it("leaves the legacy row untouched on a credential-only update", async () => {
      const before = JSON.stringify(await legacyRow());
      await upsertBackupSettings(db(), KEY, settingsInput("https://s3.moved.example", "moved", "m", { accessKeyId: "AKIA9999", secretAccessKey: "rotated" }));
      expect(JSON.stringify(await legacyRow())).toBe(before);
    });

    it("fails the settings write when a live target holds the new location: settings and legacy key stay as they were", async () => {
      await insertLiveS3("bkt_held", "https://s3.taken.example", "taken", "t");
      const settingsBefore = JSON.stringify(await db().select().from(backupSettings));
      const error = await upsertBackupSettings(db(), KEY, settingsInput("https://S3.TAKEN.example:443", "taken", "t/")).catch((e: unknown) => e);
      expect(messageOf(error)).toContain("uq_backup_targets_s3_location");
      expect(JSON.stringify(await db().select().from(backupSettings))).toBe(settingsBefore);
      expect((await legacyRow())?.s3LocationKey).toBe("https://s3.moved.example/moved/m");
      await db().delete(backupTargets).where(eq(backupTargets.id, "bkt_held"));
    });

    it("clear then save elsewhere: the legacy target stays live and follows the new location, a regular target there is refused, and a new backup gets its copy", async () => {
      // BackupSettingsService.clear(): the settings row and every site backup (their copies cascade) in one transaction.
      await db().transaction(async (tx) => {
        await tx.delete(backupSettings);
        await tx.delete(siteBackups);
      });
      const cleared = await legacyRow();
      expect(cleared).toMatchObject({ enabled: true, s3LocationKey: "https://s3.moved.example/moved/m" });
      expect(cleared?.archivedAt).toBeNull(); // deleting the settings archives nothing
      expect(await copies()).toEqual([]);

      // Save at a new location C: an INSERT of the settings row.
      await upsertBackupSettings(db(), KEY, settingsInput("https://S3.C.example:443", "c-bucket", "c", { secretAccessKey: "s" }));
      const reconfigured = await legacyRow();
      expect(reconfigured).toMatchObject({ id: LEGACY_BACKUP_TARGET_ID, enabled: true, s3LocationKey: "https://s3.c.example/c-bucket/c" });
      expect(reconfigured?.archivedAt).toBeNull();
      expect((await targets()).filter((t) => t.legacySettings && t.archivedAt === null)).toHaveLength(1);
      // The policies keep pointing at the live legacy target.
      expect((await db().select().from(backupPolicyTargets)).map((p) => p.targetId)).toEqual([LEGACY_BACKUP_TARGET_ID, LEGACY_BACKUP_TARGET_ID]);
      // The location guard is on: nothing else may take C, while the abandoned location is free.
      await expect(insertLiveS3("bkt_on_c", "https://s3.c.example", "c-bucket", "c")).rejects.toSatisfy((e) =>
        messageOf(e).includes("uq_backup_targets_s3_location"),
      );
      await insertLiveS3("bkt_left", "https://s3.moved.example", "moved", "m");
      await db().delete(backupTargets).where(eq(backupTargets.id, "bkt_left"));

      // A backup written after the reconfiguration gets its copy on the legacy target.
      await oldReleaseBackup("op_bt_after_clear", "succeeded", SNAP);
      expect(await repairLegacyBackupCopies(db())).toBe(1);
      const [after] = await db().select().from(siteBackups).where(eq(siteBackups.operationId, "op_bt_after_clear"));
      expect((await copies()).filter((c) => c.backupId === after?.id).map((c) => c.targetId)).toEqual([LEGACY_BACKUP_TARGET_ID]);
    });

    it("never gives a legacy target archived on purpose (the M3 adapter) a backup written at another location, nor creates a second one; gives it the ones at its own", async () => {
      await db().execute(sql`UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = FALSE WHERE legacy_settings`);
      const archived = await legacyRow();
      expect(archived).toMatchObject({ enabled: false, customerSelectable: false, s3LocationKey: "https://s3.c.example/c-bucket/c" });
      expect(archived?.archivedAt).not.toBeNull();

      // The settings move elsewhere and a backup is written there: the archived row neither follows nor takes it.
      await upsertBackupSettings(db(), KEY, settingsInput("https://s3.elsewhere.example", "elsewhere", "e", { secretAccessKey: "s" }));
      await oldReleaseBackup("op_bt_elsewhere", "succeeded", SNAP);
      await repairLegacyBackupCopies(db());
      const backupOf = async (operationId: string) =>
        (await db().select().from(siteBackups).where(eq(siteBackups.operationId, operationId)))[0];
      const elsewhere = await backupOf("op_bt_elsewhere");
      expect((await copies()).filter((c) => c.backupId === elsewhere?.id)).toEqual([]);
      expect((await targets()).filter((t) => t.legacySettings)).toHaveLength(1);
      expect((await legacyRow())?.archivedAt).not.toBeNull();
      expect((await legacyRow())?.s3LocationKey).toBe("https://s3.c.example/c-bucket/c");

      // The settings point at the archived target's own location again: its repository is where the backup went.
      await upsertBackupSettings(db(), KEY, settingsInput("https://s3.c.example", "c-bucket", "c"));
      await repairLegacyBackupCopies(db());
      expect((await copies()).filter((c) => c.backupId === elsewhere?.id).map((c) => c.targetId)).toEqual([LEGACY_BACKUP_TARGET_ID]);
      expect((await legacyRow())?.archivedAt).not.toBeNull(); // the repair never revives a target
    });
  });
});
