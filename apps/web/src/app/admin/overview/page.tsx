import Link from "next/link";
import { AuditOutcomeBadge, ProviderStatusBadge } from "@/components/badges";
import {
  fetchAdminAuditEvents,
  fetchAdminFleet,
  fetchAdminProviderConnections,
} from "@/lib/bff-client";
import { formatDateTimeIt } from "@/lib/format";
import { resolveAdminServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const { session } = await resolveAdminServerContext();

  const [providersRes, fleetRes, auditRes] = await Promise.all([
    fetchAdminProviderConnections(session.accessToken),
    fetchAdminFleet(session.accessToken),
    fetchAdminAuditEvents(session.accessToken),
  ]);

  const providers = providersRes.ok ? providersRes.data.data : [];
  const fleet = fleetRes.ok ? fleetRes.data.data : [];
  const audits = auditRes.ok ? auditRes.data.data.slice(0, 8) : [];

  const staleCount = fleet.filter((item) => item.stale).length;
  const unhealthyCount = fleet.filter((item) => item.health === "unhealthy").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Panoramica Amministrazione Piattaforma
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Supervisione globale dei motori di esecuzione Coolify v4, stato della flotta
          multi-tenant ed eventi di sicurezza.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Provider Registrati
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {String(providers.length)}
          </p>
          <Link
            href="/admin/providers"
            className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
          >
            Gestisci connessioni →
          </Link>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Risorse in Flotta
          </p>
          <p className="mt-2 text-2xl font-bold text-slate-900">
            {String(fleet.length)}
          </p>
          <Link
            href="/admin/fleet"
            className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
          >
            Ispeziona flotta →
          </Link>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Risorse Anomale
          </p>
          <p className="mt-2 text-2xl font-bold text-rose-700">
            {String(unhealthyCount)}
          </p>
          <p className="mt-2 text-xs text-slate-500">Salute rilevata non integra</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
            Osservazioni Stale
          </p>
          <p className="mt-2 text-2xl font-bold text-amber-700">
            {String(staleCount)}
          </p>
          <p className="mt-2 text-xs text-slate-500">Oltre soglia di freschezza</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-base font-semibold text-slate-900">
            Stato Connessioni Motore Coolify
          </h2>
          <ul className="mt-4 divide-y divide-slate-100">
            {providers.map((prv) => (
              <li
                key={prv.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    {prv.displayName}
                  </p>
                  <p className="text-xs text-slate-500">
                    Driver: <code>{prv.driver}</code> · Versione:{" "}
                    {prv.version ?? "n/d"} · Org collegate:{" "}
                    {String(prv.boundOrganizationCount)}
                  </p>
                </div>
                <ProviderStatusBadge status={prv.status} />
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Ultimi Eventi Audit
            </h2>
            <Link
              href="/admin/audit"
              className="text-xs font-semibold text-indigo-600 hover:underline"
            >
              Registro completo
            </Link>
          </div>
          <ul className="mt-4 divide-y divide-slate-100">
            {audits.map((evt) => (
              <li
                key={evt.id}
                className="flex flex-wrap items-center justify-between gap-3 py-2.5"
              >
                <div>
                  <p className="text-xs font-semibold text-slate-900">{evt.action}</p>
                  <p className="text-[11px] text-slate-500">
                    {evt.actorEmail ?? "Sistema"} · {formatDateTimeIt(evt.occurredAt)}
                  </p>
                </div>
                <AuditOutcomeBadge outcome={evt.outcome} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
