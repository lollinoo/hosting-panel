import { isWordpressSite } from "@hosting-panel/contracts";
import { notFound } from "next/navigation";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { WordpressImport } from "@/components/customer/wordpress-import";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { serverGet } from "@/lib/server-api";

// Render the WordPress import wizard, rebuilt on every load from the stored import state.
export default async function SiteWordpressImportPage({ params }: { params: Promise<{ siteId: string }> }) {
  const [{ siteId }, { orgId, session, loadError, capabilities }, locale] = await Promise.all([
    params,
    getCustomerContext(),
    getRequestLocale(),
  ]);
  const m = getMessages(locale);
  const t = m.site.wordpress;

  const siteRes = await getSite(orgId, siteId);
  if (!siteRes.ok) {
    if (siteRes.outcome === "notFound") notFound();
    return <LoadError m={m} />;
  }
  if (!isWordpressSite(siteRes.data)) notFound();
  if (loadError || !orgId || !session) return <LoadError m={m} />;

  const notice = (message: string, destructive = false) => (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t.import.title}</h2>
      <Alert variant={destructive ? "destructive" : "default"}>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
  if (capabilities?.wordpressToolsAvailable !== true) return notice(t.notAvailable);

  const sitePath = `${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}`;
  const res = await serverGet<unknown>(`v1/organizations/${sitePath}/wordpress/import`, { timeoutMs: 20_000 });

  if (!res.ok) {
    if (res.outcome === "notFound") notFound();
    if (res.status === 403 && res.code === "ORGANIZATION_SUSPENDED") return notice(t.errors.suspended);
    if (res.status === 403) return notice(errorMessage(m, "PERMISSION_DENIED"));
    if (res.status === 502 || res.status === 503 || res.status === 504) return notice(t.import.loadFailed, true);
    return <LoadError m={m} />;
  }

  return (
    <WordpressImport
      basePath={`/api/bff/orgs/${sitePath}/wordpress/import`}
      initial={res.data}
      siteName={siteRes.data.name}
      csrfToken={session.csrfToken}
      backupsHref={`/sites/${encodeURIComponent(siteId)}/backups`}
    />
  );
}
