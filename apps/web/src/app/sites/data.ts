import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgSite, fetchServerOrgSites, type ServerResult } from "@/lib/server-api";
import type { SiteDetailDto } from "@hosting-panel/contracts";

/**
 * Customer-only guard plus the single organization of this step (memberships[0]); cached per request.
 * A dead API session redirects to login inside fetchServerMe; `loadError` means /v1/me failed otherwise.
 */
export const getCustomerContext = cache(async () => {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword) redirect("/account/change-password");
  if (session.user.isServerAdmin || session.activeConsole === "admin") redirect("/admin/hosts");
  const me = await fetchServerMe();
  const orgId = me?.memberships[0]?.organizationId ?? null;
  return { session, orgId, loadError: me === null };
});

/** null = the list could not be loaded. */
export const getSites = cache(async (orgId: string | null) => (orgId ? fetchServerOrgSites(orgId) : []));

export const getSite = cache(
  async (orgId: string | null, siteId: string): Promise<ServerResult<SiteDetailDto>> =>
    orgId ? fetchServerOrgSite(orgId, siteId) : { ok: false, outcome: "notFound" },
);
