import { redirect } from "next/navigation";
import { NewSite } from "@/components/customer/new-site";
import { optional, siteLimitOf } from "@/lib/customer-reads";
import { fetchServerCustomerSiteTypes, fetchServerOrg } from "@/lib/server-api";
import { getCustomerContext } from "../data";

export default async function NewSitePage({ searchParams }: { searchParams?: Promise<{ type?: string | string[] }> } = {}) {
  const { session, orgId, support } = await getCustomerContext();
  if (!orgId) redirect("/apps");
  // A support visit lacks the customer's own permissions: the reads would be refused and audited as denied on every load.
  const [org, types] = support
    ? [null, null]
    : await Promise.all([optional(fetchServerOrg(orgId)), optional(fetchServerCustomerSiteTypes(orgId))]);
  // Either read failing never blocks creating a site: no chooser means the legacy body, and the API stays the guard.
  // A list that was read and is empty is different: nothing can be created, and the form would only fail after being filled in.
  const siteTypes = types?.siteTypes ?? [];
  // The chooser's pick only selects among the types read above; it is never sent upstream by the page.
  const type = (await searchParams)?.type;
  return (
    <NewSite
      orgId={orgId}
      csrfToken={session.csrfToken}
      siteTypes={siteTypes}
      limit={siteLimitOf(org)}
      noSiteTypes={types?.siteTypes?.length === 0}
      initialTypeId={typeof type === "string" ? type : null}
    />
  );
}
