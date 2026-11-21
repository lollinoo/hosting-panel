import { randomUUID } from "node:crypto";
import {
  HEAVY_ACTIONS_PER_HOUR,
  HEAVY_ACTIONS_PER_HOUR_PER_ORGANIZATION,
  HEAVY_ACTION_WINDOW_MS,
  HEAVY_BACKUP_OPERATION_KINDS,
  SITE_TYPE_KEYS,
  type AdminSiteBackupStatusDto,
  type BackupKind,
  type BackupProblem,
  type BackupStatus,
} from "@hosting-panel/contracts";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { DatabaseExecutor } from "./client.js";
import {
  backupPolicies,
  backupSettings,
  operations,
  organizations,
  siteBackups,
  sites,
  users,
} from "./schema.js";
import { decryptSecretAesGcm, encryptSecretAesGcm } from "./secrets-crypto.js";

const SINGLETON_ID = "default";

export const BACKUP_SECRET_AAD = {
  organizationId: "platform",
  siteId: null,
  secretKey: "HP_BACKUP_S3_SECRET_ACCESS_KEY",
} as const;

export interface BackupTarget {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupSettingsRow {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  scheduleHourUtc: number;
  retentionDays: number;
  lastNightlyRunOn: string | null;
  lastTestAt: Date | null;
  lastTestOutcome: "ok" | "failed" | null;
  lastTestProblem: BackupProblem | null;
  lastPanelBackupAt: Date | null;
  lastPanelBackupStatus: "succeeded" | "failed" | null;
  lastPanelBackupProblem: BackupProblem | null;
  updatedAt: Date;
}

export interface SiteBackupRow {
  id: string;
  siteId: string;
  kind: BackupKind;
  status: BackupStatus;
  operationId: string | null;
  snapshotId: string | null;
  sizeBytes: number | null;
  problem: BackupProblem | null;
  startedAt: Date;
  finishedAt: Date | null;
  siteUrl: string | null;
  restoreOperationId: string | null;
  restoreStatus: "running" | "succeeded" | "failed" | null;
  restoreProblem: BackupProblem | null;
  restoredAt: Date | null;
  archiveOperationId: string | null;
  archiveStatus: "preparing" | "ready" | "failed" | null;
  archiveProblem: BackupProblem | null;
  archiveReadyUntil: Date | null;
  restoreTargetId: string | null;
  archiveTargetId: string | null;
}

const SITE_BACKUP_SELECT = {
  id: siteBackups.id,
  siteId: siteBackups.siteId,
  kind: siteBackups.kind,
  status: siteBackups.status,
  operationId: siteBackups.operationId,
  snapshotId: siteBackups.snapshotId,
  sizeBytes: siteBackups.sizeBytes,
  problem: siteBackups.problem,
  startedAt: siteBackups.startedAt,
  finishedAt: siteBackups.finishedAt,
  siteUrl: siteBackups.siteUrl,
  restoreOperationId: siteBackups.restoreOperationId,
  restoreStatus: siteBackups.restoreStatus,
  restoreProblem: siteBackups.restoreProblem,
  restoredAt: siteBackups.restoredAt,
  archiveOperationId: siteBackups.archiveOperationId,
  archiveStatus: siteBackups.archiveStatus,
  archiveProblem: siteBackups.archiveProblem,
  archiveReadyUntil: siteBackups.archiveReadyUntil,
  restoreTargetId: siteBackups.restoreTargetId,
  archiveTargetId: siteBackups.archiveTargetId,
};

function generateBackupId(): string {
  return `bkp_${randomUUID().replace(/-/g, "")}`;
}

/** Reads public backup target configuration without touching ciphertext or decrypting secrets. */
export async function getBackupSettingsPublic(
  db: DatabaseExecutor,
): Promise<BackupSettingsRow | null> {
  const rows = await db
    .select({
      endpoint: backupSettings.endpoint,
      region: backupSettings.region,
      bucket: backupSettings.bucket,
      prefix: backupSettings.prefix,
      accessKeyId: backupSettings.accessKeyId,
      scheduleHourUtc: backupSettings.scheduleHourUtc,
      retentionDays: backupSettings.retentionDays,
      lastNightlyRunOn: backupSettings.lastNightlyRunOn,
      lastTestAt: backupSettings.lastTestAt,
      lastTestOutcome: backupSettings.lastTestOutcome,
      lastTestProblem: backupSettings.lastTestProblem,
      lastPanelBackupAt: backupSettings.lastPanelBackupAt,
      lastPanelBackupStatus: backupSettings.lastPanelBackupStatus,
      lastPanelBackupProblem: backupSettings.lastPanelBackupProblem,
      updatedAt: backupSettings.updatedAt,
    })
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON_ID))
    .limit(1);

  return rows[0] ?? null;
}

/** Decrypts and returns the S3 backup target credentials for backup dispatch or connectivity tests. */
export async function getBackupTarget(
  db: DatabaseExecutor,
  masterKey: string | Buffer | Uint8Array,
): Promise<BackupTarget | null> {
  const rows = await db
    .select({
      endpoint: backupSettings.endpoint,
      region: backupSettings.region,
      bucket: backupSettings.bucket,
      prefix: backupSettings.prefix,
      accessKeyId: backupSettings.accessKeyId,
      secretAccessKeyCiphertextBase64: backupSettings.secretAccessKeyCiphertextBase64,
      secretAccessKeyIvBase64: backupSettings.secretAccessKeyIvBase64,
      secretAccessKeyAuthTagBase64: backupSettings.secretAccessKeyAuthTagBase64,
    })
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON_ID))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.accessKeyId,
    secretAccessKey: decryptSecretAesGcm({
      ciphertextBase64: row.secretAccessKeyCiphertextBase64,
      ivBase64: row.secretAccessKeyIvBase64,
      authTagBase64: row.secretAccessKeyAuthTagBase64,
      masterKey,
      ...BACKUP_SECRET_AAD,
    }),
  };
}

/** Inserts or updates singleton backup settings, keeping the stored secret when omitted. */
export async function upsertBackupSettings(
  tx: DatabaseExecutor,
  masterKey: string | Buffer | Uint8Array,
  input: Omit<BackupTarget, "secretAccessKey"> & {
    secretAccessKey?: string;
    scheduleHourUtc: number;
    retentionDays: number;
    updatedByUserId: string | null;
  },
): Promise<{ targetChanged: boolean }> {
  const existingRows = await tx
    .select()
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON_ID))
    .limit(1);
  const existing = existingRows[0] ?? null;

  if (!existing && input.secretAccessKey === undefined) {
    throw new Error("secretAccessKey is required on initial backup configuration");
  }

  const envelope =
    input.secretAccessKey !== undefined
      ? encryptSecretAesGcm({
          plaintext: input.secretAccessKey,
          masterKey,
          ...BACKUP_SECRET_AAD,
        })
      : null;

  const secretEnvelopeColumns = envelope
    ? {
        secretAccessKeyCiphertextBase64: envelope.ciphertextBase64,
        secretAccessKeyIvBase64: envelope.ivBase64,
        secretAccessKeyAuthTagBase64: envelope.authTagBase64,
        secretAccessKeyKeyVersion: envelope.keyVersion,
      }
    : {
        secretAccessKeyCiphertextBase64: existing!.secretAccessKeyCiphertextBase64,
        secretAccessKeyIvBase64: existing!.secretAccessKeyIvBase64,
        secretAccessKeyAuthTagBase64: existing!.secretAccessKeyAuthTagBase64,
        secretAccessKeyKeyVersion: existing!.secretAccessKeyKeyVersion,
      };

  const now = new Date();
  if (!existing) {
    await tx.insert(backupSettings).values({
      id: SINGLETON_ID,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      ...secretEnvelopeColumns,
      scheduleHourUtc: input.scheduleHourUtc,
      retentionDays: input.retentionDays,
      updatedByUserId: input.updatedByUserId,
      updatedAt: now,
    });
    return { targetChanged: false };
  }

  const targetChanged =
    existing.endpoint !== input.endpoint ||
    existing.bucket !== input.bucket ||
    existing.prefix !== input.prefix;

  const shouldResetTest =
    targetChanged ||
    existing.region !== input.region ||
    existing.accessKeyId !== input.accessKeyId ||
    input.secretAccessKey !== undefined;

  await tx
    .update(backupSettings)
    .set({
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      prefix: input.prefix,
      accessKeyId: input.accessKeyId,
      ...secretEnvelopeColumns,
      scheduleHourUtc: input.scheduleHourUtc,
      retentionDays: input.retentionDays,
      ...(shouldResetTest
        ? {
            lastTestAt: null,
            lastTestOutcome: null,
            lastTestProblem: null,
          }
        : {}),
      updatedByUserId: input.updatedByUserId,
      updatedAt: now,
    })
    .where(eq(backupSettings.id, SINGLETON_ID));

  return { targetChanged };
}

/** Deletes the singleton backup settings row. */
export async function deleteBackupSettings(tx: DatabaseExecutor): Promise<void> {
  await tx.delete(backupSettings).where(eq(backupSettings.id, SINGLETON_ID));
}

/** Records the outcome of the latest connectivity test against the configured backup target. */
export async function recordBackupTest(
  db: DatabaseExecutor,
  at: Date,
  outcome: "ok" | "failed",
  problem: BackupProblem | null,
): Promise<void> {
  await db
    .update(backupSettings)
    .set({
      lastTestAt: at,
      lastTestOutcome: outcome,
      lastTestProblem: problem,
    })
    .where(eq(backupSettings.id, SINGLETON_ID));
}

export interface NightlyRunState {
  scheduleHourUtc: number;
  retentionDays: number;
  lastNightlyRunOn: string | null;
  nightlyRunStartedAt: Date | null;
}

export interface NightlySiteRef {
  id: string;
  organizationId: string;
  status: string;
}

// The nightly run state (hour, retention, cursor, lock) lives on the default_site policy of backup_policies, seeded by
// migration 0022 on every install, so an installation with local targets only still schedules (BKP-02). The same
// values are mirrored, write-only, into the backup_settings row while it exists: a release older than 0022 and the
// readers of getBackupSettingsPublic().lastNightlyRunOn keep working after a rollback.
const DEFAULT_SITE_POLICY = and(eq(backupPolicies.scope, "default_site"), isNull(backupPolicies.siteId));

const NIGHTLY_STATE_COLUMNS = {
  scheduleHourUtc: backupPolicies.scheduleHourUtc,
  retentionDays: backupPolicies.retentionDays,
  lastNightlyRunOn: backupPolicies.lastNightlyRunOn,
  nightlyRunStartedAt: backupPolicies.nightlyRunStartedAt,
};

function toNightlyRunState(row: {
  scheduleHourUtc: number | null;
  retentionDays: number | null;
  lastNightlyRunOn: string | null;
  nightlyRunStartedAt: Date | null;
}): NightlyRunState {
  // ck_backup_policies_hour / the seed keep both set on the default_site row.
  return { ...row, scheduleHourUtc: row.scheduleHourUtc!, retentionDays: row.retentionDays! };
}

async function mirrorNightlyCursor(
  tx: DatabaseExecutor,
  cursor: { lastNightlyRunOn: string | null; nightlyRunStartedAt: Date | null },
): Promise<void> {
  await tx
    .update(backupSettings)
    .set({ lastNightlyRunOn: cursor.lastNightlyRunOn, nightlyRunStartedAt: cursor.nightlyRunStartedAt })
    .where(eq(backupSettings.id, SINGLETON_ID));
}

/** Locks and reads the nightly run state (the default_site policy) within an active transaction. */
export async function lockNightlyRunState(
  tx: DatabaseExecutor,
): Promise<NightlyRunState | null> {
  const rows = await tx
    .select(NIGHTLY_STATE_COLUMNS)
    .from(backupPolicies)
    .where(DEFAULT_SITE_POLICY)
    .limit(1)
    .for("update");

  return rows[0] ? toNightlyRunState(rows[0]) : null;
}

/** Atomically starts a nightly backup run if idle, hour reached, and date differs from today. */
export async function startNightlyRun(
  tx: DatabaseExecutor,
  today: string,
  hourUtc: number,
  startedAt: Date = new Date(),
): Promise<NightlyRunState | null> {
  const startedAtIso = startedAt.toISOString();
  const rows = await tx
    .update(backupPolicies)
    .set({
      lastNightlyRunOn: today,
      nightlyRunStartedAt: sql<Date>`GREATEST(
        ${startedAtIso}::timestamptz,
        (
          SELECT date_trunc('milliseconds', MAX(${siteBackups.startedAt})) + INTERVAL '1 millisecond'
          FROM ${siteBackups}
          WHERE ${siteBackups.kind} = 'nightly'
        )
      )`,
    })
    .where(
      and(
        DEFAULT_SITE_POLICY,
        isNull(backupPolicies.nightlyRunStartedAt),
        lte(backupPolicies.scheduleHourUtc, hourUtc),
        or(isNull(backupPolicies.lastNightlyRunOn), ne(backupPolicies.lastNightlyRunOn, today)),
      ),
    )
    .returning(NIGHTLY_STATE_COLUMNS);

  const row = rows[0];
  if (!row) {
    return null;
  }
  await mirrorNightlyCursor(tx, row);
  return toNightlyRunState(row);
}

/** Clears nightly_run_started_at when a nightly backup run completes. */
export async function finishNightlyRun(tx: DatabaseExecutor): Promise<void> {
  await tx.update(backupPolicies).set({ nightlyRunStartedAt: null }).where(DEFAULT_SITE_POLICY);
  await tx.update(backupSettings).set({ nightlyRunStartedAt: null }).where(eq(backupSettings.id, SINGLETON_ID));
}

/** Finds the next eligible site without a nightly backup row since runStartedAt. */
export async function findNextNightlySite(
  tx: DatabaseExecutor,
  runStartedAt: Date,
): Promise<NightlySiteRef | null> {
  const rows = await tx
    .select({
      id: sites.id,
      organizationId: sites.organizationId,
      status: sites.status,
    })
    .from(sites)
    .where(
      and(
        inArray(sites.status, ["ready", "degraded", "stopped"]),
        inArray(sites.siteType, [...SITE_TYPE_KEYS]),
        // Only a site whose effective policy (its own, else default_site) has a usable target: a fresh install
        // with nothing configured must not write a failed row per site every night.
        sql`EXISTS (
          SELECT 1 FROM backup_policy_targets pt JOIN backup_targets t ON t.id = pt.target_id
          WHERE pt.policy_id = COALESCE(
              (SELECT sp.id FROM backup_policies sp WHERE sp.scope = 'site' AND sp.site_id = ${sites.id}),
              (SELECT dp.id FROM backup_policies dp WHERE dp.scope = 'default_site' AND dp.site_id IS NULL))
            AND t.enabled AND t.archived_at IS NULL
            AND (NOT t.legacy_settings OR EXISTS (SELECT 1 FROM backup_settings bs WHERE bs.id = 'default')))`,
        notExists(
          tx
            .select({ id: siteBackups.id })
            .from(siteBackups)
            .where(
              and(
                eq(siteBackups.siteId, sites.id),
                eq(siteBackups.kind, "nightly"),
                gte(siteBackups.startedAt, runStartedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(sites.id))
    .limit(1);

  return rows[0] ?? null;
}

/** Counts nightly rows recorded since runStartedAt, split into queued and site_busy. */
export async function countNightlyRunResults(
  tx: DatabaseExecutor,
  runStartedAt: Date,
): Promise<{ enqueued: number; busy: number }> {
  const [row] = await tx
    .select({
      enqueued: sql<number>`COALESCE(SUM(CASE WHEN NOT (${siteBackups.status} = 'failed' AND ${siteBackups.problem} = 'site_busy' AND ${siteBackups.operationId} IS NULL) THEN 1 ELSE 0 END), 0)::int`,
      busy: sql<number>`COALESCE(SUM(CASE WHEN ${siteBackups.status} = 'failed' AND ${siteBackups.problem} = 'site_busy' AND ${siteBackups.operationId} IS NULL THEN 1 ELSE 0 END), 0)::int`,
    })
    .from(siteBackups)
    .where(and(eq(siteBackups.kind, "nightly"), gte(siteBackups.startedAt, runStartedAt)));

  return {
    enqueued: row?.enqueued ?? 0,
    busy: row?.busy ?? 0,
  };
}

/** Inserts a new site backup history row in running or immediately failed state. */
export async function insertSiteBackup(
  tx: DatabaseExecutor,
  row: {
    siteId: string;
    kind: BackupKind;
    status: "running" | "failed";
    operationId: string | null;
    problem?: BackupProblem | null;
    siteUrl?: string | null;
    startedAt?: Date;
    finishedAt?: Date | null;
  },
): Promise<{ id: string }> {
  const id = generateBackupId();
  const startedAt = row.startedAt ?? new Date();
  const finishedAt =
    row.finishedAt !== undefined ? row.finishedAt : row.status === "failed" ? startedAt : null;

  await tx.insert(siteBackups).values({
    id,
    siteId: row.siteId,
    kind: row.kind,
    status: row.status,
    operationId: row.operationId,
    problem: row.problem ?? null,
    siteUrl: row.siteUrl ?? null,
    startedAt,
    finishedAt,
  });

  return { id };
}

/** Settles a running site backup row matching operationId to succeeded or failed. */
export async function settleSiteBackup(
  db: DatabaseExecutor,
  operationId: string,
  r: {
    status: "succeeded" | "failed";
    snapshotId?: string | null;
    sizeBytes?: number | null;
    problem?: BackupProblem | null;
  },
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      status: r.status,
      snapshotId: r.snapshotId ?? null,
      sizeBytes: r.sizeBytes ?? null,
      problem: r.problem ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(siteBackups.operationId, operationId), eq(siteBackups.status, "running")));
}

/** Lists backup rows for a site ordered newest first. */
export async function listSiteBackups(
  db: DatabaseExecutor,
  siteId: string,
): Promise<SiteBackupRow[]> {
  return db
    .select(SITE_BACKUP_SELECT)
    .from(siteBackups)
    .where(eq(siteBackups.siteId, siteId))
    .orderBy(desc(siteBackups.startedAt), desc(siteBackups.id));
}

/** Returns one backup row scoped to siteId, or null when absent or on another site. */
export async function getSiteBackup(
  db: DatabaseExecutor,
  siteId: string,
  backupId: string,
): Promise<SiteBackupRow | null> {
  const rows = await db
    .select(SITE_BACKUP_SELECT)
    .from(siteBackups)
    .where(and(eq(siteBackups.id, backupId), eq(siteBackups.siteId, siteId)))
    .limit(1);

  return rows[0] ?? null;
}

/** Marks a backup row as running a restore operation and clears any prior restore outcome. */
export async function markSiteRestoreRunning(
  db: DatabaseExecutor,
  backupId: string,
  operationId: string,
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      restoreOperationId: operationId,
      restoreStatus: "running",
      restoreProblem: null,
      restoredAt: null,
    })
    .where(eq(siteBackups.id, backupId));
}

/** Settles a running restore row matching operationId to succeeded or failed. */
export async function settleSiteRestore(
  db: DatabaseExecutor,
  operationId: string,
  r: { status: "succeeded" | "failed"; problem: BackupProblem | null },
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      restoreStatus: r.status,
      restoreProblem: r.problem,
      restoredAt: new Date(),
    })
    .where(
      and(
        eq(siteBackups.restoreOperationId, operationId),
        eq(siteBackups.restoreStatus, "running"),
      ),
    );
}

/** Clears prior archive states on the same site and marks backupId as preparing an archive. */
export async function markSiteArchivePreparing(
  db: DatabaseExecutor,
  siteId: string,
  backupId: string,
  operationId: string,
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      archiveStatus: null,
      archiveReadyUntil: null,
      archiveProblem: null,
    })
    .where(and(eq(siteBackups.siteId, siteId), ne(siteBackups.id, backupId)));

  await db
    .update(siteBackups)
    .set({
      archiveOperationId: operationId,
      archiveStatus: "preparing",
      archiveProblem: null,
      archiveReadyUntil: null,
    })
    .where(eq(siteBackups.id, backupId));
}

/** Settles a preparing archive row matching operationId to ready or failed. */
export async function settleSiteArchive(
  db: DatabaseExecutor,
  operationId: string,
  r: { status: "ready" | "failed"; readyUntil: Date | null; problem: BackupProblem | null },
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      archiveStatus: r.status,
      archiveReadyUntil: r.readyUntil,
      archiveProblem: r.problem,
    })
    .where(
      and(
        eq(siteBackups.archiveOperationId, operationId),
        eq(siteBackups.archiveStatus, "preparing"),
      ),
    );
}

/** Clears archive status fields on a backup row when its archive operation matches. */
export async function clearSiteArchive(
  db: DatabaseExecutor,
  backupId: string,
  operationId: string,
): Promise<void> {
  await db
    .update(siteBackups)
    .set({
      archiveStatus: null,
      archiveReadyUntil: null,
      archiveProblem: null,
    })
    .where(and(eq(siteBackups.id, backupId), eq(siteBackups.archiveOperationId, operationId)));
}

/** Stores the outcome of the latest nightly panel copy on the settings row. */
export async function recordPanelBackupOutcome(
  db: DatabaseExecutor,
  r: { at: Date; status: "succeeded" | "failed"; problem: BackupProblem | null },
): Promise<void> {
  await db
    .update(backupSettings)
    .set({ lastPanelBackupAt: r.at, lastPanelBackupStatus: r.status, lastPanelBackupProblem: r.problem })
    .where(eq(backupSettings.id, SINGLETON_ID));
}

/** Sums the size of each existing site's newest succeeded (or partial: it has a restorable copy) backup. */
export async function sumNewestBackupSizes(db: DatabaseExecutor): Promise<number> {
  const newest = db
    .selectDistinctOn([siteBackups.siteId], { siteId: siteBackups.siteId, sizeBytes: siteBackups.sizeBytes })
    .from(siteBackups)
    .where(sql`${siteBackups.status} IN ('succeeded', 'partial')`)
    .orderBy(siteBackups.siteId, desc(siteBackups.startedAt), desc(siteBackups.id))
    .as("newest_success");
  const [row] = await db
    .select({ total: sql<string>`COALESCE(SUM(${newest.sizeBytes}), 0)::bigint` })
    .from(newest)
    .innerJoin(sites, eq(sites.id, newest.siteId));
  return Number(row?.total ?? 0);
}

export type HeavyActionScope = { readonly siteId: string } | { readonly organizationId: string };

/** When a customer may start another heavy action in the scope; null = allowed now. */
export async function heavyActionRetryAt(
  db: DatabaseExecutor,
  scope: HeavyActionScope,
  now: Date,
  excludeOperationId: string,
): Promise<Date | null> {
  const limit = "siteId" in scope ? HEAVY_ACTIONS_PER_HOUR : HEAVY_ACTIONS_PER_HOUR_PER_ORGANIZATION;
  const rows = await db
    .select({ submittedAt: operations.submittedAt })
    .from(operations)
    .innerJoin(users, eq(users.id, operations.requestedByUserId))
    .where(
      and(
        "siteId" in scope
          ? and(eq(operations.resourceType, "site"), eq(operations.resourceId, scope.siteId))
          : eq(operations.organizationId, scope.organizationId),
        inArray(operations.kind, [...HEAVY_BACKUP_OPERATION_KINDS]),
        isNull(users.platformRole),
        gt(operations.submittedAt, new Date(now.getTime() - HEAVY_ACTION_WINDOW_MS)),
        ne(operations.id, excludeOperationId),
      ),
    )
    .orderBy(desc(operations.submittedAt))
    .limit(limit);

  return rows.length < limit ? null : new Date(rows[limit - 1]!.submittedAt.getTime() + HEAVY_ACTION_WINDOW_MS);
}

/** Lists per-site backup status across all active sites for the platform admin overview. */
export async function listAdminBackupStatus(
  db: DatabaseExecutor,
): Promise<AdminSiteBackupStatusDto[]> {
  const latestAttempt = db
    .selectDistinctOn([siteBackups.siteId], {
      siteId: siteBackups.siteId,
      startedAt: siteBackups.startedAt,
      status: siteBackups.status,
      problem: siteBackups.problem,
    })
    .from(siteBackups)
    .orderBy(siteBackups.siteId, desc(siteBackups.startedAt), desc(siteBackups.id))
    .as("latest_attempt");

  const latestSuccess = db
    .selectDistinctOn([siteBackups.siteId], {
      siteId: siteBackups.siteId,
      id: siteBackups.id,
      sizeBytes: siteBackups.sizeBytes,
      startedAt: siteBackups.startedAt,
      finishedAt: siteBackups.finishedAt,
    })
    .from(siteBackups)
    .where(sql`${siteBackups.status} IN ('succeeded', 'partial')`)
    .orderBy(siteBackups.siteId, desc(siteBackups.startedAt), desc(siteBackups.id))
    .as("latest_success");

  const latestRunning = db
    .selectDistinctOn([siteBackups.siteId], {
      siteId: siteBackups.siteId,
      operationId: siteBackups.operationId,
    })
    .from(siteBackups)
    .where(eq(siteBackups.status, "running"))
    .orderBy(siteBackups.siteId, desc(siteBackups.startedAt), desc(siteBackups.id))
    .as("latest_running");

  // Same pick as the customer's tab: a running restore first, else the newest finished one.
  const latestRestore = db
    .selectDistinctOn([siteBackups.siteId], {
      siteId: siteBackups.siteId,
      id: siteBackups.id,
      startedAt: siteBackups.startedAt,
      restoreStatus: siteBackups.restoreStatus,
      restoredAt: siteBackups.restoredAt,
      restoreProblem: siteBackups.restoreProblem,
    })
    .from(siteBackups)
    .where(
      or(
        eq(siteBackups.restoreStatus, "running"),
        and(
          inArray(siteBackups.restoreStatus, ["succeeded", "failed"]),
          sql`${siteBackups.restoredAt} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(
      siteBackups.siteId,
      desc(sql`${siteBackups.restoreStatus} = 'running'`),
      desc(siteBackups.restoredAt),
    )
    .as("latest_restore");

  const rows = await db
    .select({
      siteId: sites.id,
      siteName: sites.name,
      organizationId: organizations.id,
      organizationName: organizations.name,
      lastSuccessStartedAt: latestSuccess.startedAt,
      lastSuccessFinishedAt: latestSuccess.finishedAt,
      lastSuccessBackupId: latestSuccess.id,
      lastSuccessSizeBytes: latestSuccess.sizeBytes,
      restoreBackupId: latestRestore.id,
      restoreBackupStartedAt: latestRestore.startedAt,
      restoreStatus: latestRestore.restoreStatus,
      restoredAt: latestRestore.restoredAt,
      restoreProblem: latestRestore.restoreProblem,
      lastAttemptAt: latestAttempt.startedAt,
      lastStatus: latestAttempt.status,
      problem: latestAttempt.problem,
      runningOperationId: latestRunning.operationId,
    })
    .from(sites)
    .innerJoin(organizations, eq(sites.organizationId, organizations.id))
    .leftJoin(latestAttempt, eq(sites.id, latestAttempt.siteId))
    .leftJoin(latestSuccess, eq(sites.id, latestSuccess.siteId))
    .leftJoin(latestRunning, eq(sites.id, latestRunning.siteId))
    .leftJoin(latestRestore, eq(sites.id, latestRestore.siteId))
    .orderBy(asc(organizations.name), asc(sites.name), asc(sites.id));

  return rows.map((row) => {
    const lastSuccessTimestamp = row.lastSuccessFinishedAt ?? row.lastSuccessStartedAt;
    return {
      siteId: row.siteId,
      siteName: row.siteName,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      lastSuccessAt: lastSuccessTimestamp ? lastSuccessTimestamp.toISOString() : null,
      lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
      lastStatus: row.lastStatus ?? null,
      problem: row.problem ?? null,
      runningOperationId: row.runningOperationId ?? null,
      lastSuccessBackupId: row.lastSuccessBackupId ?? null,
      lastSuccessSizeBytes: row.lastSuccessSizeBytes ?? null,
      lastRestore:
        row.restoreBackupId && row.restoreBackupStartedAt && row.restoreStatus
          ? {
              backupId: row.restoreBackupId,
              backupStartedAt: row.restoreBackupStartedAt.toISOString(),
              status: row.restoreStatus,
              finishedAt: row.restoredAt ? row.restoredAt.toISOString() : null,
              problem: row.restoreStatus === "running" ? null : (row.restoreProblem ?? null),
            }
          : null,
    };
  });
}

/** Lists distinct deleted site IDs that still have backup rows older than cutoff. */
export async function listOrphanSiteIdsWithBackupsBefore(
  db: DatabaseExecutor,
  cutoff: Date,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ siteId: siteBackups.siteId })
    .from(siteBackups)
    .where(
      and(
        lt(siteBackups.startedAt, cutoff),
        notExists(db.select({ id: sites.id }).from(sites).where(eq(sites.id, siteBackups.siteId))),
      ),
    )
    .orderBy(asc(siteBackups.siteId));

  return rows.map((row) => row.siteId);
}

/** Deletes backup history rows by ID. */
export async function deleteSiteBackups(db: DatabaseExecutor, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await db.delete(siteBackups).where(inArray(siteBackups.id, ids));
}

/** Deletes every row from site_backups, typically after an S3 target change. */
export async function deleteAllSiteBackups(tx: DatabaseExecutor): Promise<void> {
  await tx.delete(siteBackups);
}
