import { type DockerExecTarget, runDockerExec, startDockerExec } from "./docker-exec.js";
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

const SITE_LABEL = "io.hostingpanel.site_id"; // MANAGED_DOCKER_LABELS.siteId; not imported to keep this file free of the adapter

interface Inspected {
  readonly Name?: string;
  readonly State?: { readonly Running?: boolean; readonly StartedAt?: string };
  readonly ExecIDs?: readonly string[] | null;
}

/** Container inspect: null on 404; any other failure is DOCKER_ENGINE_UNAVAILABLE with a fixed sentence. */
async function inspect(target: DockerExecTarget, containerId: string): Promise<Inspected | null> {
  const res = await target.request("GET", `/containers/${encodeURIComponent(containerId)}/json`).catch(() => null);
  if (res?.statusCode === 404) return null;
  try {
    if (res?.statusCode === 200) return JSON.parse(res.body.toString("utf8")) as Inspected;
  } catch {
    // fall through
  }
  throw new ExecutorCodedError("Failed to inspect the site container", "DOCKER_ENGINE_UNAVAILABLE");
}

/** Runs the kill script as the type's file owner; sessionId "" kills every marked process. */
function runKillScript(target: DockerExecTarget, containerId: string, sessionId: string, t: ExecutorSiteType) {
  return runDockerExec(
    target,
    { container: containerId, cmd: ["/bin/sh", "-c", TERMINAL_KILL_SCRIPT, "sh", sessionId], user: t.def.files.owner },
    { timeoutMs: TERMINAL_KILL_TIMEOUT_MS, maxOutputBytes: 0 },
  );
}

/** Opens /bin/sh as the type's file owner in its files with a TTY; NOT_FOUND when the container is missing or stopped. */
export async function startDockerTerminal(
  target: DockerExecTarget,
  containerId: string,
  sessionId: string,
  sink: TerminalShellSink,
  t: ExecutorSiteType,
): Promise<{ readonly shell: TerminalShell; readonly containerName: string }> {
  const seen = await inspect(target, containerId);
  if (seen?.State?.Running !== true) throw new ExecutorCodedError("The site container is not running", "NOT_FOUND");
  const startedAt = seen.State.StartedAt;
  const { socket } = await startDockerExec(target, {
    container: containerId,
    cmd: ["/bin/sh"],
    user: t.def.files.owner,
    workingDir: t.def.files.mountPath,
    env: ["TERM=dumb", "PS1=$PWD $ ", `HP_TERMINAL_SESSION=${sessionId}`],
    tty: true,
    consoleSize: TERMINAL_CONSOLE_SIZE,
  });
  // Worked: exit 0, or the container is gone or stopped (nothing is left to kill).
  const kill = () => runKillScript(target, containerId, sessionId, t).then(
    (done) => done.exitCode === 0,
    (err: unknown) => err instanceof ExecutorCodedError && err.code === "NOT_FOUND",
  );
  let over = false; // the stream ended, or the manager asked for the end
  const ended = (): void => {
    if (over) return;
    over = true;
    // Gone, stopped or started again means the container went away; otherwise the shell itself ended.
    void new Promise((settle) => setTimeout(settle, TERMINAL_END_SETTLE_MS))
      .then(() => inspect(target, containerId))
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

/** At executor start: kills, as the type's file owner, every marked process in running site containers that still have an exec. */
export async function reapTerminalShells(target: DockerExecTarget, t: ExecutorSiteType): Promise<void> {
  const filters = encodeURIComponent(JSON.stringify({ label: [SITE_LABEL] }));
  const res = await target.request("GET", `/containers/json?filters=${filters}`).catch(() => null);
  let list: Array<{ readonly Id?: unknown }> | null = null;
  try {
    if (res?.statusCode === 200) list = JSON.parse(res.body.toString("utf8")) as Array<{ readonly Id?: unknown }>;
  } catch {
    // fall through
  }
  if (!Array.isArray(list)) throw new ExecutorCodedError("Failed to list site containers", "DOCKER_ENGINE_UNAVAILABLE");
  let failure: ExecutorCodedError | null = null;
  for (const { Id } of list) {
    if (typeof Id !== "string") continue;
    try {
      const seen = await inspect(target, Id);
      if (seen?.State?.Running !== true || !seen.ExecIDs?.length) continue;
      const done = await runKillScript(target, Id, "", t);
      if (done.exitCode !== 0) throw new ExecutorCodedError("The terminal clean-up did not finish", "INTERNAL_ERROR");
    } catch (err) {
      failure ??= err instanceof ExecutorCodedError ? err : new ExecutorCodedError("The terminal clean-up failed", "INTERNAL_ERROR");
    }
  }
  if (failure) throw failure;
}
