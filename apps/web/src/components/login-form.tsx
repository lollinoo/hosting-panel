"use client";

import { ArrowRight, ShieldCheck, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OrgCommercialStatusBadge } from "./badges";
import type { DevPersonaSummary } from "@/lib/bff-client";
import { formatRoleLabelIt } from "@/lib/format";

export interface LoginPersonaListProps {
  readonly personas: readonly DevPersonaSummary[];
}

export function LoginPersonaList({ personas }: LoginPersonaListProps) {
  const router = useRouter();
  const [loadingUserId, setLoadingUserId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handlePersonaLogin = async (userId: string): Promise<void> => {
    if (loadingUserId !== null) {
      return;
    }
    setLoadingUserId(userId);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });

      const json = (await res.json()) as {
        readonly redirectTo?: string;
        readonly error?: { readonly message?: string };
      };

      if (!res.ok) {
        setErrorMessage(
          json.error?.message ?? "Impossibile avviare la sessione autenticata.",
        );
        return;
      }

      router.push(json.redirectTo ?? "/choose-organization");
      router.refresh();
    } catch {
      setErrorMessage(
        "Impossibile contattare il server BFF. Verifica che l'applicazione sia attiva.",
      );
    } finally {
      setLoadingUserId(null);
    }
  };

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          <p className="font-semibold">Accesso non riuscito</p>
          <p className="mt-1 text-xs">{errorMessage}</p>
        </div>
      )}

      <div className="grid gap-3">
        {personas.map((persona) => {
          const isSigningIn = loadingUserId === persona.id;
          return (
            <div
              key={persona.id}
              className="flex flex-col justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs transition hover:border-indigo-300 sm:flex-row sm:items-center"
            >
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">
                    {persona.displayName}
                  </span>
                  <span className="text-xs text-slate-500">{persona.email}</span>
                  {persona.isPlatformAdmin && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-800 ring-1 ring-inset ring-indigo-600/20">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      Platform Admin
                    </span>
                  )}
                </div>

                {persona.organizations.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {persona.organizations.map((org) => (
                      <div
                        key={org.organizationId}
                        className="inline-flex flex-wrap items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-700 ring-1 ring-inset ring-slate-200"
                      >
                        <span className="font-medium">{org.organizationName}</span>
                        <OrgCommercialStatusBadge status={org.organizationStatus} />
                        <span className="text-slate-500">
                          ({org.roles.map(formatRoleLabelIt).join(", ")})
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">
                    Console globale di amministrazione piattaforma (nessun tenant cliente
                    diretto).
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={loadingUserId !== null}
                onClick={() => {
                  void handlePersonaLogin(persona.id);
                }}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 disabled:opacity-50"
              >
                <UserCheck className="h-4 w-4" aria-hidden="true" />
                {isSigningIn ? "Accesso..." : "Accedi"}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
