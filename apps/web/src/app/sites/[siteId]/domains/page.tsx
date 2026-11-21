import { LoadError } from "@/components/shared/load-error";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerSiteDomains, fetchServerSiteTlsCertificates } from "@/lib/server-api";
import { getCustomerContext, getSite } from "../../data";

export default async function SiteDomainsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const { orgId, session, capabilities } = await getCustomerContext();
  const result = await getSite(orgId, siteId);
  if (!result.ok || !orgId) return null; // the layout shows the 404 or the load error
  const [initial, certificates] = await Promise.all([
    fetchServerSiteDomains(orgId, result.data.id),
    fetchServerSiteTlsCertificates(orgId, result.data.id),
  ]);
  if (!initial) return <LoadError m={getMessages(await getRequestLocale())} />;
  return (
    <DomainsPanel
      basePath={`/api/bff/orgs/${orgId}/managed-sites/${result.data.id}/domains`}
      csrfToken={session.csrfToken}
      initial={initial}
      // A failed certificate read, or a server without the feature, leaves the panel as it was.
      tls={{ certificates, manualAvailable: certificates !== null && capabilities?.manualTlsCertificatesAvailable === true }}
    />
  );
}
