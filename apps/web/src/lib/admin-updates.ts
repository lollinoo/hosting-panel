import type { OsPackagesDto, UpdatesDto } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";

/** How long a server job is followed: a panel update or a package install can take many minutes. */
export const JOB_FOLLOW_MS = 30 * 60_000;

/** Update is offered only when a newer release was found and no update runs. */
export function canUpdatePanel(u: UpdatesDto): boolean {
  return u.panel.check.state === "newer" && !u.panel.running;
}

type Pkg = OsPackagesDto["packages"][number];

/** The packages the panel lists (security and distribution), the ones left to SSH, and the security ones. */
export function packageGroups(p: OsPackagesDto): { main: Pkg[]; other: Pkg[]; security: Pkg[] } {
  return {
    main: p.packages.filter((x) => x.origin !== "other"),
    other: p.packages.filter((x) => x.origin === "other"),
    security: p.packages.filter((x) => x.origin === "security"),
  };
}

/** The sentence for a refused update or package job; never the server's own text. */
export function updatesErrorText(m: Messages, code: string, reason?: string): string {
  const e = m.admin.updates.errors;
  switch (code) {
    case "RESOURCE_LOCKED":
      return reason === "host_job_running" ? m.admin.updates.panel.locked : reason === "site_work_running" ? e.siteWork : e.busy;
    case "VALIDATION_ERROR":
      return reason === "already_current" ? e.alreadyCurrent : reason === "stopped" ? e.stopped : e.other;
    case "PANEL_CONTAINER_ABSENT": return e.absent;
    case "NOT_SUPPORTED": return e.notSupported;
    case "NOT_FOUND": return e.notFound;
    case "HOST_AGENT_UNAVAILABLE": return e.agentDown;
    case "UNAUTHENTICATED": return e.session;
    // A 5xx of the API, the BFF's 502/504 and a lost connection: whether it happened is unknown.
    case "INTERNAL_ERROR": case "OPERATION_AMBIGUOUS": case "": return e.noAnswer;
    default: return e.other;
  }
}
