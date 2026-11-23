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

const newestFirst = (a: AppStackBackupRow, b: AppStackBackupRow): number =>
  b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * While the last restore of an application left its data half written (its safety backup says so), the newest good
 * safety backup of whole data: the one the page tells the customer to restore. Null otherwise (ADR-0038 K5).
 */
export function appStackBackupToGoBackTo(backups: readonly AppStackBackupRow[]): AppStackBackupRow | null {
  const safety = backups.filter((b) => b.kind === "pre_restore").sort(newestFirst);
  if (!safety[0]?.leftIncomplete) return null;
  return safety.find((b) => !b.incompleteData && (b.status === "succeeded" || b.status === "partial")) ?? null;
}

/**
 * The backups of one application that the retention rule lets go. While the data of a live application are half
 * written, the safety backup to go back to stays whatever the count of newer ones (ADR-0038 K7).
 */
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
  const kept = live ? appStackBackupToGoBackTo(backups)?.id : undefined;
  return [...forget, ...drop].map((row) => row.id).filter((id) => id !== kept);
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
