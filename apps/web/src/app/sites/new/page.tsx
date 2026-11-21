import { redirect } from "next/navigation";
import type { OrganizationDetailDto } from "@hosting-panel/contracts";
import { NewSite } from "@/components/customer/new-site";
import { fetchServerOrg } from "@/lib/server-api";
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
  const { session, orgId } = await getCustomerContext();
  if (!orgId) redirect("/sites");
  const limit = siteLimitOf(await optional(fetchServerOrg(orgId)));
  return <NewSite orgId={orgId} csrfToken={session.csrfToken} limit={limit} />;
}
