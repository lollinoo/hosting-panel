import {
  appStackTaskSlotAfter,
  type AppStackTaskDto,
  type AppStackTaskRunDto,
  type AppStackTaskRunFinalStatus,
  type AppStackTaskRunProblem,
  type AppStackTaskRunSummaryDto,
  type AppTemplateTask,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  appStackTaskScheduleOf,
  getAppStackRevision,
  getAppTemplateVersion,
  type AppStackRow,
  type AppStackTaskRunRow,
  type AppStackTaskRunSummaryRow,
  type AppStackTaskScheduleRow,
  type DatabaseExecutor,
} from "@hosting-panel/database";
import { isStackTaskExecutor, type DockerExecutorPort, type StackTaskExecutorPort } from "@hosting-panel/executor-contracts";
import { validateAppTemplateSource, type AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";

// Tasks of applications (ADR-0042): what the request side, the worker and the scheduler share. The command of a task
// is read here and nowhere else, from the validated source of the template version the application runs.

/** The task calls of the executor when usable; without them a run is refused before anything is sent. */
export function appStackTaskPort(deps: {
  readonly executor: DockerExecutorPort;
  readonly config: Pick<ControlPlaneRuntimeConfig, "runtimeBackend">;
}): StackTaskExecutorPort | null {
  const { executor } = deps;
  return isStackTaskExecutor(executor) && executor.isRuntimeAvailable && deps.config.runtimeBackend !== "disabled" ? executor : null;
}

export interface InstalledAppStackTasks {
  /** The revision the application runs: the tasks are the ones of its template version. */
  readonly revisionId: string;
  readonly tasks: readonly AppTemplateTask[];
}

/**
 * The tasks of the version the application runs now, read from its source as today's checks accept it (the stored
 * compiled form is for display only). null: nothing is installed. A version that no longer passes the checks has no
 * task: nothing of it is run.
 */
export async function installedAppStackTasks(
  db: DatabaseExecutor,
  stack: Pick<AppStackRow, "id" | "organizationId" | "templateId" | "appliedRevisionId">,
  validation: AppTemplateValidationOptions,
): Promise<InstalledAppStackTasks | null> {
  if (stack.appliedRevisionId === null) return null;
  const revision = await getAppStackRevision(db, {
    organizationId: stack.organizationId,
    stackId: stack.id,
    revisionId: stack.appliedRevisionId,
  });
  if (!revision) return null;
  const version = await getAppTemplateVersion(db, { templateId: stack.templateId, versionId: revision.templateVersionId });
  if (!version) return null;
  const result = validateAppTemplateSource(version.source, validation);
  return { revisionId: revision.id, tasks: result.ok ? (result.spec.tasks ?? []) : [] };
}

/** How a run that did not end well is told in its operation: fixed texts, never what the command printed. */
const FAILURE_BY_PROBLEM: Readonly<Record<AppStackTaskRunProblem, { readonly code: ErrorCode; readonly text: string }>> = Object.freeze({
  component_not_running: {
    code: "RESOURCE_LOCKED",
    text: "The task did not start: the part of the application it belongs to is not running.",
  },
  cannot_run_tasks: { code: "NOT_SUPPORTED", text: "The task did not start: this part of the application cannot run tasks." },
  task_gone: { code: "NOT_FOUND", text: "The task did not start: the installed version no longer has it." },
  unavailable: { code: "DOCKER_ENGINE_UNAVAILABLE", text: "The task did not start: the server could not run it now. Try again in a few minutes." },
  refused: { code: "HOST_POLICY_DENIED", text: "The task did not start: the server refused it. Ask the administrator for help." },
  outcome_lost: { code: "OPERATION_AMBIGUOUS", text: "It is not known how the task ended. It was not started again." },
  busy: { code: "RESOURCE_LOCKED", text: "The task did not start: another action on the application was in progress." },
});
export const APP_STACK_TASK_FAILED_TEXT = "The task ended with an error. See what it printed.";
export const APP_STACK_TASK_TIMED_OUT_TEXT = "The task took too long and was stopped.";
export const APP_STACK_TASK_STEP_RUNNING_TEXT = "Running the task";
export const APP_STACK_TASK_STEP_DONE_TEXT = "The task ended well";

/** The code and the text of the operation of a run that did not succeed. */
export function appStackTaskFailure(
  status: Exclude<AppStackTaskRunFinalStatus, "succeeded">,
  problem: AppStackTaskRunProblem | null,
): { readonly code: ErrorCode; readonly text: string } {
  if (problem !== null) return FAILURE_BY_PROBLEM[problem];
  if (status === "timed_out") return { code: "HOST_JOB_FAILED", text: APP_STACK_TASK_TIMED_OUT_TEXT };
  if (status === "unknown") return FAILURE_BY_PROBLEM.outcome_lost;
  if (status === "not_started") return FAILURE_BY_PROBLEM.unavailable;
  return { code: "HOST_JOB_FAILED", text: APP_STACK_TASK_FAILED_TEXT };
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null;

/** No command, no arguments and no exit code: the customer sees how the run went and what it printed. */
export function appStackTaskRunSummaryDto(row: AppStackTaskRunSummaryRow): AppStackTaskRunSummaryDto {
  return {
    id: row.id,
    taskKey: row.taskKey,
    trigger: row.trigger,
    status: row.status,
    problem: row.problem,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
  };
}

export function appStackTaskRunDto(row: AppStackTaskRunRow): AppStackTaskRunDto {
  return { ...appStackTaskRunSummaryDto(row), output: row.output, outputTruncated: row.outputTruncated };
}

export function appStackTaskDto(
  task: AppTemplateTask,
  scheduleRow: AppStackTaskScheduleRow | undefined,
  lastRun: AppStackTaskRunSummaryRow | undefined,
  now: Date,
): AppStackTaskDto {
  const schedule = appStackTaskScheduleOf(scheduleRow);
  return {
    key: task.key,
    label: task.label,
    description: task.description,
    componentKey: task.service,
    schedule,
    nextRunAt: iso(appStackTaskSlotAfter(schedule, now)),
    skipped:
      scheduleRow?.skippedSlotAt && scheduleRow.skipReason
        ? { at: scheduleRow.skippedSlotAt.toISOString(), reason: scheduleRow.skipReason }
        : null,
    lastRun: lastRun ? appStackTaskRunSummaryDto(lastRun) : null,
  };
}
