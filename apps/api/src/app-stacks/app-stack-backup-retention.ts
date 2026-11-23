import {
  APP_STACK_RESOURCE_TYPE,
  DEFAULT_BACKUP_RETENTION_DAYS,
  PLATFORM_OPS_ORG_ID,
  appStackBackupOperationSteps,
  appStackLockKey,
} from "@hosting-panel/contracts";
import {
  enqueueOperationTransactional,
  getPolicy,
  listAppStackBackupCopies,
  listAppStackBackupRetentionScopes,
  listAppStackBackupsForRetention,
  type AppStackBackupCopyRow,
  type AppStackBackupRow,
  type DatabaseExecutor,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { selectExpired, type RetentionRow } from "../backups/backup-retention.js";
import { APP_STACK_STEP_LEASE_MS } from "./app-stack-runtime-policy.js";

// Which backups of an application go, and the nightly request that removes them (ADR-0038 K7). The rule is the one
// sites have: nothing here decides a number of its own.

/** The backups of one application that the retention rule lets go. */
export function expiredAppStackBackups(
  backups: readonly AppStackBackupRow[],
  copies: ReadonlyMap<string, readonly AppStackBackupCopyRow[]>,
  now: Date,
  retentionDays: number,
  live: boolean,
): string[] {
  const rows: RetentionRow[] = backups.map((b) => ({
    id: b.id,
    // Safety backups take the slots of the backups sites make before an update; a partial backup counts as good.
    kind: b.kind === "manual" ? "manual" : "pre_update",
    status: b.status === "partial" ? "succeeded" : b.status,
    snapshotId: (copies.get(b.id) ?? []).find((c) => c.snapshotId !== null)?.snapshotId ?? null,
    startedAt: b.startedAt,
  }));
  const { forget, drop } = selectExpired(rows, now, retentionDays, live);
  return [...forget, ...drop].map((row) => row.id);
}

/** The retention period of the server's backup policy: applications have none of their own. */
export async function appStackBackupRetentionDays(db: DatabaseExecutor): Promise<number> {
  return (await getPolicy(db, "default_site")).retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
}

/** Applications that need a clean-up now: a backup expired, or an interrupted action left a row open. */
export async function listAppStackPruneCandidates(db: DatabaseExecutor, now: Date): Promise<string[]> {
  const scopes = await listAppStackBackupRetentionScopes(db);
  if (scopes.length === 0) return [];
  const retentionDays = await appStackBackupRetentionDays(db);
  const candidates: string[] = [];
  for (const scope of scopes) {
    const backups = await listAppStackBackupsForRetention(db, scope.stackId);
    const copies = await listAppStackBackupCopies(
      db,
      backups.map((b) => b.id),
    );
    const open = backups.some((b) => b.status === "running" || b.restoreStatus === "running");
    if (open || expiredAppStackBackups(backups, copies, now, retentionDays, scope.live).length > 0) candidates.push(scope.stackId);
  }
  return candidates;
}

/**
 * Queues the clean-up of one application's backups. It belongs to the platform, like the clean-up of a deleted site,
 * so it also works once the application is gone; the platform organisation must exist. False = the application is
 * busy (a backup or a restore holds its lock): the next night asks again.
 */
export async function enqueueAppStackPrune(tx: DatabaseExecutor, stackId: string): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => {
      await enqueueOperationTransactional(sp as unknown as HostingPanelDatabase, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: "stack.prune",
        resourceType: APP_STACK_RESOURCE_TYPE,
        resourceId: stackId,
        lockKey: appStackLockKey(stackId),
        leaseDurationMs: APP_STACK_STEP_LEASE_MS,
        steps: appStackBackupOperationSteps("stack.prune"),
        outboxPayload: { stackId, backupId: null, sourceBackupId: null },
      });
    });
    return true;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "RESOURCE_LOCKED") return false;
    throw err;
  }
}
