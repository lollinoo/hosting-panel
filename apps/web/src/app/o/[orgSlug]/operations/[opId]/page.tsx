import Link from "next/link";
import { notFound } from "next/navigation";
import { CapabilityNotice } from "@/components/capability-notice";
import { OperationTimeline } from "@/components/timeline";
import { fetchOperationDetail } from "@/lib/bff-client";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface OperationDetailPageProps {
  readonly params: Promise<{
    readonly orgSlug: string;
    readonly opId: string;
  }>;
}

export default async function OrganizationOperationDetailPage({
  params,
}: OperationDetailPageProps) {
  const { orgSlug, opId } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);

  const opRes = await fetchOperationDetail(
    session.accessToken,
    membership.organizationId,
    opId,
  );

  if (!opRes.ok) {
    if (opRes.status === 404) {
      notFound();
    }
    return (
      <div className="space-y-4">
        <Link
          href={`/o/${orgSlug}/operations`}
          className="text-xs font-semibold text-indigo-600 hover:underline"
        >
          ← Torna al registro operazioni
        </Link>
        <CapabilityNotice
          tone="warning"
          title="Impossibile caricare il dettaglio dell'operazione"
          description={opRes.error.error.message}
        />
      </div>
    );
  }

  const op = opRes.data.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href={`/o/${orgSlug}/operations`}
            className="text-xs font-semibold text-indigo-600 hover:underline"
          >
            ← Torna al registro operazioni
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            Dettaglio Operazione &amp; Timeline Passi
          </h1>
        </div>

        {op.resourceType === "application" && (
          <Link
            href={`/o/${orgSlug}/applications/${op.resourceId}`}
            className="rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            Vai all&apos;applicazione associata
          </Link>
        )}
      </div>

      <OperationTimeline operation={op} />
    </div>
  );
}
