import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminAppTemplates, fetchServerAdminSiteTemplates, fetchServerMe } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TemplateCatalog } from "@/components/admin/template-catalog";

export const dynamic = "force-dynamic";

export default async function AdminTemplatesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, list, me] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSiteTemplates(), fetchServerMe()]);
  const appsOn = me?.platformCapabilities?.applicationTemplatesAvailable === true;
  const apps = appsOn ? await fetchServerAdminAppTemplates() : null;
  const appRows = apps?.ok ? apps.data : [];
  const appsOff = apps !== null && !apps.ok && apps.code === "NOT_SUPPORTED";
  const appsFailed = apps !== null && !apps.ok && !appsOff;
  const appsOffer = appsOn && !appsOff;
  const t = m.admin.templates;
  const a = m.admin.appTemplates;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
        {appsOffer ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                {t.create}
                <ChevronDown aria-hidden className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label={a.tabs.label}>
              <DropdownMenuItem asChild>
                <Link href="/admin/templates/new">{a.tabs.sites}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/admin/templates/apps/new">{a.tabs.apps}</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button asChild>
            <Link href="/admin/templates/new">{t.create}</Link>
          </Button>
        )}
      </div>
      {appsFailed && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{a.loadError}</AlertDescription>
        </Alert>
      )}
      {list === null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadError}</AlertDescription>
        </Alert>
      )}
      {(list !== null || appRows.length > 0) && <TemplateCatalog sites={list?.templates ?? []} apps={appRows} m={m} />}
      {apps?.ok && apps.page?.hasMore && <p className="text-sm text-muted-foreground">{a.more}</p>}
    </div>
  );
}
