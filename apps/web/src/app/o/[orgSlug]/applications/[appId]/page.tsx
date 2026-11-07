import Link from "next/link";
import { notFound } from "next/navigation";
import { AppDetailView } from "@/components/app-detail-view";
import { CapabilityNotice } from "@/components/capability-notice";
import { fetchApplicationDetail, fetchDomains } from "@/lib/bff-client";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface ApplicationDetailPageProps {
  readonly params: Promise<{
    readonly orgSlug: string;
    readonly appId: string;
  }>;
}

export default async function OrganizationApplicationDetailPage({
  params,
}: ApplicationDetailPageProps) {
  const { orgSlug, appId } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);
  const orgId = membership.organizationId;

  const [appRes, domainsRes] = await Promise.all([
    fetchApplicationDetail(session.accessToken, orgId, appId),
    fetchDomains(session.accessToken, orgId),
  ]);

  if (!appRes.ok) {
    if (appRes.status === 404) {
      notFound();
    }
    return (
      <div className="space-y-4">
        <Link
          href={`/o/${orgSlug}/applications`}
          className="text-xs font-semibold text-indigo-600 hover:underline"
        >
          ← Torna alle applicazioni
        </Link>
        <CapabilityNotice
          tone="warning"
          title="Impossibile visualizzare il dettaglio dell'applicazione"
          description={appRes.error.error.message}
        />
      </div>
    );
  }

  const appDomains = domainsRes.ok
    ? domainsRes.data.data.filter((d) => d.applicationId === appRes.data.data.id)
    : [];

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/o/${orgSlug}/applications`}
          className="text-xs font-semibold text-indigo-600 hover:underline"
        >
          ← Torna all&apos;elenco applicazioni
        </Link>
      </div>

      <AppDetailView
        orgId={orgId}
        orgSlug={orgSlug}
        organizationStatus={membership.organizationStatus}
        application={appRes.data.data}
        meta={appRes.data.meta}
        domains={appDomains}
        csrfToken={session.csrfToken}
      />
    </div>
  );
}
