import {
  AppStackTaskReadIpcRequestSchema,
  AppStackTaskRunIpcRequestSchema,
  boundAppStackTaskOutput,
  type AppStackTaskReadIpcRequest,
  type AppStackTaskReadIpcResult,
  type AppStackTaskRunIpcRequest,
  type AppStackTaskRunIpcResult,
} from "@hosting-panel/contracts";
import type { APP_STACK_TASK_EXECUTOR_METHODS, StackTaskExecutorPort } from "@hosting-panel/executor-contracts";
import { AppStackExecutorError, maskAppStackLogLines } from "./app-stacks/index.js";
import { ExecutorIpcClientError } from "./client.js";
import { ExecutorCodedError } from "./traefik-config.js";

/** How the next simulated run goes. Nothing set: it ends with code 0 and prints nothing. */
export interface AppStackTaskSimBehaviour {
  /** null = the engine did not tell how the command ended. */
  readonly exitCode?: number | null;
  /** What the command printed, before the masking and the bounds. */
  readonly lines?: readonly string[];
  /** The command was ended at its time limit. */
  readonly timedOut?: boolean;
  /** The component has no shell: the run does not start. */
  readonly noShell?: boolean;
}

/**
 * `ambiguous_before`: the answer is lost and nothing ran. `ambiguous_after`: the run finished, its answer is lost.
 * `ambiguous_running`: the answer is lost while the run still goes; it ends at `settleAppStackTaskRun`.
 */
export type AppStackTaskSimFault = "engine_unavailable" | "ambiguous_before" | "ambiguous_after" | "ambiguous_running";

export interface SimulatedAppStackTasksOptions {
  /**
   * null = no such component. Throws for an application of another organisation. `secretValues` null = the values the
   * output must never show cannot be established: what a run prints is then not kept (ADR-0042 A8).
   */
  readonly findComponent: (req: {
    readonly stackId: string;
    readonly organizationId: string;
    readonly componentKey: string;
  }) => Promise<{ readonly running: boolean; readonly secretValues: readonly string[] | null } | null>;
  readonly assertEngineAvailable: () => void;
  readonly now?: () => Date;
}

interface SimRun {
  readonly stackId: string;
  readonly organizationId: string;
  state: "running" | AppStackTaskRunIpcResult;
  finish?: () => AppStackTaskRunIpcResult;
}

function lostAnswer(): ExecutorIpcClientError {
  return new ExecutorIpcClientError(
    "IPC response stream dropped after mutating command was dispatched to docker-executor",
    "OPERATION_AMBIGUOUS",
    502,
    true,
  );
}

/** In-memory tasks of applications: the production request check, masking and bounds; no command is run. */
export class SimulatedAppStackTasks implements StackTaskExecutorPort {
  /** Every call, in order. `argv` is here for tests only: the real executor keeps it nowhere. */
  public readonly appStackTaskCalls: Array<{
    readonly method: (typeof APP_STACK_TASK_EXECUTOR_METHODS)[number];
    readonly stackId: string;
    readonly runId: string;
    readonly componentKey?: string;
    readonly argv?: readonly string[];
    readonly timeoutSeconds?: number;
  }> = [];
  private readonly runs = new Map<string, SimRun>();
  private readonly busy = new Set<string>();
  private readonly behaviours: AppStackTaskSimBehaviour[] = [];
  private readonly faults = new Map<"run" | "read", AppStackTaskSimFault[]>();
  private readonly now: () => Date;

  public constructor(private readonly options: SimulatedAppStackTasksOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Queued: the first run that reaches its command takes the first behaviour. */
  public setNextAppStackTaskRun(behaviour: AppStackTaskSimBehaviour): void {
    this.behaviours.push(behaviour);
  }

  public failNextAppStackTaskStep(step: "run" | "read", fault: AppStackTaskSimFault): void {
    this.faults.set(step, [...(this.faults.get(step) ?? []), fault]);
  }

  /** As after a restart of the executor: it knows no run any more. */
  public forgetAppStackTaskRuns(): void {
    this.runs.clear();
    this.busy.clear();
  }

  /** Ends a run that `ambiguous_running` left going. */
  public settleAppStackTaskRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run?.state !== "running" || run.finish === undefined) throw new Error(`No simulated run ${runId} is going`);
    run.state = run.finish();
    this.busy.delete(run.stackId);
  }

  public async runAppStackTask(input: AppStackTaskRunIpcRequest): Promise<AppStackTaskRunIpcResult> {
    const parsed = AppStackTaskRunIpcRequestSchema.safeParse(input);
    if (!parsed.success) throw new ExecutorCodedError("The request of a task run is not valid", "VALIDATION_ERROR");
    const req = parsed.data;
    this.appStackTaskCalls.push({
      method: "runAppStackTask",
      stackId: req.stackId,
      runId: req.runId,
      componentKey: req.componentKey,
      argv: [...req.argv],
      timeoutSeconds: req.timeoutSeconds,
    });
    const fault = this.enter("run");
    const seen = this.runs.get(req.runId);
    if (seen !== undefined) {
      if (seen.stackId !== req.stackId || seen.organizationId !== req.organizationId) {
        throw new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "This run belongs to another application");
      }
      if (seen.state === "running") throw new AppStackExecutorError("STACK_BUSY", "This run is still going");
      return seen.state;
    }
    if (this.busy.has(req.stackId)) throw new AppStackExecutorError("STACK_BUSY", "A task of this application is already running");
    const component = await this.options.findComponent(req);
    if (component === null || !component.running) {
      throw new AppStackExecutorError("STACK_COMPONENT_NOT_READY", "The component of this task is not running");
    }
    const behaviour = this.behaviours.shift() ?? {};
    const startedAt = this.now().toISOString();
    const finish = (): AppStackTaskRunIpcResult => {
      const endedAt = this.now().toISOString();
      if (behaviour.noShell === true) {
        return { runId: req.runId, outcome: "not_started", problem: "no_shell", exitCode: null, startedAt: null, endedAt, output: "", outputTruncated: false };
      }
      const lines = behaviour.lines ?? [];
      const exitCode = behaviour.timedOut === true ? null : behaviour.exitCode === undefined ? 0 : behaviour.exitCode;
      const answer = (output: string, outputTruncated: boolean): AppStackTaskRunIpcResult => ({
        runId: req.runId,
        outcome: behaviour.timedOut === true ? "timed_out" : exitCode === 0 ? "succeeded" : "failed",
        problem: null,
        exitCode,
        startedAt,
        endedAt,
        output,
        outputTruncated,
      });
      // Masked with every private value, or not kept at all: as the executor does, a run that printed something and
      // whose values cannot be established keeps nothing ("" and cut); one that printed nothing keeps "" and no cut.
      if (component.secretValues === null) return answer("", lines.some((text) => text !== ""));
      const masked = maskAppStackLogLines(
        lines.map((text) => ({ at: null, stream: "stdout" as const, text })),
        component.secretValues,
      ).map((line) => line.text);
      const { output, truncated } = boundAppStackTaskOutput(masked);
      return answer(output, truncated);
    };
    const run: SimRun = { stackId: req.stackId, organizationId: req.organizationId, state: "running" };
    this.runs.set(req.runId, run);
    if (fault === "ambiguous_running") {
      this.busy.add(req.stackId);
      run.finish = finish;
      throw lostAnswer();
    }
    run.state = finish();
    if (fault === "ambiguous_after") throw lostAnswer();
    return run.state;
  }

  public getAppStackTaskRun(input: AppStackTaskReadIpcRequest): Promise<AppStackTaskReadIpcResult> {
    const parsed = AppStackTaskReadIpcRequestSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(new ExecutorCodedError("The request of a task read is not valid", "VALIDATION_ERROR"));
    }
    const req = parsed.data;
    this.appStackTaskCalls.push({ method: "getAppStackTaskRun", stackId: req.stackId, runId: req.runId });
    try {
      this.enter("read");
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error("Simulated read failed"));
    }
    const seen = this.runs.get(req.runId);
    if (seen === undefined || seen.stackId !== req.stackId || seen.organizationId !== req.organizationId) {
      return Promise.resolve({ state: "unknown" });
    }
    return Promise.resolve(seen.state === "running" ? { state: "running" } : { state: "finished", result: seen.state });
  }

  /** Throws for the faults that stop a call before anything runs; returns the one that acts later. */
  private enter(step: "run" | "read"): AppStackTaskSimFault | undefined {
    this.options.assertEngineAvailable();
    const fault = this.faults.get(step)?.shift();
    if (fault === undefined) return undefined;
    // A read is never a mutating call: when its answer does not come, the caller is told the executor is unavailable.
    if (fault === "engine_unavailable" || step === "read") {
      throw new ExecutorCodedError("Simulated Docker Engine is currently unreachable", "DOCKER_ENGINE_UNAVAILABLE");
    }
    if (fault === "ambiguous_before") throw lostAnswer();
    return fault;
  }
}
