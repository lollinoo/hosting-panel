import Link from "next/link";
import { OperationStatusBadge } from "@/components/badges";
import { CapabilityNotice } from "@/components/capability-notice";
import { fetchOperations } from "@/lib/bff-client";
import { formatDateTimeIt, formatOperationKindIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface OperationsPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationOperationsPage({
  params,
}: OperationsPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);

  const opsRes = await fetchOperations(
    session.accessToken,
    membership.organizationId,
  );

  if (!opsRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Registro Operazioni</h1>
        <CapabilityNotice
          tone="warning"
          title="Registro operazioni non accessibile"
          description={opsRes.error.error.message}
        />
      </div>
    );
  }

  const operations = opsRes.data.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Registro Operazioni Asincrone
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Tracciamento completo a 8 stati delle mutazioni inviate al motore di esecuzione
          tramite Outbox transazionale.
        </p>
      </div>

      {operations.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessuna operazione registrata finora per questa organizzazione.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Operazione</th>
                  <th className="px-4 py-3">Risorsa</th>
                  <th className="px-4 py-3">Stato Verificato</th>
                  <th className="px-4 py-3">Inviata il</th>
                  <th className="px-4 py-3">Conclusa il</th>
                  <th className="px-4 py-3 text-right">Timeline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {operations.map((op) => (
                  <tr key={op.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-slate-900">
                        {formatOperationKindIt(op.kind)}
                      </p>
                      <code className="text-xs text-slate-500">{op.id}</code>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-700">
                      <span className="uppercase">{op.resourceType}</span> ·{" "}
                      <code>{op.resourceId}</code>
                    </td>
                    <td className="px-4 py-3.5">
                      <OperationStatusBadge status={op.status} />
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-600">
                      {formatDateTimeIt(op.submittedAt)}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-600">
                      {op.completedAt ? formatDateTimeIt(op.completedAt) : "In corso"}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Link
                        href={`/o/${orgSlug}/operations/${op.id}`}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                      >
                        Dettaglio passi
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
