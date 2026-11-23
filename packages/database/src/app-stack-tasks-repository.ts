// Tasks of applications (ADR-0042): the schedule of a task, its runs and the request side of a run.
// A run holds the application's lock like every stack operation. Lock order: app_stacks row FOR UPDATE →
// app_stack_task_schedules row FOR UPDATE. No function here takes or returns a command: the command of a task is read
// from the template when the run begins. What a run printed lives only in its row.

import {
  APP_STACK_BUSY_STATUSES,
  APP_STACK_RESOURCE_TYPE,
  APP_STACK_TASK_KIND,
  APP_STACK_TASK_LIMITS,
  APP_STACK_TASK_RUNNABLE_STATUSES,
  APP_STACK_TASK_STEPS,
  appStackLockKey,
  boundAppStackTaskOutput,
  type AppStackStatus,
  type AppStackTaskRunFinalStatus,
  type AppStackTaskRunProblem,
  type AppStackTaskSchedule,
  type AppStackTaskSkipReason,
  type ErrorCode,
} from "@hosting-panel/contracts";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { AppStackRepositoryError } from "./app-stacks-repository.js";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { ACTIVE_OPERATION_LOCK_STATUSES, enqueueOperationTransactional } from "./operations-repository.js";
import { appStackTaskRuns, appStackTaskSchedules, appStacks, operations } from "./schema.js";

export type AppStackTaskScheduleRow = typeof appStackTaskSchedules.$inferSelect;
export type AppStackTaskRunRow = typeof appStackTaskRuns.$inferSelect;
/** A run without what it printed. */
export type AppStackTaskRunSummaryRow = Omit<AppStackTaskRunRow, "output" | "outputTruncated">;

interface StackScope {
  readonly organizationId: string;
  readonly stackId: string;
}
interface TaskScope extends StackScope {
  readonly taskKey: string;
}
/** A schedule as the scheduler read it: a write is dropped when the schedule was changed in the meantime. */
interface SlotScope {
  readonly stackId: string;
  readonly taskKey: string;
  readonly changedAt: Date;
  readonly slot: Date;
}

const SUMMARY = {
  id: appStackTaskRuns.id,
  stackId: appStackTaskRuns.stackId,
  organizationId: appStackTaskRuns.organizationId,
  taskKey: appStackTaskRuns.taskKey,
  componentKey: appStackTaskRuns.componentKey,
  trigger: appStackTaskRuns.trigger,
  requestedBy: appStackTaskRuns.requestedBy,
  slotAt: appStackTaskRuns.slotAt,
  operationId: appStackTaskRuns.operationId,
  status: appStackTaskRuns.status,
  problem: appStackTaskRuns.problem,
  exitCode: appStackTaskRuns.exitCode,
  requestedAt: appStackTaskRuns.requestedAt,
  startedAt: appStackTaskRuns.startedAt,
  endedAt: appStackTaskRuns.endedAt,
} as const;

function codedError(message: string, code: ErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

/** The schedule a row stands for; no row is "never". */
export function appStackTaskScheduleOf(
  row: Pick<AppStackTaskScheduleRow, "frequency" | "hourUtc" | "weekday"> | null | undefined,
): AppStackTaskSchedule {
  if (!row) return { frequency: "never" };
  if (row.frequency === "hourly") return { frequency: "hourly" };
  if (row.frequency === "daily") return { frequency: "daily", hourUtc: row.hourUtc ?? 0 };
  return { frequency: "weekly", weekday: row.weekday ?? 1, hourUtc: row.hourUtc ?? 0 };
}

// A schedule row written by SQL keeps microseconds, a Date does not: both sides are compared at the millisecond.
const sameChange = (changedAt: Date): SQL => sql`date_trunc('milliseconds', ${appStackTaskSchedules.changedAt}) = ${changedAt.toISOString()}::timestamptz`;
const slotOwed = (slot: Date): SQL =>
  or(isNull(appStackTaskSchedules.servedSlotAt), lt(appStackTaskSchedules.servedSlotAt, slot)) as SQL;
const ofSlot = (input: SlotScope): SQL =>
  and(
    eq(appStackTaskSchedules.stackId, input.stackId),
    eq(appStackTaskSchedules.taskKey, input.taskKey),
    sameChange(input.changedAt),
    slotOwed(input.slot),
  ) as SQL;

export interface EnqueueAppStackTaskRunInput extends TaskScope {
  /** Minted by the caller (`srun_…`): the operation's payload carries it. */
  readonly runId: string;
  readonly componentKey: string;
  /** The installed revision the task was read from: another one by now means the application has just changed. */
  readonly appliedRevisionId: string;
  readonly request:
    | { readonly trigger: "manual"; readonly requestedByUserId: string | null; readonly idempotencyKey: string; readonly requestHash: string }
    | { readonly trigger: "schedule"; readonly slot: Date; readonly changedAt: Date };
  readonly now?: Date;
}

export type EnqueueAppStackTaskRunResult =
  | { readonly outcome: "queued"; readonly run: AppStackTaskRunRow; readonly operationId: string; readonly idempotentReplay: boolean }
  /** Nothing was written. `busy`: the application is being changed; `not_running`: it is stopped, failed or never installed. */
  | { readonly outcome: "refused"; readonly reason: "busy" | "not_running"; readonly status: AppStackStatus }
  /** A time of a schedule that is no longer owed (already dealt with, or the schedule has changed). */
  | { readonly outcome: "stale" };

/**
 * One transaction: replay, the application's row and lock, the operation, the run row and (for a schedule) the served
 * time. Keeps the last runs of the task and drops the older ones.
 */
export async function enqueueAppStackTaskRunTransactional(
  db: HostingPanelDatabase,
  input: EnqueueAppStackTaskRunInput,
): Promise<EnqueueAppStackTaskRunResult> {
  const request = input.request;
  return db.transaction(async (tx) => {
    if (request.trigger === "manual") {
      const [prior] = await tx
        .select()
        .from(operations)
        .where(and(eq(operations.organizationId, input.organizationId), eq(operations.idempotencyKey, request.idempotencyKey)));
      if (prior) {
        const [run] = await tx.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.operationId, prior.id));
        const same =
          prior.kind === APP_STACK_TASK_KIND && prior.resourceId === input.stackId && prior.requestHash === request.requestHash && run?.taskKey === input.taskKey;
        if (!same || !run) {
          throw codedError(`Idempotency key '${request.idempotencyKey}' was already used for a different request`, "IDEMPOTENCY_CONFLICT");
        }
        return { outcome: "queued", run, operationId: prior.id, idempotentReplay: true };
      }
    }

    const [stack] = await tx
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
      .for("update");
    if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");

    if (request.trigger === "schedule") {
      const [owed] = await tx
        .select({ taskKey: appStackTaskSchedules.taskKey })
        .from(appStackTaskSchedules)
        .where(ofSlot({ stackId: stack.id, taskKey: input.taskKey, changedAt: request.changedAt, slot: request.slot }))
        .for("update");
      if (!owed) return { outcome: "stale" };
    }

    const lockKey = appStackLockKey(stack.id);
    const [active] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.lockKey, lockKey), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])));
    if (active || (APP_STACK_BUSY_STATUSES as readonly AppStackStatus[]).includes(stack.status)) {
      return { outcome: "refused", reason: "busy", status: stack.status };
    }
    if (!(APP_STACK_TASK_RUNNABLE_STATUSES as readonly AppStackStatus[]).includes(stack.status) || stack.appliedRevisionId === null) {
      return { outcome: "refused", reason: "not_running", status: stack.status };
    }
    if (stack.appliedRevisionId !== input.appliedRevisionId) return { outcome: "refused", reason: "busy", status: stack.status };

    const now = input.now ?? new Date();
    const { operation } = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
      organizationId: stack.organizationId,
      kind: APP_STACK_TASK_KIND,
      resourceType: APP_STACK_RESOURCE_TYPE,
      resourceId: stack.id,
      ...(request.trigger === "manual"
        ? { requestedByUserId: request.requestedByUserId ?? undefined, idempotencyKey: request.idempotencyKey, requestHash: request.requestHash }
        : {}),
      lockKey,
      outboxPayload: { stackId: stack.id, runId: input.runId },
      steps: APP_STACK_TASK_STEPS,
    });
    const [run] = await tx
      .insert(appStackTaskRuns)
      .values({
        id: input.runId,
        stackId: stack.id,
        organizationId: stack.organizationId,
        taskKey: input.taskKey,
        componentKey: input.componentKey,
        trigger: request.trigger,
        requestedBy: request.trigger === "manual" ? request.requestedByUserId : null,
        slotAt: request.trigger === "schedule" ? request.slot : null,
        operationId: operation.id,
        status: "queued",
        requestedAt: now,
      })
      .returning();
    if (request.trigger === "schedule") {
      await tx
        .update(appStackTaskSchedules)
        .set({ servedSlotAt: request.slot, skippedSlotAt: null, skipReason: null })
        .where(and(eq(appStackTaskSchedules.stackId, stack.id), eq(appStackTaskSchedules.taskKey, input.taskKey)));
    }
    // The last runs of the task stay; a run that has not ended is the newest one (the lock allows one at a time).
    await tx.execute(sql`
      DELETE FROM app_stack_task_runs
      WHERE stack_id = ${stack.id} AND task_key = ${input.taskKey} AND ended_at IS NOT NULL AND id IN (
        SELECT id FROM app_stack_task_runs
        WHERE stack_id = ${stack.id} AND task_key = ${input.taskKey}
        ORDER BY requested_at DESC, id DESC
        OFFSET ${APP_STACK_TASK_LIMITS.runsKept}
      )`);
    return { outcome: "queued", run: run!, operationId: operation.id, idempotentReplay: false };
  });
}

/** A run by its id, whatever the application (the worker has only the id from the operation's payload). */
export async function getAppStackTaskRun(db: DatabaseExecutor, input: { readonly runId: string }): Promise<AppStackTaskRunRow | null> {
  const [run] = await db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.id, input.runId));
  return run ?? null;
}

/** queued → running. False when the run is not queued any more. */
export async function startAppStackTaskRun(db: DatabaseExecutor, input: { readonly runId: string; readonly startedAt: Date }): Promise<boolean> {
  const updated = await db
    .update(appStackTaskRuns)
    .set({ status: "running", startedAt: input.startedAt })
    .where(and(eq(appStackTaskRuns.id, input.runId), eq(appStackTaskRuns.status, "queued")))
    .returning({ id: appStackTaskRuns.id });
  return updated.length === 1;
}

export interface FinishAppStackTaskRunInput {
  readonly runId: string;
  readonly status: AppStackTaskRunFinalStatus;
  readonly problem: AppStackTaskRunProblem | null;
  readonly exitCode: number | null;
  /** When the command started, if it did; null keeps what is written. */
  readonly startedAt: Date | null;
  readonly endedAt: Date;
  readonly output: string;
  readonly outputTruncated: boolean;
}

/** Writes how a run ended, once: false when it had already ended. What it printed is bounded again here. */
export async function finishAppStackTaskRun(db: DatabaseExecutor, input: FinishAppStackTaskRunInput): Promise<boolean> {
  const bound = boundAppStackTaskOutput(input.output === "" ? [] : input.output.split("\n"));
  const updated = await db
    .update(appStackTaskRuns)
    .set({
      status: input.status,
      problem: input.problem,
      exitCode: input.exitCode,
      // A run that did not start has no start, whatever was written when it was sent.
      ...(input.status === "not_started" ? { startedAt: null } : input.startedAt !== null ? { startedAt: input.startedAt } : {}),
      endedAt: input.endedAt,
      output: bound.output,
      outputTruncated: input.outputTruncated || bound.truncated,
    })
    .where(and(eq(appStackTaskRuns.id, input.runId), inArray(appStackTaskRuns.status, ["queued", "running"])))
    .returning({ id: appStackTaskRuns.id });
  return updated.length === 1;
}

/**
 * Runs left queued or running although their operation has ended (the panel stopped between the two writes): a queued
 * one never started, a running one has an outcome nobody knows. Neither is started again.
 */
export async function repairOrphanedAppStackTaskRunsTransactional(db: DatabaseExecutor, now = new Date()): Promise<number> {
  const active = sql.join(
    ACTIVE_OPERATION_LOCK_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const repaired = await db
    .update(appStackTaskRuns)
    .set({
      status: sql`CASE WHEN ${appStackTaskRuns.status} = 'queued' THEN 'not_started' ELSE 'unknown' END`,
      problem: sql`CASE WHEN ${appStackTaskRuns.status} = 'queued' THEN 'unavailable' ELSE 'outcome_lost' END`,
      endedAt: now,
    })
    .where(
      and(
        inArray(appStackTaskRuns.status, ["queued", "running"]),
        sql`NOT EXISTS (SELECT 1 FROM operations o WHERE o.id = ${appStackTaskRuns.operationId} AND o.status IN (${active}))`,
      ),
    )
    .returning({ id: appStackTaskRuns.id });
  return repaired.length;
}

/** The last runs of a task, newest first, with what they printed. */
export function listAppStackTaskRuns(db: DatabaseExecutor, input: TaskScope): Promise<AppStackTaskRunRow[]> {
  return db
    .select()
    .from(appStackTaskRuns)
    .where(
      and(
        eq(appStackTaskRuns.stackId, input.stackId),
        eq(appStackTaskRuns.organizationId, input.organizationId),
        eq(appStackTaskRuns.taskKey, input.taskKey),
      ),
    )
    .orderBy(desc(appStackTaskRuns.requestedAt), desc(appStackTaskRuns.id))
    .limit(APP_STACK_TASK_LIMITS.runsKept);
}

/** The latest run of every task of an application, without what it printed. */
export function listLatestAppStackTaskRuns(db: DatabaseExecutor, input: StackScope): Promise<AppStackTaskRunSummaryRow[]> {
  return db
    .selectDistinctOn([appStackTaskRuns.taskKey], SUMMARY)
    .from(appStackTaskRuns)
    .where(and(eq(appStackTaskRuns.stackId, input.stackId), eq(appStackTaskRuns.organizationId, input.organizationId)))
    .orderBy(asc(appStackTaskRuns.taskKey), desc(appStackTaskRuns.requestedAt), desc(appStackTaskRuns.id));
}

export interface SetAppStackTaskScheduleInput extends TaskScope {
  readonly schedule: AppStackTaskSchedule;
  readonly changedBy: string | null;
  readonly now?: Date;
}

/**
 * Sets when a task runs by itself; "never" removes the row. A changed schedule starts clean: no time before the change
 * is owed, and the note of a skipped time goes.
 */
export async function setAppStackTaskScheduleTransactional(
  db: HostingPanelDatabase,
  input: SetAppStackTaskScheduleInput,
): Promise<AppStackTaskScheduleRow | null> {
  return db.transaction(async (tx) => {
    const [stack] = await tx
      .select({ id: appStacks.id, organizationId: appStacks.organizationId })
      .from(appStacks)
      .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
      .for("update");
    if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
    const schedule = input.schedule;
    if (schedule.frequency === "never") {
      await tx
        .delete(appStackTaskSchedules)
        .where(and(eq(appStackTaskSchedules.stackId, stack.id), eq(appStackTaskSchedules.taskKey, input.taskKey)));
      return null;
    }
    const values = {
      frequency: schedule.frequency,
      hourUtc: schedule.frequency === "hourly" ? null : schedule.hourUtc,
      weekday: schedule.frequency === "weekly" ? schedule.weekday : null,
      changedAt: input.now ?? new Date(),
      changedBy: input.changedBy,
      servedSlotAt: null,
      skippedSlotAt: null,
      skipReason: null,
    };
    const [row] = await tx
      .insert(appStackTaskSchedules)
      .values({ stackId: stack.id, organizationId: stack.organizationId, taskKey: input.taskKey, ...values })
      .onConflictDoUpdate({ target: [appStackTaskSchedules.stackId, appStackTaskSchedules.taskKey], set: values })
      .returning();
    return row!;
  });
}

export function listAppStackTaskSchedules(db: DatabaseExecutor, input: StackScope): Promise<AppStackTaskScheduleRow[]> {
  return db
    .select()
    .from(appStackTaskSchedules)
    .where(and(eq(appStackTaskSchedules.stackId, input.stackId), eq(appStackTaskSchedules.organizationId, input.organizationId)))
    .orderBy(asc(appStackTaskSchedules.taskKey));
}

export interface AppStackTaskScheduleOfLiveStack {
  readonly schedule: AppStackTaskScheduleRow;
  readonly stackStatus: AppStackStatus;
  readonly appliedRevisionId: string | null;
}

/** Every schedule of an application that is not deleted, with what the scheduler needs to know of the application. */
export function listAppStackTaskSchedulesOfLiveStacks(db: DatabaseExecutor): Promise<AppStackTaskScheduleOfLiveStack[]> {
  return db
    .select({ schedule: appStackTaskSchedules, stackStatus: appStacks.status, appliedRevisionId: appStacks.appliedRevisionId })
    .from(appStackTaskSchedules)
    .innerJoin(appStacks, eq(appStacks.id, appStackTaskSchedules.stackId))
    .where(isNull(appStacks.deletedAt))
    .orderBy(asc(appStackTaskSchedules.stackId), asc(appStackTaskSchedules.taskKey));
}

/** A time that could not be queued now: the reason is kept and the time stays owed (it is tried again). */
export async function noteAppStackTaskSlotRefused(
  db: DatabaseExecutor,
  input: SlotScope & { readonly reason: AppStackTaskSkipReason },
): Promise<boolean> {
  const updated = await db
    .update(appStackTaskSchedules)
    .set({ skippedSlotAt: input.slot, skipReason: input.reason })
    .where(ofSlot(input))
    .returning({ taskKey: appStackTaskSchedules.taskKey });
  return updated.length === 1;
}

/**
 * Closes a time without a run: it is not owed any more. `skipped` writes it as skipped, with the reason already noted
 * for that time or `missed` when there is none; without it the time passes with no note (the installed version does not
 * have the task).
 */
export async function closeAppStackTaskSlot(db: DatabaseExecutor, input: SlotScope & { readonly skipped: boolean }): Promise<boolean> {
  const slot = sql`${input.slot.toISOString()}::timestamptz`;
  const updated = await db
    .update(appStackTaskSchedules)
    .set({
      servedSlotAt: input.slot,
      ...(input.skipped
        ? {
            // The right side of a SET reads the row as it was: the reason noted for this very time is kept.
            skipReason: sql`CASE WHEN ${appStackTaskSchedules.skippedSlotAt} = ${slot} THEN ${appStackTaskSchedules.skipReason} ELSE 'missed' END`,
            skippedSlotAt: input.slot,
          }
        : {}),
    })
    .where(ofSlot(input))
    .returning({ taskKey: appStackTaskSchedules.taskKey });
  return updated.length === 1;
}
