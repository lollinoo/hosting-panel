"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert, Wrench, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";

export interface HostDetailActionsProps {
  hostId: string;
  csrfToken?: string;
  isInfraAdmin: boolean;
}

export function HostDetailActions({
  hostId,
  csrfToken,
  isInfraAdmin,
}: HostDetailActionsProps) {
  const [loadingMode, setLoadingMode] = React.useState(false);
  const [loadingMaint, setLoadingMaint] = React.useState(false);
  const [modeResult, setModeResult] = React.useState<{
    success: boolean;
    code?: string;
    message?: string;
  } | null>(null);
  const [maintResult, setMaintResult] = React.useState<{
    success: boolean;
    code?: string;
    message?: string;
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
          reason: "Verifica automatizzata AC-F1-06 da interfaccia amministratore",
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
          message: "Modalità aggiornata con successo (inaspettato in Fase 1).",
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

  const testMaintenanceAction = async () => {
    if (!csrfToken) return;
    setLoadingMaint(true);
    setMaintResult(null);

    try {
      const res = await fetch(`/api/bff/hosts/${hostId}/maintenance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({
          action: "kernel_patch_drain",
          reason: "Verifica confine runtime Host Agent Fase 1",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setMaintResult({
          success: false,
          code: data.error?.code || "NOT_SUPPORTED",
          message:
            data.error?.message ||
            "Operazione di manutenzione daemon host non disponibile in Fase 1 (HCP-SPEC-002 §1.3).",
        });
      } else {
        setMaintResult({
          success: true,
          message: "Azione di manutenzione accettata.",
        });
      }
    } catch {
      setMaintResult({
        success: false,
        code: "NETWORK_ERROR",
        message: "Errore di comunicazione con il BFF.",
      });
    } finally {
      setLoadingMaint(false);
    }
  };

  if (!isInfraAdmin) {
    return (
      <Alert variant="warning" className="text-xs">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Azioni Modificanti Disabilitate</AlertTitle>
        <AlertDescription>
          Solo gli utenti con ruolo `InfrastructureAdmin` possono eseguire test sui confini di sicurezza del nodo host (AC-F1-03).
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">Test Shared Mode Gating (AC-F1-06)</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Invia una richiesta `PATCH /api/bff/hosts/:hostId/mode` specificando `hostingMode: shared`.
              Verifica che il Policy Engine risponda con `409 SHARED_MODE_GATED`.
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
            <AlertDescription className="text-xs">
              {modeResult.message}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">Verifica Confine Host Agent (AC-F1-10)</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Invia una richiesta `POST /api/bff/hosts/:hostId/maintenance`.
              Verifica che il Control Plane ritorni `422 NOT_SUPPORTED` confermando l'assenza di daemon shell aperti.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={testMaintenanceAction}
            disabled={loadingMaint}
            className="text-xs gap-1.5 shrink-0"
          >
            {loadingMaint ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="h-3.5 w-3.5 text-blue-500" />
            )}
            <span>Test Manutenzione Host</span>
          </Button>
        </div>

        {maintResult && (
          <Alert variant="info">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle className="font-mono text-xs">
              Confine Fase 1 Confermato: [{maintResult.code}]
            </AlertTitle>
            <AlertDescription className="text-xs">
              {maintResult.message}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
