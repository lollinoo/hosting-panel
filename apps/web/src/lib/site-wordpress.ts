import {
  WORDPRESS_STATE_STALE_MS,
  type SiteWordpressDto,
  type SiteWordpressLastUpdateDto,
  type SiteWordpressStateDto,
  type WordpressProblem,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";

type PluginStatus = SiteWordpressStateDto["plugins"][number]["status"];
type ThemeStatus = SiteWordpressStateDto["themes"][number]["status"];
export type WordpressStatusKey = keyof Messages["site"]["wordpress"]["status"];
export type WordpressStateProblemKey = keyof Messages["site"]["wordpress"]["problem"];
export type WordpressOutcomeKey = Exclude<
  keyof Messages["site"]["wordpress"]["outcome"],
  "title" | "finishedAt" | "backupTaken" | "backupSkipped" | "item" | "before" | "after" | "result" | "updated" | "notUpdated" | "type"
>;
export type WordpressOverviewKey =
  | "wordpressLoadFailed"
  | "wordpressRunning"
  | "wordpressNotChecked"
  | "wordpressProblem"
  | "wordpressUnknown"
  | "wordpressUpToDate"
  | "wordpressCount";

/** Pending updates: WordPress itself plus each plugin and theme with a new version. */
export function pendingWordpressUpdates(state: SiteWordpressStateDto): number {
  return (
    (state.coreUpdate !== null ? 1 : 0) +
    state.plugins.filter((p) => p.updateVersion !== null).length +
    state.themes.filter((t) => t.updateVersion !== null).length
  );
}

/** True when the tab should start one check: nothing running and no state or a stale one. */
export function wordpressNeedsCheck(dto: SiteWordpressDto, now: number): boolean {
  if (dto.runningOperation !== null) return false;
  if (dto.state === null) return true;
  const at = Date.parse(dto.state.checkedAt);
  return Number.isNaN(at) || now - at >= WORDPRESS_STATE_STALE_MS;
}

/** Catalog key of a plugin or theme status; keeps the raw hyphenated values out of the page. */
export function wordpressStatusKey(status: PluginStatus | ThemeStatus): WordpressStatusKey {
  switch (status) {
    case "active-network":
      return "activeNetwork";
    case "must-use":
      return "mustUse";
    default:
      return status;
  }
}

/** Catalog key of the sentence for a site that could not be read. */
export function wordpressStateProblemKey(problem: WordpressProblem): WordpressStateProblemKey {
  switch (problem) {
    case "config_broken":
      return "configBroken";
    case "database_unreachable":
      return "databaseUnreachable";
    case "not_installed":
      return "notInstalled";
    default:
      return "other";
  }
}

/** Catalog key of the outcome sentence of the last update. */
export function wordpressOutcomeKey(last: SiteWordpressLastUpdateDto): WordpressOutcomeKey {
  if (last.status === "succeeded") return last.items.length === 0 ? "nothingToDo" : "succeeded";
  switch (last.problem) {
    case "wordpress_org_unreachable":
      return "orgUnreachable";
    case "config_broken":
      return "configBroken";
    case "database_unreachable":
      return "databaseUnreachable";
    case "not_installed":
      return "notInstalled";
    case "backup_failed":
      return "backupFailed";
    case "items_failed":
      return "itemsFailed";
    case "item_unknown":
      return "itemUnknown";
    case "interrupted":
      return "interrupted";
    case "outcome_unknown":
      return "outcomeUnknown";
    default:
      return "failed";
  }
}

/** Overview card sentence; null = the details could not be loaded. */
export function wordpressOverviewKey(dto: SiteWordpressDto | null): WordpressOverviewKey {
  if (dto === null) return "wordpressLoadFailed";
  if (dto.runningOperation?.kind === "site.wordpress.update") return "wordpressRunning";
  if (dto.state === null) return "wordpressNotChecked";
  if (dto.state.problem !== null) return "wordpressProblem";
  if (!dto.state.updatesKnown) return "wordpressUnknown";
  return pendingWordpressUpdates(dto.state) === 0 ? "wordpressUpToDate" : "wordpressCount";
}
