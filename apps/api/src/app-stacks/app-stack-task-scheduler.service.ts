import { Inject, Injectable } from "@nestjs/common";
import { appStackTaskDueSlot, type AppStackTaskSkipReason } from "@hosting-panel/contracts";
import {
  appStackTaskScheduleOf,
  closeAppStackTaskSlot,
  enqueueAppStackTaskRunTransactional,
  getAppStack,
  listAppStackTaskSchedulesOfLiveStacks,
  newAppEntityId,
  noteAppStackTaskSlotRefused,
  repairOrphanedAppStackTaskRunsTransactional,
  type AppStackTaskScheduleRow,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import { appStackTaskPort, installedAppStackTasks, type InstalledAppStackTasks } from "./app-stack-tasks.js";

/** One pass a minute: a schedule asks for a run at whole hours only. */
export const APP_STACK_TASK_SCHEDULE_INTERVAL_MS = 60_000;

export interface AppStackTaskSchedulePass {
  readonly queued: number;
  /** Times that could not be queued now and stay owed. */
  readonly refused: number;
  /** Times given up: their retry window is over. */
  readonly skipped: number;
}

/**
 * Queues the tasks that are due (ADR-0042 A7). Each time of a schedule is queued at most once (the database writes the
 * served time with the operation), tried again while the application is busy or stopped, and given up after the retry
 * window; an older time is never caught up. A schedule whose task the installed version does not have stays idle.
 * Without the task calls of the executor nothing is queued: the time stays owed and is written as missed after its window.
 */
@Injectable()
export class AppStackTaskSchedulerService {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #running: Promise<unknown> | null = null;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
  ) {}

  public startBackgroundLoop(intervalMs: number | null | undefined): void {
    if (this.#stopped || this.#timer || !intervalMs || intervalMs <= 0) return;
    const run = (): void => {
      if (this.#stopped || this.#running) return;
      this.#running = this.tick()
        .catch((err: unknown) => {
          if (this.#stopped) return;
          const code = (err as { code?: unknown } | null)?.code;
          console.warn(JSON.stringify({ event: "app_task_scheduler_tick_failed", code: typeof code === "string" ? code : "INTERNAL_ERROR" }));
        })
        .finally(() => {
          this.#running = null;
        });
    };
    // No pass at start: the first one comes after one interval, when the panel has settled.
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#running;
  }

  public async tick(now: Date = new Date()): Promise<AppStackTaskSchedulePass> {
    const db = this.dbClient.db;
    if (this.config.runtimeBackend === "disabled") return { queued: 0, refused: 0, skipped: 0 };
    // Runs whose operation ended without them (the panel stopped between the two writes) are closed first.
    await repairOrphanedAppStackTaskRunsTransactional(db, now);

    let queued = 0;
    let refused = 0;
    let skipped = 0;
    const runnable = appStackTaskPort({ executor: this.executor, config: this.config }) !== null;
    const installedOf = new Map<string, InstalledAppStackTasks | null>();
    for (const { schedule: row } of await listAppStackTaskSchedulesOfLiveStacks(db)) {
      const due = appStackTaskDueSlot({
        schedule: appStackTaskScheduleOf(row),
        now,
        changedAt: row.changedAt,
        servedSlotAt: row.servedSlotAt,
      });
      if (due === null) continue;
      const slot = { stackId: row.stackId, taskKey: row.taskKey, changedAt: row.changedAt, slot: due.slot };
      try {
        if (!due.queueable) {
          if (await closeAppStackTaskSlot(db, { ...slot, skipped: true })) skipped += 1;
          continue;
        }
        if (!runnable) continue;
        if (!installedOf.has(row.stackId)) installedOf.set(row.stackId, await this.#installed(row));
        const installed = installedOf.get(row.stackId) ?? null;
        if (installed === null) {
          if (await noteAppStackTaskSlotRefused(db, { ...slot, reason: "not_running" })) refused += 1;
          continue;
        }
        const task = installed.tasks.find((candidate) => candidate.key === row.taskKey);
        if (!task) {
          // The installed version does not have this task: the time passes with no note and no run.
          await closeAppStackTaskSlot(db, { ...slot, skipped: false });
          continue;
        }
        const reason = await this.#queue(row, task.service, installed.revisionId, due.slot, now);
        if (reason === null) queued += 1;
        else if (reason !== "stale" && (await noteAppStackTaskSlotRefused(db, { ...slot, reason }))) refused += 1;
      } catch {
        // One application that fails does not stop the pass; its time stays owed and is tried at the next pass.
      }
    }
    if (queued > 0) this.outboxWorker.triggerAsync();
    return { queued, refused, skipped };
  }

  async #installed(row: AppStackTaskScheduleRow): Promise<InstalledAppStackTasks | null> {
    const stack = await getAppStack(this.dbClient.db, { organizationId: row.organizationId, stackId: row.stackId });
    return stack ? installedAppStackTasks(this.dbClient.db, stack, this.validation) : null;
  }

  /** null = queued; otherwise why not. */
  async #queue(
    row: AppStackTaskScheduleRow,
    componentKey: string,
    appliedRevisionId: string,
    slot: Date,
    now: Date,
  ): Promise<AppStackTaskSkipReason | "stale" | null> {
    try {
      const result = await enqueueAppStackTaskRunTransactional(this.dbClient.db, {
        organizationId: row.organizationId,
        stackId: row.stackId,
        taskKey: row.taskKey,
        runId: newAppEntityId("srun"),
        componentKey,
        appliedRevisionId,
        request: { trigger: "schedule", slot, changedAt: row.changedAt },
        now,
      });
      if (result.outcome === "queued") return null;
      return result.outcome === "refused" ? result.reason : "stale";
    } catch (err) {
      // The lock of the application was taken between the check and the write.
      if ((err as { code?: unknown } | null)?.code === "RESOURCE_LOCKED") return "busy";
      throw err;
    }
  }
}
