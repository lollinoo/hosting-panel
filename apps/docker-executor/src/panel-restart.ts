import type { PanelContainer } from "@hosting-panel/contracts";
import type { DockerExecTarget } from "./docker-exec.js";
import { ExecutorCodedError } from "./traefik-config.js";

export const PANEL_RESTART_STOP_SECONDS = {
  ingress_proxy: 5, shared_database: 5, phpmyadmin: 5, sftp: 5, // stopAndRemoveContainer stops with t=5
  mail_relay: 10, // the relay's own by-name restart uses t=10
} as const satisfies Record<PanelContainer, number>;
export const PANEL_RESTART_ENGINE_TIMEOUT_MS = 25_000;

/** 404 -> NOT_FOUND; other non-204 -> INTERNAL_ERROR; unreachable -> DOCKER_ENGINE_UNAVAILABLE (client). */
export async function restartContainerByName(
  target: Pick<DockerExecTarget, "request">,
  name: string,
  stopSeconds: number,
): Promise<{ readonly startedAt: string | null }> {
  const ref = encodeURIComponent(name);
  const res = await target.request("POST", `/containers/${ref}/restart?t=${String(stopSeconds)}`, undefined, {
    timeoutMs: PANEL_RESTART_ENGINE_TIMEOUT_MS,
  });
  if (res.statusCode === 404) throw new ExecutorCodedError("Panel container not found", "NOT_FOUND");
  if (res.statusCode !== 204) {
    throw new ExecutorCodedError(`The Docker Engine did not restart the container (HTTP ${String(res.statusCode)})`, "INTERNAL_ERROR");
  }
  // The restart happened; a failed read of its start time is only a missing time.
  const inspect = await target.request("GET", `/containers/${ref}/json`).catch(() => null);
  if (inspect?.statusCode !== 200) return { startedAt: null };
  try {
    const started = Date.parse((JSON.parse(inspect.body.toString("utf8")) as { State?: { StartedAt?: string } }).State?.StartedAt ?? "");
    return { startedAt: started > 0 ? new Date(started).toISOString() : null };
  } catch {
    return { startedAt: null };
  }
}
