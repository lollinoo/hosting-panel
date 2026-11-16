import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgSite, fetchServerOrgSites, type ServerResult } from "@/lib/server-api";
import type { MeDto, SiteDetailDto } from "@hosting-panel/contracts";

/** The organisation the view loads: the visit's for an administrator, memberships[0] for a customer. */
export function viewOrgId(me: MeDto, isAdmin: boolean): string | null {
  return isAdmin ? (me.supportAccess?.organizationId ?? null) : (me.memberships[0]?.organizationId ?? null);
}

/**
 * Guard plus the organization of the view; cached per request. A customer gets memberships[0];
 * a server administrator gets the support visit's organization from /v1/me, or goes back to /admin/sites.
 * A dead API session redirects to login inside fetchServerMe; `loadError` means /v1/me failed otherwise.
 */
export const getCustomerContext = cache(async () => {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword) redirect("/account/change-password");
  // The cookie only picks the branch; the API decides every call.
  const isAdmin = session.user.isServerAdmin || session.activeConsole === "admin";
  const me = await fetchServerMe();
  if (isAdmin && me && !me.supportAccess) redirect("/admin/sites?support=ended");
  return {
    session,
    orgId: me ? viewOrgId(me, isAdmin) : null,
    loadError: me === null,
    capabilities: me?.platformCapabilities ?? null,
    support: isAdmin ? (me?.supportAccess ?? null) : null,
  };
});

/** null = the list could not be loaded. */
export const getSites = cache(async (orgId: string | null) => (orgId ? fetchServerOrgSites(orgId) : []));

export const getSite = cache(
  async (orgId: string | null, siteId: string): Promise<ServerResult<SiteDetailDto>> =>
    orgId ? fetchServerOrgSite(orgId, siteId) : { ok: false, outcome: "notFound" },
);
