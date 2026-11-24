// Tasks of an application (ADR-0042): a queued run and how it ended, the schedule of a task, the two executor calls.
// A request names a task by its key. The command lives in the template version (`spec.tasks`) and in the executor
// request, and nowhere else: not in an operation, an outbox row, an audit row or a DTO.

import { z } from "zod";
import type { OperationKind } from "../operations.js";
import { APP_TEMPLATE_LIMITS, AppStackKeySchema } from "./limits.js";
import { AppEntityIdSchema } from "./stack-ids.js";
import { AppStackRefIpcRequestSchema } from "./stack-ipc.js";
import type { AppStackStatus } from "./stack-status.js";
import { appStackTaskArgvProblem } from "./text.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const OperationIdSchema = z.string().min(1).max(128);

/** The operation of one run. It is not a stack lifecycle kind: no deployment, no revision, the stack status stays. */
export const APP_STACK_TASK_KIND = "stack.task" as const satisfies OperationKind;
export const APP_STACK_TASK_STEPS: readonly { readonly key: string; readonly label: string }[] = Object.freeze([
  Object.freeze({ key: "run", label: "Run the task" }),
]);

/**
 * The lock a run holds while it waits for the lane of tasks: one run waiting or running per application. It is not the
 * application's lock (`stack:<id>`), which the run takes only when it begins: a run that waits behind the runs of other
 * applications holds nothing a stop, an update or a delete of its application needs.
 */
export function appStackTaskQueueKey(stackId: string): string {
  return `stack:${stackId}:task`;
}

/** A run can be asked only while the application is in one of these (and no other work of it is queued or running). */
export const APP_STACK_TASK_RUNNABLE_STATUSES = ["running", "degraded"] as const satisfies readonly AppStackStatus[];

export const APP_STACK_TASK_LIMITS = Object.freeze({
  /** UTF-8 bytes of what a run printed, as kept in the row of the run. */
  outputBytes: 16_384,
  outputLines: 200,
  /** Characters of one printed line (= the cut of a log line). */
  outputLineChars: 2_000,
  /** Runs kept for each task of an application. */
  runsKept: 20,
  /** How long after its time a scheduled run is still tried while the application is busy or not running. */
  retryWindowMs: 30 * 60_000,
  /** How far ahead of the clock of a pass a stored time of a schedule may lie before it is taken for a clock that ran ahead (one pass). */
  clockAheadToleranceMs: 60_000,
});

/** Minted by the API as `srun_<24 hex>`; strict, because the executor passes it to the clean-up script. */
export const APP_STACK_TASK_RUN_ID_PATTERN = /^srun_[0-9a-f]{24}$/;
export const AppStackTaskRunIdSchema = z.string().regex(APP_STACK_TASK_RUN_ID_PATTERN);

export const APP_STACK_TASK_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "not_started", "unknown"] as const;
export type AppStackTaskRunStatus = (typeof APP_STACK_TASK_RUN_STATUSES)[number];
export const AppStackTaskRunStatusSchema = z.enum(APP_STACK_TASK_RUN_STATUSES);
/** How a run can end. `unknown`: the answer was lost; such a run is never started again by itself. */
export const APP_STACK_TASK_RUN_FINAL_STATUSES = ["succeeded", "failed", "timed_out", "not_started", "unknown"] as const satisfies
  readonly AppStackTaskRunStatus[];
export type AppStackTaskRunFinalStatus = (typeof APP_STACK_TASK_RUN_FINAL_STATUSES)[number];

/** Why a run did not start (`not_started`) or why its outcome is not known (`unknown`); null for every other status. */
export const APP_STACK_TASK_RUN_PROBLEMS = [
  "component_not_running", // the component is missing or not running
  "cannot_run_tasks", // the component has no /bin/sh: what the command starts could not be stopped
  "task_gone", // the installed version no longer has the task, or its template no longer validates
  "unavailable", // this server cannot run tasks, or the executor was not reached
  "refused", // the executor refused the request
  "outcome_lost", // nobody knows how it ended: the answer was lost and the executor does not know the run, or it could not confirm the stop
  "busy", // when it was to begin, another action of the application was queued or running
] as const;
export type AppStackTaskRunProblem = (typeof APP_STACK_TASK_RUN_PROBLEMS)[number];
export const AppStackTaskRunProblemSchema = z.enum(APP_STACK_TASK_RUN_PROBLEMS);

export const APP_STACK_TASK_TRIGGERS = ["manual", "schedule"] as const;
export type AppStackTaskTrigger = (typeof APP_STACK_TASK_TRIGGERS)[number];

// ---- what a run printed ----

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length; // works in a browser too
/** Every control character but the tab, and an unpaired surrogate. A line break is one: it never reaches a line. */
const OUTPUT_LINE_UNSAFE = /[^\P{Cc}\t]|\p{Cs}/gu;
const OUTPUT_UNSAFE = /[^\P{Cc}\t\n]|\p{Cs}/u;

/** Lines joined by "\n": at most 200, at most 16 KiB of UTF-8, no control character but the tab. */
export const AppStackTaskOutputSchema = z
  .string()
  .max(APP_STACK_TASK_LIMITS.outputBytes)
  .refine((text) => !OUTPUT_UNSAFE.test(text), { message: "The output carries a control character." })
  .refine((text) => text.split("\n").length <= APP_STACK_TASK_LIMITS.outputLines, { message: "The output has too many lines." })
  .refine((text) => utf8Bytes(text) <= APP_STACK_TASK_LIMITS.outputBytes, { message: "The output is too long." });

/**
 * The last lines that fit the bounds, each cleaned of control characters and cut. Call it on lines already masked:
 * a cut made before the masking could leave a piece of a value. `truncated` tells that something was left out.
 */
export function boundAppStackTaskOutput(lines: readonly string[]): { output: string; truncated: boolean } {
  const kept: string[] = [];
  let truncated = false;
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let line = (lines[index] ?? "").replace(OUTPUT_LINE_UNSAFE, "");
    if (line.length > APP_STACK_TASK_LIMITS.outputLineChars) {
      line = line.slice(0, APP_STACK_TASK_LIMITS.outputLineChars).replace(/[\ud800-\udbff]$/, "");
      truncated = true;
    }
    const size = utf8Bytes(line) + (kept.length > 0 ? 1 : 0);
    if (kept.length >= APP_STACK_TASK_LIMITS.outputLines || bytes + size > APP_STACK_TASK_LIMITS.outputBytes) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return { output: kept.reverse().join("\n"), truncated };
}

/**
 * A run printed something and none of it was kept: an empty output that is flagged as cut. It is one answer for every
 * cause: the cut left no whole line (one very long line), or the executor could not establish the private values to
 * hide in the output and dropped it. An empty output that is not flagged is a run that printed nothing.
 */
export function appStackTaskPrintedButNotKept(run: { readonly output: string; readonly outputTruncated: boolean }): boolean {
  return run.output === "" && run.outputTruncated;
}

// ---- schedule ----

export const APP_STACK_TASK_FREQUENCIES = ["never", "hourly", "daily", "weekly"] as const;
export type AppStackTaskFrequency = (typeof APP_STACK_TASK_FREQUENCIES)[number];
const HourUtcSchema = z.number().int().min(0).max(23);
/** ISO day of the week in UTC: 1 Monday … 7 Sunday. */
const WeekdaySchema = z.number().int().min(1).max(7);

/** Whole hours in UTC. No cron expression and no minutes (ADR-0042 A7). */
export const AppStackTaskScheduleSchema = z.discriminatedUnion("frequency", [
  z.object({ frequency: z.literal("never") }).strict(),
  z.object({ frequency: z.literal("hourly") }).strict(),
  z.object({ frequency: z.literal("daily"), hourUtc: HourUtcSchema }).strict(),
  z.object({ frequency: z.literal("weekly"), weekday: WeekdaySchema, hourUtc: HourUtcSchema }).strict(),
]);
export type AppStackTaskSchedule = z.infer<typeof AppStackTaskScheduleSchema>;
export const APP_STACK_TASK_NO_SCHEDULE: AppStackTaskSchedule = Object.freeze({ frequency: "never" });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PERIOD_MS: Readonly<Record<Exclude<AppStackTaskFrequency, "never">, number>> = Object.freeze({
  hourly: HOUR_MS,
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
});

/** The latest time, at or before `now`, at which the schedule asks for a run; null for "never". */
export function appStackTaskSlotAtOrBefore(schedule: AppStackTaskSchedule, now: Date): Date | null {
  if (schedule.frequency === "never") return null;
  const at = now.getTime();
  if (schedule.frequency === "hourly") return new Date(Math.floor(at / HOUR_MS) * HOUR_MS);
  const day = Math.floor(at / DAY_MS) * DAY_MS;
  let slot = day + schedule.hourUtc * HOUR_MS;
  if (schedule.frequency === "weekly") {
    const weekday = ((new Date(day).getUTCDay() + 6) % 7) + 1;
    slot -= ((weekday - schedule.weekday + 7) % 7) * DAY_MS;
  }
  if (slot > at) slot -= PERIOD_MS[schedule.frequency];
  return new Date(slot);
}

/** The first time after `after` at which the schedule asks for a run; null for "never". */
export function appStackTaskSlotAfter(schedule: AppStackTaskSchedule, after: Date): Date | null {
  const previous = appStackTaskSlotAtOrBefore(schedule, after);
  if (previous === null || schedule.frequency === "never") return null;
  return new Date(previous.getTime() + PERIOD_MS[schedule.frequency]);
}

export interface AppStackTaskDueInput {
  readonly schedule: AppStackTaskSchedule;
  readonly now: Date;
  /** When the schedule was last set: a time at or before it is never owed (set "hourly" at 10:20, the first run is 11:00). */
  readonly changedAt: Date;
  /** The latest time already dealt with: a run was queued for it, or it was given up. */
  readonly servedSlotAt: Date | null;
}
export interface AppStackTaskDueSlot {
  readonly slot: Date;
  /** False once the retry window is over: the time is then written as skipped, never queued. */
  readonly queueable: boolean;
}

/** The time the schedule owes at `now`, or null. Only the latest one counts: an older time is never caught up. */
export function appStackTaskDueSlot(input: AppStackTaskDueInput): AppStackTaskDueSlot | null {
  const slot = appStackTaskSlotAtOrBefore(input.schedule, input.now);
  if (slot === null) return null;
  if (slot.getTime() <= Math.max(input.changedAt.getTime(), input.servedSlotAt?.getTime() ?? 0)) return null;
  return { slot, queueable: input.now.getTime() - slot.getTime() < APP_STACK_TASK_LIMITS.retryWindowMs };
}

/** Why a scheduled time was not run. `missed`: nothing tried it inside the retry window (the panel was off). */
export const APP_STACK_TASK_SKIP_REASONS = ["busy", "not_running", "missed"] as const;
export type AppStackTaskSkipReason = (typeof APP_STACK_TASK_SKIP_REASONS)[number];
export const AppStackTaskSkipReasonSchema = z.enum(APP_STACK_TASK_SKIP_REASONS);

// ---- operation payload ----

/** Business part of the outbox payload of a `stack.task` operation: the application and the run, never the command. */
export const AppStackTaskOperationPayloadSchema = z.object({ stackId: AppEntityIdSchema, runId: AppStackTaskRunIdSchema });
export type AppStackTaskOperationPayload = z.infer<typeof AppStackTaskOperationPayloadSchema>;

// ---- executor calls ----

/** The executor derives the container from (stackId, componentKey) and re-checks its labels and these arguments. */
export const AppStackTaskRunIpcRequestSchema = AppStackRefIpcRequestSchema.extend({
  componentKey: AppStackKeySchema,
  runId: AppStackTaskRunIdSchema,
  argv: z.array(z.string()).superRefine((argv, ctx) => {
    const problem = appStackTaskArgvProblem(argv);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `The command is not allowed (${problem}).` });
  }),
  timeoutSeconds: z.number().int().min(APP_TEMPLATE_LIMITS.taskTimeoutMin).max(APP_TEMPLATE_LIMITS.taskTimeoutMax),
}).strict();
export type AppStackTaskRunIpcRequest = z.infer<typeof AppStackTaskRunIpcRequestSchema>;

/**
 * `unknown`: the command started and the executor could not confirm that it stopped what the run started (every try of
 * the clean-up failed, or the clean-up cannot work in that component). The command may still be going.
 */
export const APP_STACK_TASK_EXECUTOR_OUTCOMES = ["succeeded", "failed", "timed_out", "not_started", "unknown"] as const satisfies
  readonly AppStackTaskRunFinalStatus[];
export type AppStackTaskExecutorOutcome = (typeof APP_STACK_TASK_EXECUTOR_OUTCOMES)[number];
/** The one reason the executor answers `not_started` instead of refusing: the component has no shell for the clean-up. */
export const APP_STACK_TASK_EXECUTOR_PROBLEMS = ["no_shell"] as const;

export const AppStackTaskRunIpcResultSchema = z
  .object({
    runId: AppStackTaskRunIdSchema,
    outcome: z.enum(APP_STACK_TASK_EXECUTOR_OUTCOMES),
    problem: z.enum(APP_STACK_TASK_EXECUTOR_PROBLEMS).nullable(),
    /** Null when the command did not end by itself, or the engine did not tell how it ended. */
    exitCode: z.number().int().min(0).max(255).nullable(),
    startedAt: IsoDateTimeSchema.nullable(),
    endedAt: IsoDateTimeSchema,
    /** Standard output and standard error in the order they arrived, masked and bounded. */
    output: AppStackTaskOutputSchema,
    outputTruncated: z.boolean(),
  })
  .strict()
  .superRefine((result, ctx) => {
    const wrong = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (result.outcome === "not_started") {
      if (result.problem === null) wrong("A run that did not start names its problem.");
      if (result.exitCode !== null || result.startedAt !== null || result.output !== "" || result.outputTruncated) {
        wrong("A run that did not start has no exit code, no start and no output.");
      }
      return;
    }
    if (result.problem !== null) wrong("Only a run that did not start names a problem.");
    if (result.startedAt === null) wrong("A run that started tells when.");
    if (result.outcome === "succeeded" && result.exitCode !== 0) wrong("A run succeeds only with exit code 0.");
    if (result.outcome === "failed" && result.exitCode === 0) wrong("A failed run has no exit code 0.");
    if (result.outcome === "timed_out" && result.exitCode !== null) wrong("A run ended at its time limit has no exit code.");
    if (result.outcome === "unknown" && result.exitCode !== null) wrong("A run whose outcome is not known has no exit code.");
  });
export type AppStackTaskRunIpcResult = z.infer<typeof AppStackTaskRunIpcResultSchema>;

export const AppStackTaskReadIpcRequestSchema = AppStackRefIpcRequestSchema.extend({ runId: AppStackTaskRunIdSchema }).strict();
export type AppStackTaskReadIpcRequest = z.infer<typeof AppStackTaskReadIpcRequestSchema>;
/** `unknown`: this executor never saw the run, or it started again since; the run is then never sent a second time. */
export const AppStackTaskReadIpcResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }).strict(),
  z.object({ state: z.literal("running") }).strict(),
  z.object({ state: z.literal("finished"), result: AppStackTaskRunIpcResultSchema }).strict(),
]);
export type AppStackTaskReadIpcResult = z.infer<typeof AppStackTaskReadIpcResultSchema>;

// ---- customer DTOs: no command, no arguments, no exit code ----

export const AppStackTaskRunSummaryDtoSchema = z.object({
  id: AppStackTaskRunIdSchema,
  taskKey: AppStackKeySchema,
  trigger: z.enum(APP_STACK_TASK_TRIGGERS),
  status: AppStackTaskRunStatusSchema,
  problem: AppStackTaskRunProblemSchema.nullable(),
  requestedAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
});
export type AppStackTaskRunSummaryDto = z.infer<typeof AppStackTaskRunSummaryDtoSchema>;
export const AppStackTaskRunDtoSchema = AppStackTaskRunSummaryDtoSchema.extend({
  output: AppStackTaskOutputSchema, // "" while queued or running, and when nothing was printed
  outputTruncated: z.boolean(),
});
export type AppStackTaskRunDto = z.infer<typeof AppStackTaskRunDtoSchema>;
export const AppStackTaskRunsDtoSchema = z.object({
  runs: z.array(AppStackTaskRunDtoSchema).max(APP_STACK_TASK_LIMITS.runsKept), // newest first
});
export type AppStackTaskRunsDto = z.infer<typeof AppStackTaskRunsDtoSchema>;

export const AppStackTaskDtoSchema = z.object({
  key: AppStackKeySchema,
  label: z.string().min(1).max(APP_TEMPLATE_LIMITS.taskLabel),
  description: z.string().max(APP_TEMPLATE_LIMITS.taskDescription),
  componentKey: AppStackKeySchema,
  schedule: AppStackTaskScheduleSchema,
  /** The next time the schedule asks for a run; null for "never". */
  nextRunAt: IsoDateTimeSchema.nullable(),
  /**
   * The latest scheduled time that was not run, when it is newer than the last scheduled run. `pending`: it is still
   * tried, inside its retry window; false once it was given up.
   */
  skipped: z.object({ at: IsoDateTimeSchema, reason: AppStackTaskSkipReasonSchema, pending: z.boolean() }).nullable(),
  lastRun: AppStackTaskRunSummaryDtoSchema.nullable(),
});
export type AppStackTaskDto = z.infer<typeof AppStackTaskDtoSchema>;
/** The tasks of the installed version, in the order of the template; empty when it declares none. */
export const AppStackTasksDtoSchema = z.object({ tasks: z.array(AppStackTaskDtoSchema).max(APP_TEMPLATE_LIMITS.tasks) });
export type AppStackTasksDto = z.infer<typeof AppStackTasksDtoSchema>;

/** Body of the schedule route: the schedule itself. */
export const SetAppStackTaskScheduleInputSchema = AppStackTaskScheduleSchema;
/** Body of the run route: nothing. The task is named by the path, the command by the template. */
export const RunAppStackTaskInputSchema = z.object({}).strict();

export const AppStackTaskRunAcceptedDtoSchema = z.object({
  runId: AppStackTaskRunIdSchema,
  operationId: OperationIdSchema,
  status: AppStackTaskRunStatusSchema, // replay: the current one
});
export const AppStackTaskRunAcceptedEnvelopeSchema = z.object({
  data: AppStackTaskRunAcceptedDtoSchema,
  links: z.object({ runs: z.string(), operation: z.string() }),
});
export type AppStackTaskRunAcceptedEnvelope = z.infer<typeof AppStackTaskRunAcceptedEnvelopeSchema>;
