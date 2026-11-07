import { HealthStatusBadge, ResourceStatusBadge } from "@/components/badges";
import { FreshnessIndicator } from "@/components/freshness";
import { fetchAdminFleet } from "@/lib/bff-client";
import { resolveAdminServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export default async function AdminFleetPage() {
  const { session } = await resolveAdminServerContext();
  const fleetRes = await fetchAdminFleet(session.accessToken);
  const items = fleetRes.ok ? fleetRes.data.data : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Flotta Globale Multi-Tenant
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Vista trasversale di tutte le applicazioni e istanze database delle
          organizzazioni clienti con monitoraggio freschezza.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessuna risorsa presente nella flotta.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Risorsa</th>
                  <th className="px-4 py-3">Organizzazione</th>
                  <th className="px-4 py-3">Nodo Server</th>
                  <th className="px-4 py-3">Stato &amp; Salute</th>
                  <th className="px-4 py-3">Freschezza Osservazione</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.resourceId} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-slate-900">
                        {item.resourceName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {item.resourceType === "application"
                          ? "Applicazione"
                          : "Database"}{" "}
                        · <code>{item.resourceId}</code>
                      </p>
                    </td>
                    <td className="px-4 py-3.5">
                      <p className="font-medium text-slate-900">
                        {item.organizationName}
                      </p>
                      <code className="text-xs text-slate-500">
                        {item.organizationId}
                      </code>
                    </td>
                    <td className="px-4 py-3.5">
                      <p className="text-slate-800">{item.serverName}</p>
                      <code className="text-xs text-slate-500">{item.serverId}</code>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ResourceStatusBadge status={item.status} />
                        <HealthStatusBadge health={item.health} />
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <FreshnessIndicator
                        observedAt={item.lastObservedAt}
                        stale={item.stale}
                      />
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
