import { createHash, randomUUID } from "node:crypto";
import type {
  BackupCopyStatus,
  BackupProblem,
  BackupTargetKind,
  ErrorCode,
} from "@hosting-panel/contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getBackupTarget, type BackupTarget } from "./backups-repository.js";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";
import {
  backupPolicies,
  backupPolicyTargets,
  backupSettings,
  backupTargets,
  panelBackupCopies,
  siteBackupCopies,
  siteBackups,
} from "./schema.js";

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

/**
 * Boot repair after a rollback: a release older than 0022 writes `site_backups` rows without copies. Gives every such
 * backup its copy on the legacy target (same snapshot id and times); the target itself is created by the trigger of
 * migration 0022 on the first write of backup_settings, so this only attaches copies. A 'partial' row with a snapshot gets a succeeded copy. Idempotent; never deletes anything,
 * never un-archives a target (a clear of the settings does not archive the legacy target; only a deliberate archive does,
 * and that target takes only the backups written at its own location) and never throws on a row it cannot map.
 * Returns the number of copies inserted.
 */
export async function repairLegacyBackupCopies(db: HostingPanelDatabase): Promise<number> {
  return db.transaction(async (tx) => {
    // RETURNING counts this statement's own rows, whatever else writes to the table meanwhile.
    const inserted = await tx.execute(sql.raw(`${LEGACY_BACKUP_COPIES_BACKFILL_SQL.slice(0, -1)} RETURNING id;`));
    return inserted.rows.length;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// HCP-SPEC-004 M3: targets, policies and per-target copies (ADR-0032). Every function takes the executor it should
// run on; the ones that need atomicity with an audit row or a lock take the caller's transaction.
// ---------------------------------------------------------------------------------------------------------------

const SINGLETON_ID = "default";
type MasterKey = string | Buffer | Uint8Array;

/** A repository failure the service maps to a public error: `code` is the public code, `reason` the stable detail. */
export class BackupTargetsRepositoryError extends Error {
  readonly code: ErrorCode;
  readonly reason: string;

  constructor(code: ErrorCode, reason: string) {
    super(reason);
    this.name = "BackupTargetsRepositoryError";
    this.code = code;
    this.reason = reason;
  }
}

function violatedConstraint(err: unknown): string | null {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === "23505") {
      if (typeof e.constraint === "string") return e.constraint;
      const named = typeof e.message === "string" ? /constraint "([^"]+)"/.exec(e.message) : null;
      return named?.[1] ?? "";
    }
    current = e.cause;
  }
  return null;
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** What the executor gets: the frozen six-key S3 object (no `kind`, byte-identical pins), or a local reference. */
export type DispatchTarget = BackupTarget | { kind: "local"; targetId: string };

export interface BackupTargetRow {
  id: string;
  kind: BackupTargetKind;
  name: string;
  enabled: boolean;
  legacySettings: boolean;
  customerSelectable: boolean;
  /** S3: endpoint, region, bucket, prefix, accessKeyId (the legacy target's come from backup_settings, {} when absent); local: {}. */
  config: Record<string, unknown>;
  archivedAt: Date | null;
  lastTestAt: Date | null;
  lastTestOutcome: "ok" | "failed" | null;
  lastTestProblem: BackupProblem | null;
  lastTestAvailableBytes: number | null;
  lastTestTotalBytes: number | null;
  /** Reported by the executor on initialise/test; display only, never an input. */
  localRoot: string | null;
  localInitializedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type TargetDbRow = typeof backupTargets.$inferSelect;

function toTargetRow(row: TargetDbRow, legacyConfig: Record<string, unknown> | null): BackupTargetRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    legacySettings: row.legacySettings,
    customerSelectable: row.customerSelectable,
    config: row.legacySettings ? (legacyConfig ?? {}) : row.configJson,
    archivedAt: row.archivedAt,
    lastTestAt: row.lastTestAt,
    lastTestOutcome: row.lastTestOutcome,
    lastTestProblem: row.lastTestProblem,
    lastTestAvailableBytes: row.lastTestAvailableBytes,
    lastTestTotalBytes: row.lastTestTotalBytes,
    localRoot: row.localRoot,
    localInitializedAt: row.initializedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function legacyS3View(db: DatabaseExecutor): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({
      endpoint: backupSettings.endpoint,
      region: backupSettings.region,
      bucket: backupSettings.bucket,
      prefix: backupSettings.prefix,
      accessKeyId: backupSettings.accessKeyId,
    })
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON_ID))
    .limit(1);
  return row ?? null;
}

async function withLegacyView(db: DatabaseExecutor, rows: TargetDbRow[]): Promise<BackupTargetRow[]> {
  const legacy = rows.some((r) => r.legacySettings) ? await legacyS3View(db) : null;
  return rows.map((r) => toTargetRow(r, legacy));
}

/** Every target, archived ones included, oldest first. */
export async function listBackupTargets(db: DatabaseExecutor): Promise<BackupTargetRow[]> {
  return withLegacyView(db, await db.select().from(backupTargets).orderBy(asc(backupTargets.createdAt), asc(backupTargets.id)));
}

export async function getBackupTargetRow(db: DatabaseExecutor, id: string): Promise<BackupTargetRow | null> {
  const rows = await db.select().from(backupTargets).where(eq(backupTargets.id, id)).limit(1);
  return (await withLegacyView(db, rows))[0] ?? null;
}

/** The newest non-archived S3 target: the one the legacy admin routes read and write. */
export async function currentS3Target(db: DatabaseExecutor): Promise<BackupTargetRow | null> {
  const rows = await db
    .select()
    .from(backupTargets)
    .where(and(eq(backupTargets.kind, "s3"), sql`${backupTargets.archivedAt} IS NULL`))
    .orderBy(desc(backupTargets.createdAt), desc(backupTargets.id))
    .limit(1);
  return (await withLegacyView(db, rows))[0] ?? null;
}

/**
 * Inserts a new (non-legacy) S3 target. The secret is encrypted under the target's own AAD and the location key is
 * derived by the database (hp_s3_location_key); a live target on the same restic location → ALREADY_EXISTS.
 */
export async function insertS3Target(
  tx: DatabaseExecutor,
  masterKey: MasterKey,
  input: {
    name: string;
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
    customerSelectable: boolean;
    actorId: string | null;
  },
): Promise<{ id: string }> {
  const id = newId("bkt");
  const envelope = encryptSecretAesGcm({
    plaintext: input.secretAccessKey,
    masterKey,
    ...backupTargetS3SecretAad(id),
  });
  try {
    await tx.insert(backupTargets).values({
      id,
      kind: "s3",
      name: input.name,
      customerSelectable: input.customerSelectable,
      configJson: {
        endpoint: input.endpoint,
        region: input.region,
        bucket: input.bucket,
        prefix: input.prefix,
        accessKeyId: input.accessKeyId,
      },
      s3LocationKey: sql`hp_s3_location_key(${input.endpoint}::text, ${input.bucket}::text, ${input.prefix}::text)`,
      s3SecretCiphertextBase64: envelope.ciphertextBase64,
      s3SecretIvBase64: envelope.ivBase64,
      s3SecretAuthTagBase64: envelope.authTagBase64,
      s3SecretKeyVersion: envelope.keyVersion,
      createdByUserId: input.actorId,
      updatedByUserId: input.actorId,
    });
  } catch (err) {
    if (violatedConstraint(err) === "uq_backup_targets_s3_location") {
      throw new BackupTargetsRepositoryError("ALREADY_EXISTS", "s3_location_taken");
    }
    throw err;
  }
  return { id };
}

/** Inserts the one local target; the root is never an input (the executor answers it). Second live one → VALIDATION_ERROR. */
export async function insertLocalTarget(
  tx: DatabaseExecutor,
  input: { name: string; customerSelectable: boolean; actorId: string | null },
): Promise<{ id: string }> {
  const exists = new BackupTargetsRepositoryError("VALIDATION_ERROR", "local_target_exists");
  const [live] = await tx
    .select({ id: backupTargets.id })
    .from(backupTargets)
    .where(and(eq(backupTargets.kind, "local"), sql`${backupTargets.archivedAt} IS NULL`))
    .limit(1);
  if (live) throw exists;
  const id = newId("bkt");
  try {
    await tx.insert(backupTargets).values({
      id,
      kind: "local",
      name: input.name,
      customerSelectable: input.customerSelectable,
      createdByUserId: input.actorId,
      updatedByUserId: input.actorId,
    });
  } catch (err) {
    if (violatedConstraint(err) === "uq_backup_targets_one_local") throw exists;
    throw err;
  }
  return { id };
}

export interface BackupTargetPatch {
  name?: string;
  enabled?: boolean;
  customerSelectable?: boolean;
  /** Non-legacy S3 only; a location (endpoint, bucket, prefix) is never editable: a target id is a repository. */
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  actorId?: string | null;
}

/** Edits name, flags and (non-legacy S3) credentials. Null when the target does not exist. */
export async function updateBackupTarget(
  tx: DatabaseExecutor,
  id: string,
  patch: BackupTargetPatch,
  masterKey: MasterKey,
): Promise<BackupTargetRow | null> {
  const [current] = await tx.select().from(backupTargets).where(eq(backupTargets.id, id)).limit(1).for("update");
  if (!current) return null;
  const credentialEdit =
    patch.region !== undefined || patch.accessKeyId !== undefined || patch.secretAccessKey !== undefined;
  if (credentialEdit && (current.kind !== "s3" || current.legacySettings)) {
    throw new BackupTargetsRepositoryError("VALIDATION_ERROR", "credentials_not_editable");
  }
  if (current.archivedAt && (patch.enabled === true || patch.customerSelectable === true)) {
    throw new BackupTargetsRepositoryError("VALIDATION_ERROR", "target_archived");
  }
  const set: Partial<typeof backupTargets.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.customerSelectable !== undefined) set.customerSelectable = patch.customerSelectable;
  if (patch.actorId !== undefined) set.updatedByUserId = patch.actorId;
  if (credentialEdit) {
    set.configJson = {
      ...current.configJson,
      ...(patch.region === undefined ? {} : { region: patch.region }),
      ...(patch.accessKeyId === undefined ? {} : { accessKeyId: patch.accessKeyId }),
    };
    if (patch.secretAccessKey !== undefined) {
      const envelope = encryptSecretAesGcm({
        plaintext: patch.secretAccessKey,
        masterKey,
        ...backupTargetS3SecretAad(id),
      });
      set.s3SecretCiphertextBase64 = envelope.ciphertextBase64;
      set.s3SecretIvBase64 = envelope.ivBase64;
      set.s3SecretAuthTagBase64 = envelope.authTagBase64;
      set.s3SecretKeyVersion = envelope.keyVersion;
    }
    // New credentials invalidate the last connectivity test.
    set.lastTestAt = null;
    set.lastTestOutcome = null;
    set.lastTestProblem = null;
  }
  await tx.update(backupTargets).set(set).where(eq(backupTargets.id, id));
  return getBackupTargetRow(tx, id);
}

/** Archives a target (never deletes: copies keep pointing at it) and takes it out of every policy. Idempotent. */
export async function archiveBackupTarget(tx: DatabaseExecutor, id: string): Promise<void> {
  await tx
    .update(backupTargets)
    .set({
      enabled: false,
      customerSelectable: false,
      archivedAt: sql`COALESCE(${backupTargets.archivedAt}, NOW())`,
      updatedAt: new Date(),
    })
    .where(eq(backupTargets.id, id));
  await tx.delete(backupPolicyTargets).where(eq(backupPolicyTargets.targetId, id));
}

/**
 * Deletes the row of a target nothing refers to (copies, panel copies, policies, a restore/download in progress
 * or finished). The legacy target never goes. Repository data is not touched: the row only.
 */
export async function deleteBackupTargetIfUnreferenced(
  tx: DatabaseExecutor,
  id: string,
): Promise<"deleted" | "in_use" | "not_found"> {
  const [target] = await tx
    .select({ id: backupTargets.id, legacySettings: backupTargets.legacySettings })
    .from(backupTargets)
    .where(eq(backupTargets.id, id))
    .limit(1)
    .for("update");
  if (!target) return "not_found";
  if (target.legacySettings) return "in_use";
  const referenced = await tx.execute(sql`SELECT 1 AS x WHERE
    EXISTS (SELECT 1 FROM site_backup_copies WHERE target_id = ${id})
    OR EXISTS (SELECT 1 FROM panel_backup_copies WHERE target_id = ${id})
    OR EXISTS (SELECT 1 FROM backup_policy_targets WHERE target_id = ${id})
    OR EXISTS (SELECT 1 FROM site_backups WHERE restore_target_id = ${id} OR archive_target_id = ${id})`);
  if (referenced.rows.length > 0) return "in_use";
  await tx.delete(backupTargets).where(eq(backupTargets.id, id));
  return "deleted";
}

/** Stores a connectivity test; the free/total space and the root come from the executor's answer (local only). */
export async function recordTargetTest(
  tx: DatabaseExecutor,
  id: string,
  r: {
    at: Date;
    outcome: "ok" | "failed";
    problem: BackupProblem | null;
    availableBytes?: number | null;
    totalBytes?: number | null;
    root?: string | null;
  },
): Promise<void> {
  await tx
    .update(backupTargets)
    .set({
      lastTestAt: r.at,
      lastTestOutcome: r.outcome,
      lastTestProblem: r.problem,
      lastTestAvailableBytes: r.availableBytes ?? null,
      lastTestTotalBytes: r.totalBytes ?? null,
      ...(r.root ? { localRoot: sql`CASE WHEN ${backupTargets.kind} = 'local' THEN ${r.root}::text END` } : {}),
    })
    .where(eq(backupTargets.id, id));
}

/** The executor wrote the marker file: remembers when, and the root it reported (display only). Local targets only. */
export async function markLocalTargetInitialized(
  tx: DatabaseExecutor,
  id: string,
  at: Date,
  root: string,
): Promise<void> {
  await tx
    .update(backupTargets)
    .set({ initializedAt: at, localRoot: root })
    .where(and(eq(backupTargets.id, id), eq(backupTargets.kind, "local")));
}

/**
 * What the executor needs to reach a target's repository. Archived and disabled targets still resolve (restore,
 * forget and in-flight copies need them); null only when the row is missing, or the legacy target has no settings.
 */
export async function resolveDispatchTarget(
  db: DatabaseExecutor,
  masterKey: MasterKey,
  id: string,
): Promise<DispatchTarget | null> {
  const [row] = await db.select().from(backupTargets).where(eq(backupTargets.id, id)).limit(1);
  if (!row) return null;
  if (row.legacySettings) {
    // An archived legacy target is frozen at its own location: once backup_settings points elsewhere it must not read that repository.
    if (row.archivedAt !== null) {
      const same = await db.execute(sql`SELECT 1 FROM backup_settings bs
        WHERE bs.id = 'default' AND ${row.s3LocationKey}::text = hp_s3_location_key(bs.endpoint, bs.bucket, bs.prefix)`);
      if (same.rows.length === 0) return null;
    }
    return getBackupTarget(db, masterKey);
  }
  if (row.kind === "local") return { kind: "local", targetId: row.id };
  const config = row.configJson;
  if (!row.s3SecretCiphertextBase64 || !row.s3SecretIvBase64 || !row.s3SecretAuthTagBase64) return null;
  return {
    endpoint: String(config.endpoint),
    region: String(config.region),
    bucket: String(config.bucket),
    prefix: String(config.prefix),
    accessKeyId: String(config.accessKeyId),
    secretAccessKey: decryptSecretAesGcm({
      ciphertextBase64: row.s3SecretCiphertextBase64,
      ivBase64: row.s3SecretIvBase64,
      authTagBase64: row.s3SecretAuthTagBase64,
      masterKey,
      ...backupTargetS3SecretAad(row.id),
    }),
  };
}

/** The secret of an S3 target, for a location change that re-encrypts it under the new target's AAD. */
export async function decryptS3Secret(db: DatabaseExecutor, masterKey: MasterKey, id: string): Promise<string | null> {
  const [row] = await db.select({ kind: backupTargets.kind }).from(backupTargets).where(eq(backupTargets.id, id)).limit(1);
  if (row?.kind !== "s3") return null;
  const target = await resolveDispatchTarget(db, masterKey, id);
  return target && "secretAccessKey" in target ? target.secretAccessKey : null;
}

// --- policies ---------------------------------------------------------------------------------------------------

export interface EffectiveTarget {
  targetId: string;
  kind: BackupTargetKind;
  priority: number;
  required: boolean;
}

export interface PolicyRow {
  id: string;
  scope: "default_site" | "panel";
  scheduleHourUtc: number | null;
  retentionDays: number | null;
  targets: EffectiveTarget[];
  updatedAt: Date;
}

// A target a new backup may use: enabled, not archived, and (legacy) with the settings it reads still present.
const USABLE_TARGET = sql`t.enabled AND t.archived_at IS NULL
  AND (NOT t.legacy_settings OR EXISTS (SELECT 1 FROM backup_settings bs WHERE bs.id = 'default'))`;

async function policyTargets(db: DatabaseExecutor, policyId: string | null, usableOnly: boolean): Promise<EffectiveTarget[]> {
  if (policyId === null) return [];
  const result = await db.execute(sql`SELECT t.id AS target_id, t.kind, pt.priority, pt.required
    FROM backup_policy_targets pt JOIN backup_targets t ON t.id = pt.target_id
    WHERE pt.policy_id = ${policyId} AND (${usableOnly}::boolean = FALSE OR (${USABLE_TARGET}))
    ORDER BY pt.priority`);
  return (result.rows as { target_id: string; kind: BackupTargetKind; priority: number; required: boolean }[]).map((r) => ({
    targetId: r.target_id,
    kind: r.kind,
    priority: Number(r.priority),
    required: r.required,
  }));
}

async function scopePolicyId(db: DatabaseExecutor, scope: "default_site" | "panel"): Promise<string> {
  const [row] = await db
    .select({ id: backupPolicies.id })
    .from(backupPolicies)
    .where(and(eq(backupPolicies.scope, scope), sql`${backupPolicies.siteId} IS NULL`))
    .limit(1);
  if (!row) throw new Error(`backup policy '${scope}' is missing (migration 0022 not applied)`);
  return row.id;
}

/** The default_site or panel policy with ALL its targets (archived ones are removed from policies on archive). */
export async function getPolicy(db: DatabaseExecutor, scope: "default_site" | "panel"): Promise<PolicyRow> {
  const id = await scopePolicyId(db, scope);
  const [row] = await db.select().from(backupPolicies).where(eq(backupPolicies.id, id)).limit(1);
  return {
    id,
    scope,
    scheduleHourUtc: row!.scheduleHourUtc,
    retentionDays: row!.retentionDays,
    targets: await policyTargets(db, id, false),
    updatedAt: row!.updatedAt,
  };
}

/** Replaces the targets of a policy: priority = position + 1, all required. At most two, distinct. */
export async function setPolicyTargets(tx: DatabaseExecutor, policyId: string, targetIds: string[]): Promise<void> {
  if (targetIds.length > 2) throw new BackupTargetsRepositoryError("VALIDATION_ERROR", "too_many_targets");
  if (new Set(targetIds).size !== targetIds.length) throw new BackupTargetsRepositoryError("VALIDATION_ERROR", "duplicate_targets");
  await tx.delete(backupPolicyTargets).where(eq(backupPolicyTargets.policyId, policyId));
  if (targetIds.length > 0) {
    await tx
      .insert(backupPolicyTargets)
      .values(targetIds.map((targetId, index) => ({ policyId, targetId, priority: index + 1, required: true })));
  }
}

/**
 * Hour and retention of a scope. The hour exists on default_site only. The default_site values are mirrored, write-only,
 * into backup_settings while that row exists (a release older than 0022 and the legacy readers still see them).
 */
export async function updatePolicySettings(
  tx: DatabaseExecutor,
  scope: "default_site" | "panel",
  settings: { scheduleHourUtc?: number; retentionDays?: number },
  actorId: string | null,
): Promise<void> {
  if (scope === "panel" && settings.scheduleHourUtc !== undefined) {
    throw new BackupTargetsRepositoryError("VALIDATION_ERROR", "panel_policy_has_no_schedule");
  }
  const id = await scopePolicyId(tx, scope);
  await tx
    .update(backupPolicies)
    .set({
      ...(settings.scheduleHourUtc === undefined ? {} : { scheduleHourUtc: settings.scheduleHourUtc }),
      ...(settings.retentionDays === undefined ? {} : { retentionDays: settings.retentionDays }),
      updatedByUserId: actorId,
      updatedAt: new Date(),
    })
    .where(eq(backupPolicies.id, id));
  if (scope === "default_site" && (settings.scheduleHourUtc !== undefined || settings.retentionDays !== undefined)) {
    await tx
      .update(backupSettings)
      .set({
        ...(settings.scheduleHourUtc === undefined ? {} : { scheduleHourUtc: settings.scheduleHourUtc }),
        ...(settings.retentionDays === undefined ? {} : { retentionDays: settings.retentionDays }),
      })
      .where(eq(backupSettings.id, SINGLETON_ID));
  }
}

/** Moves every policy slot of one target to another (the legacy location swap); a policy already on `to` just drops `from`. */
export async function repointPolicyTarget(tx: DatabaseExecutor, fromTargetId: string, toTargetId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM backup_policy_targets WHERE target_id = ${fromTargetId}
    AND policy_id IN (SELECT policy_id FROM backup_policy_targets WHERE target_id = ${toTargetId})`);
  await tx.update(backupPolicyTargets).set({ targetId: toTargetId }).where(eq(backupPolicyTargets.targetId, fromTargetId));
}

const sitePolicyId = (siteId: string) => `bpl_${md5(`hp:backup-policy:site:${siteId}`)}`;

/** The site's own target choice in priority order; null = it inherits default_site. */
export async function getSitePolicyTargetIds(db: DatabaseExecutor, siteId: string): Promise<string[] | null> {
  const [policy] = await db
    .select({ id: backupPolicies.id })
    .from(backupPolicies)
    .where(and(eq(backupPolicies.scope, "site"), eq(backupPolicies.siteId, siteId)))
    .limit(1);
  if (!policy) return null;
  return (await policyTargets(db, policy.id, false)).map((t) => t.targetId);
}

/** null drops the site policy (inherit); an array (1..2 ids) replaces it. Targets only: a site policy holds no hour or retention. */
export async function setSitePolicy(
  tx: DatabaseExecutor,
  siteId: string,
  targetIds: string[] | null,
  actorId: string | null,
): Promise<void> {
  if (targetIds === null) {
    await tx.delete(backupPolicies).where(and(eq(backupPolicies.scope, "site"), eq(backupPolicies.siteId, siteId)));
    return;
  }
  const id = sitePolicyId(siteId);
  await tx
    .insert(backupPolicies)
    .values({ id, scope: "site", siteId, updatedByUserId: actorId })
    .onConflictDoUpdate({ target: backupPolicies.id, set: { updatedByUserId: actorId, updatedAt: new Date() } });
  await setPolicyTargets(tx, id, targetIds);
}

/**
 * The targets a new backup of a site goes to: its own policy if it has one, else default_site's; only enabled,
 * non-archived ones (selectability is not re-checked: a customer keeps a choice until the administrator removes it).
 */
export async function resolveEffectiveTargets(db: DatabaseExecutor, siteId: string): Promise<EffectiveTarget[]> {
  const [own] = await db
    .select({ id: backupPolicies.id })
    .from(backupPolicies)
    .where(and(eq(backupPolicies.scope, "site"), eq(backupPolicies.siteId, siteId)))
    .limit(1);
  return policyTargets(db, own?.id ?? (await scopePolicyId(db, "default_site")), true);
}

export async function resolvePanelTargets(db: DatabaseExecutor): Promise<EffectiveTarget[]> {
  return policyTargets(db, await scopePolicyId(db, "panel"), true);
}

/** At least one target a backup could be written to. */
export async function anyUsableTarget(db: DatabaseExecutor): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 AS x FROM backup_targets t WHERE ${USABLE_TARGET} LIMIT 1`);
  return result.rows.length > 0;
}

// --- copies -----------------------------------------------------------------------------------------------------

export type BackupAggregateStatus = "running" | "succeeded" | "partial" | "failed";

export interface CopyRow {
  id: string;
  backupId: string;
  targetId: string;
  targetKind: BackupTargetKind;
  priority: number;
  required: boolean;
  jobId: string | null;
  status: BackupCopyStatus;
  snapshotId: string | null;
  sizeBytes: number | null;
  problem: BackupProblem | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Executor job id of a copy: the first keeps the operation id (frozen S3 pins), the second is `<op>-t2`. */
const copyJobId = (operationId: string, priority: number) => (priority === 1 ? operationId : `${operationId}-t2`);

/** One `running` copy per effective target, pinned at enqueue, in the transaction that inserts the backup row. */
export async function insertSiteBackupCopies(
  tx: DatabaseExecutor,
  backupId: string,
  operationId: string,
  targets: readonly { targetId: string; priority: number; required: boolean }[],
): Promise<void> {
  if (targets.length === 0) return;
  await tx.insert(siteBackupCopies).values(
    targets.map((t) => ({
      id: `bcp_${md5(`${backupId}:${t.targetId}`)}`,
      backupId,
      targetId: t.targetId,
      priority: t.priority,
      required: t.required,
      jobId: copyJobId(operationId, t.priority),
      status: "running" as const,
    })),
  );
}

const COPY_COLUMNS = {
  id: siteBackupCopies.id,
  backupId: siteBackupCopies.backupId,
  targetId: siteBackupCopies.targetId,
  targetKind: backupTargets.kind,
  priority: siteBackupCopies.priority,
  required: siteBackupCopies.required,
  jobId: siteBackupCopies.jobId,
  status: siteBackupCopies.status,
  snapshotId: siteBackupCopies.snapshotId,
  sizeBytes: siteBackupCopies.sizeBytes,
  problem: siteBackupCopies.problem,
  startedAt: siteBackupCopies.startedAt,
  finishedAt: siteBackupCopies.finishedAt,
};

/** The copies of the given backups, by priority. */
export async function listSiteBackupCopies(db: DatabaseExecutor, backupIds: string[]): Promise<Map<string, CopyRow[]>> {
  const byBackup = new Map<string, CopyRow[]>();
  if (backupIds.length === 0) return byBackup;
  const rows = await db
    .select(COPY_COLUMNS)
    .from(siteBackupCopies)
    .innerJoin(backupTargets, eq(backupTargets.id, siteBackupCopies.targetId))
    .where(inArray(siteBackupCopies.backupId, backupIds))
    .orderBy(asc(siteBackupCopies.backupId), asc(siteBackupCopies.priority));
  for (const row of rows) byBackup.set(row.backupId, [...(byBackup.get(row.backupId) ?? []), row]);
  return byBackup;
}

export interface CopySettlement {
  status: "succeeded" | "failed" | "missing" | "unknown";
  snapshotId?: string | null;
  sizeBytes?: number | null;
  problem?: BackupProblem | null;
}

const settlementValues = (r: CopySettlement) => ({
  status: r.status,
  snapshotId: r.snapshotId ?? null,
  sizeBytes: r.sizeBytes ?? null,
  problem: r.problem ?? null,
  finishedAt: new Date(),
});

/** Settles a copy that is still running; false when it was not (a replayed or late answer changes nothing, BKP-14). */
export async function settleSiteBackupCopy(db: DatabaseExecutor, copyId: string, r: CopySettlement): Promise<boolean> {
  const rows = await db
    .update(siteBackupCopies)
    .set(settlementValues(r))
    .where(and(eq(siteBackupCopies.id, copyId), eq(siteBackupCopies.status, "running")))
    .returning({ id: siteBackupCopies.id });
  return rows.length > 0;
}

/**
 * Recomputes the aggregate of a backup from its copies in ONE statement and writes it to the row while it is still
 * running: any running copy → running; every required copy succeeded (and one did) → succeeded; one succeeded →
 * partial; else failed. snapshot_id / size_bytes mirror the succeeded copy of the lowest priority number (the previous
 * release reads them), problem is the first unsuccessful required copy's. Returns the row's status afterwards; null
 * when the backup does not exist. A backup without copies keeps its status.
 */
export async function settleSiteBackupAggregate(
  db: DatabaseExecutor,
  backupId: string,
): Promise<BackupAggregateStatus | null> {
  await db.execute(sql`WITH agg AS (
      SELECT CASE
          WHEN bool_or(c.status = 'running') THEN 'running'
          WHEN bool_or(c.status = 'succeeded') AND bool_and(c.status = 'succeeded' OR NOT c.required) THEN 'succeeded'
          WHEN bool_or(c.status = 'succeeded') THEN 'partial'
          ELSE 'failed' END AS status,
        (array_agg(c.snapshot_id ORDER BY c.priority) FILTER (WHERE c.status = 'succeeded'))[1] AS snapshot_id,
        (array_agg(c.size_bytes ORDER BY c.priority) FILTER (WHERE c.status = 'succeeded'))[1] AS size_bytes,
        (array_agg(c.problem ORDER BY c.priority) FILTER (WHERE c.required AND c.status <> 'succeeded' AND c.problem IS NOT NULL))[1] AS problem
      FROM site_backup_copies c WHERE c.backup_id = ${backupId} HAVING COUNT(*) > 0)
    UPDATE site_backups sb SET status = agg.status, snapshot_id = agg.snapshot_id, size_bytes = agg.size_bytes,
      problem = CASE WHEN agg.status IN ('partial', 'failed') THEN agg.problem END,
      finished_at = CASE WHEN agg.status = 'running' THEN NULL ELSE NOW() END
    FROM agg WHERE sb.id = ${backupId} AND sb.status = 'running' `);
  const [row] = await db.select({ status: siteBackups.status }).from(siteBackups).where(eq(siteBackups.id, backupId)).limit(1);
  return (row?.status as BackupAggregateStatus | undefined) ?? null;
}

export interface RetentionCopyRow {
  copyId: string;
  backupId: string;
  kind: string;
  /** The copy's own status; the retention step maps it (running/unknown → skipped, missing → dropped). */
  status: BackupCopyStatus;
  snapshotId: string | null;
  /** started_at of the logical backup. */
  startedAt: Date;
}

/** The copies a site has on one target, joined to their logical backup, newest first. */
export async function listRetentionCopies(db: DatabaseExecutor, siteId: string, targetId: string): Promise<RetentionCopyRow[]> {
  return db
    .select({
      copyId: siteBackupCopies.id,
      backupId: siteBackups.id,
      kind: siteBackups.kind,
      status: siteBackupCopies.status,
      snapshotId: siteBackupCopies.snapshotId,
      startedAt: siteBackups.startedAt,
    })
    .from(siteBackupCopies)
    .innerJoin(siteBackups, eq(siteBackups.id, siteBackupCopies.backupId))
    .where(and(eq(siteBackups.siteId, siteId), eq(siteBackupCopies.targetId, targetId)))
    .orderBy(desc(siteBackups.startedAt), desc(siteBackups.id));
}

/** Every target that holds a copy of the site (a deleted site's orphan prune forgets on each). */
export async function listTargetsWithCopiesForSite(db: DatabaseExecutor, siteId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ targetId: siteBackupCopies.targetId })
    .from(siteBackupCopies)
    .innerJoin(siteBackups, eq(siteBackups.id, siteBackupCopies.backupId))
    .where(eq(siteBackups.siteId, siteId))
    .orderBy(asc(siteBackupCopies.targetId));
  return rows.map((r) => r.targetId);
}

export async function deleteSiteBackupCopies(db: DatabaseExecutor, copyIds: string[]): Promise<void> {
  if (copyIds.length > 0) await db.delete(siteBackupCopies).where(inArray(siteBackupCopies.id, copyIds));
}

/** Deletes the given logical backups that have no copy left. */
export async function deleteEmptySiteBackups(db: DatabaseExecutor, backupIds: string[]): Promise<void> {
  if (backupIds.length === 0) return;
  await db.delete(siteBackups).where(
    and(
      inArray(siteBackups.id, backupIds),
      sql`NOT EXISTS (SELECT 1 FROM site_backup_copies c WHERE c.backup_id = ${siteBackups.id})`,
    ),
  );
}

// --- panel copies -----------------------------------------------------------------------------------------------

export interface PanelCopyRow extends Omit<CopyRow, "backupId"> {
  operationId: string;
}

/** One `running` copy per panel target for the `panel.backups.create` operation. */
export async function insertPanelBackupCopies(
  tx: DatabaseExecutor,
  operationId: string,
  targets: readonly { targetId: string; priority: number; required: boolean }[],
): Promise<void> {
  if (targets.length === 0) return;
  await tx.insert(panelBackupCopies).values(
    targets.map((t) => ({
      id: `pcp_${md5(`${operationId}:${t.targetId}`)}`,
      operationId,
      targetId: t.targetId,
      priority: t.priority,
      required: t.required,
      jobId: copyJobId(operationId, t.priority),
      status: "running" as const,
    })),
  );
}

const PANEL_COPY_COLUMNS = {
  id: panelBackupCopies.id,
  operationId: panelBackupCopies.operationId,
  targetId: panelBackupCopies.targetId,
  targetKind: backupTargets.kind,
  priority: panelBackupCopies.priority,
  required: panelBackupCopies.required,
  jobId: panelBackupCopies.jobId,
  status: panelBackupCopies.status,
  snapshotId: panelBackupCopies.snapshotId,
  sizeBytes: panelBackupCopies.sizeBytes,
  problem: panelBackupCopies.problem,
  startedAt: panelBackupCopies.startedAt,
  finishedAt: panelBackupCopies.finishedAt,
};

export async function listPanelBackupCopies(db: DatabaseExecutor, operationId: string): Promise<PanelCopyRow[]> {
  return db
    .select(PANEL_COPY_COLUMNS)
    .from(panelBackupCopies)
    .innerJoin(backupTargets, eq(backupTargets.id, panelBackupCopies.targetId))
    .where(eq(panelBackupCopies.operationId, operationId))
    .orderBy(asc(panelBackupCopies.priority));
}

/** Settles a panel copy that is still running; false when it was not. */
export async function settlePanelBackupCopy(db: DatabaseExecutor, copyId: string, r: CopySettlement): Promise<boolean> {
  const rows = await db
    .update(panelBackupCopies)
    .set(settlementValues(r))
    .where(and(eq(panelBackupCopies.id, copyId), eq(panelBackupCopies.status, "running")))
    .returning({ id: panelBackupCopies.id });
  return rows.length > 0;
}

/** The aggregate rule (running / succeeded / partial / failed) for a list of copies, same as the SQL of a site backup. */
export function aggregateCopyStatuses(copies: readonly { status: BackupCopyStatus; required: boolean }[]): BackupAggregateStatus {
  if (copies.some((c) => c.status === "running")) return "running";
  const succeeded = copies.some((c) => c.status === "succeeded");
  if (succeeded && copies.every((c) => c.status === "succeeded" || !c.required)) return "succeeded";
  return succeeded ? "partial" : "failed";
}

/** The outcome of the newest panel backup whose copies have all finished; null when there is none. */
export async function latestPanelBackupOutcome(
  db: DatabaseExecutor,
): Promise<{ at: Date; status: "succeeded" | "partial" | "failed"; problem: BackupProblem | null } | null> {
  const [newest] = await db
    .select({ operationId: panelBackupCopies.operationId })
    .from(panelBackupCopies)
    .where(
      sql`NOT EXISTS (SELECT 1 FROM panel_backup_copies r WHERE r.operation_id = ${panelBackupCopies.operationId} AND r.status = 'running')`,
    )
    .orderBy(desc(panelBackupCopies.startedAt), desc(panelBackupCopies.operationId))
    .limit(1);
  if (!newest) return null;
  const copies = await listPanelBackupCopies(db, newest.operationId);
  const status = aggregateCopyStatuses(copies);
  if (status === "running") return null;
  const at = copies.reduce<Date | null>(
    (latest, c) => (c.finishedAt && (!latest || c.finishedAt > latest) ? c.finishedAt : latest),
    null,
  );
  return {
    at: at ?? copies[0]!.startedAt,
    status,
    problem: status === "succeeded" ? null : (copies.find((c) => c.required && c.status !== "succeeded" && c.problem)?.problem ?? null),
  };
}
