import { sql } from "drizzle-orm";
import type { HostingPanelDatabase } from "./client.js";

/** `'bkt_' || md5('hp:backup-target:s3_legacy_default')`: the id migration 0022 gives the target of the legacy S3 settings. */
export const LEGACY_BACKUP_TARGET_ID = "bkt_8c7b230a58dbf28ec9cb5c8b6ef3273e";

/** AAD of the secret of a new S3 target; the legacy target never copies the `backup_settings` ciphertext (BACKUP_SECRET_AAD). */
export const backupTargetS3SecretAad = (targetId: string) =>
  ({
    organizationId: "platform",
    siteId: null,
    secretKey: `HP_BACKUP_TARGET_S3_SECRET:${targetId}`,
  }) as const;

/** Byte-equal to the last statement of migration 0022 (a test asserts it): one copy per legacy backup that has none. */
export const LEGACY_BACKUP_COPIES_BACKFILL_SQL = `INSERT INTO site_backup_copies (id, backup_id, target_id, priority, required, job_id, status, snapshot_id,
  size_bytes, problem, started_at, finished_at)
SELECT 'bcp_' || md5(sb.id || ':' || t.id), sb.id, t.id, 1, TRUE, sb.operation_id,
  CASE WHEN sb.status = 'partial' THEN 'succeeded' ELSE sb.status END, sb.snapshot_id,
  sb.size_bytes, sb.problem, sb.started_at, sb.finished_at
FROM site_backups sb JOIN backup_targets t ON t.id = 'bkt_' || md5('hp:backup-target:s3_legacy_default')
WHERE (sb.snapshot_id IS NOT NULL OR sb.status = 'running')
  AND (t.archived_at IS NULL OR EXISTS (SELECT 1 FROM backup_settings bs
    WHERE bs.id = 'default' AND t.s3_location_key = hp_s3_location_key(bs.endpoint, bs.bucket, bs.prefix)))
  AND NOT EXISTS (SELECT 1 FROM site_backup_copies c WHERE c.backup_id = sb.id)
ON CONFLICT DO NOTHING;`;

// Only when the settings exist and no legacy target does; keeps the last test and the editing user of the settings,
// keys the target by their location, and attaches it to the policies that have no target yet.
const LEGACY_BACKUP_TARGET_REPAIR_SQL = `WITH ins AS (
  INSERT INTO backup_targets (id, kind, name, enabled, legacy_settings, customer_selectable, config_json, s3_location_key,
    last_test_at, last_test_outcome, last_test_problem, updated_by_user_id, created_at, updated_at)
  SELECT 'bkt_' || md5('hp:backup-target:s3_legacy_default'), 's3', 'S3', TRUE, TRUE, FALSE, '{}'::jsonb,
    hp_s3_location_key(bs.endpoint, bs.bucket, bs.prefix), bs.last_test_at, bs.last_test_outcome, bs.last_test_problem,
    bs.updated_by_user_id, bs.updated_at, bs.updated_at
  FROM backup_settings bs WHERE bs.id = 'default' AND NOT EXISTS (SELECT 1 FROM backup_targets WHERE legacy_settings)
  ON CONFLICT DO NOTHING RETURNING id)
INSERT INTO backup_policy_targets (policy_id, target_id, priority, required)
SELECT p.id, ins.id, 1, TRUE FROM ins JOIN backup_policies p ON p.scope IN ('default_site','panel')
WHERE NOT EXISTS (SELECT 1 FROM backup_policy_targets x WHERE x.policy_id = p.id)
ON CONFLICT DO NOTHING;`;

/**
 * Boot repair after a rollback: a release older than 0022 writes `site_backups` rows without copies, and may have
 * re-created the S3 settings. Re-creates the legacy target when it is absent, then gives every such backup its copy
 * (same snapshot id and times). A 'partial' row with a snapshot gets a succeeded copy. Idempotent; never deletes anything,
 * never un-archives a target (a clear of the settings does not archive the legacy target; only a deliberate archive does,
 * and that target takes only the backups written at its own location) and never throws on a row it cannot map.
 * Returns the number of copies inserted.
 */
export async function repairLegacyBackupCopies(db: HostingPanelDatabase): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(LEGACY_BACKUP_TARGET_REPAIR_SQL));
    // RETURNING counts this statement's own rows, whatever else writes to the table meanwhile.
    const inserted = await tx.execute(sql.raw(`${LEGACY_BACKUP_COPIES_BACKFILL_SQL.slice(0, -1)} RETURNING id;`));
    return inserted.rows.length;
  });
}
