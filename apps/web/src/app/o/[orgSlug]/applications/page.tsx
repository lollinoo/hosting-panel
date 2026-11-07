import { Lock } from "lucide-react";
import Link from "next/link";
import { HealthStatusBadge, ResourceStatusBadge } from "@/components/badges";
import { CapabilityNotice } from "@/components/capability-notice";
import { FreshnessIndicator } from "@/components/freshness";
import { fetchApplications } from "@/lib/bff-client";
import { formatDateTimeIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface ApplicationsPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationApplicationsPage({
  params,
}: ApplicationsPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);

  const appsRes = await fetchApplications(
    session.accessToken,
    membership.organizationId,
  );

  if (!appsRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Applicazioni</h1>
        <CapabilityNotice
          tone="warning"
          title="Elenco applicazioni non accessibile"
          description={appsRes.error.error.message}
        />
      </div>
    );
  }

  const apps = appsRes.data.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Applicazioni</h1>
          <p className="mt-1 text-sm text-slate-600">
            Applicazioni autorizzate per il tuo profilo nell&apos;organizzazione{" "}
            <strong>{membership.organizationName}</strong> (filtrate secondo policy RBAC e
            ResourceGrant).
          </p>
        </div>
        <FreshnessIndicator
          observedAt={appsRes.data.meta?.observedAt}
          stale={appsRes.data.meta?.stale}
          source={appsRes.data.meta?.source}
        />
      </div>

      {apps.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessuna applicazione disponibile o autorizzata per questo account.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Applicazione</th>
                  <th className="px-4 py-3">Ambiente</th>
                  <th className="px-4 py-3">Stato &amp; Salute</th>
                  <th className="px-4 py-3">Dominio Primario</th>
                  <th className="px-4 py-3">Ultimo Deploy</th>
                  <th className="px-4 py-3 text-right">Dettaglio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {apps.map((app) => (
                  <tr key={app.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/o/${orgSlug}/applications/${app.id}`}
                          className="font-semibold text-slate-900 hover:text-indigo-600"
                        >
                          {app.name}
                        </Link>
                        {app.lockedByOperationId && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                            <Lock className="h-3 w-3" aria-hidden="true" />
                            Operazione in corso
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500">{app.slug}</p>
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                        {app.environment}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ResourceStatusBadge status={app.status} />
                        <HealthStatusBadge health={app.health} />
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-700">
                      {app.primaryDomain ?? "—"}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-600">
                      {formatDateTimeIt(app.lastDeployedAt)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <Link
                        href={`/o/${orgSlug}/applications/${app.id}`}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                      >
                        Apri scheda
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
