import { Database } from "lucide-react";
import { HealthStatusBadge, ResourceStatusBadge } from "@/components/badges";
import { CapabilityNotice } from "@/components/capability-notice";
import { FreshnessIndicator } from "@/components/freshness";
import { fetchDatabaseDetail, fetchDatabases } from "@/lib/bff-client";
import {
  formatDatabaseBackupUnsupportedIt,
  formatDatabaseEngineIt,
  formatDateTimeIt,
} from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface DatabasesPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationDatabasesPage({
  params,
}: DatabasesPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);
  const orgId = membership.organizationId;

  const listRes = await fetchDatabases(session.accessToken, orgId);
  if (!listRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Database Gestiti</h1>
        <CapabilityNotice
          tone="warning"
          title="Inventario database non accessibile"
          description={listRes.error.error.message}
        />
      </div>
    );
  }

  const summaries = listRes.data.data;
  const details = await Promise.all(
    summaries.map(async (item) => {
      const detailRes = await fetchDatabaseDetail(
        session.accessToken,
        orgId,
        item.id,
      );
      return detailRes.ok ? detailRes.data.data : null;
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Database Gestiti</h1>
          <p className="mt-1 text-sm text-slate-600">
            Inventario e parametri di connessione interna delle istanze database (vista
            di consultazione verificata).
          </p>
        </div>
        <FreshnessIndicator
          observedAt={listRes.data.meta?.observedAt}
          stale={listRes.data.meta?.stale}
          source={listRes.data.meta?.source}
        />
      </div>

      {summaries.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessun database registrato o visibile per questa organizzazione.
        </div>
      ) : (
        <div className="grid gap-4">
          {summaries.map((summary, idx) => {
            const detail = details[idx] ?? null;
            return (
              <article
                key={summary.id}
                className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      <Database className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-bold text-slate-900">
                          {summary.name}
                        </h2>
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                          {formatDatabaseEngineIt(summary.engine)} {summary.engineVersion}
                        </span>
                        <ResourceStatusBadge status={summary.status} />
                        <HealthStatusBadge health={summary.health} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        ID Risorsa: <code>{summary.id}</code> · Server:{" "}
                        <code>{summary.serverId}</code>
                      </p>
                    </div>
                  </div>
                </div>

                <dl className="mt-5 grid gap-4 rounded-lg bg-slate-50 p-4 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-slate-500">Host rete interna</dt>
                    <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-900">
                      {detail?.internalHostname ?? "Rete privata"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Porta interna</dt>
                    <dd className="mt-0.5 font-mono text-xs font-semibold text-slate-900">
                      {detail?.port ? String(detail.port) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Storage allocato</dt>
                    <dd className="mt-0.5 font-semibold text-slate-900">
                      {detail ? `${String(detail.storageAllocatedGb)} GB` : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Ultimo backup verificato</dt>
                    <dd className="mt-0.5 text-xs font-medium text-slate-800">
                      {summary.backupSupported
                        ? formatDateTimeIt(summary.lastBackupAt)
                        : "Non applicabile"}
                    </dd>
                  </div>
                </dl>

                {!summary.backupSupported && (
                  <div className="mt-4">
                    <CapabilityNotice
                      tone="warning"
                      title="Funzionalità di backup non disponibile per questo motore"
                      description={formatDatabaseBackupUnsupportedIt(
                        summary.engine,
                        detail?.backupUnsupportedReason ?? null,
                      )}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
