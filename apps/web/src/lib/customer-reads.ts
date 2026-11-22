import { cache } from "react";
import type { AppStackSummaryDto, ManagedSiteDto, OrganizationDetailDto } from "@hosting-panel/contracts";
import type { SiteLimit } from "@/components/customer/new-site";
import { fetchServerOrgAppStacks, serverGet, type ServerResult } from "@/lib/server-api";

/** A read that fails (or throws) leaves the page without its extra; a dead session still redirects. */
export async function optional<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (String((error as { digest?: unknown } | null)?.digest ?? "").startsWith("NEXT_REDIRECT")) throw error;
    return null;
  }
}

/** null = no limit, or the limit could not be read (the API refuses a site over the limit anyway). */
export const siteLimitOf = (org: OrganizationDetailDto | null): SiteLimit | null =>
  org?.maxSites == null ? null : { used: org.siteCount, max: org.maxSites };

/** The view's application stacks, read once per request (layout + /apps). Call only when appsGate(ctx) === null. */
export const getAppStacks = cache(async (orgId: string): Promise<ServerResult<AppStackSummaryDto[]>> => fetchServerOrgAppStacks(orgId));

/** Site id → main web address, for the list's address column. {} when it cannot be read: the column then shows "—". */
export async function getSiteAddresses(orgId: string): Promise<Record<string, string>> {
  const r = await serverGet<ManagedSiteDto[]>(`v1/organizations/${orgId}/managed-sites`);
  if (!r.ok || !Array.isArray(r.data)) return {};
  return Object.fromEntries(r.data.flatMap((s) => (s.primaryDomain === null ? [] : [[s.id, s.primaryDomain] as const])));
}
