import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  AppStackTaskOperationPayloadSchema,
  type AppStackTaskRunFinalStatus,
  type AppStackTaskRunIpcResult,
  type AppStackTaskRunProblem,
} from "@hosting-panel/contracts";
import {
  appStackTaskRuns,
  beginAppStackTaskRunTransactional,
  eq,
  finishAppStackTaskRun,
  getAppStack,
  getAppStackTaskRun,
  operationSteps,
  renewOperationLease,
  reopenAppStackTaskSlot,
  settleOperation,
  updateOperationStepTransactional,
  type AppStackTaskRunRow,
  type DatabaseClient,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { ZodError } from "zod";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import {
  RECOVERY_UNCONFIRMED_TEXT,
  closeUnconfirmedOperation,
  type RecoveryGiveUp,
  type RecoveryOutcome,
  type RecoveryReadBound,
} from "../runtime/recovery-read-bound.js";
import { isAmbiguousFailure } from "../runtime/site-provisioner.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import {
  APP_STACK_TASK_STEP_DONE_TEXT,
  APP_STACK_TASK_STEP_RUNNING_TEXT,
  appStackTaskFailure,
  appStackTaskPort,
  installedAppStackTasks,
} from "./app-stack-tasks.js";

// Worker side of one run of a task (ADR-0042). The command is read here, when the run begins, from the template
// version of the installed revision: the operation carries only the application and the id of the run. A run waits for
// this lane without holding its application and takes the application's lock when it begins; if the application is
// busy or not running then, it does not start. The row of the run is always closed together with its operation; a run
// whose answer is lost is asked to the executor and never started a second time.

type OperationRow = typeof operations.$inferSelect;
const OPEN_STEP = new Set(["pending", "running", "unknown"]);
const STEP = "run";

/**
 * Beyond the time limit of the run, how long its operation keeps its lease: the executor's own margin
 * (APP_STACK_TASK_RUN_MARGIN_MS) and a minute more, so that recovery never takes an operation whose call still waits.
 */
export const APP_STACK_TASK_LEASE_EXTRA_MS = 180_000;

/** How a run ended, as its row tells it. */
interface RunEnd {
  readonly status: AppStackTaskRunFinalStatus;
  readonly problem: AppStackTaskRunProblem | null;
  readonly exitCode: number | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date;
  readonly output: string;
  readonly outputTruncated: boolean;
}

/** Why the executor did not start a run it refused for sure (nothing ran). */
export function appStackTaskRefusalProblem(err: unknown): AppStackTaskRunProblem {
  const e = err as { code?: unknown; reason?: unknown } | null | undefined;
  if (e?.reason === "STACK_COMPONENT_NOT_READY") return "component_not_running";
  if (e?.reason === "STACK_BUSY") return "unavailable";
  return e?.code === "HOST_POLICY_DENIED" || e?.code === "VALIDATION_ERROR" ? "refused" : "unavailable";
}

@Injectable()
export class AppStackTaskRuntime {
  readonly #db: HostingPanelDatabase;
  readonly #validation: AppTemplateValidationOptions;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Optional() @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) validation?: AppTemplateValidationOptions,
  ) {
    this.#db = dbClient.db;
    this.#validation = validation ?? {};
  }

  /**
   * Worker dispatch of a `stack.task` operation. It settles the operation itself and returns; it throws only when the
   * answer of the executor is lost, so that the worker parks the operation and `recover` asks how the run went.
   */
  public async apply(op: OperationRow, payload: Readonly<Record<string, unknown>>): Promise<void> {
    const db = this.#db;
    const parsed = AppStackTaskOperationPayloadSchema.safeParse(payload);
    const run =
      parsed.success && parsed.data.stackId === op.resourceId ? await getAppStackTaskRun(db, { runId: parsed.data.runId }) : null;
    if (!run || run.operationId !== op.id || run.stackId !== op.resourceId || run.organizationId !== op.organizationId) {
      // The application was deleted since (its runs went with it), or the payload is not of this operation.
      await this.#settle(op, null, this.#notStarted("task_gone"));
      return;
    }
    if (run.status !== "queued") {
      // Not expected: a run that began once is never started again.
      await this.#close(op, run);
      return;
    }
    const port = appStackTaskPort({ executor: this.executor, config: this.config });
    if (port === null) {
      await this.#settle(op, run, this.#notStarted("unavailable"));
      return;
    }
    const stack = await getAppStack(db, { organizationId: run.organizationId, stackId: run.stackId });
    const installed = stack ? await installedAppStackTasks(db, stack, this.#validation) : null;
    const task = installed?.tasks.find((candidate) => candidate.key === run.taskKey);
    if (!task || !installed) {
      await this.#settle(op, run, this.#notStarted("task_gone"));
      return;
    }

    const begun = await beginAppStackTaskRunTransactional(db, {
      runId: run.id,
      operationId: op.id,
      revisionId: installed.revisionId,
      componentKey: task.service,
      startedAt: new Date(),
    });
    if (begun.outcome === "refused") {
      await this.#notBegun(op, run, begun.reason);
      return;
    }
    if (begun.outcome === "gone") {
      await this.#settle(op, run, this.#lost(run));
      return;
    }
    await updateOperationStepTransactional(db, op.id, STEP, "running", APP_STACK_TASK_STEP_RUNNING_TEXT).catch(() => undefined);
    await renewOperationLease(db, op.id, task.timeoutSeconds * 1000 + APP_STACK_TASK_LEASE_EXTRA_MS);
    let result: AppStackTaskRunIpcResult;
    try {
      result = await port.runAppStackTask({
        stackId: run.stackId,
        organizationId: run.organizationId,
        componentKey: task.service,
        runId: run.id,
        argv: [...task.command],
        timeoutSeconds: task.timeoutSeconds,
      });
    } catch (err) {
      if (isAmbiguousFailure(err)) throw err;
      // A refusal for sure: nothing ran.
      await this.#settle(op, run, this.#notStarted(appStackTaskRefusalProblem(err)));
      return;
    }
    await this.#settle(op, run, this.#endOf(result));
  }

  /** Worker recovery of an `unknown` `stack.task` operation: a read, it never starts the command. */
  public async recover(op: OperationRow, reads?: RecoveryReadBound): Promise<RecoveryOutcome> {
    const db = this.#db;
    const [run] = await db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.operationId, op.id));
    if (!run) {
      await this.#settle(op, null, this.#notStarted("task_gone"));
      return "settled";
    }
    if (run.status !== "queued" && run.status !== "running") {
      await this.#close(op, run);
      return "settled";
    }
    if (run.status === "queued") {
      // The panel stopped before anything was sent.
      await this.#settle(op, run, this.#notStarted("unavailable"));
      return "settled";
    }
    const port = appStackTaskPort({ executor: this.executor, config: this.config });
    if (port === null) {
      await this.#settle(op, run, this.#lost(run));
      return "settled";
    }
    let seen: Awaited<ReturnType<typeof port.getAppStackTaskRun>>;
    try {
      seen = await port.getAppStackTaskRun({ stackId: run.stackId, organizationId: run.organizationId, runId: run.id });
    } catch (err) {
      // An answer that fails the schema the panel holds will fail it on the next pass too: nobody can tell how it went.
      if (err instanceof ZodError) {
        await this.#settle(op, run, this.#lost(run));
        return "settled";
      }
      return this.#unconfirmed(op, run, reads?.failed(op.id, err) ?? null);
    }
    if (seen.state === "running") {
      reads?.answered(op.id);
      return "pending";
    }
    // An executor that does not know the run started again since, or never got it: nobody knows how it went.
    await this.#settle(op, run, seen.state === "finished" ? this.#endOf(seen.result) : this.#lost(run));
    return "settled";
  }

  /**
   * Issue #183: the reads of the run have failed, for a reason waiting does not cure, for the whole bound. The run is
   * closed as one whose outcome is lost and is never started again; the operation gets its own code and text and an audit
   * row. Released, the lock lets a new run or a change of the containers be asked: while the old run still goes, the
   * executor refuses both (STACK_BUSY). An operation that is no longer unknown (unlocked by hand meanwhile) is left as
   * it is, its run too.
   */
  async #unconfirmed(op: OperationRow, run: AppStackTaskRunRow, giveUp: RecoveryGiveUp | null): Promise<RecoveryOutcome> {
    if (giveUp === null) return "pending";
    const closed = await closeUnconfirmedOperation(this.#db, op.id, giveUp, async (tx) => {
      await this.#finish(tx, run, this.#lost(run));
      await this.#closeSteps(tx, op.id, "failed", RECOVERY_UNCONFIRMED_TEXT);
    });
    return closed ? "unconfirmed" : "pending";
  }

  /**
   * A run that could not begin did not start. A run of a schedule gives its time back, to be tried again inside its
   * window (ADR-0042 A7); a run asked by a person ends as not started.
   */
  async #notBegun(op: OperationRow, run: AppStackTaskRunRow, reason: "busy" | "not_running"): Promise<void> {
    const end = this.#notStarted(reason === "busy" ? "busy" : "component_not_running");
    const settled = await this.#settleOperation(op, end.status, end.problem, async (tx) => {
      if (run.trigger === "schedule" && (await reopenAppStackTaskSlot(tx, { runId: run.id, reason }))) return;
      await this.#finish(tx, run, end);
    });
    if (!settled) await this.#finish(this.#db, run, end).catch(() => undefined);
  }

  /** A run that is not queued any more: closed already, its operation ends the same way; still going, nobody knows. */
  async #close(op: OperationRow, run: AppStackTaskRunRow): Promise<void> {
    if (run.status === "queued" || run.status === "running") await this.#settle(op, run, this.#lost(run));
    else await this.#settleOperation(op, run.status, run.problem, null);
  }

  /**
   * `unknown` from the executor (it could not confirm that it stopped what the command started) ends as a run whose
   * outcome is lost: the same problem, so the same operation end and text. What it printed is kept.
   */
  #endOf(result: AppStackTaskRunIpcResult): RunEnd {
    return {
      status: result.outcome,
      problem: result.outcome === "not_started" ? "cannot_run_tasks" : result.outcome === "unknown" ? "outcome_lost" : null,
      exitCode: result.exitCode,
      startedAt: result.startedAt === null ? null : new Date(result.startedAt),
      endedAt: new Date(result.endedAt),
      output: result.output,
      outputTruncated: result.outputTruncated,
    };
  }

  #notStarted(problem: AppStackTaskRunProblem): RunEnd {
    return { status: "not_started", problem, exitCode: null, startedAt: null, endedAt: new Date(), output: "", outputTruncated: false };
  }

  #lost(run: AppStackTaskRunRow): RunEnd {
    return { status: "unknown", problem: "outcome_lost", exitCode: null, startedAt: run.startedAt, endedAt: new Date(), output: "", outputTruncated: false };
  }

  /** One transaction: the row of the run, the step and the operation. */
  async #settle(op: OperationRow, run: AppStackTaskRunRow | null, end: RunEnd): Promise<void> {
    const settled = await this.#settleOperation(op, end.status, end.problem, run === null ? null : (tx) => this.#finish(tx, run, end));
    // The operation had ended already (it was cancelled): the run is closed all the same.
    if (!settled && run !== null) await this.#finish(this.#db, run, end).catch(() => undefined);
  }

  async #finish(db: HostingPanelDatabase, run: AppStackTaskRunRow, end: RunEnd): Promise<void> {
    await finishAppStackTaskRun(db, { runId: run.id, ...end });
  }

  #settleOperation(
    op: OperationRow,
    status: AppStackTaskRunFinalStatus,
    problem: AppStackTaskRunProblem | null,
    write: ((tx: HostingPanelDatabase) => Promise<void>) | null,
  ): Promise<boolean> {
    const failure = status === "succeeded" ? null : appStackTaskFailure(status, problem);
    return settleOperation(
      this.#db,
      op.id,
      failure === null ? { status: "succeeded" } : { status: "failed", errorCode: failure.code, errorMessage: failure.text },
      async (tx) => {
        await write?.(tx);
        await this.#closeSteps(
          tx,
          op.id,
          failure === null ? "succeeded" : "failed",
          failure === null ? APP_STACK_TASK_STEP_DONE_TEXT : failure.text,
        );
      },
    );
  }

  async #closeSteps(tx: HostingPanelDatabase, operationId: string, status: "succeeded" | "failed", text: string): Promise<void> {
    const steps = await tx
      .select({ key: operationSteps.key, status: operationSteps.status })
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId));
    for (const step of steps) {
      if (OPEN_STEP.has(step.status)) await updateOperationStepTransactional(tx, operationId, step.key, status, text);
    }
  }
}
