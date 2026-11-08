import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminSites } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { SitesTable } from "@/components/admin/sites-table";
import { CreateSiteForCustomerDialog } from "@/components/admin/create-site-for-customer-dialog";

export const dynamic = "force-dynamic";

export default async function AdminSitesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, list] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSites()]);
  const t = m.admin.sites;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        {list && <CreateSiteForCustomerDialog customers={list.customers} csrfToken={session.csrfToken} />}
      </div>
      {list ? (
        <Card>
          <CardContent className="pt-6">
            <SitesTable sites={list.sites} customers={list.customers} csrfToken={session.csrfToken} />
          </CardContent>
        </Card>
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
