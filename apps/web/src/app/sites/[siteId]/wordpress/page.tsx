import { isWordpressSite, SiteWordpressImportDtoSchema, type SiteWordpressDto } from "@hosting-panel/contracts";
import { notFound } from "next/navigation";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { SiteWordpress } from "@/components/customer/site-wordpress";
import { WordpressImportCard } from "@/components/customer/wordpress-import-card";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { serverGet } from "@/lib/server-api";

// Render the customer site WordPress tab from the stored details loaded server-side.
export default async function SiteWordpressPage({ params }: { params: Promise<{ siteId: string }> }) {
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
  // The read route answers 200 with an empty state when the tools are off, so the flag decides here.
  if (capabilities?.wordpressToolsAvailable !== true) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">{t.title}</h2>
        <Alert>
          <AlertDescription>{t.notAvailable}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const sitePath = `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}`;
  const [res, importRes] = await Promise.all([
    serverGet<SiteWordpressDto>(`${sitePath}/wordpress`, { timeoutMs: 20_000 }),
    serverGet<unknown>(`${sitePath}/wordpress/import`, { timeoutMs: 20_000 }),
  ]);
  // A failed import load only leaves the card out; the tab still works.
  const parsedImport = importRes.ok ? SiteWordpressImportDtoSchema.safeParse(importRes.data) : null;
  const importState = parsedImport?.success && parsedImport.data.available ? parsedImport.data : null;
  const importBase = `/api/bff/orgs/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/wordpress/import`;
  const card = importState && (
    <WordpressImportCard
      basePath={importBase}
      importHref={`/sites/${encodeURIComponent(siteId)}/wordpress/import`}
      initial={importState}
    />
  );
  // While an import runs only the card is shown, so the tab never checks a locked site.
  if (importState?.runningOperation) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">{t.title}</h2>
        {card}
      </div>
    );
  }

  if (!res.ok) {
    if (res.outcome === "notFound") notFound();
    let message: string | null = null;
    if (res.status === 403 && res.code === "ORGANIZATION_SUSPENDED") message = t.errors.suspended;
    else if (res.status === 403) message = errorMessage(m, "PERMISSION_DENIED");
    else if (res.status === 502 || res.status === 503 || res.status === 504) message = t.loadFailed;
    if (!message) return <LoadError m={m} />;
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">{t.title}</h2>
        <Alert variant={(res.status ?? 0) >= 500 ? "destructive" : "default"}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const basePath = `/api/bff/orgs/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/wordpress`;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t.title}</h2>
      {card}
      <SiteWordpress basePath={basePath} initial={res.data} csrfToken={session.csrfToken} />
    </div>
  );
}
