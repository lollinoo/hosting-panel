import {
  PANEL_CONTAINERS,
  isTerminalOperationStatus,
  type AdminHealthDto,
  type HostService,
  type PanelContainer,
} from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";

type PartRow = AdminHealthDto["components"][number];
type SiteRow = AdminHealthDto["siteContainers"][number];

export type RestartTarget =
  | { kind: "part"; component: PanelContainer }
  | { kind: "site"; siteId: string; siteName: string; desired: SiteRow["desired"] }
  | { kind: "service"; service: HostService };

export const RESTART_POLL_MS = 2000;
export const RESTART_FOLLOW_MS = 180_000;

/** A panel container that is in use and has a container to restart. */
export function canRestartPart(c: PartRow): c is PartRow & { component: PanelContainer } {
  return (PANEL_CONTAINERS as readonly string[]).includes(c.component)
    && c.state !== "not_in_use" && c.reason !== "missing" && c.reason !== "runtime_disabled";
}

/** A terminal needs a running container. */
export function canOpenTerminal(observed: SiteRow["observed"]): boolean {
  return observed === "running" || observed === "degraded";
}

/** The BFF route that restarts the target. */
export function restartUrl(target: RestartTarget): string {
  if (target.kind === "service") return `/api/admin/host-services/${target.service}/restart`;
  return target.kind === "part"
    ? `/api/admin/panel-containers/${target.component}/restart`
    : `/api/admin/sites/${target.siteId}/restart`;
}

/** The target's name as the page shows it. */
export function restartName(m: Messages, target: RestartTarget): string {
  if (target.kind === "service") return m.admin.health.components[target.service];
  return target.kind === "part" ? m.admin.health.components[target.component] : target.siteName;
}

/** What the restart interrupts; a site its owner stopped also learns it starts again. */
export function restartWarning(m: Messages, target: RestartTarget): string {
  const w = m.admin.health.restart.warn;
  if (target.kind === "part") return w[target.component];
  if (target.kind === "service") return w[target.service];
  const name = { name: target.siteName };
  const base = format(w.site, name);
  return target.desired === "stopped" ? `${base} ${format(w.siteStopped, name)}` : base;
}

/** The sentence for a refused restart. */
export function restartErrorText(m: Messages, name: string, code: string, reason?: string): string {
  const r = m.admin.health.restart;
  switch (code) {
    case "VALIDATION_ERROR": return r.reasonRequired;
    case "NOT_FOUND": return format(r.notFound, { name });
    case "RESOURCE_LOCKED":
      return reason === "site_work_running" ? r.siteWork : reason === "host_job_running" ? r.hostJob : format(r.locked, { name });
    case "PANEL_CONTAINER_ABSENT": return format(r.absent, { name });
    default: return errorMessage(m, code);
  }
}

/** Polls the operation until it ends; a failed read is retried until the deadline, `followMs` from now; a 401 (the session ended) stops it. */
export async function followRestart(
  operationId: string,
  deps: { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number } = {
    fetch: (...a) => fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  },
  followMs = RESTART_FOLLOW_MS,
): Promise<"succeeded" | "failed" | "unknown" | "signedOut"> {
  const deadline = deps.now() + followMs;
  while (deps.now() < deadline) {
    await deps.sleep(RESTART_POLL_MS);
    try {
      const res = await deps.fetch(`/api/admin/operations/${operationId}`, { cache: "no-store" });
      if (res.status === 401) return "signedOut";
      const status = res.ok ? (await res.json())?.data?.status : null;
      if (status && isTerminalOperationStatus(status)) return status === "succeeded" ? "succeeded" : "failed";
    } catch {
      // keep trying until the deadline: the restart itself may cut this page's connection
    }
  }
  return "unknown";
}
