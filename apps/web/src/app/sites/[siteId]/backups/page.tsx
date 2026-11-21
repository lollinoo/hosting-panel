import type { SiteBackupPolicyDto, SiteBackupsDto } from "@hosting-panel/contracts";
import { notFound } from "next/navigation";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { SiteBackups } from "@/components/customer/site-backups";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { errorMessage, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerSiteBackupPolicy, serverGet } from "@/lib/server-api";

// The destination chooser is optional: any failure to read the policy simply hides it.
async function loadPolicy(orgId: string, siteId: string): Promise<SiteBackupPolicyDto | null> {
  try {
    return await fetchServerSiteBackupPolicy(orgId, siteId);
  } catch {
    return null;
  }
}

// Render the customer site Backups tab by loading site ownership and backup state server-side.
export async function SiteBackupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ siteId }, resolvedSearch, { orgId, session, loadError }, locale] = await Promise.all([
    params,
    searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>),
    getCustomerContext(),
    getRequestLocale(),
  ]);
  const m = getMessages(locale);

  const rawDownload = Array.isArray(resolvedSearch.download)
    ? resolvedSearch.download[0]
    : resolvedSearch.download;
  const initialDownloadError =
    rawDownload === "gone" ? "gone" : rawDownload === "failed" ? "failed" : null;

  const siteRes = await getSite(orgId, siteId);
  if (!siteRes.ok) {
    if (siteRes.outcome === "notFound") notFound();
    return <LoadError m={m} />;
  }
  if (loadError || !orgId || !session) {
    return <LoadError m={m} />;
  }

  // Started first so the backups read stays the page's main (and last) request.
  const policyPromise = loadPolicy(orgId, siteId);
  const backupsRes = await serverGet<SiteBackupsDto>(
    `v1/organizations/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/backups`,
    { timeoutMs: 20_000 },
  );

  if (!backupsRes.ok) {
    if (backupsRes.outcome === "notFound") notFound();

    let message: string | null = null;
    if (backupsRes.status === 403 && backupsRes.code === "ORGANIZATION_SUSPENDED") {
      message = m.site.backups.errors.ORGANIZATION_SUSPENDED;
    } else if (backupsRes.status === 403) {
      message = errorMessage(m, "PERMISSION_DENIED");
    } else if (backupsRes.status === 422) {
      message = m.site.backups.notAvailable;
    } else if (backupsRes.status === 502 || backupsRes.status === 503 || backupsRes.status === 504) {
      message = m.site.backups.loadFailed;
    }

    if (!message) {
      return <LoadError m={m} />;
    }

    return (
      <div className="space-y-4">
        <h2 className="text-lg font-medium">{m.site.backups.title}</h2>
        <Alert variant={(backupsRes.status ?? 0) >= 500 ? "destructive" : "default"}>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </div>
    );
  }


  const policy = await policyPromise;
  const basePath = `/api/bff/orgs/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}/backups`;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{m.site.backups.title}</h2>
      <SiteBackups
        basePath={basePath}
        initial={backupsRes.data}
        csrfToken={session.csrfToken}
        siteName={siteRes.data.name}
        initialDownloadError={initialDownloadError}
        policy={policy}
      />
    </div>
  );
}

export default SiteBackupsPage;
