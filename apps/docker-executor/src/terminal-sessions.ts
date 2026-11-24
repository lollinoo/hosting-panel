import {
  TERMINAL_IDLE_MS,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_OUTPUT_KEPT_BYTES,
  TERMINAL_READ_WAIT_MS,
  TERMINAL_SESSION_MAX_MS,
  TERMINAL_SESSIONS_MAX,
} from "@hosting-panel/contracts";
import type { AppStackTerminalOpenIpcRequest } from "@hosting-panel/contracts";
import type {
  TerminalEnded,
  TerminalExecutorEndReason,
  TerminalOpenRequest,
  TerminalOpenResult,
  TerminalReadResult,
  TerminalSessionRecord,
} from "@hosting-panel/executor-contracts";
import { ExecutorCodedError } from "./traefik-config.js";

// Nothing typed or printed is logged here, and every error message is a fixed sentence.

export const TERMINAL_ENDED_KEPT_MS = 600_000;

export interface TerminalShell { write(bytes: Buffer): void; /** Never rejects; true when nothing of the shell is left. */ kill(): Promise<boolean> }
export interface TerminalShellSink { data(chunk: Buffer): void; exit(reason: "shell_exited" | "container_gone"): void }
export interface TerminalLimits {
  readonly maxSessions: number; readonly sessionMaxMs: number; readonly idleMs: number;
  readonly keptBytes: number; readonly readWaitMs: number; readonly endedKeptMs: number;
}

type StartShell = (sink: TerminalShellSink) => Promise<{ readonly shell: TerminalShell; readonly containerName: string }>;

interface Waiter { cursor: number; resolve(r: TerminalReadResult): void; reject(e: Error): void; timer: NodeJS.Timeout }

/** What a session is on, as the list returns it: a site's container or one component of an application (ADR-0041). */
type SessionTarget =
  | { readonly sessionId: string; readonly siteId: string; readonly serviceInstanceId: string }
  | { readonly sessionId: string; readonly stackId: string; readonly organizationId: string; readonly componentKey: string };

const targetOf = (req: TerminalOpenRequest | AppStackTerminalOpenIpcRequest): SessionTarget =>
  "stackId" in req
    ? { sessionId: req.sessionId, stackId: req.stackId, organizationId: req.organizationId, componentKey: req.componentKey }
    : { sessionId: req.sessionId, siteId: req.siteId, serviceInstanceId: req.serviceInstanceId };

/** One session per container: the site, or the component of the application. The two prefixes never meet. */
const containerKey = (t: SessionTarget): string => ("stackId" in t ? `stack:${t.stackId}:${t.componentKey}` : `site:${t.siteId}`);

interface Session {
  readonly req: SessionTarget;
  readonly key: string;
  containerName: string | null; // null until the shell has started
  openedAt: string;
  shell: TerminalShell | null;
  start: number; // absolute byte position of buf[0]
  buf: Buffer;
  ended: TerminalEnded | null;
  killWanted: boolean;
  killing: Promise<boolean> | null; // null again after a kill that did not work
  waiter: Waiter | null;
  maxTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  keptTimer?: NodeJS.Timeout;
}

/** Bytes at the end that start an unfinished UTF-8 character. */
export function incompleteUtf8Tail(buf: Buffer): number {
  for (let i = 1; i <= Math.min(3, buf.length); i++) {
    const b = buf[buf.length - i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > i ? i : 0;
  }
  return 0;
}

const notFound = () => new ExecutorCodedError("Terminal session not found", "NOT_FOUND");

function later(ms: number, fn: () => void): NodeJS.Timeout {
  return setTimeout(fn, ms).unref();
}

/** Executor-memory terminal sessions: output window, long poll, limits and timers; no Docker here. */
export class TerminalSessions {
  private readonly limits: TerminalLimits;
  private readonly sessions = new Map<string, Session>();

  public constructor(limits?: Partial<TerminalLimits>) {
    this.limits = {
      maxSessions: TERMINAL_SESSIONS_MAX,
      sessionMaxMs: TERMINAL_SESSION_MAX_MS,
      idleMs: TERMINAL_IDLE_MS,
      keptBytes: TERMINAL_OUTPUT_KEPT_BYTES,
      readWaitMs: TERMINAL_READ_WAIT_MS,
      endedKeptMs: TERMINAL_ENDED_KEPT_MS,
      ...limits,
    };
  }

  /** A session on a site or on a component: the limit of the server counts both, the limit of a container its own. */
  public async open(req: TerminalOpenRequest | AppStackTerminalOpenIpcRequest, start: StartShell): Promise<TerminalOpenResult> {
    if (this.sessions.has(req.sessionId)) throw new ExecutorCodedError("Terminal session already exists", "ALREADY_EXISTS");
    const target = targetOf(req);
    const key = containerKey(target);
    const live = [...this.sessions.values()].filter((s) => !s.ended);
    if (live.some((s) => s.key === key)) {
      throw new ExecutorCodedError(
        "stackId" in target ? "A terminal is already open on this component" : "A terminal is already open on this site",
        "RESOURCE_LOCKED",
      );
    }
    if (live.length >= this.limits.maxSessions) throw new ExecutorCodedError("Too many terminal sessions open", "QUOTA_EXCEEDED");

    // The slot is taken here, before the first await.
    const s: Session = {
      req: target, key,
      containerName: null, openedAt: new Date().toISOString(), shell: null, start: 0, buf: Buffer.alloc(0),
      ended: null, killWanted: false, killing: null, waiter: null,
    };
    this.sessions.set(req.sessionId, s);
    const sink: TerminalShellSink = {
      data: (chunk) => this.append(s, chunk),
      exit: (reason) => this.end(s, reason, reason === "shell_exited"), // Ctrl-D leaves background children
    };
    let started: Awaited<ReturnType<StartShell>>;
    try {
      started = await start(sink);
    } catch (err) {
      this.drop(s);
      throw err;
    }
    s.shell = started.shell;
    if (this.sessions.get(req.sessionId) !== s) { // forgotten or closed while starting
      void started.shell.kill();
      throw notFound();
    }
    s.containerName = started.containerName;
    s.openedAt = new Date().toISOString();
    this.kill(s);
    if (!s.ended) {
      s.maxTimer = later(this.limits.sessionMaxMs, () => this.end(s, "time_limit", true));
      this.resetIdle(s);
    }
    return { containerName: s.containerName, openedAt: s.openedAt };
  }

  public write(req: { readonly sessionId: string; readonly input: string }): void {
    const s = this.sessions.get(req.sessionId);
    if (!s || !s.shell) throw notFound();
    if (s.ended) throw new ExecutorCodedError("Terminal session has ended", "OPERATION_INTERRUPTED");
    const bytes = Buffer.from(req.input, "utf8");
    if (bytes.length > TERMINAL_INPUT_MAX_BYTES) {
      throw new ExecutorCodedError(`Input longer than ${TERMINAL_INPUT_MAX_BYTES} bytes`, "VALIDATION_ERROR");
    }
    s.shell.write(bytes);
  }

  public async read(req: { readonly sessionId: string; readonly cursor: number }): Promise<TerminalReadResult> {
    const s = this.sessions.get(req.sessionId);
    if (!s || !s.shell) throw notFound();
    if (req.cursor > s.start + s.buf.length) throw new ExecutorCodedError("Cursor is beyond the output", "VALIDATION_ERROR");
    if (!s.ended) this.resetIdle(s);
    const now = this.slice(s, req.cursor);
    if (now.output || now.dropped || now.ended) return now;
    this.answerWaiter(s);
    return new Promise((resolve, reject) => {
      const timer = later(this.limits.readWaitMs, () => this.answerWaiter(s));
      s.waiter = { cursor: req.cursor, resolve, reject, timer };
    });
  }

  public async close(req: { readonly sessionId: string }): Promise<TerminalEnded> {
    const s = this.sessions.get(req.sessionId);
    if (!s) throw notFound();
    this.end(s, "closed", true);
    this.kill(s); // again, after a kill that did not work
    if ((await s.killing) ?? true) this.drop(s);
    return s.ended!;
  }

  public list(): readonly TerminalSessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => s.containerName !== null)
      .map((s) => ({ ...s.req, containerName: s.containerName!, openedAt: s.openedAt, ended: s.ended }));
  }

  public endService(serviceInstanceId: string, reason: TerminalExecutorEndReason): void {
    for (const s of this.sessions.values()) {
      if ("serviceInstanceId" in s.req && s.req.serviceInstanceId === serviceInstanceId) this.end(s, reason, true);
    }
  }

  /** Ends the sessions on one component of an application, or on all of them when no component is named. */
  public endAppStack(stackId: string, componentKey: string | null, reason: TerminalExecutorEndReason): void {
    for (const s of this.sessions.values()) {
      if ("stackId" in s.req && s.req.stackId === stackId && (componentKey === null || s.req.componentKey === componentKey)) {
        this.end(s, reason, true);
      }
    }
  }

  /** Drops every record, as an executor restart does; waiting reads get NOT_FOUND. */
  public forgetAll(): void {
    for (const s of [...this.sessions.values()]) {
      s.killWanted = true;
      this.kill(s);
      s.waiter?.reject(notFound());
      if (s.waiter) clearTimeout(s.waiter.timer);
      s.waiter = null;
      this.drop(s);
    }
  }

  private append(s: Session, chunk: Buffer): void {
    if (s.ended || chunk.length === 0) return;
    let buf = Buffer.concat([s.buf, chunk]);
    const over = buf.length - this.limits.keptBytes;
    if (over > 0) {
      buf = buf.subarray(over);
      s.start += over;
    }
    s.buf = buf;
    const w = s.waiter;
    if (w && this.slice(s, w.cursor).output) this.answerWaiter(s);
  }

  // From the cursor to the last complete character; skips continuation bytes after a drop.
  private slice(s: Session, cursor: number): TerminalReadResult {
    const dropped = cursor < s.start;
    let from = Math.max(cursor, s.start) - s.start;
    if (dropped) while (from < s.buf.length && (s.buf[from]! & 0xc0) === 0x80) from++;
    let bytes = s.buf.subarray(from);
    if (!s.ended) bytes = bytes.subarray(0, bytes.length - incompleteUtf8Tail(bytes));
    return { output: bytes.toString("utf8"), cursor: s.start + from + bytes.length, dropped, ended: s.ended };
  }

  private answerWaiter(s: Session): void {
    const w = s.waiter;
    if (!w) return;
    s.waiter = null;
    clearTimeout(w.timer);
    w.resolve(this.slice(s, w.cursor));
  }

  private resetIdle(s: Session): void {
    clearTimeout(s.idleTimer);
    s.idleTimer = later(this.limits.idleMs, () => this.end(s, "idle", true));
  }

  private end(s: Session, reason: TerminalExecutorEndReason, kill: boolean): void {
    if (s.ended) return;
    s.ended = { reason, at: new Date().toISOString() };
    this.clearTimers(s);
    s.keptTimer = later(this.limits.endedKeptMs, () => {
      if (s.killWanted && s.shell && !s.killing) {
        // Only the event and a code: nothing of the session.
        console.error(JSON.stringify({
          component: "hp-docker-executor", event: "terminal_kill_failed", code: "INTERNAL_ERROR", timestamp: new Date().toISOString(),
        }));
      }
      this.drop(s);
    });
    s.killWanted = kill;
    this.kill(s);
    this.answerWaiter(s);
  }

  private kill(s: Session): void {
    if (!s.killWanted || !s.shell || s.killing) return;
    const killing: Promise<boolean> = s.shell.kill().then((worked) => {
      if (!worked && s.killing === killing) s.killing = null;
      return worked;
    });
    s.killing = killing;
  }

  private drop(s: Session): void {
    this.clearTimers(s);
    if (this.sessions.get(s.req.sessionId) === s) this.sessions.delete(s.req.sessionId);
  }

  private clearTimers(s: Session): void {
    clearTimeout(s.maxTimer);
    clearTimeout(s.idleTimer);
    clearTimeout(s.keptTimer);
  }
}
