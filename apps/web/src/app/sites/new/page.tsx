import { redirect } from "next/navigation";
import type { OrganizationDetailDto } from "@hosting-panel/contracts";
import { NewSite } from "@/components/customer/new-site";
import { fetchServerCustomerSiteTypes, fetchServerOrg } from "@/lib/server-api";
import { getCustomerContext } from "../data";

/** A read that fails (or throws) leaves the page without its extra; a dead session still redirects. */
async function optional<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (String((error as { digest?: unknown } | null)?.digest ?? "").startsWith("NEXT_REDIRECT")) throw error;
    return null;
  }
}

/** null = no limit, or the limit could not be read (the API refuses a site over the limit anyway). */
const siteLimitOf = (org: OrganizationDetailDto | null) => (org?.maxSites == null ? null : { used: org.siteCount, max: org.maxSites });

export default async function NewSitePage() {
  const { session, orgId, support } = await getCustomerContext();
  if (!orgId) redirect("/sites");
  // A support visit lacks the customer's own permissions: the reads would be refused and audited as denied on every load.
  const [org, types] = support
    ? [null, null]
    : await Promise.all([optional(fetchServerOrg(orgId)), optional(fetchServerCustomerSiteTypes(orgId))]);
  // Either read failing never blocks creating a site: no chooser means the legacy body, and the API stays the guard.
  // A list that was read and is empty is different: nothing can be created, and the form would only fail after being filled in.
  const siteTypes = types?.siteTypes ?? [];
  return <NewSite orgId={orgId} csrfToken={session.csrfToken} siteTypes={siteTypes} limit={siteLimitOf(org)} noSiteTypes={types?.siteTypes?.length === 0} />;
}
