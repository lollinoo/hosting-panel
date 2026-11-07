"use client";

import {
  isTerminalOperationStatus,
  type AsyncAcceptedEnvelope,
  type OperationDto,
} from "@hosting-panel/contracts";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { OperationStatusBadge } from "./badges";

function makeRecheckKey(): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
  return `idem_tls_${rand}`;
}

export interface DomainRecheckButtonProps {
  readonly orgId: string;
  readonly domainId: string;
  readonly csrfToken: string;
  readonly disabled?: boolean;
}

export function DomainRecheckButton({
  orgId,
  domainId,
  csrfToken,
  disabled = false,
}: DomainRecheckButtonProps) {
  const router = useRouter();
  const pendingKeyRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const opQuery = useQuery({
    queryKey: ["bff-domain-op", orgId, operationId],
    enabled: operationId !== null,
    queryFn: async (): Promise<OperationDto> => {
      const res = await fetch(
        `/api/bff/orgs/${encodeURIComponent(orgId)}/operations/${encodeURIComponent(operationId ?? "")}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        throw new Error("Errore lettura stato verifica TLS.");
      }
      const body = (await res.json()) as { readonly data: OperationDto };
      return body.data;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && isTerminalOperationStatus(data.status)) {
        return false;
      }
      return 800;
    },
  });

  useEffect(() => {
    if (opQuery.data && isTerminalOperationStatus(opQuery.data.status)) {
      router.refresh();
    }
  }, [opQuery.data, router]);

  const handleRecheck = async (): Promise<void> => {
    if (submitting || disabled) {
      return;
    }
    if (!pendingKeyRef.current) {
      pendingKeyRef.current = makeRecheckKey();
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/bff/orgs/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/recheck`,
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrfToken,
            "Idempotency-Key": pendingKeyRef.current,
          },
        },
      );

      const json = (await res.json()) as
        | AsyncAcceptedEnvelope
        | { readonly error?: { readonly message?: string } };

      if (!res.ok || !("data" in json)) {
        setErrorMessage(
          "error" in json && json.error?.message
            ? json.error.message
            : "Impossibile avviare il ricontrollo TLS.",
        );
        return;
      }

      pendingKeyRef.current = null;
      setOperationId(json.data.operationId);
    } catch {
      setErrorMessage("Errore di rete. Riprova.");
    } finally {
      setSubmitting(false);
    }
  };

  const inProgress =
    operationId !== null &&
    (!opQuery.data || !isTerminalOperationStatus(opQuery.data.status));

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        disabled={disabled || submitting || inProgress}
        onClick={() => {
          void handleRecheck();
        }}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw
          className={`h-3.5 w-3.5 ${submitting || inProgress ? "animate-spin" : ""}`}
          aria-hidden="true"
        />
        {submitting ? "Invio..." : "Ricontrolla TLS"}
      </button>
      {opQuery.data && <OperationStatusBadge status={opQuery.data.status} />}
      {errorMessage && <span className="text-[11px] text-rose-600">{errorMessage}</span>}
    </div>
  );
}
