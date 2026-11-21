import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKUP_SECRET_AAD,
  BackupTargetsRepositoryError,
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
  inArray,
  aggregateCopyStatuses,
  anyUsableTarget,
  archiveBackupTarget,
  currentS3Target,
  decryptS3Secret,
  deleteBackupTargetIfUnreferenced,
  deleteEmptySiteBackups,
  deleteSiteBackupCopies,
  finishNightlyRun,
  findNextNightlySite,
  getBackupTarget,
  getBackupTargetRow,
  getPolicy,
  getSitePolicyTargetIds,
  insertLocalTarget,
  insertPanelBackupCopies,
  insertS3Target,
  insertSiteBackupCopies,
  latestPanelBackupOutcome,
  listBackupTargets,
  listPanelBackupCopies,
  listRetentionCopies,
  listSiteBackupCopies,
  listTargetsWithCopiesForSite,
  lockNightlyRunState,
  markLocalTargetInitialized,
  operations,
  panelBackupCopies,
  recordTargetTest,
  repointPolicyTarget,
  resolveDispatchTarget,
  resolveEffectiveTargets,
  resolvePanelTargets,
  setPolicyTargets,
  setSitePolicy,
  settlePanelBackupCopy,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  sites,
  startNightlyRun,
  updateBackupTarget,
  updatePolicySettings,
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

  it("keys the legacy target re-created by a settings write by its location and carries the last test and the editing user of backup_settings", async () => {
    await db().insert(users).values({ id: "usr_bt", email: "bt@example.test", name: "BT" });
    const testedAt = new Date("2026-11-18T08:30:00.000Z");
    await db().delete(siteBackupCopies);
    await db().delete(backupPolicyTargets);
    await db().delete(backupTargets).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID));
    // no legacy target at all: the trigger of 0022 creates it on this UPDATE, from the row it writes
    await db()
      .update(backupSettings)
      .set({ lastTestAt: testedAt, lastTestOutcome: "failed", lastTestProblem: "unreachable", updatedByUserId: "usr_bt" })
      .where(eq(backupSettings.id, "default"));

    expect(await db().select().from(backupPolicyTargets)).toHaveLength(2);
    expect(await repairLegacyBackupCopies(db())).toBe(3); // the three backups the delete above left without a copy

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

    it("resolves an archived legacy target only while backup_settings still points at its own location", async () => {
      await db().execute(sql`UPDATE backup_targets SET archived_at = NOW(), enabled = FALSE, customer_selectable = FALSE WHERE legacy_settings`);
      const bucketOf = async () => ((await resolveDispatchTarget(db(), KEY, LEGACY_BACKUP_TARGET_ID)) as { bucket: string } | null)?.bucket ?? null;
      expect(await bucketOf()).toBe("c-bucket");

      // After a rollback a settings write moves backup_settings elsewhere: the frozen target must not read that repository.
      await upsertBackupSettings(db(), KEY, settingsInput("https://s3.elsewhere.example", "elsewhere", "e", { secretAccessKey: "s" }));
      expect(await bucketOf()).toBeNull();

      await upsertBackupSettings(db(), KEY, settingsInput("https://s3.c.example", "c-bucket", "c"));
      expect(await bucketOf()).toBe("c-bucket");
    });
  });
});

describe("@hosting-panel/database — backup targets repository (M3: targets, policies, copies, nightly state)", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let siteId = "";
  let otherSiteId = "";
  const DEFAULT_POLICY_ID = `bpl_${createHash("md5").update("hp:backup-policy:default_site").digest("hex")}`;
  const secretOf = (target: unknown) => (target as { secretAccessKey?: string } | null)?.secretAccessKey;

  const s3Input = (over: Partial<Parameters<typeof insertS3Target>[2]> = {}) => ({
    name: "Offsite",
    endpoint: "https://s3.offsite.example",
    region: "eu-west-1",
    bucket: "offsite",
    prefix: "p",
    accessKeyId: "AKIAOFFSITE",
    secretAccessKey: "offsite-secret",
    customerSelectable: false,
    actorId: null,
    ...over,
  });
  const configureLegacy = () =>
    upsertBackupSettings(db(), KEY, {
      endpoint: "https://s3.example.com",
      region: "eu-central-1",
      bucket: "panel-backups",
      prefix: "prod",
      accessKeyId: "AKIA1234",
      secretAccessKey: "legacy-secret",
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: null,
    });
  const newSite = async (slug: string) =>
    (await createSiteTransactional(db(), {
      organizationId: "org_m3",
      hostAllocationId: "alloc_m3",
      name: slug,
      slug,
      phpVersion: "8.4",
      siteType: "wordpress",
    })).site.id;
  const backupWithCopies = async (site: string, op: string, targets: { targetId: string; priority: number; required: boolean }[]) => {
    const { id } = await insertSiteBackup(db(), { siteId: site, kind: "manual", status: "running", operationId: op });
    await insertSiteBackupCopies(db(), id, op, targets);
    return id;
  };
  const copyOf = async (backupId: string, priority: number) =>
    (await listSiteBackupCopies(db(), [backupId])).get(backupId)!.find((c) => c.priority === priority)!;
  const rowOf = async (backupId: string) => (await db().select().from(siteBackups).where(eq(siteBackups.id, backupId)))[0]!;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_m3", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_m3",
      platformInstallationId: "pin_m3",
      name: "m3-host",
      hostname: "m3-host.local",
      ipv4Address: "10.0.0.31",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: "org_m3", platformInstallationId: "pin_m3", name: "M3", slug: "m3" });
    await db().insert(hostAllocations).values({ id: "alloc_m3", hostId: "hst_m3", organizationId: "org_m3", status: "active" });
    await db().insert(users).values({ id: "usr_m3", email: "m3@example.test", name: "M3" });
    siteId = await newSite("m3-site");
    otherSiteId = await newSite("m3-other");
  });

  afterAll(async () => {
    await client.close();
  });

  describe("nightly state without S3 settings (BKP-02)", () => {
    it("a local-only install runs the nightly cursor on the seeded default_site policy and mirrors nothing", async () => {
      const local = await insertLocalTarget(db(), { name: "Local", customerSelectable: false, actorId: "usr_m3" });
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [local.id]);
      expect(await db().select().from(backupSettings)).toEqual([]);

      const startedAt = new Date("2026-11-20T02:00:00.000Z");
      expect(await db().transaction((tx) => startNightlyRun(tx, "2026-11-20", 2, startedAt))).toEqual({
        scheduleHourUtc: 2,
        retentionDays: 14,
        lastNightlyRunOn: "2026-11-20",
        nightlyRunStartedAt: startedAt,
      });
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toEqual(startedAt);
      await finishNightlyRun(db());
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.nightlyRunStartedAt).toBeNull();
      expect(await db().select().from(backupSettings)).toEqual([]); // nothing was created by the mirror
      await db().update(sites).set({ status: "ready" });
      expect((await findNextNightlySite(db(), startedAt))?.id).toBeDefined(); // the local target is usable
    });

    it("mirrors the cursor into backup_settings when that row exists, write-only", async () => {
      await configureLegacy();
      const startedAt = new Date("2026-11-21T02:00:00.000Z");
      await startNightlyRun(db(), "2026-11-21", 2, startedAt);
      expect(await db().select({ on: backupSettings.lastNightlyRunOn, at: backupSettings.nightlyRunStartedAt }).from(backupSettings)).toEqual([
        { on: "2026-11-21", at: startedAt },
      ]);
      // a rollback-era direct write on backup_settings is not read back
      await db().execute(sql`UPDATE backup_settings SET last_nightly_run_on = '2030-01-01'`);
      expect((await db().transaction((tx) => lockNightlyRunState(tx)))?.lastNightlyRunOn).toBe("2026-11-21");
      await finishNightlyRun(db());
      expect((await db().select({ at: backupSettings.nightlyRunStartedAt }).from(backupSettings))[0]?.at).toBeNull();
      await db().delete(backupSettings);
    });

    it("updatePolicySettings writes default_site and mirrors hour/retention while the settings row exists; panel has no hour", async () => {
      await updatePolicySettings(db(), "default_site", { scheduleHourUtc: 5, retentionDays: 30 }, "usr_m3");
      expect(await getPolicy(db(), "default_site")).toMatchObject({ scope: "default_site", scheduleHourUtc: 5, retentionDays: 30 });
      await configureLegacy();
      await updatePolicySettings(db(), "default_site", { scheduleHourUtc: 6 }, "usr_m3");
      expect((await db().select().from(backupSettings))[0]).toMatchObject({ scheduleHourUtc: 6, retentionDays: 14 });
      await updatePolicySettings(db(), "panel", { retentionDays: 7 }, "usr_m3");
      expect(await getPolicy(db(), "panel")).toMatchObject({ scope: "panel", scheduleHourUtc: null, retentionDays: 7 });
      await expect(updatePolicySettings(db(), "panel", { scheduleHourUtc: 3 }, null)).rejects.toThrow(BackupTargetsRepositoryError);
      await db().delete(backupSettings);
    });
  });

  describe("targets", () => {
    it("inserts an S3 target with its own AAD, a database-derived location key, and resolves to exactly the six frozen keys", async () => {
      const { id } = await insertS3Target(db(), KEY, s3Input({ customerSelectable: true, actorId: "usr_m3" }));
      expect(id).toMatch(/^bkt_[0-9a-f]{32}$/);
      const [row] = await db().select().from(backupTargets).where(eq(backupTargets.id, id));
      expect(row).toMatchObject({
        kind: "s3",
        legacySettings: false,
        customerSelectable: true,
        s3LocationKey: "https://s3.offsite.example/offsite/p",
        configJson: { endpoint: "https://s3.offsite.example", region: "eu-west-1", bucket: "offsite", prefix: "p", accessKeyId: "AKIAOFFSITE" },
      });
      expect(JSON.stringify(row)).not.toContain("offsite-secret");

      const resolved = await resolveDispatchTarget(db(), KEY, id);
      expect(Object.keys(resolved ?? {}).sort()).toEqual(["accessKeyId", "bucket", "endpoint", "prefix", "region", "secretAccessKey"]);
      expect(resolved).toEqual({
        endpoint: "https://s3.offsite.example",
        region: "eu-west-1",
        bucket: "offsite",
        prefix: "p",
        accessKeyId: "AKIAOFFSITE",
        secretAccessKey: "offsite-secret",
      });
      expect(await decryptS3Secret(db(), KEY, id)).toBe("offsite-secret");
    });

    it("isolates the secret by AAD: the legacy AAD and another target's AAD cannot open it, and a swapped ciphertext does not resolve", async () => {
      const [first] = await db().select().from(backupTargets).where(eq(backupTargets.name, "Offsite"));
      const second = await insertS3Target(db(), KEY, s3Input({ name: "Second", bucket: "second", secretAccessKey: "second-secret" }));
      const fields = (r: typeof first) => ({
        masterKey: KEY,
        ciphertextBase64: r!.s3SecretCiphertextBase64!,
        ivBase64: r!.s3SecretIvBase64!,
        authTagBase64: r!.s3SecretAuthTagBase64!,
      });
      expect(decryptSecretAesGcm({ ...fields(first), ...backupTargetS3SecretAad(first!.id) })).toBe("offsite-secret");
      expect(() => decryptSecretAesGcm({ ...fields(first), ...BACKUP_SECRET_AAD })).toThrow();
      expect(() => decryptSecretAesGcm({ ...fields(first), ...backupTargetS3SecretAad(second.id) })).toThrow();
      // copying the first target's ciphertext under the second id (what a ciphertext copy would be) is not decryptable
      await db()
        .update(backupTargets)
        .set({
          s3SecretCiphertextBase64: first!.s3SecretCiphertextBase64,
          s3SecretIvBase64: first!.s3SecretIvBase64,
          s3SecretAuthTagBase64: first!.s3SecretAuthTagBase64,
        })
        .where(eq(backupTargets.id, second.id));
      await expect(resolveDispatchTarget(db(), KEY, second.id)).rejects.toThrow();
      await expect(resolveDispatchTarget(db(), "c".repeat(64), first!.id)).rejects.toThrow();
      await db().delete(backupTargets).where(eq(backupTargets.id, second.id));
    });

    it("refuses a second live target on one restic location (any spelling) with ALREADY_EXISTS", async () => {
      await expect(insertS3Target(db(), KEY, s3Input({ endpoint: "HTTPS://S3.OFFSITE.example:443/", prefix: "/p/" }))).rejects.toMatchObject({
        code: "ALREADY_EXISTS",
        reason: "s3_location_taken",
      });
    });

    it("resolves the legacy target through the unchanged getBackupTarget, null while the settings are absent", async () => {
      await configureLegacy();
      // the settings write created the legacy target (trigger of 0022) and attached it to both policies
      const legacy = await resolveDispatchTarget(db(), KEY, LEGACY_BACKUP_TARGET_ID);
      expect(legacy).toEqual(await getBackupTarget(db(), KEY));
      expect(Object.keys(legacy ?? {}).sort()).toEqual(["accessKeyId", "bucket", "endpoint", "prefix", "region", "secretAccessKey"]);
      expect(secretOf(legacy)).toBe("legacy-secret");
      expect(await decryptS3Secret(db(), KEY, LEGACY_BACKUP_TARGET_ID)).toBe("legacy-secret");

      const view = await getBackupTargetRow(db(), LEGACY_BACKUP_TARGET_ID);
      expect(view).toMatchObject({
        legacySettings: true,
        config: { endpoint: "https://s3.example.com", bucket: "panel-backups", prefix: "prod", region: "eu-central-1", accessKeyId: "AKIA1234" },
      });
      expect(JSON.stringify(view)).not.toContain("legacy-secret");
      // attached only to the policies that had no target: the local target already sits on one of them here
      expect((await db().select().from(backupPolicyTargets).where(eq(backupPolicyTargets.targetId, LEGACY_BACKUP_TARGET_ID))).length).toBeGreaterThan(0);
      // the legacy target is the oldest live S3 target: "Offsite" (created after the first settings write) is the current one
      const offsite = (await listBackupTargets(db())).find((t) => t.name === "Offsite")!;
      expect((await currentS3Target(db()))?.id).toBe(offsite.id);

      await db().delete(backupSettings);
      expect(await resolveDispatchTarget(db(), KEY, LEGACY_BACKUP_TARGET_ID)).toBeNull();
      expect((await getBackupTargetRow(db(), LEGACY_BACKUP_TARGET_ID))?.config).toEqual({});
      expect(await resolveDispatchTarget(db(), KEY, "bkt_unknown")).toBeNull();
      await configureLegacy();
    });

    it("the single local target: second one refused, marker and test persisted, resolves to {kind,targetId}", async () => {
      const [local] = (await listBackupTargets(db())).filter((t) => t.kind === "local");
      expect(local).toMatchObject({ localRoot: null, localInitializedAt: null, config: {} });
      await expect(insertLocalTarget(db(), { name: "Again", customerSelectable: false, actorId: null })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        reason: "local_target_exists",
      });
      expect(await resolveDispatchTarget(db(), KEY, local!.id)).toEqual({ kind: "local", targetId: local!.id });

      const at = new Date("2026-11-20T10:00:00.000Z");
      await markLocalTargetInitialized(db(), local!.id, at, "/var/lib/hosting-panel/local-repos");
      await recordTargetTest(db(), local!.id, { at, outcome: "ok", problem: null, availableBytes: 5_000, totalBytes: 9_000, root: "/var/lib/hosting-panel/local-repos" });
      expect(await getBackupTargetRow(db(), local!.id)).toMatchObject({
        localInitializedAt: at,
        localRoot: "/var/lib/hosting-panel/local-repos",
        lastTestOutcome: "ok",
        lastTestAvailableBytes: 5_000,
        lastTestTotalBytes: 9_000,
      });
      // the root and the marker are local-only: an S3 target is never given one
      const s3 = (await listBackupTargets(db())).find((t) => t.name === "Offsite")!;
      await recordTargetTest(db(), s3.id, { at, outcome: "failed", problem: "unreachable", root: "/etc" });
      await markLocalTargetInitialized(db(), s3.id, at, "/etc");
      expect(await getBackupTargetRow(db(), s3.id)).toMatchObject({ localRoot: null, localInitializedAt: null, lastTestOutcome: "failed", lastTestProblem: "unreachable" });
    });

    it("edits name and flags; credentials only on a non-legacy S3 target, re-encrypted under its own AAD, last test reset", async () => {
      const s3 = (await listBackupTargets(db())).find((t) => t.name === "Offsite")!;
      const edited = await updateBackupTarget(db(), s3.id, { name: "Renamed", customerSelectable: true, actorId: "usr_m3" }, KEY);
      expect(edited).toMatchObject({ name: "Renamed", customerSelectable: true, lastTestOutcome: "failed" }); // flags keep the test
      const rotated = await updateBackupTarget(db(), s3.id, { accessKeyId: "AKIANEW", region: "eu-west-3", secretAccessKey: "rotated" }, KEY);
      expect(rotated).toMatchObject({ lastTestOutcome: null, config: { accessKeyId: "AKIANEW", region: "eu-west-3", bucket: "offsite" } });
      expect(await resolveDispatchTarget(db(), KEY, s3.id)).toMatchObject({ secretAccessKey: "rotated", accessKeyId: "AKIANEW" });
      expect((await db().select().from(backupTargets).where(eq(backupTargets.id, s3.id)))[0]?.s3LocationKey).toBe("https://s3.offsite.example/offsite/p");

      await expect(updateBackupTarget(db(), LEGACY_BACKUP_TARGET_ID, { region: "x" }, KEY)).rejects.toMatchObject({ reason: "credentials_not_editable" });
      const local = (await listBackupTargets(db())).find((t) => t.kind === "local")!;
      await expect(updateBackupTarget(db(), local.id, { secretAccessKey: "x" }, KEY)).rejects.toMatchObject({ reason: "credentials_not_editable" });
      expect(await updateBackupTarget(db(), "bkt_missing", { name: "x" }, KEY)).toBeNull();
    });

    it("archiving disables the target, takes it out of every policy, stays resolvable and is idempotent; an archived one cannot be re-enabled", async () => {
      const { id } = await insertS3Target(db(), KEY, s3Input({ name: "Old", bucket: "old", customerSelectable: true }));
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [id]);
      await setSitePolicy(db(), siteId, [id], "usr_m3");
      await archiveBackupTarget(db(), id);
      await archiveBackupTarget(db(), id);
      const row = (await getBackupTargetRow(db(), id))!;
      expect(row).toMatchObject({ enabled: false, customerSelectable: false });
      expect(row.archivedAt).not.toBeNull();
      expect((await getPolicy(db(), "default_site")).targets).toEqual([]);
      expect(await getSitePolicyTargetIds(db(), siteId)).toEqual([]);
      expect(await resolveDispatchTarget(db(), KEY, id)).toMatchObject({ bucket: "old", secretAccessKey: "offsite-secret" });
      await expect(updateBackupTarget(db(), id, { enabled: true }, KEY)).rejects.toMatchObject({ reason: "target_archived" });
      // an archived location is free again
      const again = await insertS3Target(db(), KEY, s3Input({ name: "Old again", bucket: "old" }));
      await archiveBackupTarget(db(), again.id);
      await setSitePolicy(db(), siteId, null, "usr_m3");
    });
  });

  describe("delete only when nothing refers to the target", () => {
    const fresh = async (name: string) => (await insertS3Target(db(), KEY, s3Input({ name, bucket: name.toLowerCase() }))).id;

    it("is in_use for the legacy target, a policy slot, a copy, a panel copy, a restore or a download target; not_found for an unknown id", async () => {
      expect(await deleteBackupTargetIfUnreferenced(db(), LEGACY_BACKUP_TARGET_ID)).toBe("in_use");
      expect(await deleteBackupTargetIfUnreferenced(db(), "bkt_missing")).toBe("not_found");

      const inPolicy = await fresh("InPolicy");
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [inPolicy]);
      expect(await deleteBackupTargetIfUnreferenced(db(), inPolicy)).toBe("in_use");
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, []);
      expect(await deleteBackupTargetIfUnreferenced(db(), inPolicy)).toBe("deleted");

      const withCopy = await fresh("WithCopy");
      const backupId = await backupWithCopies(siteId, "op_del_copy", [{ targetId: withCopy, priority: 1, required: true }]);
      expect(await deleteBackupTargetIfUnreferenced(db(), withCopy)).toBe("in_use");

      const restore = await fresh("Restore");
      await db().update(siteBackups).set({ restoreTargetId: restore }).where(eq(siteBackups.id, backupId));
      expect(await deleteBackupTargetIfUnreferenced(db(), restore)).toBe("in_use");
      await db().update(siteBackups).set({ restoreTargetId: null, archiveTargetId: restore }).where(eq(siteBackups.id, backupId));
      expect(await deleteBackupTargetIfUnreferenced(db(), restore)).toBe("in_use");
      await db().update(siteBackups).set({ archiveTargetId: null }).where(eq(siteBackups.id, backupId));
      expect(await deleteBackupTargetIfUnreferenced(db(), restore)).toBe("deleted");

      const withPanel = await fresh("WithPanel");
      await db().insert(operations).values({
        id: "op_del_panel",
        organizationId: "org_m3",
        kind: "panel.backups.create",
        status: "succeeded",
        resourceType: "host",
        resourceId: "panel",
      });
      await insertPanelBackupCopies(db(), "op_del_panel", [{ targetId: withPanel, priority: 1, required: true }]);
      expect(await deleteBackupTargetIfUnreferenced(db(), withPanel)).toBe("in_use");

      // archiving does not release a copy: history keeps pointing at the target
      await archiveBackupTarget(db(), withCopy);
      expect(await deleteBackupTargetIfUnreferenced(db(), withCopy)).toBe("in_use");
      expect((await getBackupTargetRow(db(), withCopy))?.archivedAt).not.toBeNull();

      await db().delete(siteBackups).where(eq(siteBackups.id, backupId));
      expect(await deleteBackupTargetIfUnreferenced(db(), withCopy)).toBe("deleted");
      await db().delete(panelBackupCopies);
      expect(await deleteBackupTargetIfUnreferenced(db(), withPanel)).toBe("deleted");
      await db().delete(operations).where(eq(operations.id, "op_del_panel"));
    });
  });

  describe("policies and effective targets", () => {
    let local = "";
    let offsite = "";
    beforeAll(async () => {
      local = (await listBackupTargets(db())).find((t) => t.kind === "local")!.id;
      offsite = (await listBackupTargets(db())).find((t) => t.name === "Renamed")!.id;
    });

    it("setPolicyTargets numbers by position, replaces, and refuses more than two or a repeated target", async () => {
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [local, offsite]);
      expect((await getPolicy(db(), "default_site")).targets).toEqual([
        { targetId: local, kind: "local", priority: 1, required: true },
        { targetId: offsite, kind: "s3", priority: 2, required: true },
      ]);
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [offsite]);
      expect((await getPolicy(db(), "default_site")).targets.map((t) => [t.targetId, t.priority])).toEqual([[offsite, 1]]);
      await expect(setPolicyTargets(db(), DEFAULT_POLICY_ID, [local, offsite, LEGACY_BACKUP_TARGET_ID])).rejects.toMatchObject({ reason: "too_many_targets" });
      await expect(setPolicyTargets(db(), DEFAULT_POLICY_ID, [local, local])).rejects.toMatchObject({ reason: "duplicate_targets" });
      expect((await getPolicy(db(), "default_site")).targets).toHaveLength(1); // a refused replace changed nothing
    });

    it("a site policy overrides default_site, null inherits; disabled, archived and settings-less legacy targets are never effective", async () => {
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [offsite]);
      expect((await resolveEffectiveTargets(db(), siteId)).map((t) => t.targetId)).toEqual([offsite]);
      expect(await getSitePolicyTargetIds(db(), siteId)).toBeNull();

      await setSitePolicy(db(), siteId, [local], "usr_m3");
      expect(await getSitePolicyTargetIds(db(), siteId)).toEqual([local]);
      expect(await resolveEffectiveTargets(db(), siteId)).toEqual([{ targetId: local, kind: "local", priority: 1, required: true }]);
      expect((await resolveEffectiveTargets(db(), otherSiteId)).map((t) => t.targetId)).toEqual([offsite]);
      const [sitePolicy] = await db().select().from(backupPolicies).where(eq(backupPolicies.siteId, siteId));
      expect(sitePolicy).toMatchObject({ scope: "site", scheduleHourUtc: null, retentionDays: null, enabled: true });

      await db().update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, local));
      expect(await resolveEffectiveTargets(db(), siteId)).toEqual([]); // the site's own choice, now unusable: not configured
      await db().update(backupTargets).set({ enabled: true }).where(eq(backupTargets.id, local));

      await setSitePolicy(db(), siteId, null, "usr_m3");
      expect(await getSitePolicyTargetIds(db(), siteId)).toBeNull();
      expect(await db().select().from(backupPolicies).where(eq(backupPolicies.siteId, siteId))).toEqual([]);

      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [LEGACY_BACKUP_TARGET_ID, offsite]);
      expect((await resolveEffectiveTargets(db(), siteId)).map((t) => t.targetId)).toEqual([LEGACY_BACKUP_TARGET_ID, offsite]);
      await db().delete(backupSettings);
      expect((await resolveEffectiveTargets(db(), siteId)).map((t) => t.targetId)).toEqual([offsite]);
      await configureLegacy();
    });

    it("resolves the panel targets and answers whether any target is usable", async () => {
      await setPolicyTargets(db(), (await getPolicy(db(), "panel")).id, [local]);
      expect(await resolvePanelTargets(db())).toEqual([{ targetId: local, kind: "local", priority: 1, required: true }]);
      expect(await anyUsableTarget(db())).toBe(true);
    });

    it("repointPolicyTarget moves a slot, and a policy that already holds the destination just drops the source", async () => {
      const panelId = (await getPolicy(db(), "panel")).id;
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [offsite, local]);
      await setPolicyTargets(db(), panelId, [offsite]);
      await repointPolicyTarget(db(), offsite, local);
      expect((await getPolicy(db(), "panel")).targets.map((t) => t.targetId)).toEqual([local]);
      expect((await getPolicy(db(), "default_site")).targets.map((t) => [t.targetId, t.priority])).toEqual([[local, 2]]);
    });
  });

  describe("copies", () => {
    let t1 = "";
    let t2 = "";
    beforeAll(async () => {
      t1 = (await listBackupTargets(db())).find((t) => t.kind === "local")!.id;
      t2 = (await listBackupTargets(db())).find((t) => t.name === "Renamed")!.id;
    });
    const both = (required2 = true) => [
      { targetId: t1, priority: 1, required: true },
      { targetId: t2, priority: 2, required: required2 },
    ];
    const settle = async (backupId: string, priority: number, r: Parameters<typeof settleSiteBackupCopy>[2]) =>
      settleSiteBackupCopy(db(), (await copyOf(backupId, priority)).id, r);

    it("insertSiteBackupCopies pins one running copy per target; job ids are <op> and <op>-t2", async () => {
      const backupId = await backupWithCopies(siteId, "op_cp_ids", both());
      const copies = (await listSiteBackupCopies(db(), [backupId])).get(backupId)!;
      expect(copies.map((c) => [c.priority, c.jobId, c.status, c.targetKind, c.snapshotId])).toEqual([
        [1, "op_cp_ids", "running", "local", null],
        [2, "op_cp_ids-t2", "running", "s3", null],
      ]);
      expect(await listSiteBackupCopies(db(), [])).toEqual(new Map());
      await expect(insertSiteBackupCopies(db(), backupId, "op_cp_ids", [{ targetId: t1, priority: 1, required: true }])).rejects.toThrow();
    });

    it("settles a copy once: a second or late settlement is a no-op (BKP-14)", async () => {
      const backupId = await backupWithCopies(siteId, "op_cp_once", [{ targetId: t1, priority: 1, required: true }]);
      const copy = await copyOf(backupId, 1);
      expect(await settleSiteBackupCopy(db(), copy.id, { status: "succeeded", snapshotId: SNAP, sizeBytes: 7 })).toBe(true);
      expect(await settleSiteBackupCopy(db(), copy.id, { status: "failed", problem: "other" })).toBe(false);
      expect(await settleSiteBackupCopy(db(), "bcp_missing", { status: "failed" })).toBe(false);
      expect(await copyOf(backupId, 1)).toMatchObject({ status: "succeeded", snapshotId: SNAP, sizeBytes: 7, problem: null });
      expect((await copyOf(backupId, 1)).finishedAt).toBeInstanceOf(Date);
      // a succeeded copy always carries its snapshot (CHECK)
      const other = await backupWithCopies(siteId, "op_cp_nosnap", [{ targetId: t1, priority: 1, required: true }]);
      await expect(settle(other, 1, { status: "succeeded" })).rejects.toThrow();
    });

    const truth: [string, ("succeeded" | "failed" | "missing" | "unknown" | "running")[], boolean, string, string | null][] = [
      ["one required copy ok", ["succeeded"], true, "succeeded", SNAP],
      ["one required copy failed", ["failed"], true, "failed", null],
      ["one copy still running", ["running"], true, "running", null],
      ["both ok", ["succeeded", "succeeded"], true, "succeeded", SNAP],
      ["first ok, second failed", ["succeeded", "failed"], true, "partial", SNAP],
      ["first failed, second ok", ["failed", "succeeded"], true, "partial", "b".repeat(64)],
      ["both failed", ["failed", "failed"], true, "failed", null],
      ["first ok, second running", ["succeeded", "running"], true, "running", SNAP],
      ["first ok, second unknown", ["succeeded", "unknown"], true, "partial", SNAP],
      ["first ok, second missing", ["succeeded", "missing"], true, "partial", SNAP],
      ["optional second failed", ["succeeded", "failed"], false, "succeeded", SNAP],
      ["optional second failed, first failed", ["failed", "failed"], false, "failed", null],
    ];
    it.each(truth)("aggregate truth table (D9): %s", async (name, statuses, required2, expected, mirroredSnapshot) => {
      const op = `op_agg_${name.replaceAll(/\W+/g, "_")}`;
      const backupId = await backupWithCopies(siteId, op, statuses.length === 1 ? [both()[0]!] : both(required2));
      for (const [index, status] of statuses.entries()) {
        if (status === "running") continue;
        await settle(backupId, index + 1, {
          status,
          snapshotId: status === "succeeded" ? (index === 0 ? SNAP : "b".repeat(64)) : null,
          sizeBytes: status === "succeeded" ? 100 + index : null,
          problem: status === "failed" ? (index === 0 ? "no_space" : "unreachable") : null,
        });
      }
      expect(await settleSiteBackupAggregate(db(), backupId)).toBe(expected);
      expect(aggregateCopyStatuses((await listSiteBackupCopies(db(), [backupId])).get(backupId)!)).toBe(expected);
      const row = await rowOf(backupId);
      expect(row.status).toBe(expected);
      expect(row.snapshotId).toBe(mirroredSnapshot);
      expect(row.sizeBytes).toBe(mirroredSnapshot === null ? null : mirroredSnapshot === SNAP ? 100 : 101);
      expect(row.finishedAt === null).toBe(expected === "running");
      const firstFailedRequired = statuses.findIndex((s, i) => s !== "succeeded" && (i === 0 || required2) && s === "failed");
      expect(row.problem).toBe(expected === "failed" || expected === "partial" ? (firstFailedRequired === 0 ? "no_space" : firstFailedRequired === 1 ? "unreachable" : null) : null);
    });

    it("aggregates once: a settled backup keeps its status, a backup without copies keeps its own, an unknown id is null", async () => {
      const backupId = await backupWithCopies(siteId, "op_agg_twice", both());
      await settle(backupId, 1, { status: "succeeded", snapshotId: SNAP, sizeBytes: 1 });
      await settle(backupId, 2, { status: "failed", problem: "unreachable" });
      expect(await settleSiteBackupAggregate(db(), backupId)).toBe("partial");
      const settledAt = (await rowOf(backupId)).finishedAt;
      await db().execute(sql`UPDATE site_backup_copies SET status = 'succeeded', snapshot_id = ${SNAP} WHERE backup_id = ${backupId}`);
      expect(await settleSiteBackupAggregate(db(), backupId)).toBe("partial"); // only a running row is rewritten
      expect((await rowOf(backupId)).finishedAt).toEqual(settledAt);

      const bare = await insertSiteBackup(db(), { siteId, kind: "manual", status: "running", operationId: "op_agg_bare" });
      expect(await settleSiteBackupAggregate(db(), bare.id)).toBe("running");
      expect(await settleSiteBackupAggregate(db(), "bkp_missing")).toBeNull();
    });

    it("lists retention copies per target and the targets that hold a site's copies; deleting copies then empty backups", async () => {
      const a = await backupWithCopies(otherSiteId, "op_ret_a", both());
      const b = await backupWithCopies(otherSiteId, "op_ret_b", [{ targetId: t2, priority: 1, required: true }]);
      await settle(a, 1, { status: "succeeded", snapshotId: SNAP, sizeBytes: 1 });
      await settle(a, 2, { status: "missing", problem: "backup_copy_missing" });
      await settle(b, 1, { status: "failed", problem: "unreachable" });
      await db().execute(sql`UPDATE site_backups SET started_at = '2026-11-01T00:00:00Z' WHERE id = ${a}`);
      await db().execute(sql`UPDATE site_backups SET started_at = '2026-11-02T00:00:00Z' WHERE id = ${b}`);

      expect(await listTargetsWithCopiesForSite(db(), otherSiteId)).toEqual([t1, t2].sort());
      expect(await listTargetsWithCopiesForSite(db(), "site_gone")).toEqual([]);
      const onT2 = await listRetentionCopies(db(), otherSiteId, t2);
      expect(onT2.map((r) => [r.backupId, r.kind, r.status, r.snapshotId])).toEqual([
        [b, "manual", "failed", null],
        [a, "manual", "missing", null],
      ]);
      expect(onT2[1]!.startedAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
      const onT1 = await listRetentionCopies(db(), otherSiteId, t1);
      expect(onT1).toEqual([expect.objectContaining({ backupId: a, status: "succeeded", snapshotId: SNAP })]);
      expect(await listRetentionCopies(db(), siteId, t1)).not.toContainEqual(expect.objectContaining({ backupId: a }));

      // forgetting copy by copy: the logical row goes only with its last copy
      await deleteSiteBackupCopies(db(), [onT2[1]!.copyId]);
      await deleteEmptySiteBackups(db(), [a, b]);
      expect(await rowOf(a)).toBeDefined(); // still has its copy on t1
      expect((await db().select().from(siteBackups).where(eq(siteBackups.id, b))).length).toBe(1); // b still has its failed copy
      await deleteSiteBackupCopies(db(), [onT1[0]!.copyId, onT2[0]!.copyId]);
      await deleteEmptySiteBackups(db(), [a, b]);
      expect(await db().select().from(siteBackups).where(inArray(siteBackups.id, [a, b]))).toEqual([]);
      await deleteSiteBackupCopies(db(), []);
      await deleteEmptySiteBackups(db(), []);
    });

    it("panel copies: pinned per target, settled once, and the latest outcome is the aggregate of the newest finished operation", async () => {
      expect(await latestPanelBackupOutcome(db())).toBeNull();
      const op = async (id: string) =>
        db().insert(operations).values({ id, organizationId: "org_m3", kind: "panel.backups.create", status: "succeeded", resourceType: "host", resourceId: "panel" });
      await op("op_pnl_1");
      await insertPanelBackupCopies(db(), "op_pnl_1", both());
      expect((await listPanelBackupCopies(db(), "op_pnl_1")).map((c) => [c.priority, c.jobId, c.status, c.targetKind])).toEqual([
        [1, "op_pnl_1", "running", "local"],
        [2, "op_pnl_1-t2", "running", "s3"],
      ]);
      expect(await latestPanelBackupOutcome(db())).toBeNull(); // still running
      const [c1, c2] = await listPanelBackupCopies(db(), "op_pnl_1");
      expect(await settlePanelBackupCopy(db(), c1!.id, { status: "succeeded", snapshotId: SNAP, sizeBytes: 3 })).toBe(true);
      expect(await settlePanelBackupCopy(db(), c1!.id, { status: "failed" })).toBe(false);
      expect(await settlePanelBackupCopy(db(), c2!.id, { status: "failed", problem: "unreachable" })).toBe(true);
      expect(await latestPanelBackupOutcome(db())).toMatchObject({ status: "partial", problem: "unreachable" });

      await op("op_pnl_2");
      await insertPanelBackupCopies(db(), "op_pnl_2", [both()[0]!]);
      expect(await latestPanelBackupOutcome(db())).toMatchObject({ status: "partial" }); // the newer one is not finished
      const [d1] = await listPanelBackupCopies(db(), "op_pnl_2");
      await settlePanelBackupCopy(db(), d1!.id, { status: "succeeded", snapshotId: SNAP });
      expect(await latestPanelBackupOutcome(db())).toMatchObject({ status: "succeeded", problem: null });
      await insertPanelBackupCopies(db(), "op_pnl_2", []);
    });
  });

  describe("scheduling skips sites without a usable effective target", () => {
    it("findNextNightlySite: no target → none; default_site target → all; a site policy overrides; unusable legacy → none", async () => {
      const local = (await listBackupTargets(db())).find((t) => t.kind === "local")!.id;
      await db().update(sites).set({ status: "ready" });
      const since = new Date("2026-12-01T00:00:00.000Z");
      const ids = async () => {
        const seen: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          const next = await findNextNightlySite(db(), since);
          if (!next) break;
          seen.push(next.id);
          await insertSiteBackup(db(), { siteId: next.id, kind: "nightly", status: "failed", operationId: null, problem: "site_busy", startedAt: new Date("2026-12-01T02:00:00.000Z") });
        }
        await db().delete(siteBackups).where(eq(siteBackups.kind, "nightly"));
        return seen.sort();
      };
      const both = [siteId, otherSiteId].sort();

      await setPolicyTargets(db(), DEFAULT_POLICY_ID, []);
      expect(await ids()).toEqual([]);
      await setPolicyTargets(db(), DEFAULT_POLICY_ID, [local]);
      expect(await ids()).toEqual(both);

      await db().update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, local));
      await setSitePolicy(db(), otherSiteId, [LEGACY_BACKUP_TARGET_ID], "usr_m3"); // its own choice
      expect(await ids()).toEqual([otherSiteId]);
      await db().delete(backupSettings); // the legacy target cannot be resolved without its settings
      expect(await ids()).toEqual([]);
      await configureLegacy();
      await db().update(backupTargets).set({ archivedAt: new Date(), enabled: false }).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID));
      expect(await ids()).toEqual([]);
    });
  });
});
