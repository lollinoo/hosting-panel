import { AuditOutcomeBadge } from "@/components/badges";
import { fetchAdminAuditEvents } from "@/lib/bff-client";
import { formatDateTimeIt } from "@/lib/format";
import { resolveAdminServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface AdminAuditPageProps {
  readonly searchParams: Promise<{
    readonly outcome?: string;
    readonly organizationId?: string;
    readonly q?: string;
  }>;
}

export default async function AdminAuditPage({
  searchParams,
}: AdminAuditPageProps) {
  const { session } = await resolveAdminServerContext();
  const resolvedSearch = await searchParams;
  const outcomeFilter = resolvedSearch.outcome?.trim() ?? "";
  const orgFilter = resolvedSearch.organizationId?.trim() ?? "";
  const textQuery = (resolvedSearch.q ?? "").trim().toLowerCase();

  const auditRes = await fetchAdminAuditEvents(session.accessToken, {
    outcome: outcomeFilter || undefined,
    organizationId: orgFilter || undefined,
  });

  const rawEvents = auditRes.ok ? auditRes.data.data : [];
  const filteredEvents =
    textQuery.length === 0
      ? rawEvents
      : rawEvents.filter((evt) => {
          const haystack = [
            evt.action,
            evt.actorEmail ?? "",
            evt.targetType,
            evt.targetId ?? "",
            evt.organizationId ?? "",
            evt.requestId,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(textQuery);
        });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Registro Audit di Sicurezza (Append-Only)
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Eventi immutabili di autorizzazione, mutazioni infrastrutturali, revoca
          sessioni e tentativi negati (AC-016).
        </p>
      </div>

      {/* Filtro ricerca server-side */}
      <form
        method="GET"
        action="/admin/audit"
        className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs sm:grid-cols-4"
      >
        <div>
          <label
            htmlFor="audit-q"
            className="block text-xs font-semibold text-slate-600"
          >
            Ricerca libera
          </label>
          <input
            id="audit-q"
            name="q"
            type="search"
            defaultValue={resolvedSearch.q ?? ""}
            placeholder="Azione, email, requestId..."
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor="audit-org"
            className="block text-xs font-semibold text-slate-600"
          >
            ID Organizzazione
          </label>
          <input
            id="audit-org"
            name="organizationId"
            type="text"
            defaultValue={orgFilter}
            placeholder="Es. org_acme"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor="audit-outcome"
            className="block text-xs font-semibold text-slate-600"
          >
            Esito Evento
          </label>
          <select
            id="audit-outcome"
            name="outcome"
            defaultValue={outcomeFilter}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900"
          >
            <option value="">Tutti gli esiti</option>
            <option value="succeeded">Completato (succeeded)</option>
            <option value="denied">Negato (denied)</option>
            <option value="failed">Fallito (failed)</option>
            <option value="allowed">Autorizzato (allowed)</option>
          </select>
        </div>

        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Filtra eventi
          </button>
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
        {filteredEvents.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            Nessun evento di audit corrisponde ai criteri selezionati.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Timestamp</th>
                  <th className="px-4 py-3">Azione</th>
                  <th className="px-4 py-3">Esito</th>
                  <th className="px-4 py-3">Attore</th>
                  <th className="px-4 py-3">Target / Org</th>
                  <th className="px-4 py-3">Metadati &amp; Request ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEvents.map((evt) => (
                  <tr key={evt.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-3 text-xs whitespace-nowrap text-slate-600">
                      {formatDateTimeIt(evt.occurredAt)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-900">
                      {evt.action}
                    </td>
                    <td className="px-4 py-3">
                      <AuditOutcomeBadge outcome={evt.outcome} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      <p className="font-medium">{evt.actorEmail ?? "Sistema"}</p>
                      {evt.actorUserId && (
                        <code className="text-[11px] text-slate-500">
                          {evt.actorUserId}
                        </code>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      <p>
                        {evt.targetType}
                        {evt.targetId ? ` (${evt.targetId})` : ""}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Org: {evt.organizationId ?? "Piattaforma"}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-600">
                      <p>{JSON.stringify(evt.metadata)}</p>
                      <p className="text-slate-400">req: {evt.requestId}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
