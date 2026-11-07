"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  isTerminalOperationStatus,
  type OperationDto,
  type OperationStatus,
  type OperationStepStatus,
} from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  AlertTriangle,
  X,
  Activity,
} from "lucide-react";

export interface OperationTimelineProps {
  pollUrl: string;
  operationId: string;
  initialStatus?: OperationStatus;
  title?: string;
  onDismiss?: () => void;
}

function getOperationStatusLabel(status: OperationStatus): string {
  switch (status) {
    case "queued":
      return "In coda (Outbox)";
    case "processing":
      return "In esecuzione";
    case "accepted":
      return "Accettata dal demone IPC";
    case "reconciling":
      return "In riconciliazione";
    case "succeeded":
      return "Completata";
    case "failed":
      return "Fallita";
    case "cancelled":
      return "Annullata";
    case "unknown":
      return "Stato indeterminato (Recovery TH-08)";
  }
}

function getOperationBadgeVariant(status: OperationStatus) {
  switch (status) {
    case "succeeded":
      return "success" as const;
    case "failed":
      return "destructive" as const;
    case "unknown":
      return "warning" as const;
    case "processing":
    case "accepted":
    case "reconciling":
      return "default" as const;
    default:
      return "secondary" as const;
  }
}

function getStepStatusLabel(status: OperationStepStatus): string {
  switch (status) {
    case "pending":
      return "In attesa";
    case "running":
      return "In corso";
    case "succeeded":
      return "Completato";
    case "failed":
      return "Fallito";
    case "cancelled":
      return "Annullato";
    case "skipped":
      return "Saltato";
    case "unknown":
      return "Verifica Read-Only";
  }
}

function getStepBadgeVariant(status: OperationStepStatus) {
  switch (status) {
    case "succeeded":
      return "success" as const;
    case "failed":
      return "destructive" as const;
    case "unknown":
      return "warning" as const;
    case "running":
      return "default" as const;
    default:
      return "outline" as const;
  }
}

function renderStepIcon(status: OperationStepStatus) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
    case "running":
      return <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />;
    case "unknown":
      return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground shrink-0" />;
  }
}

export function OperationTimeline({
  pollUrl,
  operationId,
  initialStatus = "queued",
  title,
  onDismiss,
}: OperationTimelineProps) {
  const router = useRouter();
  const [operation, setOperation] = React.useState<OperationDto | null>(null);
  const [pollError, setPollError] = React.useState<string | null>(null);
  const refreshedForIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchOperation = async () => {
      try {
        const res = await fetch(pollUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        const payload = (await res.json()) as {
          data?: OperationDto;
          error?: { message?: string };
        };

        if (!active) return;

        if (!res.ok || !payload.data) {
          setPollError(
            payload.error?.message ||
              "Impossibile aggiornare lo stato dell'operazione asincrona."
          );
          return;
        }

        setPollError(null);
        const nextOp = payload.data;
        setOperation(nextOp);

        if (isTerminalOperationStatus(nextOp.status)) {
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
          if (refreshedForIdRef.current !== nextOp.id) {
            refreshedForIdRef.current = nextOp.id;
            router.refresh();
          }
        }
      } catch {
        if (!active) return;
        setPollError("Connessione temporaneamente non disponibile durante il polling.");
      }
    };

    void fetchOperation();
    intervalId = setInterval(() => {
      void fetchOperation();
    }, 1000);

    return () => {
      active = false;
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
    };
  }, [pollUrl, operationId, router]);

  const currentStatus: OperationStatus = operation?.status ?? initialStatus;
  const isTerminal = isTerminalOperationStatus(currentStatus);
  const hasUnknownState =
    currentStatus === "unknown" ||
    Boolean(operation?.steps.some((step) => step.status === "unknown"));

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">
              {title || "Timeline Operazione Asincrona"}
            </span>
            <Badge variant={getOperationBadgeVariant(currentStatus)} className="text-[10px]">
              {!isTerminal && <Loader2 className="h-3 w-3 animate-spin mr-1 inline" />}
              {getOperationStatusLabel(currentStatus)}
            </Badge>
            {operation?.kind && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {operation.kind}
              </Badge>
            )}
          </div>
          <p className="text-[11px] font-mono text-muted-foreground">
            Operazione ID: {operation?.id ?? operationId}
            {operation?.resourceId ? ` • Risorsa: ${operation.resourceId}` : ""}
          </p>
        </div>

        {onDismiss && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onDismiss}
            title="Chiudi pannello operazione"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {hasUnknownState && (
        <Alert variant="warning" className="text-xs">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="font-semibold text-xs">
            Crash-Recovery da Stato Indeterminato Attivo (TH-08 / AC-F2-07)
          </AlertTitle>
          <AlertDescription className="text-xs">
            L&apos;operazione ha rilevato un&apos;interruzione o timeout post-invio IPC ed è transitata nello stato{" "}
            <code className="font-mono">unknown</code>. Il lock esclusivo resta acquisito: il riconciliatore interroga lo
            stato osservato in sola lettura (<code className="font-mono">getObservedState</code>) senza alcun replay cieco{" "}
            <code className="font-mono">POST</code>.
          </AlertDescription>
        </Alert>
      )}

      {operation?.status === "failed" && (
        <Alert variant="destructive" className="text-xs">
          <XCircle className="h-4 w-4" />
          <AlertTitle className="font-mono text-xs">
            Errore Operazione: [{operation.errorCode || "INTERNAL_ERROR"}]
          </AlertTitle>
          <AlertDescription className="text-xs">
            {operation.errorMessage || "L'esecuzione asincrona non è andata a buon fine."}
          </AlertDescription>
        </Alert>
      )}

      {pollError && (
        <Alert variant="warning" className="text-xs">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="text-xs">Avviso Telemetria Operazione</AlertTitle>
          <AlertDescription className="text-xs">{pollError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2 pt-1">
        {!operation ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>Acquisizione stato iniziale dall&apos;Outbox transazionale...</span>
          </div>
        ) : operation.steps.length === 0 ? (
          <div className="text-xs text-muted-foreground py-1">
            Operazione registrata ({getOperationStatusLabel(operation.status)}). Nessuno step dettagliato emesso.
          </div>
        ) : (
          <ol className="space-y-2">
            {operation.steps.map((step) => (
              <li
                key={step.id}
                className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2 text-xs"
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5">{renderStepIcon(step.status)}</div>
                  <div>
                    <div className="font-medium text-foreground">{step.label}</div>
                    {step.message && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{step.message}</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge variant={getStepBadgeVariant(step.status)} className="text-[10px]">
                    {getStepStatusLabel(step.status)}
                  </Badge>
                  {step.completedAt && (
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {new Date(step.completedAt).toLocaleTimeString("it-IT")}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
