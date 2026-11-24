// Backups of applications (ADR-0038). A backup or a restore is one operation on the application's `stack:<id>` lock:
// it has no deployment row. Lock order: app_stacks row FOR UPDATE → app_stack_backups row → operations.
import {
  APP_STACK_BACKUP_ACTION_WINDOW_MS,
  APP_STACK_BACKUP_ACTIONS_PER_HOUR,
  APP_STACK_RESOURCE_TYPE,
  appStackBackupEnqueueTarget,
  appStackBackupOperationSteps,
  appStackLockKey,
  canTransitionAppStack,
  type AppStackBackupOperationKind,
  type AppStackBackupStatus,
  type BackupProblem,
  type BackupTargetKind,
  type ErrorCode,
} from "@hosting-panel/contracts";
import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import { AppStackRepositoryError, newAppEntityId, type AppStackRow } from "./app-stacks-repository.js";
import { resolveAppStackBackupTargets } from "./backup-targets-repository.js";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { ACTIVE_OPERATION_LOCK_STATUSES, enqueueOperationTransactional } from "./operations-repository.js";
import {
  appStackBackupCopies,
  appStackBackups,
  appStackComponents,
  appStacks,
  appStackVolumes,
  backupTargets,
  operations,
  users,
} from "./schema.js";

export type AppStackBackupRow = typeof appStackBackups.$inferSelect;
export type AppStackBackupCopyRow = typeof appStackBackupCopies.$inferSelect & { readonly targetKind: BackupTargetKind };
type OperationRow = typeof operations.$inferSelect;

export type AppStackBackupRepositoryErrorCode =
  | "NO_DATA" // the application has no data to save
  | "NO_DESTINATION" // the server has no usable backup destination
  | "BACKUP_NOT_FOUND"
  | "NOT_RESTORABLE" // no good copy, or none of its data belongs to the application any more
  | "TOO_MANY"; // hourly limit; `retryAt` says when

export class AppStackBackupRepositoryError extends Error {
  constructor(
    readonly code: AppStackBackupRepositoryErrorCode,
    message: string,
    readonly retryAt: Date | null = null,
  ) {
    super(message);
    this.name = "AppStackBackupRepositoryError";
  }
}

interface StackScope {
  readonly organizationId: string;
  readonly stackId: string;
}

function codedError(message: string, code: ErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

/** Priority 1 runs under the operation's own id, priority 2 under `<op>-t2` (the sites' rule). */
function copyJobId(operationId: string, priority: number): string {
  return priority === 1 ? operationId : `${operationId}-t2`;
}

export interface EnqueueAppStackBackupInput extends StackScope {
  readonly kind: Exclude<AppStackBackupOperationKind, "stack.prune">;
  /** The backup a restore reads; null for a backup. */
  readonly sourceBackupId: string | null;
  readonly requestedByUserId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** Customers are limited per hour; server administrators are not. */
  readonly limited: boolean;
}

export interface AppStackBackupWriteResult {
  readonly stack: AppStackRow;
  /** The row the operation writes: the backup, or the safety backup of a restore. */
  readonly backup: AppStackBackupRow;
  readonly operation: OperationRow;
  readonly idempotentReplay: boolean;
}

/**
 * When the hourly limit of an application frees a slot, or null while there is room. Counts the backups and restores
 * customers asked for; `excludeOperationId` is the request being judged.
 */
export async function appStackBackupRetryAt(
  db: DatabaseExecutor,
  stackId: string,
  now: Date,
  excludeOperationId: string,
): Promise<Date | null> {
  const limit = APP_STACK_BACKUP_ACTIONS_PER_HOUR;
  const rows = await db
    .select({ submittedAt: operations.submittedAt })
    .from(operations)
    .innerJoin(users, eq(users.id, operations.requestedByUserId))
    .where(
      and(
        eq(operations.resourceType, APP_STACK_RESOURCE_TYPE),
        eq(operations.resourceId, stackId),
        inArray(operations.kind, ["stack.backup", "stack.restore"]),
        isNull(users.platformRole),
        gt(operations.submittedAt, new Date(now.getTime() - APP_STACK_BACKUP_ACTION_WINDOW_MS)),
        ne(operations.id, excludeOperationId),
      ),
    )
    .orderBy(desc(operations.submittedAt))
    .limit(limit);
  return rows.length < limit ? null : new Date(rows[limit - 1]!.submittedAt.getTime() + APP_STACK_BACKUP_ACTION_WINDOW_MS);
}

/**
 * Accepts a backup or a restore in one transaction: the operation, the backup row with one copy per destination, the
 * marker on the backup a restore reads, and the application's status (`stopping`, or `stopped` when it already was).
 * A restore always writes a safety backup of the data as they are (`pre_restore`) under the same operation.
 * Throws AppStackRepositoryError (NOT_FOUND, INVALID_TRANSITION), AppStackBackupRepositoryError, or a coded error
 * (RESOURCE_LOCKED, IDEMPOTENCY_CONFLICT).
 */
export async function enqueueAppStackBackupTransactional(
  db: HostingPanelDatabase,
  input: EnqueueAppStackBackupInput,
): Promise<AppStackBackupWriteResult> {
  return await db.transaction(async (tx) => {
    const [prior] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.organizationId, input.organizationId), eq(operations.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.kind !== input.kind || prior.resourceId !== input.stackId || prior.requestHash !== input.requestHash) {
        throw codedError(`Idempotency key '${input.idempotencyKey}' was already used for a different request`, "IDEMPOTENCY_CONFLICT");
      }
      const [stack] = await tx
        .select()
        .from(appStacks)
        .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId)));
      const [backup] = await tx.select().from(appStackBackups).where(eq(appStackBackups.operationId, prior.id));
      if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
      if (!backup) throw new AppStackBackupRepositoryError("BACKUP_NOT_FOUND", "Backup not found.");
      return { stack, backup, operation: prior, idempotentReplay: true };
    }

    const [stack] = await tx
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
      .for("update");
    if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
    const lockKey = appStackLockKey(stack.id);
    const [active] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.lockKey, lockKey), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
      .limit(1);
    if (active) {
      throw codedError(`Resource lock '${lockKey}' is currently held by active operation '${active.id}'`, "RESOURCE_LOCKED");
    }
    const target = appStackBackupEnqueueTarget(stack.status);
    if (target === null) {
      throw new AppStackRepositoryError(
        "INVALID_TRANSITION",
        `This action is not available while the application is ${stack.status}.`,
        stack.status,
      );
    }

    const present = (
      await tx
        .select({ key: appStackVolumes.volumeKey })
        .from(appStackVolumes)
        .where(and(eq(appStackVolumes.stackId, stack.id), eq(appStackVolumes.status, "present")))
        .orderBy(asc(appStackVolumes.volumeKey))
    ).map((row) => row.key);
    if (present.length === 0) throw new AppStackBackupRepositoryError("NO_DATA", "The application has no data to save.");

    let source: AppStackBackupRow | null = null;
    if (input.kind === "stack.restore") {
      const [row] = await tx
        .select()
        .from(appStackBackups)
        .where(
          and(
            eq(appStackBackups.id, input.sourceBackupId ?? ""),
            eq(appStackBackups.stackId, stack.id),
            eq(appStackBackups.organizationId, stack.organizationId),
          ),
        )
        .for("update");
      if (!row) throw new AppStackBackupRepositoryError("BACKUP_NOT_FOUND", "Backup not found.");
      const [good] = await tx
        .select({ id: appStackBackupCopies.id })
        .from(appStackBackupCopies)
        .where(and(eq(appStackBackupCopies.backupId, row.id), eq(appStackBackupCopies.status, "succeeded")))
        .limit(1);
      const usable = (row.status === "succeeded" || row.status === "partial") && good !== undefined;
      if (!usable || !row.volumeKeys.some((key) => present.includes(key))) {
        throw new AppStackBackupRepositoryError("NOT_RESTORABLE", "This backup cannot be restored.");
      }
      source = row;
    }

    const targets = await resolveAppStackBackupTargets(tx);
    if (targets.length === 0) {
      throw new AppStackBackupRepositoryError("NO_DESTINATION", "No backup destination is configured on this server.");
    }

    // A backup, by hand or a safety one, copies incomplete data while a restore that failed has left them so: writing
    // it back leaves them so again (ADR-0038 K5).
    const incompleteData = (await getAppStackIncompleteDataMark(tx, stack.id)) !== null;

    const backupId = newAppEntityId("sbak");
    const { operation } = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
      organizationId: stack.organizationId,
      kind: input.kind,
      resourceType: APP_STACK_RESOURCE_TYPE,
      resourceId: stack.id,
      requestedByUserId: input.requestedByUserId ?? undefined,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      lockKey,
      outboxPayload: { stackId: stack.id, backupId, sourceBackupId: source?.id ?? null },
      steps: appStackBackupOperationSteps(input.kind),
    });
    if (input.limited) {
      const retryAt = await appStackBackupRetryAt(tx, stack.id, operation.submittedAt, operation.id);
      if (retryAt) {
        throw new AppStackBackupRepositoryError("TOO_MANY", "Too many backup actions on this application.", retryAt);
      }
    }

    const now = new Date();
    const [backup] = await tx
      .insert(appStackBackups)
      .values({
        id: backupId,
        stackId: stack.id,
        organizationId: stack.organizationId,
        kind: source ? "pre_restore" : "manual",
        status: "running",
        operationId: operation.id,
        revisionId: stack.appliedRevisionId,
        volumeKeys: present,
        resumeAfter: stack.status !== "stopped",
        incompleteData,
        startedAt: now,
      })
      .returning();
    await tx.insert(appStackBackupCopies).values(
      targets.map((t) => ({
        id: newAppEntityId("sbkc"),
        backupId,
        targetId: t.targetId,
        priority: t.priority,
        required: t.required,
        jobId: copyJobId(operation.id, t.priority),
        status: "running" as const,
        startedAt: now,
      })),
    );
    if (source) {
      await tx
        .update(appStackBackups)
        .set({ restoreOperationId: operation.id, restoreStatus: "running", restoreProblem: null, restoredAt: null })
        .where(eq(appStackBackups.id, source.id));
    }
    const [updated] = await tx.update(appStacks).set({ status: target, updatedAt: now }).where(eq(appStacks.id, stack.id)).returning();
    return { stack: updated!, backup: backup!, operation, idempotentReplay: false };
  });
}

/**
 * The outcome of the stop step of a backup or a restore: `stopped` (every part reads stopped, nothing is published),
 * or `degraded` when the stop failed for certain. Null when the application is gone.
 */
export async function settleAppStackBackupStopTransactional(
  db: DatabaseExecutor,
  input: StackScope & { readonly to: "stopped" | "degraded"; readonly routesWithdrawn: boolean },
): Promise<AppStackRow | null> {
  const [stack] = await db
    .select()
    .from(appStacks)
    .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
    .for("update");
  if (!stack) return null;
  if (stack.status !== input.to && !canTransitionAppStack(stack.status, input.to)) {
    throw new AppStackRepositoryError("INVALID_TRANSITION", `The application cannot move from ${stack.status} to ${input.to}.`, stack.status);
  }
  const now = new Date();
  if (input.to === "stopped") {
    await db
      .update(appStackComponents)
      .set({ health: "stopped", healthObservedAt: now, updatedAt: now })
      .where(eq(appStackComponents.stackId, stack.id));
  }
  const [updated] = await db
    .update(appStacks)
    // Withdrawn routes take the fingerprint of their addresses with them: nothing published, nothing pending (ADR-0037).
    .set({ status: input.to, updatedAt: now, ...(input.routesWithdrawn ? { appliedRoutesHash: null, appliedAddressesHash: null } : {}) })
    .where(eq(appStacks.id, stack.id))
    .returning();
  return updated!;
}

export async function getAppStackBackup(
  db: DatabaseExecutor,
  input: StackScope & { readonly backupId: string },
): Promise<AppStackBackupRow | null> {
  const [row] = await db
    .select()
    .from(appStackBackups)
    .where(
      and(
        eq(appStackBackups.id, input.backupId),
        eq(appStackBackups.stackId, input.stackId),
        eq(appStackBackups.organizationId, input.organizationId),
      ),
    );
  return row ?? null;
}

/** The backup an operation writes (the worker's recovery starts from the operation). */
export async function getAppStackBackupByOperation(db: DatabaseExecutor, operationId: string): Promise<AppStackBackupRow | null> {
  const [row] = await db.select().from(appStackBackups).where(eq(appStackBackups.operationId, operationId));
  return row ?? null;
}

/** Newest first. */
export async function listAppStackBackups(
  db: DatabaseExecutor,
  input: StackScope & { readonly limit?: number },
): Promise<AppStackBackupRow[]> {
  return await db
    .select()
    .from(appStackBackups)
    .where(and(eq(appStackBackups.stackId, input.stackId), eq(appStackBackups.organizationId, input.organizationId)))
    .orderBy(desc(appStackBackups.startedAt), desc(appStackBackups.id))
    .limit(input.limit ?? 100);
}

/** Copies by backup, each list by priority. */
export async function listAppStackBackupCopies(
  db: DatabaseExecutor,
  backupIds: readonly string[],
): Promise<Map<string, AppStackBackupCopyRow[]>> {
  const byBackup = new Map<string, AppStackBackupCopyRow[]>();
  if (backupIds.length === 0) return byBackup;
  const rows = await db
    .select({ copy: appStackBackupCopies, targetKind: backupTargets.kind })
    .from(appStackBackupCopies)
    .innerJoin(backupTargets, eq(backupTargets.id, appStackBackupCopies.targetId))
    .where(inArray(appStackBackupCopies.backupId, [...backupIds]))
    .orderBy(asc(appStackBackupCopies.backupId), asc(appStackBackupCopies.priority));
  for (const row of rows) {
    const list = byBackup.get(row.copy.backupId) ?? [];
    list.push({ ...row.copy, targetKind: row.targetKind });
    byBackup.set(row.copy.backupId, list);
  }
  return byBackup;
}

export interface AppStackBackupCopySettlement {
  readonly status: "succeeded" | "failed";
  readonly snapshotId?: string | null;
  readonly sizeBytes?: number | null;
  readonly problem?: BackupProblem | null;
}

/** Ends a copy that is still running; false when it already ended (a late answer changes nothing). */
export async function settleAppStackBackupCopy(db: DatabaseExecutor, copyId: string, r: AppStackBackupCopySettlement): Promise<boolean> {
  const good = r.status === "succeeded";
  const updated = await db
    .update(appStackBackupCopies)
    .set({
      status: r.status,
      snapshotId: good ? (r.snapshotId ?? null) : null,
      sizeBytes: good ? (r.sizeBytes ?? null) : null,
      problem: good ? null : (r.problem ?? "other"),
      finishedAt: new Date(),
    })
    .where(and(eq(appStackBackupCopies.id, copyId), eq(appStackBackupCopies.status, "running")))
    .returning({ id: appStackBackupCopies.id });
  return updated.length > 0;
}

/** Fails every copy of a backup that is still running (the copy was never sent, or its outcome is lost). */
export async function failRunningAppStackBackupCopies(db: DatabaseExecutor, backupId: string, problem: BackupProblem): Promise<number> {
  const updated = await db
    .update(appStackBackupCopies)
    .set({ status: "failed", snapshotId: null, sizeBytes: null, problem, finishedAt: new Date() })
    .where(and(eq(appStackBackupCopies.backupId, backupId), eq(appStackBackupCopies.status, "running")))
    .returning({ id: appStackBackupCopies.id });
  return updated.length;
}

/**
 * Sets the backup's status from its copies (the sites' rule): good when every required copy is good, `partial` when
 * only some copy is, `failed` when none. A backup that already ended is left as it is. Returns the status now stored.
 */
export async function settleAppStackBackupAggregate(db: DatabaseExecutor, backupId: string): Promise<AppStackBackupStatus | null> {
  await db.execute(sql`WITH agg AS (
      SELECT CASE
          WHEN bool_or(c.status = 'running') THEN 'running'
          WHEN bool_or(c.status = 'succeeded') AND bool_and(c.status = 'succeeded' OR NOT c.required) THEN 'succeeded'
          WHEN bool_or(c.status = 'succeeded') THEN 'partial'
          ELSE 'failed' END AS status,
        (array_agg(c.size_bytes ORDER BY c.priority) FILTER (WHERE c.status = 'succeeded'))[1] AS size_bytes,
        (array_agg(c.problem ORDER BY c.priority)
          FILTER (WHERE c.required AND c.status <> 'succeeded' AND c.problem IS NOT NULL))[1] AS problem
      FROM app_stack_backup_copies c WHERE c.backup_id = ${backupId} HAVING COUNT(*) > 0)
    UPDATE app_stack_backups b SET status = agg.status, size_bytes = agg.size_bytes,
      problem = CASE WHEN agg.status IN ('partial', 'failed') THEN agg.problem END,
      finished_at = CASE WHEN agg.status = 'running' THEN NULL ELSE NOW() END
    FROM agg WHERE b.id = ${backupId} AND b.status = 'running'`);
  const [row] = await db.select({ status: appStackBackups.status }).from(appStackBackups).where(eq(appStackBackups.id, backupId));
  return row?.status ?? null;
}

/**
 * Ends the restore an operation started on the backup it reads; false when it already ended. Its safety backup says
 * whether it left the data half written: a failed one when it may have written, or left them as half written as they
 * already were; a successful one when the backup it wrote back was itself a copy of half written data.
 */
export async function settleAppStackRestore(
  db: DatabaseExecutor,
  input: {
    readonly operationId: string;
    readonly status: "succeeded" | "failed";
    readonly problem: string | null;
    /** The job that writes the data back was accepted. Absent = not known: it may have been once the safety backup was good. */
    readonly mayHaveWritten?: boolean;
  },
): Promise<boolean> {
  const updated = await db
    .update(appStackBackups)
    .set({ restoreStatus: input.status, restoreProblem: input.status === "succeeded" ? null : input.problem, restoredAt: new Date() })
    .where(and(eq(appStackBackups.restoreOperationId, input.operationId), eq(appStackBackups.restoreStatus, "running")))
    .returning({ id: appStackBackups.id, incompleteData: appStackBackups.incompleteData });
  const [source] = updated;
  if (source === undefined) return false;
  const wrote =
    input.mayHaveWritten === undefined
      ? sql`${appStackBackups.status} IN ('succeeded', 'partial')`
      : input.mayHaveWritten
        ? sql`TRUE`
        : sql`FALSE`;
  await db
    .update(appStackBackups)
    .set({ leftIncomplete: input.status === "succeeded" ? source.incompleteData : sql`(${wrote} OR ${appStackBackups.incompleteData})` })
    .where(and(eq(appStackBackups.operationId, input.operationId), eq(appStackBackups.kind, "pre_restore")));
  return true;
}

/**
 * The safety backup of the restore that left an application's data half written, while they still are (ADR-0038 K5):
 * that restore is the newest operation asked of the application that is not a backup, a clean-up or another action
 * that failed, and its safety backup says it left them so. Anything else asked since, a start above all, takes the
 * data as they are; one that fails (a start the executor refuses) leaves them as they were. A restore counts even when
 * it failed: its safety backup says whether it left them so. Null while the data are whole. The one test of "the data
 * are half written now": the mark on a new safety backup, the retention rule and the page all ask it.
 */
export async function getAppStackIncompleteDataMark(db: DatabaseExecutor, stackId: string): Promise<AppStackBackupRow | null> {
  const [last] = await db
    .select({ id: operations.id, kind: operations.kind })
    .from(operations)
    .where(
      and(
        eq(operations.lockKey, appStackLockKey(stackId)),
        notInArray(operations.kind, ["stack.backup", "stack.prune"]),
        // A cancelled one failed before the worker took it up.
        or(eq(operations.kind, "stack.restore"), notInArray(operations.status, ["failed", "cancelled"])),
      ),
    )
    .orderBy(desc(operations.submittedAt), desc(operations.id))
    .limit(1);
  if (last?.kind !== "stack.restore") return null;
  const [safety] = await db
    .select()
    .from(appStackBackups)
    .where(and(eq(appStackBackups.operationId, last.id), eq(appStackBackups.kind, "pre_restore"), eq(appStackBackups.leftIncomplete, true)));
  return safety ?? null;
}

/** The backup a restore operation reads. */
export async function getAppStackRestoreSource(db: DatabaseExecutor, operationId: string): Promise<AppStackBackupRow | null> {
  const [row] = await db.select().from(appStackBackups).where(eq(appStackBackups.restoreOperationId, operationId));
  return row ?? null;
}

// --- retention --------------------------------------------------------------------------------------------------------

export interface AppStackBackupRetentionScope {
  readonly stackId: string;
  readonly organizationId: string;
  /** False once the application is deleted: its backups then expire by age alone. */
  readonly live: boolean;
}

/** Every application that has backup rows, deleted ones included. */
export async function listAppStackBackupRetentionScopes(db: DatabaseExecutor): Promise<AppStackBackupRetentionScope[]> {
  const live = exists(
    db
      .select({ one: sql`1` })
      .from(appStacks)
      .where(and(eq(appStacks.id, appStackBackups.stackId), isNull(appStacks.deletedAt))),
  );
  return await db
    .selectDistinct({
      stackId: appStackBackups.stackId,
      organizationId: appStackBackups.organizationId,
      live: sql<boolean>`${live}`,
    })
    .from(appStackBackups)
    .orderBy(asc(appStackBackups.stackId));
}

/** Every backup row of an application, newest first, whoever owns it (the retention sweep runs for the platform). */
export async function listAppStackBackupsForRetention(db: DatabaseExecutor, stackId: string): Promise<AppStackBackupRow[]> {
  return await db
    .select()
    .from(appStackBackups)
    .where(eq(appStackBackups.stackId, stackId))
    .orderBy(desc(appStackBackups.startedAt), desc(appStackBackups.id));
}

export async function deleteAppStackBackupCopies(db: DatabaseExecutor, copyIds: readonly string[]): Promise<void> {
  if (copyIds.length === 0) return;
  await db.delete(appStackBackupCopies).where(inArray(appStackBackupCopies.id, [...copyIds]));
}

/** Deletes the given backups that ended and have no copy left; returns how many went. */
export async function deleteAppStackBackupsWithoutCopies(db: DatabaseExecutor, backupIds: readonly string[]): Promise<number> {
  if (backupIds.length === 0) return 0;
  const deleted = await db
    .delete(appStackBackups)
    .where(
      and(
        inArray(appStackBackups.id, [...backupIds]),
        ne(appStackBackups.status, "running"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(appStackBackupCopies)
            .where(eq(appStackBackupCopies.backupId, appStackBackups.id)),
        ),
      ),
    )
    .returning({ id: appStackBackups.id });
  return deleted.length;
}
