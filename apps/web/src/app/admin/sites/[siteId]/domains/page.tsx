import Link from "next/link";
import { redirect } from "next/navigation";
import { LoadError } from "@/components/shared/load-error";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminSiteDomains } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function AdminSiteDomainsPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");
  const m = getMessages(await getRequestLocale());
  const initial = await fetchServerAdminSiteDomains(siteId);
  if (!initial) return <LoadError m={m} />;
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/sites" className="text-sm text-muted-foreground hover:underline">
          {m.admin.sites.domainsBack}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{format(m.admin.sites.domainsTitle, { site: initial.domains[0]?.hostname ?? "" })}</h1>
      </div>
      <DomainsPanel basePath={`/api/admin/sites/${siteId}/domains`} csrfToken={session.csrfToken} initial={initial} />
    </div>
  );
}
