import { LoadError } from "@/components/shared/load-error";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerSiteDomains } from "@/lib/server-api";
import { getCustomerContext, getSite } from "../../data";

export default async function SiteDomainsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const { orgId, session } = await getCustomerContext();
  const result = await getSite(orgId, siteId);
  if (!result.ok || !orgId) return null; // the layout shows the 404 or the load error
  const initial = await fetchServerSiteDomains(orgId, result.data.id);
  if (!initial) return <LoadError m={getMessages(await getRequestLocale())} />;
  return (
    <DomainsPanel
      basePath={`/api/bff/orgs/${orgId}/managed-sites/${result.data.id}/domains`}
      csrfToken={session.csrfToken}
      initial={initial}
    />
  );
}
