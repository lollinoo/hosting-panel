import {
  APP_STACK_BACKUP_OPERATION_KINDS,
  BACKUP_PROBLEMS,
  isBackupAvailable,
  type AppStackBackupOperationKind,
  type AppStackBackupStepKey,
  type BackupJobStatus,
  type BackupProblem,
  type ErrorCode,
  type RuntimeBackend,
} from "@hosting-panel/contracts";
import {
  and,
  appStacks,
  deleteAppStackBackupCopies,
  deleteAppStackBackupsWithoutCopies,
  enqueueAppStackResumeTransactional,
  eq,
  failRunningAppStackBackupCopies,
  getAppStack,
  getAppStackBackupByOperation,
  getAppStackIncompleteDataMark,
  getAppStackRestoreSource,
  isNull,
  listAppStackBackupCopies,
  listAppStackBackupsForRetention,
  operationSteps,
  renewOperationLease,
  resolveDispatchTarget,
  settleAppStackBackupAggregate,
  settleAppStackBackupCopy,
  settleAppStackBackupStopTransactional,
  settleAppStackRestore,
  settleOperation,
  updateOperationStepTransactional,
  type AppStackBackupCopyRow,
  type AppStackBackupCopySettlement,
  type AppStackBackupRow,
  type DispatchTarget,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import { isStackExecutor, type DockerExecutorPort, type StackExecutorPort } from "@hosting-panel/executor-contracts";
import { extractKnownErrorCode, normalizeBackupProblem } from "../backups/site-backups-applier.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { isAmbiguousFailure } from "../runtime/site-provisioner.js";
import { appStackBackupRetentionDays, expiredAppStackBackups } from "./app-stack-backup-retention.js";
import type { AppStackRuntimeDeps } from "./app-stack-runtime.js";
import {
  APP_STACK_FAILURE,
  APP_STACK_STEP_FAILED_TEXT,
  APP_STACK_STEP_LEASE_MS,
  APP_STACK_STEP_RUNNING_TEXT,
  APP_STACK_STEP_SKIPPED_TEXT,
  APP_STACK_UNCERTAIN_TEXT,
} from "./app-stack-runtime-policy.js";
import { parkAppStackOperationUnknown } from "./app-stack-settle.js";

// Backup, restore and nightly clean-up of an application (ADR-0038). The three kinds run in worker lanes of their own
// under the application's lock. Every outcome is written by one settleOperation transaction: steps, copies, the
// restore mark, the application's status and, when the application has to start again, the operation that starts it.

type OperationRow = typeof operations.$inferSelect;

export const APP_STACK_BACKUP_POLL_MS = 5_000;
/** Status reads that keep failing for this long leave the outcome to recovery. */
export const APP_STACK_BACKUP_POLL_GIVE_UP_MS = 120_000;
export const APP_STACK_BACKUP_POLL_DEADLINE_MS = 6 * 3_600_000;
const FORGET_BATCH = 100;
/** Job ids of one clean-up: `<op>-forget`, then `<op>-forget-t2` … `-t9`; the rest waits for the next night. */
const FORGET_JOBS_PER_PASS = 9;

export const APP_STACK_BACKUP_STEP_DONE_TEXT: Readonly<Record<AppStackBackupStepKey, string>> = {
  validate: "Request checked",
  unpublish: "Web addresses withdrawn",
  stop: "Components stopped",
  copy: "Backup saved",
  restore: "Data restored",
  expire: "Old backups removed",
  settle: "Done",
};
export const APP_STACK_BACKUP_STEP_NOT_NEEDED_TEXT = "The application was already stopped";
export const APP_STACK_BACKUP_FAILED_TEXT: Readonly<Record<AppStackBackupOperationKind, string>> = {
  "stack.backup": "The backup did not finish.",
  "stack.restore": "The restore did not finish.",
  "stack.prune": "Old backups could not be removed.",
};

export function isAppStackBackupKind(kind: string): kind is AppStackBackupOperationKind {
  return (APP_STACK_BACKUP_OPERATION_KINDS as readonly string[]).includes(kind);
}

/** Application backups work where applications run and site backups are available (ADR-0038 K10). */
export function appStackBackupsAvailable(executor: DockerExecutorPort, runtimeBackend: RuntimeBackend): boolean {
  return isStackExecutor(executor) && executor.isRuntimeAvailable && isBackupAvailable(runtimeBackend);
}

const OPEN_STEP = new Set(["pending", "running", "unknown"]);

/** A step that ended for certain without doing its work. */
class BackupStepFailure extends Error {
  public constructor(
    public readonly problem: BackupProblem,
    public readonly code: ErrorCode = "INTERNAL_ERROR",
  ) {
    super(problem);
  }
}

interface Ctx {
  readonly op: OperationRow;
  readonly kind: AppStackBackupOperationKind;
  current: AppStackBackupStepKey;
}

/** What a failing backup or restore needs to settle, filled as the steps go. */
interface Progress {
  backup: AppStackBackupRow | null;
  /** This operation withdrew the web addresses. */
  unpublished: boolean;
  /** The job that writes the data back was sent: the data may have changed. */
  applying: boolean;
}

interface Settlement {
  readonly outcome: "succeeded" | "failed";
  readonly code?: ErrorCode;
  /** Outcome failed: the step that failed; null = every step that had started. */
  readonly failedStep?: AppStackBackupStepKey | null;
  /** Writes of the same transaction, before the operation ends. */
  readonly write?: (tx: HostingPanelDatabase) => Promise<void>;
  /** Queue the operation that starts the application again, once this one has ended. */
  readonly resume: boolean;
}

function asProblem(value: string | null): BackupProblem {
  return value !== null && (BACKUP_PROBLEMS as readonly string[]).includes(value) ? (value as BackupProblem) : "other";
}

/** A request the executor refused before it did anything. */
function refusalProblem(err: unknown): BackupProblem {
  const code = extractKnownErrorCode(err);
  if (code === "RESOURCE_LOCKED") return "site_busy";
  if (code === "NOT_FOUND" || code === "HOST_POLICY_DENIED") return "files_unreadable";
  return "other";
}

/** A job that says it ended well without a snapshot saved nothing that can be restored. */
function copyOutcome(job: BackupJobStatus): AppStackBackupCopySettlement {
  if (job.state === "succeeded" && job.snapshot) {
    return { status: "succeeded", snapshotId: job.snapshot.snapshotId, sizeBytes: job.snapshot.totalBytes };
  }
  if (job.state === "failed") return { status: "failed", problem: normalizeBackupProblem(job.failure) };
  return { status: "failed", problem: job.state === "succeeded" ? "other" : "interrupted" };
}

const ambiguous = () => new ControlPlaneError("OPERATION_AMBIGUOUS", APP_STACK_UNCERTAIN_TEXT);

export class AppStackBackupRuntime {
  readonly #deps: AppStackRuntimeDeps;

  public constructor(deps: AppStackRuntimeDeps) {
    this.#deps = deps;
  }

  /** Worker dispatch for every APP_STACK_BACKUP_OPERATION_KINDS kind. Throws to fail. */
  public async apply(op: OperationRow): Promise<void> {
    const ctx: Ctx = { op, kind: op.kind as AppStackBackupOperationKind, current: "validate" };
    const st: Progress = { backup: null, unpublished: false, applying: false };
    try {
      if (ctx.kind === "stack.prune") await this.#prune(ctx);
      else await this.#run(ctx, st);
    } catch (err) {
      if (isAmbiguousFailure(err)) {
        // A clean-up belongs to no customer: nothing of the application moves.
        await parkAppStackOperationUnknown(this.#deps.db, op, null);
        throw ambiguous();
      }
      const failure = err instanceof BackupStepFailure ? err : new BackupStepFailure(refusalProblem(err));
      await this.#fail(ctx, st, failure);
      throw new ControlPlaneError(failure.code, APP_STACK_BACKUP_FAILED_TEXT[ctx.kind]);
    }
  }

  /**
   * Settles an `unknown` operation from reads only: the state of its jobs and one read of the application. No job is
   * started or repeated; a job the executor no longer knows is closed as interrupted.
   */
  public async recover(op: OperationRow): Promise<"pending" | "settled"> {
    const { db } = this.#deps;
    const kind = op.kind as AppStackBackupOperationKind;
    const ctx: Ctx = { op, kind, current: "settle" };
    const interrupted = { outcome: "failed", code: "OPERATION_INTERRUPTED", failedStep: null } as const;
    if (kind === "stack.prune") {
      // The next night removes what this one left.
      await this.#settle(ctx, { ...interrupted, resume: false });
      return "settled";
    }
    const scope = { organizationId: op.organizationId, stackId: op.resourceId };
    const backup = await getAppStackBackupByOperation(db, op.id);
    if (backup) {
      for (const copy of (await listAppStackBackupCopies(db, [backup.id])).get(backup.id) ?? []) {
        if (copy.status !== "running") continue;
        if (copy.jobId === null) {
          await settleAppStackBackupCopy(db, copy.id, { status: "failed", problem: "interrupted" });
          continue;
        }
        const job = await this.#read(copy.jobId);
        if (job === null || job.state === "running") return "pending";
        await settleAppStackBackupCopy(db, copy.id, copyOutcome(job));
      }
    }

    // The restore job was sent only after its step was marked as started.
    let sent = false;
    let applied: BackupJobStatus | null = null;
    if (kind === "stack.restore") {
      const [step] = await db
        .select({ status: operationSteps.status })
        .from(operationSteps)
        .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "restore")));
      sent = step !== undefined && step.status !== "pending" && step.status !== "skipped";
      if (sent) {
        applied = await this.#read(`${op.id}-apply`);
        if (applied === null || applied.state === "running") return "pending";
      }
    }

    const stack = await getAppStack(db, scope);
    let observed: { active: boolean; published: boolean } | null = null;
    if (stack && (stack.status === "stopping" || stack.status === "unknown")) {
      const port = this.#port();
      try {
        if (!port) throw new Error("runtime unavailable");
        const read = await port.getAppStackStatus(scope);
        observed = {
          active: read.components.some((c) => c.state === "running" || c.state === "restarting"),
          published: read.routes.published,
        };
      } catch {
        await parkAppStackOperationUnknown(db, op, null);
        return "pending";
      }
    }

    const aggregate = backup ? await settleAppStackBackupAggregate(db, backup.id) : null;
    const saved = aggregate === "succeeded" || aggregate === "partial";
    const restored = applied?.state === "succeeded";
    const restoreProblem: BackupProblem = applied?.state === "failed" ? normalizeBackupProblem(applied.failure) : "interrupted";
    const stoppedState = observed;
    await this.#settle(ctx, {
      ...((kind === "stack.backup" ? saved : restored) ? ({ outcome: "succeeded" } as const) : interrupted),
      // Data that a restore may have half written stays as it is, with the application stopped.
      resume: backup !== null && backup.resumeAfter && (kind === "stack.backup" || !sent || restored),
      write: async (tx) => {
        if (kind === "stack.restore") {
          await settleAppStackRestore(tx, {
            operationId: op.id,
            status: restored ? "succeeded" : "failed",
            problem: restored ? null : restoreProblem,
            mayHaveWritten: sent,
          });
        }
        if (stoppedState) {
          await settleAppStackBackupStopTransactional(tx, {
            ...scope,
            to: stoppedState.active ? "degraded" : "stopped",
            routesWithdrawn: !stoppedState.published,
          });
        }
      },
    });
    return "settled";
  }

  #port(): StackExecutorPort | null {
    const { executor, config } = this.#deps;
    return appStackBackupsAvailable(executor, config.runtimeBackend) ? (executor as DockerExecutorPort & StackExecutorPort) : null;
  }

  #renew(ctx: Ctx): Promise<unknown> {
    return renewOperationLease(this.#deps.db, ctx.op.id, APP_STACK_STEP_LEASE_MS);
  }

  async #step<T>(ctx: Ctx, key: AppStackBackupStepKey, work: () => Promise<T>): Promise<T> {
    const { db } = this.#deps;
    ctx.current = key;
    await this.#renew(ctx);
    await updateOperationStepTransactional(db, ctx.op.id, key, "running", APP_STACK_STEP_RUNNING_TEXT);
    const result = await work();
    await updateOperationStepTransactional(db, ctx.op.id, key, "succeeded", APP_STACK_BACKUP_STEP_DONE_TEXT[key]);
    return result;
  }

  /** One transaction: the steps, the caller's writes, the end of the operation and the restart that follows it. */
  #settle(ctx: Ctx, s: Settlement): Promise<boolean> {
    const { db } = this.#deps;
    const { op, kind } = ctx;
    const outcome =
      s.outcome === "succeeded"
        ? ({ status: "succeeded" } as const)
        : ({
            status: "failed",
            errorCode: s.code ?? "INTERNAL_ERROR",
            errorMessage: s.code === "OPERATION_INTERRUPTED" ? APP_STACK_FAILURE.OPERATION_INTERRUPTED.text : APP_STACK_BACKUP_FAILED_TEXT[kind],
          } as const);
    return settleOperation(
      db,
      op.id,
      outcome,
      async (tx) => {
        const steps = await tx
          .select({ key: operationSteps.key, status: operationSteps.status })
          .from(operationSteps)
          .where(eq(operationSteps.operationId, op.id));
        for (const step of steps) {
          if (!OPEN_STEP.has(step.status)) continue;
          const key = step.key as AppStackBackupStepKey;
          if (s.outcome === "succeeded") {
            await updateOperationStepTransactional(tx, op.id, key, "succeeded", APP_STACK_BACKUP_STEP_DONE_TEXT[key]);
          } else if (key === s.failedStep || step.status !== "pending") {
            await updateOperationStepTransactional(tx, op.id, key, "failed", APP_STACK_STEP_FAILED_TEXT);
          } else {
            await updateOperationStepTransactional(tx, op.id, key, "skipped", APP_STACK_STEP_SKIPPED_TEXT);
          }
        }
        await s.write?.(tx);
      },
      async (tx) => {
        if (!s.resume) return;
        // A new, ordinary operation: it takes the lock this one has just released.
        await enqueueAppStackResumeTransactional(tx, {
          organizationId: op.organizationId,
          stackId: op.resourceId,
          requestedByUserId: op.requestedByUserId,
          sourceOperationId: op.id,
        });
      },
    );
  }

  /** A failure known for certain. The application starts again unless a restore may have changed its data. */
  async #fail(ctx: Ctx, st: Progress, failure: BackupStepFailure): Promise<void> {
    const { op, kind } = ctx;
    const { backup } = st;
    const scope = { organizationId: op.organizationId, stackId: op.resourceId };
    await this.#settle(ctx, {
      outcome: "failed",
      code: failure.code,
      failedStep: ctx.current,
      resume: kind !== "stack.prune" && backup !== null && backup.resumeAfter && !st.applying,
      write: async (tx) => {
        if (kind === "stack.prune") return;
        if (backup) {
          await failRunningAppStackBackupCopies(tx, backup.id, failure.problem);
          await settleAppStackBackupAggregate(tx, backup.id);
        }
        if (kind === "stack.restore") {
          await settleAppStackRestore(tx, { operationId: op.id, status: "failed", problem: failure.problem, mayHaveWritten: st.applying });
        }
        // Not stopped for certain: with its addresses possibly withdrawn the application does not serve as before.
        const stack = await getAppStack(tx, scope);
        if (stack?.status === "stopping") {
          await settleAppStackBackupStopTransactional(tx, { ...scope, to: "degraded", routesWithdrawn: st.unpublished });
        }
      },
    });
  }

  /** stack.backup and stack.restore: stop, save a copy, (restore: write the chosen backup back), start again. */
  async #run(ctx: Ctx, st: Progress): Promise<void> {
    const { db } = this.#deps;
    const { op, kind } = ctx;
    const scope = { organizationId: op.organizationId, stackId: op.resourceId };
    const { backup, source, port, wasStopped } = await this.#step(ctx, "validate", async () => {
      const row = await getAppStackBackupByOperation(db, op.id);
      st.backup = row;
      const from = kind === "stack.restore" ? await getAppStackRestoreSource(db, op.id) : null;
      const stack = await getAppStack(db, scope);
      if (!row || row.status !== "running" || !stack || (kind === "stack.restore" && !from)) throw new BackupStepFailure("other");
      if (stack.status !== "stopping" && stack.status !== "stopped") throw new BackupStepFailure("site_busy");
      const executor = this.#port();
      if (!executor) throw new BackupStepFailure("tool_unavailable", "NOT_SUPPORTED");
      return { backup: row, source: from, port: executor, wasStopped: stack.status === "stopped" };
    });

    if (wasStopped) {
      for (const key of ["unpublish", "stop"] as const) {
        await updateOperationStepTransactional(db, op.id, key, "skipped", APP_STACK_BACKUP_STEP_NOT_NEEDED_TEXT);
      }
    } else {
      // Always asked (idempotent): the stored routes hash can be null while a route file is still in place.
      await this.#step(ctx, "unpublish", async () => {
        await port.unpublishAppStackRoutes(scope);
        st.unpublished = true;
      });
      await this.#step(ctx, "stop", async () => {
        await port.stopAppStack(scope);
        await db.transaction((tx) => settleAppStackBackupStopTransactional(tx, { ...scope, to: "stopped", routesWithdrawn: true }));
      });
    }

    await this.#step(ctx, "copy", async () => {
      await this.#copy(ctx, backup);
      const status = await settleAppStackBackupAggregate(db, backup.id);
      if (status === "succeeded" || status === "partial") return;
      // For a restore this is the safety backup: without it nothing of the application is touched.
      throw new BackupStepFailure(asProblem((await getAppStackBackupByOperation(db, op.id))?.problem ?? null));
    });

    if (kind === "stack.backup") {
      ctx.current = "settle";
      await this.#settle(ctx, { outcome: "succeeded", resume: backup.resumeAfter });
      return;
    }
    if (source) await this.#restore(ctx, st, backup, source);
    ctx.current = "settle";
    await this.#settle(ctx, {
      outcome: "succeeded",
      resume: backup.resumeAfter,
      write: async (tx) => {
        await settleAppStackRestore(tx, { operationId: op.id, status: "succeeded", problem: null });
      },
    });
  }

  /** The destinations one after the other: the application is stopped for both. */
  async #copy(ctx: Ctx, backup: AppStackBackupRow): Promise<void> {
    const { db } = this.#deps;
    for (const copy of (await listAppStackBackupCopies(db, [backup.id])).get(backup.id) ?? []) {
      if (copy.status !== "running") continue;
      await settleAppStackBackupCopy(db, copy.id, await this.#copyOne(ctx, backup, copy));
    }
  }

  async #copyOne(ctx: Ctx, backup: AppStackBackupRow, copy: AppStackBackupCopyRow): Promise<AppStackBackupCopySettlement> {
    const { db, executor, config } = this.#deps;
    const target = await resolveDispatchTarget(db, config.secretsMasterKey, copy.targetId);
    if (target === null || copy.jobId === null) return { status: "failed", problem: "other" };
    let started: BackupJobStatus;
    try {
      started = await executor.backups({
        action: "stackStart",
        jobId: copy.jobId,
        stackId: backup.stackId,
        organizationId: backup.organizationId,
        volumeKeys: backup.volumeKeys,
        target,
      });
    } catch (err) {
      if (isAmbiguousFailure(err)) throw err;
      return { status: "failed", problem: refusalProblem(err) };
    }
    return copyOutcome(await this.#poll(ctx, copy.jobId, started));
  }

  /**
   * Writes the chosen backup back: the first good copy, by priority, whose destination is still configured, and only
   * the volumes that both the backup and the application have (ADR-0038 K5).
   */
  async #restore(ctx: Ctx, st: Progress, safety: AppStackBackupRow, source: AppStackBackupRow): Promise<void> {
    const { db, executor, config } = this.#deps;
    const { op } = ctx;
    ctx.current = "restore";
    let from: { snapshotId: string; target: DispatchTarget } | null = null;
    for (const copy of (await listAppStackBackupCopies(db, [source.id])).get(source.id) ?? []) {
      if (copy.status !== "succeeded" || copy.snapshotId === null) continue;
      const target = await resolveDispatchTarget(db, config.secretsMasterKey, copy.targetId);
      if (target !== null) {
        from = { snapshotId: copy.snapshotId, target };
        break;
      }
    }
    const volumeKeys = source.volumeKeys.filter((key) => safety.volumeKeys.includes(key));
    if (from === null || volumeKeys.length === 0) throw new BackupStepFailure("backup_copy_missing");

    // Marked as started before the request leaves: recovery reads this to know whether the data may have changed.
    await this.#renew(ctx);
    await updateOperationStepTransactional(db, op.id, "restore", "running", APP_STACK_STEP_RUNNING_TEXT);
    const jobId = `${op.id}-apply`;
    let started: BackupJobStatus;
    try {
      started = await executor.backups({
        action: "stackRestore",
        jobId,
        stackId: op.resourceId,
        organizationId: op.organizationId,
        volumeKeys,
        snapshotId: from.snapshotId,
        target: from.target,
      });
    } catch (err) {
      throw isAmbiguousFailure(err) ? err : new BackupStepFailure(refusalProblem(err));
    }
    st.applying = true;
    const ended = await this.#poll(ctx, jobId, started);
    if (ended.state !== "succeeded") {
      throw new BackupStepFailure(ended.state === "failed" ? normalizeBackupProblem(ended.failure) : "interrupted");
    }
    await updateOperationStepTransactional(db, op.id, "restore", "succeeded", APP_STACK_BACKUP_STEP_DONE_TEXT.restore);
  }

  /** stack.prune: closes rows an interrupted action left open, then removes what the retention rule lets go. */
  async #prune(ctx: Ctx): Promise<void> {
    const { db } = this.#deps;
    const stackId = ctx.op.resourceId;
    await this.#step(ctx, "validate", async () => {
      if (!this.#port()) throw new BackupStepFailure("tool_unavailable", "NOT_SUPPORTED");
      // This operation holds the application's lock, so no backup or restore of it is running now.
      for (const row of await listAppStackBackupsForRetention(db, stackId)) {
        if (row.status === "running") {
          await failRunningAppStackBackupCopies(db, row.id, "interrupted");
          await settleAppStackBackupAggregate(db, row.id);
        }
        if (row.restoreStatus === "running" && row.restoreOperationId !== null) {
          await settleAppStackRestore(db, { operationId: row.restoreOperationId, status: "failed", problem: "interrupted" });
        }
      }
    });
    await this.#step(ctx, "expire", async () => {
      if (!(await this.#expire(ctx, stackId))) throw new BackupStepFailure("other");
    });
    ctx.current = "settle";
    await this.#settle(ctx, { outcome: "succeeded", resume: false });
  }

  /** True when everything that had to go went; false leaves the rest, with its rows, to the next night. */
  async #expire(ctx: Ctx, stackId: string): Promise<boolean> {
    const { db, executor, config, clock } = this.#deps;
    const backups = await listAppStackBackupsForRetention(db, stackId);
    if (backups.length === 0) return true;
    const copies = await listAppStackBackupCopies(
      db,
      backups.map((b) => b.id),
    );
    const [live] = await db
      .select({ id: appStacks.id })
      .from(appStacks)
      .where(and(eq(appStacks.id, stackId), isNull(appStacks.deletedAt)));
    const retentionDays = await appStackBackupRetentionDays(db);
    const incomplete = (await getAppStackIncompleteDataMark(db, stackId)) !== null;
    const expired = expiredAppStackBackups(backups, copies, new Date(clock.now()), retentionDays, live !== undefined, incomplete);
    if (expired.length === 0) return true;

    const withoutSnapshot: string[] = [];
    const byTarget = new Map<string, { id: string; snapshotId: string }[]>();
    for (const copy of expired.flatMap((id) => copies.get(id) ?? [])) {
      if (copy.snapshotId === null) withoutSnapshot.push(copy.id);
      else byTarget.set(copy.targetId, [...(byTarget.get(copy.targetId) ?? []), { id: copy.id, snapshotId: copy.snapshotId }]);
    }
    await deleteAppStackBackupCopies(db, withoutSnapshot);

    let clean = true;
    let jobs = 0;
    for (const [targetId, held] of byTarget) {
      const target = await resolveDispatchTarget(db, config.secretsMasterKey, targetId);
      if (target === null) {
        // A destination that is no longer configured cannot be reached: only the rows go.
        await deleteAppStackBackupCopies(
          db,
          held.map((c) => c.id),
        );
        continue;
      }
      if (jobs >= FORGET_JOBS_PER_PASS) {
        clean = false;
        continue;
      }
      jobs += 1;
      const batch = held.slice(0, FORGET_BATCH);
      if (batch.length < held.length) clean = false;
      const jobId = jobs === 1 ? `${ctx.op.id}-forget` : `${ctx.op.id}-forget-t${String(jobs)}`;
      try {
        const started = await executor.backups({
          action: "stackForget",
          jobId,
          stackId,
          target,
          snapshotIds: [...new Set(batch.map((c) => c.snapshotId))],
        });
        const ended = await this.#poll(ctx, jobId, started);
        if (ended.state === "succeeded") {
          await deleteAppStackBackupCopies(
            db,
            batch.map((c) => c.id),
          );
        } else {
          clean = false;
        }
      } catch (err) {
        if (isAmbiguousFailure(err)) throw err;
        clean = false;
      }
    }
    await deleteAppStackBackupsWithoutCopies(db, expired);
    return clean;
  }

  /**
   * Follows a job to its end under a renewed lease; the first read does not wait. The executor accepted the job: any
   * failure before its end is read is ambiguous, because settling now would release the application while it may run.
   */
  async #poll(ctx: Ctx, jobId: string, initial: BackupJobStatus): Promise<BackupJobStatus> {
    const { executor, clock } = this.#deps;
    const began = clock.now();
    let status = initial;
    let failingSince: number | null = null;
    let first = true;
    while (status.state === "running") {
      if (clock.now() - began >= APP_STACK_BACKUP_POLL_DEADLINE_MS) throw ambiguous();
      try {
        await this.#renew(ctx);
        if (!first) await clock.sleep(APP_STACK_BACKUP_POLL_MS);
      } catch {
        throw ambiguous();
      }
      first = false;
      try {
        status = await executor.backups({ action: "status", jobId });
        failingSince = null;
      } catch {
        failingSince ??= clock.now();
        if (clock.now() - failingSince >= APP_STACK_BACKUP_POLL_GIVE_UP_MS) throw ambiguous();
      }
    }
    return status;
  }

  /** One status read; null when the executor did not answer. */
  async #read(jobId: string): Promise<BackupJobStatus | null> {
    try {
      return await this.#deps.executor.backups({ action: "status", jobId });
    } catch {
      return null;
    }
  }
}
