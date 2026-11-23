import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  type AppStackTaskSchedule,
  type AppStackTaskRunsDto,
  type AppStackTasksDto,
  type AppTemplateTask,
} from "@hosting-panel/contracts";
import {
  and,
  enqueueAppStackTaskRunTransactional,
  eq,
  listAppStackTaskRuns,
  listAppStackTaskSchedules,
  listLatestAppStackTaskRuns,
  newAppEntityId,
  operations,
  setAppStackTaskScheduleTransactional,
  type AppStackRow,
  type AppStackTaskRunRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appNotFound, appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { mapAppStackError } from "./app-stack-errors.js";
import { appStackTaskDto, appStackTaskRunDto, installedAppStackTasks } from "./app-stack-tasks.js";
import type { AppStackRequestContext } from "./app-stacks.service.js";

export interface AppStackTaskRunAccepted {
  readonly run: AppStackTaskRunRow;
  readonly operationId: string;
  readonly idempotentReplay: boolean;
}

function notRunning(status: string): ControlPlaneError {
  const message = `This action is not possible while the application is ${status}.`;
  return appRefusal("RESOURCE_LOCKED", message, { field: "status", message, reason: status }, false);
}
const busy = () =>
  new ControlPlaneError("RESOURCE_LOCKED", "Another action is still running on this application. Try again when it ends.", {
    retryable: true,
  });

/**
 * Tasks of a customer's application (ADR-0042). A request names a task by its key and nothing else: the command is the
 * one the template version of the installed revision declares, and it never passes through here.
 */
@Injectable()
export class AppStackTasksService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
  ) {}

  /** The tasks of the installed version, in the order of the template; none when nothing is installed. */
  public async list(stack: AppStackRow, now = new Date()): Promise<AppStackTasksDto> {
    const db = this.dbClient.db;
    const installed = await installedAppStackTasks(db, stack, this.validation);
    if (!installed || installed.tasks.length === 0) return { tasks: [] };
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const schedules = new Map((await listAppStackTaskSchedules(db, scope)).map((row) => [row.taskKey, row]));
    const latest = new Map((await listLatestAppStackTaskRuns(db, scope)).map((row) => [row.taskKey, row]));
    return { tasks: installed.tasks.map((task) => appStackTaskDto(task, schedules.get(task.key), latest.get(task.key), now)) };
  }

  /** The last runs of one task, newest first, with what they printed. */
  public async runs(stack: AppStackRow, taskKey: string): Promise<AppStackTaskRunsDto> {
    await this.#task(stack, taskKey);
    const rows = await listAppStackTaskRuns(this.dbClient.db, { organizationId: stack.organizationId, stackId: stack.id, taskKey });
    return { runs: rows.map(appStackTaskRunDto) };
  }

  /** Queues one run. Refused while the application is being changed, is stopped or was never installed. */
  public async run(ctx: AppStackRequestContext, stack: AppStackRow, taskKey: string): Promise<AppStackTaskRunAccepted> {
    const db = this.dbClient.db;
    const requestHash = canonicalRequestHash({
      route: APP_AUDIT_ACTIONS.taskRun,
      organizationId: ctx.organizationId,
      stackId: stack.id,
      body: { taskKey },
    });
    // A retry of a request that was accepted is answered as before, whatever the application runs by now.
    const replay = await this.#keyUsed(ctx);
    const found = replay ? null : await this.#task(stack, taskKey);
    const result = await guardedApp(mapAppStackError, () =>
      db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        const r = await enqueueAppStackTaskRunTransactional(t, {
          organizationId: ctx.organizationId,
          stackId: stack.id,
          taskKey,
          runId: newAppEntityId("srun"),
          componentKey: found?.task.service ?? "",
          appliedRevisionId: found?.revisionId ?? "",
          request: { trigger: "manual", requestedByUserId: ctx.userId, idempotencyKey: ctx.idempotencyKey, requestHash },
        });
        if (r.outcome === "queued" && !r.idempotentReplay) {
          await ctx.audit(t, {
            action: APP_AUDIT_ACTIONS.taskRun,
            targetType: "app_stack",
            targetId: stack.id,
            details: { taskKey, runId: r.run.id, operationId: r.operationId },
          });
        }
        return r;
      }),
    );
    if (result.outcome === "queued") return result;
    if (result.outcome === "refused" && result.reason === "not_running") throw notRunning(result.status);
    throw busy();
  }

  /** When the task runs by itself; "never" removes the schedule. */
  public async setSchedule(
    ctx: AppStackRequestContext,
    stack: AppStackRow,
    taskKey: string,
    schedule: AppStackTaskSchedule,
  ): Promise<AppStackTasksDto> {
    await this.#task(stack, taskKey);
    await guardedApp(mapAppStackError, () =>
      this.dbClient.db.transaction(async (tx) => {
        const t = tx as unknown as HostingPanelDatabase;
        await setAppStackTaskScheduleTransactional(t, {
          organizationId: ctx.organizationId,
          stackId: stack.id,
          taskKey,
          schedule,
          changedBy: ctx.userId,
        });
        await ctx.audit(t, {
          action: APP_AUDIT_ACTIONS.taskSchedule,
          targetType: "app_stack",
          targetId: stack.id,
          details: {
            taskKey,
            frequency: schedule.frequency,
            ...("hourUtc" in schedule ? { hourUtc: schedule.hourUtc } : {}),
            ...("weekday" in schedule ? { weekday: schedule.weekday } : {}),
          },
        });
      }),
    );
    return this.list(stack);
  }

  /** The task of the installed version: 409 when nothing is installed, 404 when that version has no such task. */
  async #task(stack: AppStackRow, taskKey: string): Promise<{ task: AppTemplateTask; revisionId: string }> {
    const installed = await installedAppStackTasks(this.dbClient.db, stack, this.validation);
    if (!installed) throw notRunning(stack.status);
    const task = installed.tasks.find((candidate) => candidate.key === taskKey);
    if (!task) throw appNotFound();
    return { task, revisionId: installed.revisionId };
  }

  async #keyUsed(ctx: AppStackRequestContext): Promise<boolean> {
    const [prior] = await this.dbClient.db
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.organizationId, ctx.organizationId), eq(operations.idempotencyKey, ctx.idempotencyKey)))
      .limit(1);
    return prior !== undefined;
  }
}
