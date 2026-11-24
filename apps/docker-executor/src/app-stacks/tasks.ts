import type { Duplex } from "node:stream";
import {
  AppStackTaskReadIpcRequestSchema,
  AppStackTaskRunIpcRequestSchema,
  boundAppStackTaskOutput,
  type AppStackExecutorReason,
  type AppStackTaskReadIpcRequest,
  type AppStackTaskReadIpcResult,
  type AppStackTaskRunIpcRequest,
  type AppStackTaskRunIpcResult,
} from "@hosting-panel/contracts";
import type { StackTaskExecutorPort } from "@hosting-panel/executor-contracts";
import { inspectExecExitCode, runDockerExec, startDockerExec, type DockerExecTarget } from "../docker-exec.js";
import { ExecutorCodedError } from "../traefik-config.js";
import { ownComponentKey } from "./engine.js";
import { AppStackExecutorError } from "./errors.js";
import { APP_STACK_COMPONENT_ROLE, APP_STACK_LABELS, appStackContainerName } from "./names.js";
import { maskAppStackLogLines, readAppStackComponentSecretValues } from "./secrets.js";

/** The command of a run, and all it starts, carry `HP_TASK_RUN=<run id>` in their environment (ADR-0042 A3). */
export const APP_STACK_TASK_MARK = "HP_TASK_RUN";
export const APP_STACK_TASK_KILL_TIMEOUT_MS = 10_000;
/** After the time limit and the kill, how long the output may take to end before the stream is dropped. */
export const APP_STACK_TASK_END_SETTLE_MS = 2_000;
/** Raw bytes of output kept while a run goes: the last ones. The answer is bounded again, after the masking. */
export const APP_STACK_TASK_OUTPUT_TAIL_BYTES = 65_536;
/** Finished runs remembered by id, so that a second call with the same id never starts the command again. */
export const APP_STACK_TASK_RUNS_REMEMBERED = 200;
export const APP_STACK_TASK_CLEANUP_RETRIES = 6;
export const APP_STACK_TASK_CLEANUP_RETRY_MS = 5_000;
/**
 * How the engine's own message begins when it could not start the program of a run (it is not in the image, or it is
 * not executable; exit code 127 or 126). The message names the program, so it is never returned as what the run printed.
 */
export const APP_STACK_TASK_ENGINE_ERROR_PREFIX = "OCI runtime exec failed";

/**
 * Kills, in one container, every process whose environment carries the mark of a run ($1 = the run id; empty = any
 * run) and every process of their sessions; never pid 1. Only `/proc` and what a POSIX shell has built in, so it runs
 * in any image that has `/bin/sh`. It is tried before the command of a run: where it cannot run, no task starts.
 */
export const APP_STACK_TASK_KILL_SCRIPT =
  `m="${APP_STACK_TASK_MARK}=\${1:-srun_}"; s=" "; ` +
  'marked() { while IFS= read -r x || [ -n "$x" ]; do case "$x" in *"$m"*) return 0;; esac; done 2>/dev/null <"$1/environ"; return 1; }; ' +
  'sid() { l=""; while IFS= read -r x || [ -n "$x" ]; do l=$x; done 2>/dev/null <"$1/stat"; l=${l##*) }; set -- $l; i=${4:-0}; }; ' +
  'for p in /proc/[0-9]*; do marked "$p" || continue; sid "$p"; [ "$i" -gt 1 ] 2>/dev/null && s="$s$i "; ' +
  '[ "${p#/proc/}" -gt 1 ] && kill -KILL "${p#/proc/}" 2>/dev/null; done; ' +
  'for p in /proc/[0-9]*; do [ "${p#/proc/}" -gt 1 ] || continue; sid "$p"; ' +
  'case "$s" in *" $i "*) kill -KILL "${p#/proc/}" 2>/dev/null;; esac; done; exit 0';

export interface AppStackTaskLimits {
  /** Milliseconds in one second of a time limit (tests shorten it). */
  readonly secondMs?: number;
  readonly killTimeoutMs?: number;
  readonly endSettleMs?: number;
  readonly retryDelayMs?: number;
}

export interface AppStackTaskRunnerDeps {
  readonly target: DockerExecTarget;
  readonly secretsRootDir: string;
  readonly now?: () => Date;
  /** The clean-up after a run did not finish, also when tried again. It is told nothing: no name and no output. */
  readonly onCleanupFailed?: () => void;
  readonly limits?: AppStackTaskLimits;
}

interface TaskContainerInspect {
  readonly Id?: unknown;
  readonly Name?: string;
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>> | null };
  readonly State?: { readonly Running?: boolean; readonly Restarting?: boolean };
}

type KillOutcome = "done" | "gone" | "no_shell" | "failed";

interface RememberedRun {
  readonly stackId: string;
  readonly organizationId: string;
  state: "running" | AppStackTaskRunIpcResult;
}

function refuse(reason: AppStackExecutorReason, message: string): never {
  throw new AppStackExecutorError(reason, message);
}

function notRunning(): never {
  throw new AppStackExecutorError("STACK_COMPONENT_NOT_READY", "The component of this task is not running");
}

const codeOf = (err: unknown): string => (err instanceof ExecutorCodedError ? err.code : "INTERNAL_ERROR");

/** null = no such container. Never by a name the caller gave: by the derived name, or by an id the engine listed. */
async function inspectTaskContainer(target: DockerExecTarget, ref: string): Promise<TaskContainerInspect | null> {
  let res: { readonly statusCode: number; readonly body: Buffer };
  try {
    res = await target.request("GET", `/containers/${encodeURIComponent(ref)}/json`);
  } catch {
    throw new ExecutorCodedError("Docker could not inspect the component of a task", "DOCKER_ENGINE_UNAVAILABLE");
  }
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    throw new ExecutorCodedError("Docker could not inspect the component of a task", "DOCKER_ENGINE_UNAVAILABLE");
  }
  try {
    return JSON.parse(res.body.toString("utf8")) as TaskContainerInspect;
  } catch {
    throw new ExecutorCodedError("Docker answered the inspect of a component with no JSON", "DOCKER_ENGINE_UNAVAILABLE");
  }
}

/**
 * Runs the kill script in one container. `gone`: the container is not there or not running, so nothing is left in it.
 * Only the start of the output is read: the script prints nothing, the engine its message when it cannot start /bin/sh.
 */
async function killMarkedProcesses(
  target: DockerExecTarget,
  containerId: string,
  runId: string,
  timeoutMs: number,
): Promise<KillOutcome> {
  try {
    const done = await runDockerExec(
      target,
      { container: containerId, cmd: ["/bin/sh", "-c", APP_STACK_TASK_KILL_SCRIPT, "sh", runId] },
      { timeoutMs, maxOutputBytes: APP_STACK_TASK_ENGINE_ERROR_PREFIX.length },
    );
    if (done.exitCode === 0) return "done";
    // The engine could not start the shell (126, 127, with its own message): this image has none. The script's own
    // exit never carries that message.
    const engine = [done.stdout, done.stderr].some((out) => out.toString("utf8").startsWith(APP_STACK_TASK_ENGINE_ERROR_PREFIX));
    return (done.exitCode === 126 || done.exitCode === 127) && engine ? "no_shell" : "failed";
  } catch (err) {
    return codeOf(err) === "NOT_FOUND" ? "gone" : "failed";
  }
}

/** Keeps the last bytes a command printed: standard output and standard error in the order they arrived. */
class TaskOutputTail {
  private pending: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private keep = false;
  private chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;

  public constructor(private readonly capBytes: number) {}

  /** Docker frames: 8 bytes (byte 0 = the stream, bytes 4-7 = the length), then the bytes. */
  public push(chunk: Buffer): void {
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (data.length > 0) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, data.length);
        if (this.keep) this.append(data.subarray(0, take));
        this.remaining -= take;
        data = data.subarray(take);
        continue;
      }
      if (data.length < 8) {
        this.pending = Buffer.from(data);
        return;
      }
      this.keep = data[0] === 1 || data[0] === 2;
      this.remaining = data.readUInt32BE(4);
      data = data.subarray(8);
    }
  }

  private append(bytes: Buffer): void {
    this.chunks.push(Buffer.from(bytes));
    this.size += bytes.length;
    for (let first = this.chunks[0]; first !== undefined && this.size - first.length >= this.capBytes; first = this.chunks[0]) {
      this.chunks.shift();
      this.size -= first.length;
      this.overflowed = true;
    }
  }

  /** The lines kept; `cut` when the beginning was left out. A line the cut left in pieces is dropped. */
  public lines(): { readonly lines: string[]; readonly cut: boolean } {
    let raw = Buffer.concat(this.chunks);
    let cut = this.overflowed;
    if (raw.length > this.capBytes) {
      raw = raw.subarray(raw.length - this.capBytes);
      cut = true;
    }
    const lines = raw
      .toString("utf8")
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (cut) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return { lines, cut };
  }
}

/**
 * Runs the tasks of applications (ADR-0042): a command, in the existing container of one component, started directly
 * with no user, no working directory, no terminal and no input. One run per application at a time. Nothing a run
 * printed is logged here, and no Docker id leaves this class.
 */
export class AppStackTaskRunner implements StackTaskExecutorPort {
  private readonly busy = new Set<string>();
  private readonly runs = new Map<string, RememberedRun>();
  private readonly target: DockerExecTarget;
  private readonly secondMs: number;
  private readonly killTimeoutMs: number;
  private readonly endSettleMs: number;
  private readonly retryDelayMs: number;

  public constructor(private readonly deps: AppStackTaskRunnerDeps) {
    this.target = deps.target;
    this.secondMs = deps.limits?.secondMs ?? 1_000;
    this.killTimeoutMs = deps.limits?.killTimeoutMs ?? APP_STACK_TASK_KILL_TIMEOUT_MS;
    this.endSettleMs = deps.limits?.endSettleMs ?? APP_STACK_TASK_END_SETTLE_MS;
    this.retryDelayMs = deps.limits?.retryDelayMs ?? APP_STACK_TASK_CLEANUP_RETRY_MS;
  }

  public async runAppStackTask(input: AppStackTaskRunIpcRequest): Promise<AppStackTaskRunIpcResult> {
    const parsed = AppStackTaskRunIpcRequestSchema.safeParse(input);
    if (!parsed.success) throw new ExecutorCodedError("The request of a task run is not valid", "VALIDATION_ERROR");
    const req = parsed.data;
    const seen = this.runs.get(req.runId);
    if (seen !== undefined) {
      if (seen.stackId !== req.stackId || seen.organizationId !== req.organizationId) {
        refuse("STACK_NAMESPACE_CONFLICT", "This run belongs to another application");
      }
      if (seen.state === "running") refuse("STACK_BUSY", "This run is still going");
      return seen.state;
    }
    if (this.busy.has(req.stackId)) refuse("STACK_BUSY", "A task of this application is already running");
    this.busy.add(req.stackId);
    try {
      const containerId = await this.findContainer(req);
      const remembered: RememberedRun = { stackId: req.stackId, organizationId: req.organizationId, state: "running" };
      this.runs.set(req.runId, remembered);
      let result: AppStackTaskRunIpcResult;
      try {
        result = await this.execute(req, containerId);
      } catch (err) {
        // Thrown only before the command was started: nothing ran, so a later call may try again.
        this.runs.delete(req.runId);
        throw err;
      }
      remembered.state = result;
      this.forgetOldRuns();
      return result;
    } finally {
      this.busy.delete(req.stackId);
    }
  }

  /** A read: it starts nothing. A run of another application, or of another customer, is `unknown`. */
  public getAppStackTaskRun(input: AppStackTaskReadIpcRequest): Promise<AppStackTaskReadIpcResult> {
    const parsed = AppStackTaskReadIpcRequestSchema.safeParse(input);
    if (!parsed.success) {
      return Promise.reject(new ExecutorCodedError("The request of a task read is not valid", "VALIDATION_ERROR"));
    }
    const seen = this.runs.get(parsed.data.runId);
    if (seen === undefined || seen.stackId !== parsed.data.stackId || seen.organizationId !== parsed.data.organizationId) {
      return Promise.resolve({ state: "unknown" });
    }
    return Promise.resolve(seen.state === "running" ? { state: "running" } : { state: "finished", result: seen.state });
  }

  /** The container the engine itself names for this component, with the labels of this application, running. */
  private async findContainer(req: AppStackTaskRunIpcRequest): Promise<string> {
    const seen = await inspectTaskContainer(this.target, appStackContainerName(req.stackId, req.componentKey));
    if (seen === null) return notRunning();
    if (ownComponentKey(seen.Config?.Labels, seen.Name, req) !== req.componentKey) {
      refuse("STACK_NAMESPACE_CONFLICT", "An object on this server uses the name or label of this application stack");
    }
    if (seen.State?.Running !== true || seen.State.Restarting === true) return notRunning();
    if (typeof seen.Id !== "string" || seen.Id.length === 0) {
      throw new ExecutorCodedError("Docker answered the inspect of a component with no id", "DOCKER_ENGINE_UNAVAILABLE");
    }
    // From here on the checked container is used by its id: a container put under the same name later is not this one.
    return seen.Id;
  }

  private async execute(req: AppStackTaskRunIpcRequest, containerId: string): Promise<AppStackTaskRunIpcResult> {
    // The clean-up is tried first: it proves the command can be stopped, and ends what an earlier run left here.
    const probe = await killMarkedProcesses(this.target, containerId, "", this.killTimeoutMs);
    if (probe === "gone") return notRunning();
    if (probe === "no_shell") {
      return {
        runId: req.runId,
        outcome: "not_started",
        problem: "no_shell",
        exitCode: null,
        startedAt: null,
        endedAt: this.now().toISOString(),
        output: "",
        outputTruncated: false,
      };
    }
    if (probe !== "done") {
      throw new ExecutorCodedError("The clean-up of tasks could not run in the component", "DOCKER_ENGINE_UNAVAILABLE");
    }

    const startedAt = this.now();
    const tail = new TaskOutputTail(APP_STACK_TASK_OUTPUT_TAIL_BYTES);
    let exec: { readonly execId: string; readonly socket: Duplex };
    try {
      exec = await startDockerExec(this.target, {
        container: containerId,
        cmd: req.argv,
        env: [`${APP_STACK_TASK_MARK}=${req.runId}`],
      });
    } catch (err) {
      // The engine refused to create the exec: the container is gone or stopped, nothing started.
      if (codeOf(err) === "NOT_FOUND") return notRunning();
      // Otherwise the command may be running (a failed create cannot be told from a failed start).
      await this.cleanUp(containerId, req.runId);
      return this.finished(req, "failed", null, startedAt, tail);
    }

    // A late error of the stream must never be an unhandled one.
    exec.socket.on("error", () => undefined);
    try {
      return await this.followToTheEnd(req, containerId, exec, startedAt, tail);
    } catch {
      // Not expected. The command did start, so the run is remembered as failed and is never started again.
      exec.socket.destroy();
      await this.cleanUp(containerId, req.runId);
      return {
        runId: req.runId,
        outcome: "failed",
        problem: null,
        exitCode: null,
        startedAt: startedAt.toISOString(),
        endedAt: this.now().toISOString(),
        output: "",
        outputTruncated: false,
      };
    }
  }

  private async followToTheEnd(
    req: AppStackTaskRunIpcRequest,
    containerId: string,
    exec: { readonly execId: string; readonly socket: Duplex },
    startedAt: Date,
    tail: TaskOutputTail,
  ): Promise<AppStackTaskRunIpcResult> {
    const how = await this.follow(exec.socket, tail, req.timeoutSeconds * this.secondMs);
    if (how === "limit") {
      await this.cleanUp(containerId, req.runId);
      await this.waitForEnd(exec.socket);
      exec.socket.destroy();
      return this.finished(req, "timed_out", null, startedAt, tail);
    }
    exec.socket.destroy();
    // What the command left behind ends before the answer; then the engine tells how the command itself ended.
    await this.cleanUp(containerId, req.runId);
    const exit = await inspectExecExitCode(this.target, exec.execId).catch(() => ({ exitCode: null }));
    const exitCode =
      exit.exitCode !== null && Number.isInteger(exit.exitCode) && exit.exitCode >= 0 && exit.exitCode <= 255 ? exit.exitCode : null;
    return this.finished(req, exitCode === 0 ? "succeeded" : "failed", exitCode, startedAt, tail);
  }

  /** Resolves when the output ended, when the connection broke, or at the time limit. The command gets no input. */
  private follow(socket: Duplex, tail: TaskOutputTail, limitMs: number): Promise<"ended" | "broken" | "limit"> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (how: "ended" | "broken" | "limit"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(how);
      };
      const timer = setTimeout(() => settle("limit"), limitMs);
      socket.on("data", (chunk: Buffer | string) => {
        tail.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      socket.once("end", () => settle("ended"));
      socket.once("error", () => settle("broken"));
      socket.once("close", () => settle("broken"));
      if (socket.destroyed) settle("broken");
      else socket.end();
    });
  }

  private waitForEnd(socket: Duplex): Promise<void> {
    if (socket.readableEnded || socket.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, this.endSettleMs);
      socket.once("end", done);
      socket.once("error", done);
      socket.once("close", done);
    });
  }

  /** Kills what a run started. A failure is tried again in the background; the next run's first step is another net. */
  private async cleanUp(containerId: string, runId: string): Promise<void> {
    const first = await killMarkedProcesses(this.target, containerId, runId, this.killTimeoutMs);
    if (first === "done" || first === "gone") return;
    let attempt = 1;
    const again = (): void => {
      const timer = setTimeout(() => {
        void killMarkedProcesses(this.target, containerId, runId, this.killTimeoutMs).then((outcome) => {
          if (outcome === "done" || outcome === "gone") return;
          attempt += 1;
          if (attempt < APP_STACK_TASK_CLEANUP_RETRIES) again();
          else this.deps.onCleanupFailed?.();
        });
      }, this.retryDelayMs);
      timer.unref();
    };
    again();
  }

  private async finished(
    req: AppStackTaskRunIpcRequest,
    outcome: "succeeded" | "failed" | "timed_out",
    exitCode: number | null,
    startedAt: Date,
    tail: TaskOutputTail,
  ): Promise<AppStackTaskRunIpcResult> {
    const kept = tail.lines();
    // The program never ran: what is there is the engine's message, not something the task printed. The exit code tells.
    const engineError =
      (exitCode === 126 || exitCode === 127) && !kept.cut && kept.lines[0]?.startsWith(APP_STACK_TASK_ENGINE_ERROR_PREFIX) === true;
    const { lines, cut } = engineError ? { lines: [], cut: false } : kept;
    const values = await readAppStackComponentSecretValues(this.deps.secretsRootDir, req.stackId, req.componentKey);
    const masked = maskAppStackLogLines(
      lines.map((text) => ({ at: null, stream: "stdout" as const, text })),
      values,
    ).map((line) => line.text);
    const { output, truncated } = boundAppStackTaskOutput(masked);
    return {
      runId: req.runId,
      outcome,
      problem: null,
      exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: this.now().toISOString(),
      output,
      outputTruncated: truncated || cut,
    };
  }

  private forgetOldRuns(): void {
    let finished = 0;
    for (const run of this.runs.values()) if (run.state !== "running") finished += 1;
    for (const [runId, run] of this.runs) {
      if (finished <= APP_STACK_TASK_RUNS_REMEMBERED) break;
      if (run.state === "running") continue;
      this.runs.delete(runId);
      finished -= 1;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/**
 * At start-up: ends what the tasks of a previous executor left running. In every running container of an application
 * component (name and labels as the engine gives them), also one with no exec listed: the engine drops an exec once its
 * command ends, and what the command left in the background stays. One container that fails does not stop the pass.
 * A container with no shell never ran a task.
 */
export async function reapAppStackTasks(target: DockerExecTarget, limits?: Pick<AppStackTaskLimits, "killTimeoutMs">): Promise<void> {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${APP_STACK_LABELS.role}=${APP_STACK_COMPONENT_ROLE}`] }));
  const res = await target.request("GET", `/containers/json?filters=${filters}`).catch(() => null);
  let list: Array<{ readonly Id?: unknown }> | null = null;
  try {
    if (res?.statusCode === 200) list = JSON.parse(res.body.toString("utf8")) as Array<{ readonly Id?: unknown }>;
  } catch {
    // Falls through to the refusal below.
  }
  if (!Array.isArray(list)) {
    throw new ExecutorCodedError("Docker could not list the components of applications", "DOCKER_ENGINE_UNAVAILABLE");
  }
  let failure: ExecutorCodedError | null = null;
  for (const { Id } of list) {
    if (typeof Id !== "string" || Id.length === 0) continue;
    try {
      const seen = await inspectTaskContainer(target, Id);
      if (seen === null || seen.State?.Running !== true) continue;
      const labels = seen.Config?.Labels;
      const stackId = labels?.[APP_STACK_LABELS.stackId];
      const organizationId = labels?.[APP_STACK_LABELS.organizationId];
      if (stackId === undefined || organizationId === undefined) continue;
      // A container whose name or labels are not as the engine gives them is not touched.
      let own: string | null;
      try {
        own = ownComponentKey(labels, seen.Name, { stackId, organizationId });
      } catch {
        own = null;
      }
      if (own === null) continue;
      const outcome = await killMarkedProcesses(target, Id, "", limits?.killTimeoutMs ?? APP_STACK_TASK_KILL_TIMEOUT_MS);
      if (outcome === "failed") throw new ExecutorCodedError("The clean-up of tasks did not finish", "INTERNAL_ERROR");
    } catch (err) {
      failure ??= err instanceof ExecutorCodedError ? err : new ExecutorCodedError("The clean-up of tasks failed", "INTERNAL_ERROR");
    }
  }
  if (failure) throw failure;
}
