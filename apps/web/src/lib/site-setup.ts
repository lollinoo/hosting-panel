import type { OperationStatus, SiteStatus } from "@hosting-panel/contracts";
import { isTerminalOperationStatus } from "@hosting-panel/contracts";

/** The setup card is for the site.provision operation only; restarts and PHP changes report through the Manage card. */
export function showSetupProgress(site: SiteStatus, provision: OperationStatus | undefined): boolean {
  if (!provision) return false;
  if (!isTerminalOperationStatus(provision)) return true;
  return site === "degraded" && provision === "failed";
}

/** A rejected request (4xx) is gone for good; after a 5xx or a lost reply the same key must be reused so a retry replays. */
export const renewKeyAfter = (status: number): boolean => status >= 400 && status < 500;
