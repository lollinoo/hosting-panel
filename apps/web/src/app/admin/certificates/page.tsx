import { redirect } from "next/navigation";
import { getMessages, type Messages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import {
  fetchServerAdminDnsProvider,
  fetchServerAdminSiteDomains,
  fetchServerAdminSiteTlsCertificates,
  fetchServerAdminSites,
  fetchServerAdminTlsAlerts,
  fetchServerAdminTlsCertificates,
  fetchServerMe,
} from "@/lib/server-api";
import { parseInventoryQuery } from "@/lib/tls-view";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DnsProviderForm } from "@/components/admin/dns-provider-form";
import { CertificateInventory } from "@/components/admin/certificate-inventory";
import { TlsAlerts } from "@/components/admin/tls-alerts";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/** Alerts, filters and the table; loads its own data so the DNS form below does not wait for it. */
async function InventorySection({ searchParams, csrfToken, m }: { searchParams: SearchParams; csrfToken: string; m: Messages }) {
  const { filter, q, site } = parseInventoryQuery(searchParams);
  const [items, alerts, sitesList, me] = await Promise.all([
    fetchServerAdminTlsCertificates({ filter, q }),
    fetchServerAdminTlsAlerts(),
    fetchServerAdminSites(),
    fetchServerMe(),
  ]);
  const sites = (sitesList?.sites ?? []).map((s) => ({ id: s.id, name: s.name, owner: s.owner?.name ?? null }));
  // Only a site the API listed is used: the id from the URL never reaches an upstream path unchecked.
  const siteId = site !== null && sites.some((s) => s.id === site) ? site : null;
  const [siteDomains, siteCertificates] = siteId
    ? await Promise.all([fetchServerAdminSiteDomains(siteId), fetchServerAdminSiteTlsCertificates(siteId)])
    : [null, null];
  return (
    <>
      <TlsAlerts alerts={alerts} />
      {items ? (
        <CertificateInventory
          items={items}
          sites={sites}
          siteId={siteId}
          domains={siteDomains?.domains ?? []}
          certificates={siteCertificates ?? []}
          query={{ filter, q }}
          manualAvailable={me?.platformCapabilities.manualTlsCertificatesAvailable === true}
          csrfToken={csrfToken}
          now={new Date().toISOString()}
        />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.admin.certificates.inventory.unavailable}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

export default async function AdminCertificatesPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, settings, sp] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminDnsProvider(), searchParams ?? {}]);
  const t = m.admin.certificates;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      <InventorySection searchParams={sp} csrfToken={session.csrfToken} m={m} />
      {settings ? (
        <DnsProviderForm csrfToken={session.csrfToken} initial={settings} />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
