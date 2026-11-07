import Link from "next/link";
import {
  HealthStatusBadge,
  OperationStatusBadge,
  ResourceStatusBadge,
} from "@/components/badges";
import { FreshnessIndicator } from "@/components/freshness";
import {
  fetchApplications,
  fetchDomains,
  fetchOperations,
  fetchOrganizationDetail,
  fetchOrganizationQuotas,
  fetchServers,
} from "@/lib/bff-client";
import { formatDateTimeIt, formatOperationKindIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface OverviewPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationOverviewPage({
  params,
}: OverviewPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);
  const orgId = membership.organizationId;

  const [orgRes, quotaRes, serversRes, appsRes, domainsRes, opsRes] =
    await Promise.all([
      fetchOrganizationDetail(session.accessToken, orgId),
      fetchOrganizationQuotas(session.accessToken, orgId),
      fetchServers(session.accessToken, orgId),
      fetchApplications(session.accessToken, orgId),
      fetchDomains(session.accessToken, orgId),
      fetchOperations(session.accessToken, orgId),
    ]);

  const orgDetail = orgRes.ok ? orgRes.data.data : null;
  const quotas = quotaRes.ok ? quotaRes.data.data : null;
  const apps = appsRes.ok ? appsRes.data.data : [];
  const domains = domainsRes.ok ? domainsRes.data.data : [];
  const operations = opsRes.ok ? opsRes.data.data.slice(0, 6) : [];
  const readMeta = serversRes.ok
    ? serversRes.data.meta
    : appsRes.ok
      ? appsRes.data.meta
      : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Panoramica — {membership.organizationName}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Stato operativo delle risorse gestite, quote piano e ultime attività
            asincrone.
          </p>
        </div>
        <FreshnessIndicator
          observedAt={readMeta?.observedAt ?? orgDetail?.updatedAt}
          stale={readMeta?.stale}
          source={readMeta?.source}
        />
      </div>

      {/* KPI Principali */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Applicazioni
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {quotas
              ? `${String(quotas.applicationsUsed)} / ${String(quotas.applicationsLimit)}`
              : String(orgDetail?.applicationCount ?? apps.length)}
          </p>
          <Link
            href={`/o/${orgSlug}/applications`}
            className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
          >
            Gestisci applicazioni →
          </Link>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Database Gestiti
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {quotas
              ? `${String(quotas.databasesUsed)} / ${String(quotas.databasesLimit)}`
              : String(orgDetail?.databaseCount ?? 0)}
          </p>
          <Link
            href={`/o/${orgSlug}/databases`}
            className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
          >
            Inventario database →
          </Link>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Server Allocati
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {quotas
              ? `${String(quotas.serversUsed)} / ${String(quotas.serversLimit)}`
              : String(orgDetail?.serverCount ?? 0)}
          </p>
          <Link
            href={`/o/${orgSlug}/servers`}
            className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
          >
            Stato nodi e telemetria →
          </Link>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Domini &amp; Piano
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {quotas
              ? `${String(quotas.domainsUsed)} / ${String(quotas.domainsLimit)}`
              : String(domains.length)}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Piano commerciale:{" "}
            <strong className="text-slate-800 uppercase">
              {quotas?.planCode ?? "Standard"}
            </strong>
          </p>
        </div>
      </div>

      {/* Stato salute applicazioni + Ultime operazioni */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Stato Salute Applicazioni
            </h2>
            <Link
              href={`/o/${orgSlug}/applications`}
              className="text-xs font-semibold text-indigo-600 hover:underline"
            >
              Vedi tutte
            </Link>
          </div>

          {apps.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              Nessuna applicazione visibile con i permessi correnti.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {apps.map((app) => (
                <li
                  key={app.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <Link
                      href={`/o/${orgSlug}/applications/${app.id}`}
                      className="text-sm font-semibold text-slate-900 hover:text-indigo-600"
                    >
                      {app.name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {app.primaryDomain ?? app.slug} · {app.environment}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ResourceStatusBadge status={app.status} />
                    <HealthStatusBadge health={app.health} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Ultime Operazioni Asincrone
            </h2>
            <Link
              href={`/o/${orgSlug}/operations`}
              className="text-xs font-semibold text-indigo-600 hover:underline"
            >
              Registro completo
            </Link>
          </div>

          {operations.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              Nessuna operazione recente registrata per questa organizzazione.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-slate-100">
              {operations.map((op) => (
                <li
                  key={op.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div>
                    <Link
                      href={`/o/${orgSlug}/operations/${op.id}`}
                      className="text-sm font-medium text-slate-900 hover:text-indigo-600"
                    >
                      {formatOperationKindIt(op.kind)}
                    </Link>
                    <p className="text-xs text-slate-500">
                      Risorsa: <code>{op.resourceId}</code> ·{" "}
                      {formatDateTimeIt(op.submittedAt)}
                    </p>
                  </div>
                  <OperationStatusBadge status={op.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
