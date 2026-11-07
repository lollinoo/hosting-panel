"use client";

import type { AdminProviderConnectionDto } from "@hosting-panel/contracts";
import { Activity } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTimeIt } from "@/lib/format";

export interface ProviderTestButtonProps {
  readonly providerId: string;
  readonly csrfToken: string;
}

export function ProviderTestButton({
  providerId,
  csrfToken,
}: ProviderTestButtonProps) {
  const router = useRouter();
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{
    readonly ok: boolean;
    readonly text: string;
  } | null>(null);

  const handleTest = async (): Promise<void> => {
    if (testing) {
      return;
    }
    setTesting(true);
    setFeedback(null);

    try {
      const res = await fetch(
        `/api/bff/admin/providers/${encodeURIComponent(providerId)}/test`,
        {
          method: "POST",
          headers: {
            "X-CSRF-Token": csrfToken,
          },
        },
      );

      const json = (await res.json()) as
        | { readonly data: AdminProviderConnectionDto }
        | { readonly error?: { readonly message?: string } };

      if (!res.ok || !("data" in json)) {
        setFeedback({
          ok: false,
          text:
            "error" in json && json.error?.message
              ? json.error.message
              : "Verifica connessione fallita.",
        });
      } else {
        setFeedback({
          ok: true,
          text: `Connesso (v${json.data.version ?? "n/d"}) · ${formatDateTimeIt(json.data.lastCheckedAt)}`,
        });
      }
      router.refresh();
    } catch {
      setFeedback({
        ok: false,
        text: "Errore di rete durante il test del provider.",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        disabled={testing}
        onClick={() => {
          void handleTest();
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-2xs hover:bg-indigo-700 disabled:opacity-50"
      >
        <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        {testing ? "Verifica in corso..." : "Testa connessione Coolify"}
      </button>
      {feedback && (
        <span
          className={`text-xs font-medium ${
            feedback.ok ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}
