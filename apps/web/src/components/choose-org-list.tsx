"use client";

import type { MeMembershipDto } from "@hosting-panel/contracts";
import { ArrowRight, Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OrgCommercialStatusBadge } from "./badges";
import { formatRoleLabelIt } from "@/lib/format";

export interface ChooseOrgListProps {
  readonly memberships: readonly MeMembershipDto[];
  readonly csrfToken: string;
}

export function ChooseOrgList({ memberships, csrfToken }: ChooseOrgListProps) {
  const router = useRouter();
  const [selectingSlug, setSelectingSlug] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSelect = async (slug: string): Promise<void> => {
    if (selectingSlug !== null) {
      return;
    }
    setSelectingSlug(slug);
    setErrorMessage(null);

    try {
      const res = await fetch("/api/session/switch-org", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ organizationSlug: slug }),
      });

      const json = (await res.json()) as {
        readonly error?: { readonly message?: string };
      };

      if (!res.ok) {
        setErrorMessage(
          json.error?.message ?? "Impossibile selezionare l'organizzazione richiesta.",
        );
        return;
      }

      router.push(`/o/${slug}/overview`);
      router.refresh();
    } catch {
      setErrorMessage("Errore di rete durante la selezione dell'organizzazione.");
    } finally {
      setSelectingSlug(null);
    }
  };

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {memberships.map((m) => {
          const isSelecting = selectingSlug === m.organizationSlug;
          return (
            <div
              key={m.organizationId}
              className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-2xs transition hover:border-indigo-300"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                      <Building2 className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <h2 className="font-semibold text-slate-900">
                        {m.organizationName}
                      </h2>
                      <p className="text-xs text-slate-500">Slug: {m.organizationSlug}</p>
                    </div>
                  </div>
                  <OrgCommercialStatusBadge status={m.organizationStatus} />
                </div>

                <div className="mt-4 flex flex-wrap gap-1.5">
                  {m.roles.map((role) => (
                    <span
                      key={role}
                      className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                    >
                      {formatRoleLabelIt(role)}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="button"
                disabled={selectingSlug !== null}
                onClick={() => {
                  void handleSelect(m.organizationSlug);
                }}
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isSelecting ? "Apertura console..." : "Apri organizzazione"}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
