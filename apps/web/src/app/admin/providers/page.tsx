import { ProviderStatusBadge } from "@/components/badges";
import { ProviderTestButton } from "@/components/provider-test-btn";
import { fetchAdminProviderConnections } from "@/lib/bff-client";
import { formatDateTimeIt } from "@/lib/format";
import { resolveAdminServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export default async function AdminProvidersPage() {
  const { session } = await resolveAdminServerContext();
  const providersRes = await fetchAdminProviderConnections(session.accessToken);
  const providers = providersRes.ok ? providersRes.data.data : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Connessioni Provider d&apos;Esecuzione
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Istanze Coolify v4 gestite centralmente con allowlist statica degli host,
          blocco redirect e redazione segreti (AC-008, AC-009, AC-017).
        </p>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessun provider registrato.
        </div>
      ) : (
        <div className="grid gap-4">
          {providers.map((prv) => (
            <article
              key={prv.id}
              className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-lg font-bold text-slate-900">
                      {prv.displayName}
                    </h2>
                    <ProviderStatusBadge status={prv.status} />
                    <code className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {prv.driver}
                    </code>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    ID Istanza: <code>{prv.id}</code> · Versione rilevata:{" "}
                    <strong>{prv.version ?? "Non verificata"}</strong> · Organizzazioni
                    associate: <strong>{String(prv.boundOrganizationCount)}</strong> ·
                    Ultima verifica: {formatDateTimeIt(prv.lastCheckedAt)}
                  </p>
                </div>

                <ProviderTestButton
                  providerId={prv.id}
                  csrfToken={session.csrfToken}
                />
              </div>

              <div className="mt-5 border-t border-slate-100 pt-4">
                <h3 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  Matrice Capacità Dichiarate
                </h3>
                <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {(
                    [
                      {
                        label: "Deploy applicazioni",
                        ok: prv.capabilities.applicationDeploy.supported,
                      },
                      {
                        label: "Riavvio applicazioni",
                        ok: prv.capabilities.applicationRestart.supported,
                      },
                      {
                        label: "Ricontrollo TLS",
                        ok: prv.capabilities.certificateRecheck.supported,
                      },
                      {
                        label: "Backup PostgreSQL",
                        ok: prv.capabilities.databaseBackupByEngine.postgresql
                          .supported,
                      },
                      {
                        label: "Backup Redis automatico",
                        ok: prv.capabilities.databaseBackupByEngine.redis.supported,
                      },
                    ] as const
                  ).map((cap) => (
                    <div
                      key={cap.label}
                      className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs"
                    >
                      <span className="text-slate-700">{cap.label}</span>
                      <span
                        className={`font-semibold ${
                          cap.ok ? "text-emerald-700" : "text-amber-700"
                        }`}
                      >
                        {cap.ok ? "Supportato" : "Non supportato"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
