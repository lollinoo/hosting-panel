import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminAppStacks, fetchServerAdminSites, fetchServerMe } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { CertificateAlerts } from "@/components/admin/certificate-alerts";
import { CustomerSiteLimits } from "@/components/admin/customer-site-limits";
import { SitesTable } from "@/components/admin/sites-table";
import { CreateSiteForCustomerDialog } from "@/components/admin/create-site-for-customer-dialog";

export const dynamic = "force-dynamic";

export default async function AdminSitesPage({ searchParams }: { searchParams: Promise<{ support?: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, list, { support }, me] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSites(), searchParams, fetchServerMe()]);
  const t = m.admin.sites;
  const stacksOn = me?.platformCapabilities?.applicationStacksAvailable === true;
  const stacks = stacksOn ? await fetchServerAdminAppStacks() : null;
  const stacksFailed = stacks !== null && !stacks.ok && stacks.code !== "NOT_SUPPORTED";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        {list && <CreateSiteForCustomerDialog customers={list.customers} csrfToken={session.csrfToken} />}
      </div>
      {support === "ended" && (
        <Alert role="status">
          <AlertDescription>{t.support.ended}</AlertDescription>
        </Alert>
      )}
      {list && <CertificateAlerts alerts={list.certificateAlerts} />}
      {list && <CustomerSiteLimits customers={list.customers} csrfToken={session.csrfToken} />}
      {list && stacksFailed && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.stacksLoadError}</AlertDescription>
        </Alert>
      )}
      {list ? (
        <Card>
          <CardContent className="pt-6">
            <SitesTable sites={list.sites} stacks={stacks?.ok ? stacks.data.stacks : []} customers={list.customers} csrfToken={session.csrfToken} />
          </CardContent>
        </Card>
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadError}</AlertDescription>
        </Alert>
      )}
      {list && stacks?.ok && stacks.data.truncated && <p className="text-sm text-muted-foreground">{t.stacksTruncated}</p>}
    </div>
  );
}
