import type { SiteSummaryDto } from "@hosting-panel/contracts";

export const LAST_SITE_COOKIE = "hp_last_site";

export function pickLandingSite(sites: SiteSummaryDto[], lastSiteId: string | undefined): string | null {
  return sites.find((s) => s.id === lastSiteId)?.id ?? sites[0]?.id ?? null;
}
