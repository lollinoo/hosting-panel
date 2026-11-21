import Link from "next/link";
import { redirect } from "next/navigation";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminDnsProvider, fetchServerAdminSiteDomains, fetchServerAdminSiteTlsCertificates, fetchServerMe } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

/** The imported-certificate extras never block the page: any failure reads as "feature off". */
const optional = <T,>(load: () => Promise<T | null>): Promise<T | null> => Promise.resolve().then(load).catch(() => null);

export default async function AdminSiteDomainsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");
  const m = getMessages(await getRequestLocale());
  const [initial, dns, certificates, me] = await Promise.all([
    fetchServerAdminSiteDomains(siteId),
    fetchServerAdminDnsProvider(),
    optional(() => fetchServerAdminSiteTlsCertificates(siteId)),
    optional(() => fetchServerMe()),
  ]);
  if (!initial) return <LoadError m={m} />;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/sites" className="text-sm text-muted-foreground hover:underline">
          {m.admin.sites.domainsBack}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{format(m.admin.sites.domainsTitle, { site: initial.domains[0]?.hostname ?? "" })}</h1>
      </div>
      {/* null = the provider read failed, not "no provider": keep dns-01 open, the API refuses it if none is set. */}
      {!dns && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
      <DomainsPanel
        basePath={`/api/admin/sites/${siteId}/domains`}
        csrfToken={session.csrfToken}
        initial={initial}
        challenge={{ dnsAvailable: !dns || dns.provider !== null }}
        tls={{ certificates, manualAvailable: certificates !== null && me?.platformCapabilities?.manualTlsCertificatesAvailable === true }}
      />
    </div>
  );
}
