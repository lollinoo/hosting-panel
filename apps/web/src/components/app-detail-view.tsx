"use client";

import {
  isTerminalOperationStatus,
  type ApplicationDetailDto,
  type AsyncAcceptedEnvelope,
  type DomainDto,
  type OperationDto,
  type ReadMeta,
} from "@hosting-panel/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Lock,
  Play,
  RotateCw,
  Shield,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CertificateStatusBadge,
  DomainVerificationBadge,
  HealthStatusBadge,
  OperationStatusBadge,
  ResourceStatusBadge,
} from "./badges";
import { CapabilityNotice } from "./capability-notice";
import { DangerConfirmDialog } from "./confirm-dialog";
import { FreshnessIndicator } from "./freshness";
import { OperationTimeline } from "./timeline";
import { formatDateTimeIt } from "@/lib/format";

type AppTabKey = "overview" | "deployments" | "domains" | "permissions";

export interface AppDetailViewProps {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly organizationStatus: string;
  readonly application: ApplicationDetailDto;
  readonly meta: ReadMeta | undefined;
  readonly domains: readonly DomainDto[];
  readonly csrfToken: string;
}

export function AppDetailView({
  orgId,
  orgSlug,
  organizationStatus,
  application,
  meta,
  domains,
  csrfToken,
}: AppDetailViewProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<AppTabKey>("overview");
  const [confirmAction, setConfirmAction] = useState<"deploy" | "restart" | null>(null);
  const [forceRebuild, setForceRebuild] = useState(false);
  const [reason, setReason] = useState("");
  const [activeOperationId, setActiveOperationId] = useState<string | null>(
    application.lockedByOperationId,
  );
  const [acceptedBanner, setAcceptedBanner] = useState<{
    readonly operationId: string;
    readonly submittedAt: string;
    readonly actionLabel: string;
  } | null>(null);

  const operationQuery = useQuery({
    queryKey: ["bff-operation", orgId, activeOperationId],
    enabled: activeOperationId !== null,
    queryFn: async (): Promise<OperationDto> => {
      const res = await fetch(
        `/api/bff/orgs/${encodeURIComponent(orgId)}/operations/${encodeURIComponent(activeOperationId ?? "")}`,
        {
          headers: { Accept: "application/json" },
          cache: "no-store",
        },
      );
      if (!res.ok) {
        throw new Error("Impossibile aggiornare lo stato dell'operazione.");
      }
      const envelope = (await res.json()) as { readonly data: OperationDto };
      return envelope.data;
    },
    refetchInterval: (query) => {
      const current = query.state.data;
      if (current && isTerminalOperationStatus(current.status)) {
        return false;
      }
      return 800;
    },
  });

  const liveOperation = operationQuery.data ?? null;
  const isOperationRunning =
    activeOperationId !== null &&
    (!liveOperation || !isTerminalOperationStatus(liveOperation.status));

  useEffect(() => {
    if (liveOperation && isTerminalOperationStatus(liveOperation.status)) {
      router.refresh();
    }
  }, [liveOperation, router]);

  const isSuspended = organizationStatus === "suspended";
  const canClickDeploy =
    application.allowedActions.canDeploy && !isSuspended && !isOperationRunning;
  const canClickRestart =
    application.allowedActions.canRestart && !isSuspended && !isOperationRunning;

  const submitMutation = async (
    kind: "deploy" | "restart",
    idempotencyKey: string,
  ): Promise<void> => {
    const endpoint = `/api/bff/orgs/${encodeURIComponent(orgId)}/applications/${encodeURIComponent(application.id)}/${kind}`;
    const trimmedReason = reason.trim();
    const payload: Record<string, unknown> = {};
    if (trimmedReason.length > 0) {
      payload["reason"] = trimmedReason;
    }
    if (kind === "deploy" && forceRebuild) {
      payload["forceRebuild"] = true;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    const json = (await res.json()) as
      | AsyncAcceptedEnvelope
      | { readonly error?: { readonly message?: string; readonly code?: string } };

    if (!res.ok || !("data" in json)) {
      const errMsg =
        "error" in json && json.error?.message
          ? json.error.message
          : "Operazione rifiutata dal Control Plane.";
      throw new Error(errMsg);
    }

    setActiveOperationId(json.data.operationId);
    setAcceptedBanner({
      operationId: json.data.operationId,
      submittedAt: json.data.submittedAt,
      actionLabel: kind === "deploy" ? "Deploy applicazione" : "Riavvio applicazione",
    });
    setReason("");
    setForceRebuild(false);
  };

  return (
    <div className="space-y-6">
      {/* Header scheda applicazione */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold text-slate-900">{application.name}</h1>
              <ResourceStatusBadge status={application.status} />
              <HealthStatusBadge health={application.health} />
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                Ambiente: {application.environment}
              </span>
              {(application.lockedByOperationId || isOperationRunning) && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  Operazione in corso
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
              <span>
                Slug: <code className="text-slate-800">{application.slug}</code>
              </span>
              <span>Buildpack: {application.buildPack}</span>
              {application.primaryDomain && (
                <span className="inline-flex items-center gap-1 text-indigo-700">
                  Dominio primario: <strong>{application.primaryDomain}</strong>
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </span>
              )}
            </div>

            <FreshnessIndicator
              observedAt={meta?.observedAt ?? application.lastObservedAt}
              stale={meta?.stale}
              source={meta?.source}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {application.allowedActions.canDeploy && (
              <button
                type="button"
                disabled={!canClickDeploy}
                onClick={() => {
                  setConfirmAction("deploy");
                }}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Avvia Deploy
              </button>
            )}

            {application.allowedActions.canRestart && (
              <button
                type="button"
                disabled={!canClickRestart}
                onClick={() => {
                  setConfirmAction("restart");
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-2xs hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCw className="h-4 w-4" aria-hidden="true" />
                Riavvia
              </button>
            )}
          </div>
        </div>

        {!application.allowedActions.canDeploy &&
          !application.allowedActions.canRestart && (
            <div className="mt-4">
              <CapabilityNotice
                tone="info"
                title="Accesso in sola lettura su questa applicazione"
                description="Il tuo profilo non dispone dei permessi application.deploy o application.restart per eseguire modifiche operative su questa risorsa."
              />
            </div>
          )}

        {isSuspended && (
          <div className="mt-4">
            <CapabilityNotice
              tone="danger"
              title="Azioni bloccate: organizzazione sospesa"
              description="Deploy e riavvii sono disabilitati finché lo stato amministrativo dell'organizzazione rimane Sospesa."
            />
          </div>
        )}
      </div>

      {/* Banner 202 Accepted + OperationTimeline live */}
      {acceptedBanner && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-950"
        >
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-indigo-600" />
            <div>
              <p className="font-semibold">
                {acceptedBanner.actionLabel} presa in carico (HTTP 202 Accepted)
              </p>
              <p className="text-xs text-indigo-800">
                ID Operazione: <code>{acceptedBanner.operationId}</code> · L&apos;esito
                sarà confermato solo al termine della riconciliazione col motore di
                esecuzione.
              </p>
            </div>
          </div>
          <Link
            href={`/o/${orgSlug}/operations/${acceptedBanner.operationId}`}
            className="text-xs font-semibold text-indigo-700 underline hover:text-indigo-900"
          >
            Apri scheda operazione
          </Link>
        </div>
      )}

      {liveOperation && <OperationTimeline operation={liveOperation} />}

      {/* Schede informative (§3.5) */}
      <div className="border-b border-slate-200">
        <nav className="-mb-px flex flex-wrap gap-6" aria-label="Sezioni applicazione">
          {(
            [
              { key: "overview", label: "Panoramica" },
              {
                key: "deployments",
                label: `Deployment recenti (${String(application.recentDeployments.length)})`,
              },
              {
                key: "domains",
                label: `Domini & SSL (${String(domains.length)})`,
              },
              { key: "permissions", label: "Permessi effettivi" },
            ] as const
          ).map((tab) => {
            const selected = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveTab(tab.key);
                }}
                className={`border-b-2 pb-3 text-sm font-medium transition ${
                  selected
                    ? "border-indigo-600 text-indigo-600"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === "overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              Configurazione Sorgente &amp; Build
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Repository Git</dt>
                <dd className="font-mono text-xs text-slate-900">
                  {application.repositoryUrl ?? "Immagine pre-compilata"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Branch di rilascio</dt>
                <dd className="inline-flex items-center gap-1 font-medium text-slate-900">
                  <GitBranch className="h-3.5 w-3.5 text-slate-400" />
                  {application.branch ?? "main"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Sistema di build</dt>
                <dd className="font-medium text-slate-900">{application.buildPack}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Ultimo deploy completato</dt>
                <dd className="font-medium text-slate-900">
                  {formatDateTimeIt(application.lastDeployedAt)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-sm font-semibold text-slate-900">
              Allocazione Infrastrutturale
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">ID Risorsa Control Plane</dt>
                <dd className="font-mono text-xs text-slate-900">{application.id}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Server ospite</dt>
                <dd className="font-mono text-xs text-slate-900">
                  {application.serverId}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Domini associati</dt>
                <dd className="text-right font-medium text-slate-900">
                  {application.domains.length > 0
                    ? application.domains.join(", ")
                    : "Nessun dominio configurato"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Creata il</dt>
                <dd className="text-slate-900">
                  {formatDateTimeIt(application.createdAt)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}

      {activeTab === "deployments" && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {application.recentDeployments.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">
              Nessun deployment registrato per questa applicazione.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-3">ID Deploy</th>
                    <th className="px-4 py-3">Stato</th>
                    <th className="px-4 py-3">Commit / Tag</th>
                    <th className="px-4 py-3">Avviato</th>
                    <th className="px-4 py-3">Terminato</th>
                    <th className="px-4 py-3">Operazione</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {application.recentDeployments.map((dep) => (
                    <tr key={dep.id} className="hover:bg-slate-50/70">
                      <td className="px-4 py-3 font-mono text-xs text-slate-800">
                        {dep.id}
                      </td>
                      <td className="px-4 py-3">
                        <OperationStatusBadge status={dep.status} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">
                        {dep.commitSha ?? dep.imageTag ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {formatDateTimeIt(dep.startedAt ?? dep.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {dep.finishedAt ? formatDateTimeIt(dep.finishedAt) : "In corso"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {dep.operationId ? (
                          <Link
                            href={`/o/${orgSlug}/operations/${dep.operationId}`}
                            className="font-medium text-indigo-600 hover:underline"
                          >
                            {dep.operationId}
                          </Link>
                        ) : (
                          <span className="text-slate-400">Storico</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "domains" && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {domains.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">
              Nessun dominio personalizzato associato a questa applicazione.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wider text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-3">Hostname</th>
                    <th className="px-4 py-3">Verifica DNS</th>
                    <th className="px-4 py-3">Certificato HTTPS / TLS</th>
                    <th className="px-4 py-3">Scadenza TLS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {domains.map((dom) => (
                    <tr key={dom.id}>
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {dom.hostname}{" "}
                        {dom.isPrimary && (
                          <span className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                            Primario
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <DomainVerificationBadge status={dom.verificationStatus} />
                      </td>
                      <td className="px-4 py-3">
                        {dom.certificate ? (
                          <CertificateStatusBadge status={dom.certificate.status} />
                        ) : (
                          <span className="text-xs text-slate-500">Non osservato</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {dom.certificate?.expiresAt
                          ? formatDateTimeIt(dom.certificate.expiresAt)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "permissions" && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              Permessi effettivi valutati dal Policy Engine (RBAC + ResourceGrant)
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Valutazione lato server con precedenza esplicita <code>deny</code> su{" "}
            <code>allow</code>.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(
              [
                {
                  key: "application.deploy",
                  label: "Avvio nuovo deploy",
                  allowed: application.allowedActions.canDeploy,
                },
                {
                  key: "application.restart",
                  label: "Riavvio container applicazione",
                  allowed: application.allowedActions.canRestart,
                },
                {
                  key: "application.stop",
                  label: "Arresto applicazione",
                  allowed: application.allowedActions.canStop,
                },
                {
                  key: "application.logs.read",
                  label: "Consultazione log applicativi",
                  allowed: application.allowedActions.canReadLogs,
                },
              ] as const
            ).map((perm) => (
              <div
                key={perm.key}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-900">{perm.label}</p>
                  <code className="text-xs text-slate-500">{perm.key}</code>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    perm.allowed
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {perm.allowed ? "Consentito" : "Negato"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modali di conferma con Idempotency-Key stabile */}
      <DangerConfirmDialog
        open={confirmAction === "deploy"}
        title={`Conferma deploy di ${application.name}`}
        description="Il Control Plane registrerà l'operazione nella coda transazionale (Outbox), acquisirà il lock esclusivo sulla risorsa e avvierà il deploy sul motore di esecuzione."
        confirmLabel="Conferma e avvia deploy"
        intentPrefix="idem_deploy"
        onClose={() => {
          setConfirmAction(null);
        }}
        onConfirm={async (idempotencyKey) => {
          await submitMutation("deploy", idempotencyKey);
        }}
      >
        <div className="space-y-3">
          <div>
            <label
              htmlFor="deploy-reason-input"
              className="block text-xs font-medium text-slate-700"
            >
              Nota di rilascio (opzionale)
            </label>
            <input
              id="deploy-reason-input"
              type="text"
              maxLength={200}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
              placeholder="Es. Aggiornamento configurazione catalogo"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
              checked={forceRebuild}
              onChange={(e) => {
                setForceRebuild(e.target.checked);
              }}
              className="h-4 w-4 rounded border-slate-300 text-indigo-600"
            />
            Forza ricompilazione completa senza cache (<code>forceRebuild</code>)
          </label>
        </div>
      </DangerConfirmDialog>

      <DangerConfirmDialog
        open={confirmAction === "restart"}
        tone="danger"
        title={`Conferma riavvio di ${application.name}`}
        description="Il riavvio dei container può causare una breve interruzione delle connessioni attive. Vuoi procedere con il riavvio controllato?"
        confirmLabel="Conferma riavvio"
        intentPrefix="idem_restart"
        onClose={() => {
          setConfirmAction(null);
        }}
        onConfirm={async (idempotencyKey) => {
          await submitMutation("restart", idempotencyKey);
        }}
      />
    </div>
  );
}
