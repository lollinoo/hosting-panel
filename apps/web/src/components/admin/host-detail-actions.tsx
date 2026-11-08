"use client";

import * as React from "react";
import type { OperationStatus, RuntimeBackend } from "@hosting-panel/contracts";
import { OperationTimeline } from "@/components/shared/operation-timeline";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
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
  runtimeBackend?: RuntimeBackend;
}

const MAINTENANCE_ACTIONS = [
  { action: "collect_diagnostics", text: "collectDiagnostics" },
  { action: "verify_storage_posture", text: "verifyStorage" },
  { action: "refresh_host_inventory", text: "refreshInventory" },
] as const;

const SECURITY_POLICIES = [
  { policyRef: "verify_baseline_firewall", text: "verifyFirewall" },
  { policyRef: "apply_dedicated_nftables_22_80_443", text: "applyFirewall" },
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
  runtimeBackend = "disabled",
}: HostDetailActionsProps) {
  const m = useMessages();
  const t = m.admin.actions;
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
          reason: t.modeReason,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setModeResult({
          success: false,
          code: data.error?.code || "ERROR",
          message:
            data.error?.message ||
            t.modeRejected,
        });
      } else {
        setModeResult({
          success: true,
          message: t.modeUnexpected,
        });
      }
    } catch {
      setModeResult({
        success: false,
        code: "NETWORK_ERROR",
        message: t.networkError,
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
          reason: format(t.maintReason, { action }),
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
          title: format(t.maintTitle, { label, action }),
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
            t.maintRejected,
        });
      }
    } catch {
      setActionFeedback({
        variant: "destructive",
        code: "NETWORK_ERROR",
        message: t.networkError,
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
          reason: format(t.secReason, { policy: policyRef }),
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
          title: format(t.secTitle, { label, policy: policyRef }),
        });
      } else if (!res.ok) {
        const code = payload.error?.code || "ERROR";
        setActionFeedback({
          variant: code === "NOT_SUPPORTED" ? "info" : "destructive",
          code,
          message:
            payload.error?.message ||
            t.secRejected,
        });
      }
    } catch {
      setActionFeedback({
        variant: "destructive",
        code: "NETWORK_ERROR",
        message: t.networkError,
      });
    } finally {
      setLoadingActionKey(null);
    }
  };

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
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          <AlertTitle className="font-mono text-xs">
            {format(t.outcome, { code: actionFeedback.code })}
          </AlertTitle>
          <AlertDescription className="text-xs">{actionFeedback.message}</AlertDescription>
        </Alert>
      )}

      {/* 1. Shared Mode Gating (AC-F1-06 & AC-F2-10) */}
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">{t.gatingTitle}</h4>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t.gatingHint}
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
            <span>{t.gatingButton}</span>
          </Button>
        </div>

        {modeResult && (
          <Alert variant={modeResult.code === "SHARED_MODE_GATED" ? "warning" : "destructive"}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="font-mono text-xs">
              {format(t.policyResponse, { code: modeResult.code ?? "" })}
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
                {t.maintSectionTitle}
              </h4>
              <Badge variant="outline" className="font-mono text-[10px]">
                {format(m.admin.host.backend, { backend: runtimeBackend })}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t.maintSectionHint}
            </p>
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-3">
          {MAINTENANCE_ACTIONS.map((item) => {
            const text = t[item.text];
            const busy = loadingActionKey === `maint:${item.action}`;
            return (
              <div
                key={item.action}
                className="rounded-md border bg-card p-3 flex flex-col justify-between gap-2"
              >
                <div>
                  <div className="text-xs font-semibold">{text.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{item.action}</div>
                  <p className="text-[11px] text-muted-foreground mt-1">{text.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isAnyActionBusy}
                  onClick={() => triggerHostMaintenance(item.action, text.label)}
                  className="w-full text-xs gap-1.5 mt-1"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Wrench className="h-3.5 w-3.5 text-blue-500" />
                  )}
                  <span>{t.run}</span>
                </Button>
              </div>
            );
          })}
        </div>

        {/* Policy Rejection Verification Button */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-2.5 bg-background/60">
          <div className="text-[11px] text-muted-foreground">
            {t.forbiddenTest}
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={isAnyActionBusy}
            onClick={() => triggerHostMaintenance("kernel_patch_drain", t.forbiddenLabel)}
            className="text-xs gap-1.5 shrink-0"
          >
            {loadingActionKey === "maint:kernel_patch_drain" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Ban className="h-3.5 w-3.5 text-destructive" />
            )}
            <span>{t.forbiddenButton}</span>
          </Button>
        </div>
      </div>

      {/* 3. Allowlisted Host Security / nftables Triggers */}
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div>
          <h4 className="text-sm font-semibold">
            {t.secSectionTitle}
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t.secSectionHint}
          </p>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          {SECURITY_POLICIES.map((sec) => {
            const text = t[sec.text];
            const busy = loadingActionKey === `sec:${sec.policyRef}`;
            return (
              <div
                key={sec.policyRef}
                className="rounded-md border bg-card p-3 flex flex-col justify-between gap-2"
              >
                <div>
                  <div className="text-xs font-semibold">{text.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{sec.policyRef}</div>
                  <p className="text-[11px] text-muted-foreground mt-1">{text.description}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isAnyActionBusy}
                  onClick={() => triggerHostSecurity(sec.policyRef, text.label)}
                  className="w-full text-xs gap-1.5 mt-1"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                  <span>{t.runPolicy}</span>
                </Button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
