import type { OperationDto } from "@hosting-panel/contracts";
import { AlertCircle } from "lucide-react";
import { OperationStatusBadge } from "./badges";
import {
  formatDateTimeIt,
  formatOperationKindIt,
  formatStepStatusIt,
} from "@/lib/format";

export interface OperationTimelineProps {
  readonly operation: OperationDto;
  readonly compact?: boolean;
}

export function OperationTimeline({
  operation,
  compact = false,
}: OperationTimelineProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">
              {formatOperationKindIt(operation.kind)}
            </h3>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
              {operation.id}
            </code>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            Inviata: {formatDateTimeIt(operation.submittedAt)}
            {operation.completedAt
              ? ` · Conclusa: ${formatDateTimeIt(operation.completedAt)}`
              : ""}
          </p>
        </div>
        <OperationStatusBadge status={operation.status} />
      </div>

      {operation.errorMessage && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <div>
            <p className="font-semibold">
              Errore operazione{operation.errorCode ? ` (${operation.errorCode})` : ""}
            </p>
            <p className="mt-0.5">{operation.errorMessage}</p>
          </div>
        </div>
      )}

      <ol className={`mt-4 space-y-3 ${compact ? "text-xs" : "text-sm"}`}>
        {operation.steps.map((step, idx) => {
          const stepInfo = formatStepStatusIt(step.status);
          return (
            <li key={step.id} className="relative flex items-start gap-3">
              <div className="flex flex-col items-center pt-1">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${stepInfo.dotClassName}`}
                  aria-hidden="true"
                />
                {idx < operation.steps.length - 1 && (
                  <span
                    className="mt-1 h-6 w-px bg-slate-200"
                    aria-hidden="true"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{step.label}</span>
                  <span className="text-xs font-medium text-slate-500">
                    {stepInfo.label}
                  </span>
                </div>
                {step.message && (
                  <p className="mt-0.5 text-xs text-slate-600">{step.message}</p>
                )}
                {(step.startedAt || step.completedAt) && !compact && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {step.startedAt ? `Avvio: ${formatDateTimeIt(step.startedAt)}` : ""}
                    {step.completedAt
                      ? ` · Fine: ${formatDateTimeIt(step.completedAt)}`
                      : ""}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
