import {
  CertificateStatusBadge,
  DomainVerificationBadge,
} from "@/components/badges";
import { CapabilityNotice } from "@/components/capability-notice";
import { DomainRecheckButton } from "@/components/domain-recheck-btn";
import { FreshnessIndicator } from "@/components/freshness";
import { fetchDomains } from "@/lib/bff-client";
import { formatDateTimeIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface DomainsPageProps {
  readonly params: Promise<{ readonly orgSlug: string }>;
}

export default async function OrganizationDomainsPage({
  params,
}: DomainsPageProps) {
  const { orgSlug } = await params;
  const { session, membership } = await resolveOrgServerContext(orgSlug);
  const orgId = membership.organizationId;

  const domainsRes = await fetchDomains(session.accessToken, orgId);
  if (!domainsRes.ok) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Domini &amp; Certificati TLS</h1>
        <CapabilityNotice
          tone="warning"
          title="Elenco domini non accessibile"
          description={domainsRes.error.error.message}
        />
      </div>
    );
  }

  const domains = domainsRes.data.data;
  const canRecheckTls =
    membership.permissions.includes("certificate.recheck") &&
    membership.organizationStatus !== "suspended";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          Domini &amp; Certificati TLS
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Distinzione esplicita tra stato di verifica DNS dell&apos;hostname e validità
          effettiva del certificato HTTPS osservato.
        </p>
      </div>

      {domains.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          Nessun dominio associato alle applicazioni dell&apos;organizzazione.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Hostname</th>
                  <th className="px-4 py-3">Verifica DNS</th>
                  <th className="px-4 py-3">Stato Certificato TLS</th>
                  <th className="px-4 py-3">Ente Emittente &amp; Scadenza</th>
                  <th className="px-4 py-3 text-right">Azione</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {domains.map((dom) => (
                  <tr key={dom.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">
                          {dom.hostname}
                        </span>
                        {dom.isPrimary && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                            Primario
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Applicazione: <code>{dom.applicationId}</code>
                      </p>
                    </td>
                    <td className="px-4 py-4">
                      <DomainVerificationBadge status={dom.verificationStatus} />
                    </td>
                    <td className="px-4 py-4">
                      {dom.certificate ? (
                        <div className="space-y-1">
                          <CertificateStatusBadge status={dom.certificate.status} />
                          <div>
                            <FreshnessIndicator
                              observedAt={dom.certificate.observedAt}
                              source={dom.certificate.source}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">
                          Nessuna osservazione TLS
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-600">
                      <p className="font-medium text-slate-800">
                        {dom.certificate?.issuer ?? "Emittente non rilevato"}
                      </p>
                      <p className="mt-0.5">
                        Scadenza:{" "}
                        {dom.certificate?.expiresAt
                          ? formatDateTimeIt(dom.certificate.expiresAt)
                          : "—"}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-right">
                      {canRecheckTls ? (
                        <DomainRecheckButton
                          orgId={orgId}
                          domainId={dom.id}
                          csrfToken={session.csrfToken}
                        />
                      ) : (
                        <span className="text-xs text-slate-400">Sola lettura</span>
                      )}
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
