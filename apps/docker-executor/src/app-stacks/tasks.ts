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
import { DockerExecCreateRefusedError, inspectExecState, runDockerExec, startDockerExec, type DockerExecTarget } from "../docker-exec.js";
import { ExecutorCodedError } from "../traefik-config.js";
import { ownComponentKey } from "./engine.js";
import { AppStackExecutorError } from "./errors.js";
import { APP_STACK_COMPONENT_ROLE, APP_STACK_LABELS, appStackContainerName } from "./names.js";
import { appStackContainerMaskValues, maskAppStackLogLines, type AppStackInspectedContainer } from "./secrets.js";

/** The command of a run, and all it starts, carry `HP_TASK_RUN=<run id>` in their environment (ADR-0042 A3). */
export const APP_STACK_TASK_MARK = "HP_TASK_RUN";
export const APP_STACK_TASK_KILL_TIMEOUT_MS = 10_000;
/** After the time limit and the kill, how long the output may take to end before the stream is dropped. */
export const APP_STACK_TASK_END_SETTLE_MS = 2_000;
/** Raw bytes of output kept while a run goes: the last ones. The answer is bounded again, after the masking. */
export const APP_STACK_TASK_OUTPUT_TAIL_BYTES = 65_536;
/** Finished runs remembered by id, so that a second call with the same id never starts the command again. */
export const APP_STACK_TASK_RUNS_REMEMBERED = 200;
/**
 * Tries of the kill after a run, the first one included, and the pause between two of them. They are part of the run:
 * the application stays held, and nothing is answered, until a kill is confirmed or the last one failed.
 */
export const APP_STACK_TASK_CLEANUP_RETRIES = 6;
export const APP_STACK_TASK_CLEANUP_RETRY_MS = 5_000;
/** Components the start-up clean-up works in at once. */
export const APP_STACK_TASK_REAP_CONCURRENCY = 4;
/**
 * The start-up clean-up ends by then, before the executor takes calls (one component can take about 30 s). A component
 * it did not reach is cleaned by the probe of its next run.
 */
export const APP_STACK_TASK_REAP_DEADLINE_MS = 60_000;
/**
 * How the engine's own message begins when it could not start the program of a run (it is not in the image, or it is
 * not executable; exit code 127 or 126). The message names the program, so it is never returned as what the run printed.
 */
export const APP_STACK_TASK_ENGINE_ERROR_PREFIX = "OCI runtime exec failed";

/** Passes of the clean-up script: it ends with a failure when its last pass still finds a process it had not killed. */
export const APP_STACK_TASK_KILL_PASSES = 5;
/**
 * The clean-up script's exit when pid 1 itself carries the mark: the mark comes from the component's own environment
 * (its image or its settings), not from a run, so the script kills nothing there and no task can run there.
 */
export const APP_STACK_TASK_KILL_OWN_MARK_EXIT = 3;

/**
 * Kills, in one container, every process whose environment carries the mark of a run ($1 = the run id; empty = any
 * run) and every process of their sessions; never pid 1. Only `/proc` and what a POSIX shell has built in, so it runs
 * in any image that has `/bin/sh`. It is tried before the command of a run: where it cannot run, no task starts.
 * A pass can miss a process forked while it ran, so passes repeat until one finds no process it had not killed yet
 * (one killed but not gone yet does not count); exit 1 when the last pass still found one: the clean-up did not finish.
 * First of all, before any kill: when pid 1 carries the mark, the mark is the component's own and every process would
 * carry it, so the script kills nothing and exits with APP_STACK_TASK_KILL_OWN_MARK_EXIT.
 */
export const APP_STACK_TASK_KILL_SCRIPT =
  `m="${APP_STACK_TASK_MARK}=\${1:-srun_}"; ` +
  'marked() { while IFS= read -r x || [ -n "$x" ]; do case "$x" in *"$m"*) return 0;; esac; done 2>/dev/null <"$1/environ"; return 1; }; ' +
  `marked /proc/1 && exit ${String(APP_STACK_TASK_KILL_OWN_MARK_EXIT)}; s=" "; k=" "; ` +
  'sid() { l=""; while IFS= read -r x || [ -n "$x" ]; do l=$x; done 2>/dev/null <"$1/stat"; l=${l##*) }; set -- $l; i=${4:-0}; }; ' +
  'hit() { [ "$1" -gt 1 ] || return 0; kill -KILL "$1" 2>/dev/null; case "$k" in *" $1 "*) ;; *) k="$k$1 "; f=1;; esac; }; ' +
  'pass() { f=0; for p in /proc/[0-9]*; do marked "$p" || continue; sid "$p"; ' +
  '[ "$i" -gt 1 ] 2>/dev/null && case "$s" in *" $i "*) ;; *) s="$s$i ";; esac; hit "${p#/proc/}"; done; ' +
  'for p in /proc/[0-9]*; do [ "${p#/proc/}" -gt 1 ] || continue; sid "$p"; case "$s" in *" $i "*) hit "${p#/proc/}";; esac; done; }; ' +
  `n=0; while [ "$n" -lt ${String(APP_STACK_TASK_KILL_PASSES)} ]; do pass; [ "$f" = 0 ] && exit 0; n=$((n+1)); done; exit 1`;

export interface AppStackTaskLimits {
  /** Milliseconds in one second of a time limit (tests shorten it). */
  readonly secondMs?: number;
  readonly killTimeoutMs?: number;
  readonly endSettleMs?: number;
  readonly retryDelayMs?: number;
  readonly reapDeadlineMs?: number;
}

export interface AppStackTaskRunnerDeps {
  readonly target: DockerExecTarget;
  readonly secretsRootDir: string;
  readonly now?: () => Date;
  /** The clean-up after a run did not finish, the last try included. It is told nothing: no name and no output. */
  readonly onCleanupFailed?: () => void;
  /** A run printed something and none of it was kept: the private values of the component could not be established, so
   *  it could not be masked. It is told nothing: no name, no output, no value. */
  readonly onOutputWithheld?: () => void;
  /** The engine of this executor is changing the application: no task of it starts meanwhile (ADR-0042). */
  readonly engineBusy?: (stackId: string) => boolean;
  readonly limits?: AppStackTaskLimits;
}

interface TaskContainerInspect {
  readonly Id?: unknown;
  readonly Name?: string;
  readonly Config?: { readonly Labels?: Readonly<Record<string, string>> | null; readonly Env?: readonly string[] | null };
  readonly HostConfig?: unknown;
  readonly State?: { readonly Running?: boolean; readonly Restarting?: boolean };
}

/** The container a run goes to: its id, and what the output of the run is masked from (its own inspect). */
interface TaskContainer {
  readonly id: string;
  readonly inspected: AppStackInspectedContainer;
}

/** `own_mark`: pid 1 carries the mark, so the script killed nothing: no task can run in that component. */
type KillOutcome = "done" | "gone" | "no_shell" | "own_mark" | "failed";

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
    if (done.exitCode === APP_STACK_TASK_KILL_OWN_MARK_EXIT) return "own_mark";
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
  /** Applications with a run going: it lasts until a kill is confirmed or the last try of it failed. */
  private readonly busy = new Set<string>();
  /** Applications with a start-up clean-up still going, and how many. */
  private readonly held = new Map<string, number>();
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
    if (this.deps.engineBusy?.(req.stackId) === true) refuse("STACK_BUSY", "The application is being changed");
    if (this.held.has(req.stackId)) refuse("STACK_BUSY", "The tasks of this application are still being cleaned up");
    this.busy.add(req.stackId);
    try {
      const container = await this.findContainer(req);
      const remembered: RememberedRun = { stackId: req.stackId, organizationId: req.organizationId, state: "running" };
      this.runs.set(req.runId, remembered);
      let result: AppStackTaskRunIpcResult;
      try {
        result = await this.execute(req, container);
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

  /** A task of the application runs here (the engine asks before it changes the application's containers). */
  public isRunning(stackId: string): boolean {
    return this.busy.has(stackId);
  }

  /**
   * No task of the application starts until `cleaning` ends: the start-up clean-up, past its deadline, still works in
   * one of its components, and would kill the command of a new run.
   */
  public holdWhile(stackId: string, cleaning: Promise<unknown>): void {
    this.held.set(stackId, (this.held.get(stackId) ?? 0) + 1);
    const release = (): void => {
      const left = (this.held.get(stackId) ?? 1) - 1;
      if (left > 0) this.held.set(stackId, left);
      else this.held.delete(stackId);
    };
    void cleaning.then(release, release);
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
  private async findContainer(req: AppStackTaskRunIpcRequest): Promise<TaskContainer> {
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
    return { id: seen.Id, inspected: { labels: seen.Config?.Labels, env: seen.Config?.Env, hostConfig: seen.HostConfig } };
  }

  private async execute(req: AppStackTaskRunIpcRequest, container: TaskContainer): Promise<AppStackTaskRunIpcResult> {
    const containerId = container.id;
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
    // Not finished, or the component's own environment carries the mark (no run there could ever be cleaned up).
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
      // The engine answered the create with a refusal: no exec exists, nothing of this run is there to stop, and the
      // clean-up before the command has just emptied the component of any earlier mark. No try, no hold.
      if (err instanceof DockerExecCreateRefusedError) return this.finished(req, container.inspected, "failed", null, startedAt, tail);
      // Otherwise the command may be running (a create or a start whose answer could not be read): it ended as failed
      // only where the kill is confirmed, else nobody knows.
      const stopped = await this.cleanUp(containerId, req.runId);
      return this.finished(req, container.inspected, stopped ? "failed" : "unknown", null, startedAt, tail);
    }

    // A late error of the stream must never be an unhandled one.
    exec.socket.on("error", () => undefined);
    try {
      return await this.followToTheEnd(req, container, exec, startedAt, tail);
    } catch {
      // Not expected. The command did start, so the run is remembered and is never started again: as failed where the
      // kill is confirmed, else as not known.
      exec.socket.destroy();
      const stopped = await this.cleanUp(containerId, req.runId);
      return {
        runId: req.runId,
        outcome: stopped ? "failed" : "unknown",
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
    container: TaskContainer,
    exec: { readonly execId: string; readonly socket: Duplex },
    startedAt: Date,
    tail: TaskOutputTail,
  ): Promise<AppStackTaskRunIpcResult> {
    const containerId = container.id;
    const how = await this.follow(exec.socket, tail, req.timeoutSeconds * this.secondMs);
    if (how === "limit") {
      // Stopped at its time limit only where a kill is confirmed (or the container is gone): else the command may still
      // be going, and the run is not known to have ended.
      const stopped = await this.cleanUp(containerId, req.runId);
      await this.waitForEnd(exec.socket);
      exec.socket.destroy();
      return this.finished(req, container.inspected, stopped ? "timed_out" : "unknown", null, startedAt, tail);
    }
    exec.socket.destroy();
    // What the command left behind ends before the answer (every try of the kill is part of the run); then the engine
    // tells how the command itself ended.
    const stopped = await this.cleanUp(containerId, req.runId);
    const state = await inspectExecState(this.target, exec.execId).catch(() => undefined);
    const raw = state?.exitCode ?? null;
    const exitCode = raw !== null && Number.isInteger(raw) && raw >= 0 && raw <= 255 ? raw : null;
    // No process (pid 0), or an exec the engine no longer knows: taken as a command that never started, and what came
    // back as the engine's own text, which can carry a Docker id. The engine drops an exec that never ran when its
    // container stops, but it also forgets every exec when it restarts: a command that did run then loses its output
    // and its exit code (ADR-0042 §7).
    const started = state !== null && state?.pid !== 0;
    // A command that ended by itself keeps its outcome and exit code, whatever the kill of what it left behind. An end
    // of the output that comes with no exit code (a connection that broke ends it the same way) does not say that the
    // command ended: with no confirmed kill either, it may still be going. Only an engine that says no process ever ran
    // (pid 0) tells a command that never started; one that no longer knows the exec does not, so that run is not known
    // (its output stays withheld, as the engine's own text can be all it holds).
    if (!stopped && exitCode === null && state?.pid !== 0) {
      return this.finished(req, container.inspected, "unknown", null, startedAt, tail, started);
    }
    return this.finished(req, container.inspected, exitCode === 0 ? "succeeded" : "failed", exitCode, startedAt, tail, started);
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

  /**
   * Kills what a run started, and tries again after a failure, up to `APP_STACK_TASK_CLEANUP_RETRIES` tries in all, each
   * one awaited: the run, and so the hold on the application, lasts until a kill is confirmed or the last one failed.
   * True when a kill is confirmed (also when the container is gone, so nothing is left to stop); false when it is not,
   * which is logged once. The component's own environment carrying the mark is not tried again: the script would kill
   * nothing again. The next run's first step is another net.
   */
  private async cleanUp(containerId: string, runId: string): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await killMarkedProcesses(this.target, containerId, runId, this.killTimeoutMs);
      if (outcome === "done" || outcome === "gone") return true;
      if (outcome === "own_mark" || attempt >= APP_STACK_TASK_CLEANUP_RETRIES) {
        this.deps.onCleanupFailed?.();
        return false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
  }

  private async finished(
    req: AppStackTaskRunIpcRequest,
    inspected: AppStackInspectedContainer,
    outcome: "succeeded" | "failed" | "timed_out" | "unknown",
    exitCode: number | null,
    startedAt: Date,
    tail: TaskOutputTail,
    started = true,
  ): Promise<AppStackTaskRunIpcResult> {
    const kept = tail.lines();
    // The program never ran: what is there is the engine's message, not something the task printed. The engine tells it
    // (no process); else, as a second net, its own prefix with an exit code of 126 or 127 or none known.
    const engineError =
      !started ||
      ((exitCode === null || exitCode === 126 || exitCode === 127) &&
        !kept.cut &&
        kept.lines[0]?.startsWith(APP_STACK_TASK_ENGINE_ERROR_PREFIX) === true);
    const { lines, cut } = engineError ? { lines: [], cut: false } : kept;
    const answer = (output: string, outputTruncated: boolean): AppStackTaskRunIpcResult => ({
      runId: req.runId,
      outcome,
      problem: null,
      exitCode,
      startedAt: startedAt.toISOString(),
      endedAt: this.now().toISOString(),
      output,
      outputTruncated,
    });
    // Masked with every private value of the component, or not kept at all. The values come from the container the run
    // went to (its binds name its secret files, its environment holds the rest), as the log reader takes them, so a
    // folder a reboot emptied cannot leave a value unmasked. Where they cannot be established, what the run printed is
    // dropped and the answer is the one of a run whose output was all cut away: empty and flagged. A run that printed
    // nothing has nothing to mask, so it keeps its ordinary answer.
    const printed = cut || lines.some((line) => line !== "");
    let values: string[] = [];
    if (printed) {
      try {
        values = await appStackContainerMaskValues(this.deps.secretsRootDir, req, inspected);
      } catch {
        this.deps.onOutputWithheld?.();
        return answer("", true);
      }
    }
    const masked = maskAppStackLogLines(
      lines.map((text) => ({ at: null, stream: "stdout" as const, text })),
      values,
    ).map((line) => line.text);
    const { output, truncated } = boundAppStackTaskOutput(masked);
    return answer(output, truncated || cut);
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

export interface AppStackTaskReapResult {
  /** Components whose own environment carries the mark of a run: nothing was killed there. */
  readonly ownMark: number;
  /** Components whose clean-up had not ended at the deadline. */
  readonly unreached: number;
  /** The first failure of a component, once every other one was tried. */
  readonly failure: ExecutorCodedError | null;
}

/**
 * At start-up: ends what the tasks of a previous executor left running. In every running container of an application
 * component (name and labels as the engine gives them), also one with no exec listed: the engine drops an exec once its
 * command ends, and what the command left in the background stays. One container that fails does not stop the pass.
 * A container with no shell never ran a task; nor did one whose own environment carries the mark (it is counted).
 * A few containers at once, and one deadline for the whole pass: what it did not reach is counted and left to the probe
 * of the next run. Each clean-up is handed to `hold` with its application: one still going after the deadline keeps the
 * tasks of that application from starting.
 */
export async function reapAppStackTasks(
  target: DockerExecTarget,
  limits?: Pick<AppStackTaskLimits, "killTimeoutMs" | "reapDeadlineMs">,
  hold?: (stackId: string, cleaning: Promise<unknown>) => void,
): Promise<AppStackTaskReapResult> {
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
  const ids = list.flatMap(({ Id }) => (typeof Id === "string" && Id.length > 0 ? [Id] : []));
  let failure: ExecutorCodedError | null = null;
  let ownMark = 0;
  let ended = 0;
  let late = false;
  const reapOne = async (Id: string): Promise<void> => {
    const seen = await inspectTaskContainer(target, Id);
    if (seen === null || seen.State?.Running !== true) return;
    const labels = seen.Config?.Labels;
    const stackId = labels?.[APP_STACK_LABELS.stackId];
    const organizationId = labels?.[APP_STACK_LABELS.organizationId];
    if (stackId === undefined || organizationId === undefined) return;
    // A container whose name or labels are not as the engine gives them is not touched.
    let own: string | null;
    try {
      own = ownComponentKey(labels, seen.Name, { stackId, organizationId });
    } catch {
      own = null;
    }
    // Past the deadline no clean-up starts: the executor may be taking calls already.
    if (own === null || late) return;
    const cleaning = killMarkedProcesses(target, Id, "", limits?.killTimeoutMs ?? APP_STACK_TASK_KILL_TIMEOUT_MS);
    hold?.(stackId, cleaning);
    const outcome = await cleaning;
    if (outcome === "own_mark") ownMark += 1;
    if (outcome === "failed") throw new ExecutorCodedError("The clean-up of tasks did not finish", "INTERNAL_ERROR");
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < ids.length && !late; i = next++) {
      try {
        await reapOne(ids[i]!);
      } catch (err) {
        failure ??= err instanceof ExecutorCodedError ? err : new ExecutorCodedError("The clean-up of tasks failed", "INTERNAL_ERROR");
      }
      ended += 1;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limits?.reapDeadlineMs ?? APP_STACK_TASK_REAP_DEADLINE_MS);
  });
  await Promise.race([Promise.all(Array.from({ length: Math.min(APP_STACK_TASK_REAP_CONCURRENCY, ids.length) }, worker)), deadline]);
  clearTimeout(timer);
  late = true;
  return { ownMark, unreached: ids.length - ended, failure };
}
