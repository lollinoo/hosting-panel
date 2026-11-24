import { type DockerExecResult, type DockerExecTarget, runDockerExec, startDockerExec } from "./docker-exec.js";
import type { ExecutorSiteType } from "./site-types/types.js";
import type { TerminalShell, TerminalShellSink } from "./terminal-sessions.js";
import { ExecutorCodedError } from "./traefik-config.js";

// Nothing typed or printed is logged here, and every error message is a fixed sentence.

export const TERMINAL_CONSOLE_SIZE = [24, 80] as const;
export const TERMINAL_KILL_TIMEOUT_MS = 10_000;
// A stop kills the shell before the Engine reports the container stopped; the end inspect waits this long.
export const TERMINAL_END_SETTLE_MS = 1_000;
// Kills every process marked with the session (all marked when $1 is empty), then their sessions.
export const TERMINAL_KILL_SCRIPT =
  'm="^HP_TERMINAL_SESSION=${1:-.*}\\$"; s=""; for p in /proc/[0-9]*; do grep -qz "$m" "$p/environ" 2>/dev/null || continue; ' +
  'i=$(ps -o sid= -p "${p#/proc/}"); i=${i##* }; [ "${i:-0}" -gt 1 ] && s="$s,$i"; kill -KILL "${p#/proc/}" 2>/dev/null; done; ' +
  '[ -z "$s" ] || pkill -KILL -s "${s#,}"; exit 0';
/**
 * The component clean-up's exit when pid 1 itself carries the mark: the mark is then the component's own environment
 * (two entries read without their separator, ADR-0041 §4), every process would match, and the script kills nothing.
 * No other path gives it: 0 done, 1 and 2 the shell's own errors, 126 and 127 the engine without /bin/sh, 128+ a signal.
 */
export const APP_STACK_TERMINAL_KILL_OWN_MARK_EXIT = 3;
// The same for a component of an application (ADR-0041), with nothing but what the shell has built in: the image may
// have neither grep, ps nor pkill. First pid 1 (see above); then marked processes (never pid 1 or the script itself),
// then every process in one of their sessions (never session 0 or 1, which are the component's own, nor the script).
// Session ids have one length, so none is the start of another.
export const APP_STACK_TERMINAL_KILL_SCRIPT =
  'm="HP_TERMINAL_SESSION=${1:-term_}"; ' +
  'marked() { while IFS= read -r x || [ -n "$x" ]; do case "$x" in *"$m"*) return 0;; esac; done 2>/dev/null <"$1/environ"; return 1; }; ' +
  `marked /proc/1 && exit ${String(APP_STACK_TERMINAL_KILL_OWN_MARK_EXIT)}; s=" "; ` +
  'sid() { l=""; while IFS= read -r x || [ -n "$x" ]; do l=$x; done 2>/dev/null <"$1/stat"; l=${l##*) }; set -- $l; i=${4:-0}; }; ' +
  'for p in /proc/[0-9]*; do marked "$p" || continue; sid "$p"; [ "$i" -gt 1 ] 2>/dev/null && s="$s$i "; ' +
  '[ "${p#/proc/}" -gt 1 ] && [ "${p#/proc/}" != "$$" ] && kill -KILL "${p#/proc/}" 2>/dev/null; done; ' +
  'for p in /proc/[0-9]*; do [ "${p#/proc/}" -gt 1 ] && [ "${p#/proc/}" != "$$" ] || continue; sid "$p"; ' +
  'case "$s" in *" $i "*) kill -KILL "${p#/proc/}" 2>/dev/null;; esac; done; exit 0';

const SITE_LABEL = "io.hostingpanel.site_id"; // MANAGED_DOCKER_LABELS.siteId; not imported to keep this file free of the adapter
const APP_COMPONENT_LABEL = "io.hostingpanel.app_component"; // APP_STACK_LABELS.component, for the same reason
/** How the engine's own message begins when it cannot start the program of an exec (exit 127 or 126). */
const ENGINE_EXEC_FAILED = "OCI runtime exec failed";

/** What differs between a shell in a site and one in a component of an application. */
/** "own_mark": pid 1 carries the mark, so the script killed nothing there: nothing a session started can be told apart. */
type KillOutcome = "done" | "own_mark" | "failed";

interface ShellKind {
  /** A site names the owner of its files and their folder; a component names neither (ADR-0041). */
  readonly as: { readonly user?: string; readonly workingDir?: string };
  readonly notRunning: string;
  readonly inspectFailed: string;
  /** Runs the clean-up script ("done": nothing the session started is left); rejects as runDockerExec does. */
  readonly kill: (containerId: string, sessionId: string) => Promise<KillOutcome>;
}

interface Inspected {
  readonly Name?: string;
  readonly State?: { readonly Running?: boolean; readonly StartedAt?: string };
  readonly ExecIDs?: readonly string[] | null;
}

/** Container inspect: null on 404; any other failure is DOCKER_ENGINE_UNAVAILABLE with a fixed sentence. */
async function inspect(target: DockerExecTarget, containerId: string, failed: string): Promise<Inspected | null> {
  const res = await target.request("GET", `/containers/${encodeURIComponent(containerId)}/json`).catch(() => null);
  if (res?.statusCode === 404) return null;
  try {
    if (res?.statusCode === 200) return JSON.parse(res.body.toString("utf8")) as Inspected;
  } catch {
    // fall through
  }
  throw new ExecutorCodedError(failed, "DOCKER_ENGINE_UNAVAILABLE");
}

/** Runs the kill script as the type's file owner; sessionId "" kills every marked process. */
function runKillScript(target: DockerExecTarget, containerId: string, sessionId: string, t: ExecutorSiteType): Promise<DockerExecResult> {
  return runDockerExec(
    target,
    { container: containerId, cmd: ["/bin/sh", "-c", TERMINAL_KILL_SCRIPT, "sh", sessionId], user: t.def.files.owner },
    { timeoutMs: TERMINAL_KILL_TIMEOUT_MS, maxOutputBytes: 0 },
  );
}

/**
 * Runs the builtin-only kill script as the user the component runs as (no user is named); "" kills every marked process.
 * Only the start of the output is read: the script prints nothing, the engine its message when it cannot start /bin/sh.
 */
function runAppStackKillScript(target: DockerExecTarget, containerId: string, sessionId: string): Promise<DockerExecResult> {
  return runDockerExec(
    target,
    { container: containerId, cmd: ["/bin/sh", "-c", APP_STACK_TERMINAL_KILL_SCRIPT, "sh", sessionId] },
    { timeoutMs: TERMINAL_KILL_TIMEOUT_MS, maxOutputBytes: ENGINE_EXEC_FAILED.length },
  );
}

/**
 * The engine could not start /bin/sh (127: not there, 126: not runnable), so no shell of a session ever ran in this
 * image and none left anything (ADR-0041 T4). The script's own exit never carries the engine's message.
 */
function hasNoShell(done: DockerExecResult): boolean {
  return (done.exitCode === 126 || done.exitCode === 127) && [done.stdout, done.stderr].some((out) => out.toString("utf8").startsWith(ENGINE_EXEC_FAILED));
}

/** One line for the components whose own environment carries the mark: a count, never a name or an id. */
function logOwnMark(count: number): void {
  console.error(JSON.stringify({ component: "hp-docker-executor", event: "terminal_own_mark", count, timestamp: new Date().toISOString() }));
}

const siteKind = (target: DockerExecTarget, t: ExecutorSiteType): ShellKind => ({
  as: { user: t.def.files.owner, workingDir: t.def.files.mountPath },
  notRunning: "The site container is not running",
  inspectFailed: "Failed to inspect the site container",
  kill: (containerId, sessionId) => runKillScript(target, containerId, sessionId, t).then((done) => (done.exitCode === 0 ? "done" : "failed")),
});

const appStackKind = (target: DockerExecTarget): ShellKind => ({
  as: {},
  notRunning: "The component is not running",
  inspectFailed: "Failed to inspect the component's container",
  kill: (containerId, sessionId) =>
    runAppStackKillScript(target, containerId, sessionId).then((done) => {
      if (done.exitCode === APP_STACK_TERMINAL_KILL_OWN_MARK_EXIT) return "own_mark";
      return done.exitCode === 0 || hasNoShell(done) ? "done" : "failed";
    }),
});

/** /bin/sh with a TTY in a running container; NOT_FOUND when the container is missing or stopped. */
async function startShell(
  target: DockerExecTarget,
  containerId: string,
  sessionId: string,
  sink: TerminalShellSink,
  kind: ShellKind,
): Promise<{ readonly shell: TerminalShell; readonly containerName: string }> {
  const seen = await inspect(target, containerId, kind.inspectFailed);
  if (seen?.State?.Running !== true) throw new ExecutorCodedError(kind.notRunning, "NOT_FOUND");
  const startedAt = seen.State.StartedAt;
  const { socket } = await startDockerExec(target, {
    container: containerId,
    cmd: ["/bin/sh"],
    ...kind.as,
    env: ["TERM=dumb", "PS1=$PWD $ ", `HP_TERMINAL_SESSION=${sessionId}`],
    tty: true,
    consoleSize: TERMINAL_CONSOLE_SIZE,
  });
  // Worked: the script found nothing left or nothing to clean, or the container is gone or stopped (nothing is left to kill).
  const kill = () =>
    kind.kill(containerId, sessionId).then(
      (outcome) => {
        if (outcome === "own_mark") logOwnMark(1);
        return outcome !== "failed";
      },
      (err: unknown) => err instanceof ExecutorCodedError && err.code === "NOT_FOUND",
    );
  let over = false; // the stream ended, or the manager asked for the end
  const ended = (): void => {
    if (over) return;
    over = true;
    // Gone, stopped or started again means the container went away; otherwise the shell itself ended.
    void new Promise((settle) => setTimeout(settle, TERMINAL_END_SETTLE_MS))
      .then(() => inspect(target, containerId, kind.inspectFailed))
      .then((now) => (now?.State?.Running === true && now.State.StartedAt === startedAt ? "shell_exited" : "container_gone"))
      .catch(() => "shell_exited" as const)
      .then((reason) => sink.exit(reason));
  };
  socket.on("data", (chunk: Buffer | string) => sink.data(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  socket.on("error", () => undefined); // close follows
  socket.on("end", ended);
  socket.on("close", ended);
  return {
    containerName: (seen.Name ?? "").replace(/^\//, ""),
    shell: {
      write: (bytes) => {
        if (!socket.destroyed) socket.write(bytes);
      },
      kill: async () => {
        over = true;
        const worked = await kill();
        socket.destroy();
        return worked;
      },
    },
  };
}

/** Opens /bin/sh as the type's file owner in its files with a TTY; NOT_FOUND when the container is missing or stopped. */
export function startDockerTerminal(
  target: DockerExecTarget,
  containerId: string,
  sessionId: string,
  sink: TerminalShellSink,
  t: ExecutorSiteType,
): Promise<{ readonly shell: TerminalShell; readonly containerName: string }> {
  return startShell(target, containerId, sessionId, sink, siteKind(target, t));
}

/**
 * Opens /bin/sh with a TTY in the container of one component of an application (ADR-0041). The exec names no user and
 * no folder: the shell is the user the container runs as, with its capabilities, mounts and networks and no more. The
 * caller has found the container by its derived name and checked its labels; this takes the id it read there.
 */
export function startAppStackTerminal(
  target: DockerExecTarget,
  containerId: string,
  sessionId: string,
  sink: TerminalShellSink,
): Promise<{ readonly shell: TerminalShell; readonly containerName: string }> {
  return startShell(target, containerId, sessionId, sink, appStackKind(target));
}

/** Kills every marked process in the running containers with that label that still have an exec. */
async function reap(target: DockerExecTarget, label: string, listFailed: string, kind: ShellKind): Promise<void> {
  const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
  const res = await target.request("GET", `/containers/json?filters=${filters}`).catch(() => null);
  let list: Array<{ readonly Id?: unknown }> | null = null;
  try {
    if (res?.statusCode === 200) list = JSON.parse(res.body.toString("utf8")) as Array<{ readonly Id?: unknown }>;
  } catch {
    // fall through
  }
  if (!Array.isArray(list)) throw new ExecutorCodedError(listFailed, "DOCKER_ENGINE_UNAVAILABLE");
  let failure: ExecutorCodedError | null = null;
  let ownMark = 0; // nothing to clean there: counted, then logged once for the whole pass
  for (const { Id } of list) {
    if (typeof Id !== "string") continue;
    try {
      const seen = await inspect(target, Id, kind.inspectFailed);
      if (seen?.State?.Running !== true || !seen.ExecIDs?.length) continue;
      const outcome = await kind.kill(Id, "");
      if (outcome === "own_mark") ownMark += 1;
      else if (outcome === "failed") throw new ExecutorCodedError("The terminal clean-up did not finish", "INTERNAL_ERROR");
    } catch (err) {
      failure ??= err instanceof ExecutorCodedError ? err : new ExecutorCodedError("The terminal clean-up failed", "INTERNAL_ERROR");
    }
  }
  if (ownMark > 0) logOwnMark(ownMark);
  if (failure) throw failure;
}

/** At executor start: kills, as the type's file owner, every marked process in running site containers that still have an exec. */
export function reapTerminalShells(target: DockerExecTarget, t: ExecutorSiteType): Promise<void> {
  return reap(target, SITE_LABEL, "Failed to list site containers", siteKind(target, t));
}

/** At executor start: the same in the running containers of application components, as the user each one runs as. */
export function reapAppStackTerminalShells(target: DockerExecTarget): Promise<void> {
  return reap(target, APP_COMPONENT_LABEL, "Failed to list application containers", appStackKind(target));
}
