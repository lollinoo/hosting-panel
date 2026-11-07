"use client";

import * as React from "react";
import type { OperationStatus, RuntimeBackend } from "@hosting-panel/contracts";
import { OperationTimeline } from "@/components/operations/operation-timeline";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  ShieldAlert,
  ShieldCheck,
  Wrench,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Ban,
} from "lucide-react";

export interface HostDetailActionsProps {
  hostId: string;
  csrfToken?: string;
  isInfraAdmin: boolean;
  runtimeBackend?: RuntimeBackend;
}

const ALLOWLISTED_MAINTENANCE_ACTIONS = [
  {
    action: "collect_diagnostics",
    label: "Raccogli Diagnostica",
    description: "Snapshot strutturato carico, memoria, filesystem e cgroups v2",
  },
  {
    action: "verify_storage_posture",
    label: "Verifica Postura Storage",
    description: "Controllo permessi 0750/0700 e opzioni mount directory gestite",
  },
  {
    action: "refresh_host_inventory",
    label: "Aggiorna Inventario Hardware",
    description: "Rilevamento CPU logiche, RAM fisica, storage e architettura",
  },
] as const;

const ALLOWLISTED_SECURITY_POLICIES = [
  {
    policyRef: "verify_baseline_firewall",
    label: "Verifica Baseline nftables",
    description: "Ispeziona il ruleset attivo tramite execFile (/usr/sbin/nft)",
  },
  {
    policyRef: "apply_dedicated_nftables_22_80_443",
    label: "Applica Profilo nftables (22/80/443)",
    description: "Applica il profilo statico dedicato verificato da hash",
  },
] as const;

function makeHostIdempotencyKey(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function HostDetailActions({
  hostId,
  csrfToken,
  isInfraAdmin,
  runtimeBackend = "disabled",
}: HostDetailActionsProps) {
  const [loadingMode, setLoadingMode] = React.useState(false);
  const [loadingActionKey, setLoadingActionKey] = React.useState<string | null>(null);

  const [modeResult, setModeResult] = React.useState<{
    success: boolean;
    code?: string;
    message?: string;
  } | null>(null);

  const [actionFeedback, setActionFeedback] = React.useState<{
    variant: "info" | "warning" | "destructive";
    code: string;
    message: string;
  } | null>(null);

  const [activeOperation, setActiveOperation] = React.useState<{
    operationId: string;
    status: OperationStatus;
    title: string;
  } | null>(null);

  const testSharedModeGating = async () => {
    if (!csrfToken) return;
    setLoadingMode(true);
    setModeResult(null);

    try {
      const res = await fetch(`/api/bff/hosts/${hostId}/mode`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          hostingMode: "shared",
          reason: "Verifica automatizzata AC-F1-06 / AC-F2-10 da interfaccia amministratore",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setModeResult({
          success: false,
          code: data.error?.code || "ERROR",
          message:
            data.error?.message ||
            "Transizione alla modalità Shared respinta dalle policy di piattaforma.",
        });
      } else {
        setModeResult({
          success: true,
          message: "Modalità aggiornata con successo (inaspettato con Shared Hosting chiuso).",
        });
      }
    } catch {
      setModeResult({
        success: false,
        code: "NETWORK_ERROR",
        message: "Errore di comunicazione con il BFF.",
      });
    } finally {
      setLoadingMode(false);
    }
  };

  const triggerHostMaintenance = async (action: string, label: string) => {
    if (!csrfToken) return;
    setLoadingActionKey(`maint:${action}`);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/bff/hosts/${hostId}/maintenance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": makeHostIdempotencyKey(`maint-${action}`),
        },
        body: JSON.stringify({
          action,
          reason: `Trigger manutenzione '${action}' da Console Infrastructure Admin`,
        }),
      });

      const payload = (await res.json()) as {
        data?: { operationId?: string; status?: OperationStatus };
        error?: { code?: string; message?: string };
      };

      if (res.status === 202 && payload.data?.operationId) {
        setActiveOperation({
          operationId: payload.data.operationId,
          status: payload.data.status ?? "queued",
          title: `Manutenzione Host: ${label} (${action})`,
        });
      } else if (!res.ok) {
        const code = payload.error?.code || "ERROR";
        setActionFeedback({
          variant:
            code === "HOST_POLICY_DENIED"
              ? "warning"
              : code === "NOT_SUPPORTED"
                ? "info"
                : "destructive",
          code,
          message:
            payload.error?.message ||
            "Azione di manutenzione respinta o runtime Host Agent disabilitato.",
        });
      }
    } catch {
      setActionFeedback({
        variant: "destructive",
        code: "NETWORK_ERROR",
        message: "Errore di comunicazione con il BFF durante l'invio manutenzione.",
      });
    } finally {
      setLoadingActionKey(null);
    }
  };

  const triggerHostSecurity = async (policyRef: string, label: string) => {
    if (!csrfToken) return;
    setLoadingActionKey(`sec:${policyRef}`);
    setActionFeedback(null);

    try {
      const res = await fetch(`/api/bff/hosts/${hostId}/security`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": makeHostIdempotencyKey(`sec-${policyRef}`),
        },
        body: JSON.stringify({
          policyRef,
          reason: `Verifica postura sicurezza '${policyRef}' da Console Infrastructure Admin`,
        }),
      });

      const payload = (await res.json()) as {
        data?: { operationId?: string; status?: OperationStatus };
        error?: { code?: string; message?: string };
      };

      if (res.status === 202 && payload.data?.operationId) {
        setActiveOperation({
          operationId: payload.data.operationId,
          status: payload.data.status ?? "queued",
          title: `Sicurezza Host / nftables: ${label} (${policyRef})`,
        });
      } else if (!res.ok) {
        const code = payload.error?.code || "ERROR";
        setActionFeedback({
          variant: code === "NOT_SUPPORTED" ? "info" : "destructive",
          code,
          message:
            payload.error?.message ||
            "Operazione di sicurezza host respinta o runtime disabilitato.",
        });
      }
    } catch {
      setActionFeedback({
        variant: "destructive",
        code: "NETWORK_ERROR",
        message: "Errore di comunicazione con il BFF durante l'invio policy sicurezza.",
      });
    } finally {
      setLoadingActionKey(null);
    }
  };

  if (!isInfraAdmin) {
    return (
      <Alert variant="warning" className="text-xs">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Azioni Modificanti Disabilitate (AC-F1-03)</AlertTitle>
        <AlertDescription>
          Solo gli utenti con ruolo <code className="font-mono">infrastructure_admin</code> possono invocare
          manutenzione OS o posture <code className="font-mono">nftables</code> sul nodo host. Il ruolo{" "}
          <code className="font-mono">hosting_admin</code> riceve tassativamente{" "}
          <code className="font-mono">403 PERMISSION_DENIED</code>.
        </AlertDescription>
      </Alert>
    );
  }

  const isAnyActionBusy = loadingActionKey !== null;

  return (
    <div className="space-y-4">
      {/* Live 202 Accepted Operation Timeline for Host Operations */}
      {activeOperation && (
        <OperationTimeline
          pollUrl={`/api/bff/hosts/${hostId}/operations/${activeOperation.operationId}`}
          operationId={activeOperation.operationId}
          initialStatus={activeOperation.status}
          title={activeOperation.title}
          onDismiss={() => setActiveOperation(null)}
        />
      )}

      {/* Action Error / Policy Rejection Feedback */}
      {actionFeedback && (
        <Alert variant={actionFeedback.variant}>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle className="font-mono text-xs">
            Esito Controllo Host Agent: [{actionFeedback.code}]
          </AlertTitle>
          <AlertDescription className="text-xs">{actionFeedback.message}</AlertDescription>
        </Alert>
      )}

      {/* 1. Shared Mode Gating (AC-F1-06 & AC-F2-10) */}
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">Test Shared Mode Gating (AC-F1-06 / AC-F2-10)</h4>
              <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-700 dark:text-amber-300">
                ADR-011 OPEN
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Invia <code className="font-mono">PATCH /api/bff/hosts/:hostId/mode</code> con{" "}
              <code className="font-mono">hostingMode: shared</code>. Verifica che il Policy Engine risponda{" "}
              <code className="font-mono">409 SHARED_MODE_GATED</code> anche in Fase 2.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={testSharedModeGating}
            disabled={loadingMode}
            className="text-xs gap-1.5 shrink-0"
          >
            {loadingMode ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span>Test Transizione Shared</span>
          </Button>
        </div>

        {modeResult && (
          <Alert variant={modeResult.code === "SHARED_MODE_GATED" ? "warning" : "destructive"}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="font-mono text-xs">
              Risposta Policy: [{modeResult.code}]
            </AlertTitle>
            <AlertDescription className="text-xs">{modeResult.message}</AlertDescription>
          </Alert>
        )}
      </div>

      {/* 2. Allowlisted Host Maintenance Triggers (AC-F2-04 & AC-F2-06) */}
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">
                Manutenzione Host Allowlisted (`hp-host-agent` &bull; Zero Shell)
              </h4>
              <Badge variant="outline" className="font-mono text-[10px]">
                backend: {runtimeBackend}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Esegue comandi pre-approvati tramite Outbox asincrono (<code className="font-mono">202 Accepted</code>) su
              socket IPC firmato. Qualsiasi azione fuori allowlist viene rigettata (<code className="font-mono">403 HOST_POLICY_DENIED</code>).
            </p>
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-3">
          {ALLOWLISTED_MAINTENANCE_ACTIONS.map((item) => {
            const busy = loadingActionKey === `maint:${item.action}`;
            return (
              <div
                key={item.action}
                className="rounded-md border bg-card p-3 flex flex-col justify-between gap-2"
              >
                <div>
                  <div className="text-xs font-semibold">{item.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{item.action}</div>
                  <p className="text-[11px] text-muted-foreground mt-1">{item.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isAnyActionBusy}
                  onClick={() => triggerHostMaintenance(item.action, item.label)}
                  className="w-full text-xs gap-1.5 mt-1"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5 text-blue-500" />
                  )}
                  <span>Esegui</span>
                </Button>
              </div>
            );
          })}
        </div>

        {/* Policy Rejection Verification Button */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2.5 bg-background/60">
          <div className="text-[11px] text-muted-foreground">
            <strong className="text-foreground">Test Reiezione Allowlist (AC-F2-04):</strong> invia l&apos;azione non
            consentita <code className="font-mono">kernel_patch_drain</code> per verificare il rifiuto{" "}
            <code className="font-mono">403 HOST_POLICY_DENIED</code> (o <code className="font-mono">422</code> se
            disabilitato).
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={isAnyActionBusy}
            onClick={() => triggerHostMaintenance("kernel_patch_drain", "Test Azione Vietata")}
            className="text-xs gap-1.5 shrink-0"
          >
            {loadingActionKey === "maint:kernel_patch_drain" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Ban className="h-3.5 w-3.5 text-destructive" />
            )}
            <span>Test `kernel_patch_drain`</span>
          </Button>
        </div>
      </div>

      {/* 3. Allowlisted Host Security / nftables Triggers */}
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div>
          <h4 className="text-sm font-semibold">
            Sicurezza Host &amp; Postura Firewall `nftables` (`CAP_NET_ADMIN`)
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Invoca <code className="font-mono">POST /api/bff/hosts/:hostId/security</code> con{" "}
            <code className="font-mono">Idempotency-Key</code> usando esclusivamente{" "}
            <code className="font-mono">execFile(&quot;/usr/sbin/nft&quot;)</code> su profili statici certificati.
          </p>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          {ALLOWLISTED_SECURITY_POLICIES.map((sec) => {
            const busy = loadingActionKey === `sec:${sec.policyRef}`;
            return (
              <div
                key={sec.policyRef}
                className="rounded-md border bg-card p-3 flex flex-col justify-between gap-2"
              >
                <div>
                  <div className="text-xs font-semibold">{sec.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{sec.policyRef}</div>
                  <p className="text-[11px] text-muted-foreground mt-1">{sec.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isAnyActionBusy}
                  onClick={() => triggerHostSecurity(sec.policyRef, sec.label)}
                  className="w-full text-xs gap-1.5 mt-1"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                  <span>Avvia Policy</span>
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
