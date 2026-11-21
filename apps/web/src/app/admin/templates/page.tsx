import Link from "next/link";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminSiteTemplates } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SiteTemplateList } from "@/components/admin/site-template-list";

export const dynamic = "force-dynamic";

export default async function AdminTemplatesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, list] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSiteTemplates()]);
  const t = m.admin.templates;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        <Button asChild>
          <Link href="/admin/templates/new">{t.create}</Link>
        </Button>
      </div>
      {list ? (
        <SiteTemplateList templates={list.templates} m={m} />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
