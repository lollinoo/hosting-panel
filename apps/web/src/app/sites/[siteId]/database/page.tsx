import { notFound } from "next/navigation";
import type { SiteDatabasesDto } from "@hosting-panel/contracts";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { SiteDatabases } from "@/components/customer/site-databases";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { serverGet } from "@/lib/server-api";

export async function SiteDatabasePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const [{ orgId, session, loadError }, locale] = await Promise.all([
    getCustomerContext(),
    getRequestLocale(),
  ]);
  const m = getMessages(locale);

  const siteRes = await getSite(orgId, siteId);
  if (!siteRes.ok) {
    if (siteRes.outcome === "notFound") notFound();
    return <LoadError m={m} />;
  }
  if (loadError || !orgId || !session) {
    return <LoadError m={m} />;
  }

  const dbRes = await serverGet<SiteDatabasesDto>(
    `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/databases`,
    { timeoutMs: 20_000 }
  );

  if (!dbRes.ok) {
    if (dbRes.outcome === "notFound") notFound();

    let message: string | null = null;
    if (dbRes.status === 403 && dbRes.code === "ORGANIZATION_SUSPENDED") {
      message = m.site.database.errors.ORGANIZATION_SUSPENDED;
    } else if (dbRes.status === 403) {
      message = errorMessage(m, "PERMISSION_DENIED");
    } else if (dbRes.status === 422) {
      message = m.site.database.unavailable;
    } else if (dbRes.status === 502 || dbRes.status === 503 || dbRes.status === 504) {
      message = m.site.database.loadFailed;
    }

    if (!message) {
      return <LoadError m={m} />;
    }

    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">{m.site.database.title}</h2>
        <Alert variant={(dbRes.status ?? 0) >= 500 ? "destructive" : "default"}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const basePath = `/api/bff/orgs/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}`;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{m.site.database.title}</h2>
      <SiteDatabases
        orgId={orgId}
        siteId={siteId}
        basePath={basePath}
        initial={dbRes.data}
        csrfToken={session.csrfToken}
      />
    </div>
  );
}

export default SiteDatabasePage;
