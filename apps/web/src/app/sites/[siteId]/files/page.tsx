import { Suspense } from "react";
import { getCustomerContext, getSite } from "@/app/sites/data";
import { FilesNotReady, FilesPanel } from "@/components/customer/files-panel";

export default async function SiteFilesPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const { session, orgId } = await getCustomerContext();
  if (!session || !orgId) return null;

  const result = await getSite(orgId, siteId);
  if (!result.ok) return null;

  if (result.data.status === "deploying") {
    return <FilesNotReady />;
  }

  return (
    <Suspense>
      <FilesPanel
        apiBase={`/api/bff/orgs/${orgId}/managed-sites/${result.data.id}`}
        orgId={orgId}
        siteId={result.data.id}
        csrfToken={session.csrfToken}
      />
    </Suspense>
  );
}
