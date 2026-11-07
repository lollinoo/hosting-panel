import type { ServerMetricsDto } from "@hosting-panel/contracts";
import { Cpu, HardDrive, MemoryStick, Server } from "lucide-react";
import { HealthStatusBadge, ResourceStatusBadge } from "@/components/badges";
import { CapabilityNotice } from "@/components/capability-notice";
import { FreshnessIndicator } from "@/components/freshness";
import { fetchServerMetrics, fetchServers } from "@/lib/bff-client";
import { formatMemoryGb } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface ServersPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationServersPage({
  params,
}: ServersPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);
  const orgId = membership.organizationId;

  const serversRes = await fetchServers(session.accessToken, orgId);
  if (!serversRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Server Infrastrutturali</h1>
        <CapabilityNotice
          tone="warning"
          title="Inventario server non accessibile"
          description={serversRes.error.error.message}
        />
      </div>
    );
  }

  const servers = serversRes.data.data;
  const canReadMetrics = membership.permissions.includes("server.metrics.read");

  const metricsEntries = await Promise.all(
    servers.map(async (srv) => {
      if (!canReadMetrics) {
        return [srv.id, null] as const;
      }
      const mRes = await fetchServerMetrics(session.accessToken, orgId, srv.id);
      return [srv.id, mRes.ok ? mRes.data : null] as const;
    }),
  );
  const metricsByServerId = new Map<
    string,
    { readonly data: ServerMetricsDto; readonly stale: boolean } | null
  >(
    metricsEntries.map(([id, env]) => [
      id,
      env ? { data: env.data, stale: env.meta?.stale === true } : null,
    ]),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Server Infrastrutturali</h1>
          <p className="mt-1 text-sm text-slate-600">
            Nodi di calcolo dedicati all&apos;organizzazione, capacità hardware e
            freschezza della telemetria Sentinel.
          </p>
        </div>
        <FreshnessIndicator
          observedAt={serversRes.data.meta?.observedAt}
          stale={serversRes.data.meta?.stale}
          source={serversRes.data.meta?.source}
        />
      </div>

      {servers.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessun server allocato per questa organizzazione.
        </div>
      ) : (
        <div className="grid gap-4">
          {servers.map((srv) => {
            const metricWrap = metricsByServerId.get(srv.id) ?? null;
            const metrics = metricWrap?.data ?? null;
            const serverStale =
              metricWrap?.stale === true || serversRes.data.meta?.stale === true;

            return (
              <article
                key={srv.id}
                className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                      <Server className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-bold text-slate-900">
                          {srv.name}
                        </h2>
                        <ResourceStatusBadge status={srv.status} />
                        <HealthStatusBadge health={srv.health} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Regione: <strong>{srv.region}</strong> · IPv4 pubblico:{" "}
                        <code>{srv.publicIpv4 ?? "Rete privata"}</code> · ID:{" "}
                        <code>{srv.id}</code>
                      </p>
                    </div>
                  </div>

                  <FreshnessIndicator
                    observedAt={srv.lastObservedAt}
                    stale={serverStale}
                    source="coolify"
                  />
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-3">
                  <div className="rounded-lg bg-slate-50 p-3.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <Cpu className="h-3.5 w-3.5" aria-hidden="true" />
                      Processore (vCPU)
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {srv.vcpuCount} vCPU
                      {metrics?.cpuUsagePercent !== null &&
                      metrics?.cpuUsagePercent !== undefined
                        ? ` · Utilizzo ${metrics.cpuUsagePercent.toFixed(1)}%`
                        : " · Telemetria CPU non disponibile"}
                    </p>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <MemoryStick className="h-3.5 w-3.5" aria-hidden="true" />
                      Memoria RAM
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {formatMemoryGb(srv.memoryMb)}
                      {metrics?.memoryUsedMb !== null &&
                      metrics?.memoryUsedMb !== undefined
                        ? ` · Usata ${formatMemoryGb(metrics.memoryUsedMb)}`
                        : ""}
                    </p>
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3.5">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                      <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
                      Storage NVMe
                    </div>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {srv.diskGb} GB totali
                      {metrics?.diskUsedGb !== null && metrics?.diskUsedGb !== undefined
                        ? ` · Usati ${String(metrics.diskUsedGb)} GB`
                        : ""}
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
