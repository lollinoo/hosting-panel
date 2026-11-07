import type { ObservationSource } from "@hosting-panel/contracts";
import { AlertTriangle, Clock } from "lucide-react";
import { formatDateTimeIt } from "@/lib/format";

export interface FreshnessIndicatorProps {
  readonly observedAt: string | null | undefined;
  readonly stale?: boolean | undefined;
  readonly source?: ObservationSource | undefined;
}

function formatSourceIt(source: ObservationSource | undefined): string {
  switch (source) {
    case "coolify":
      return "Motore Coolify";
    case "monitoring":
      return "Telemetria";
    case "external_probe":
      return "Sonda HTTP esterna";
    default:
      return "Osservazione";
  }
}

export function FreshnessIndicator({
  observedAt,
  stale = false,
  source,
}: FreshnessIndicatorProps) {
  return (
    <div className="inline-flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-slate-700">
        <Clock className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
        <span>
          Osservato: <strong>{formatDateTimeIt(observedAt)}</strong>
          {source ? ` (${formatSourceIt(source)})` : ""}
        </span>
      </span>
      {stale && (
        <span
          role="status"
          className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 font-medium text-amber-900 ring-1 ring-inset ring-amber-600/30"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-amber-700" aria-hidden="true" />
          Dato non aggiornato (stale)
        </span>
      )}
    </div>
  );
}
