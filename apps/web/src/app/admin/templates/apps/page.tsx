import Link from "next/link";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminAppTemplates } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AppTemplateList } from "@/components/admin/app-template-list";

export const dynamic = "force-dynamic";

export default async function AdminAppTemplatesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, r] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminAppTemplates()]);
  const t = m.admin.appTemplates;
  const off = !r.ok && r.code === "NOT_SUPPORTED";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        {!off && (
          <Button asChild>
            <Link href="/admin/templates/apps/new">{t.create}</Link>
          </Button>
        )}
      </div>
      {r.ok ? (
        <>
          <AppTemplateList templates={r.data} m={m} />
          {r.page?.hasMore && <p className="text-sm text-muted-foreground">{t.more}</p>}
        </>
      ) : off ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{t.notAvailable}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
