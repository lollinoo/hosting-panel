"use client";

import type { MeMembershipDto } from "@hosting-panel/contracts";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface OrgSwitcherProps {
  readonly currentOrgSlug: string;
  readonly memberships: readonly MeMembershipDto[];
  readonly csrfToken: string;
}

export function OrgSwitcher({
  currentOrgSlug,
  memberships,
  csrfToken,
}: OrgSwitcherProps) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (nextSlug: string): Promise<void> => {
    if (!nextSlug || nextSlug === currentOrgSlug || switching) {
      return;
    }

    setSwitching(true);
    setError(null);
    try {
      const res = await fetch("/api/session/switch-org", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ organizationSlug: nextSlug }),
      });

      if (!res.ok) {
        setError("Impossibile cambiare organizzazione.");
        return;
      }

      router.push(`/o/${nextSlug}/overview`);
      router.refresh();
    } catch {
      setError("Errore di rete durante il cambio organizzazione.");
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="space-y-1">
      <label
        htmlFor="hp-org-switcher"
        className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase"
      >
        <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
        Organizzazione attiva
      </label>
      <select
        id="hp-org-switcher"
        value={currentOrgSlug}
        disabled={switching}
        onChange={(e) => {
          void handleChange(e.target.value);
        }}
        className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-900 shadow-2xs focus:border-indigo-500 focus:outline-none disabled:opacity-60"
      >
        {memberships.map((m) => (
          <option key={m.organizationId} value={m.organizationSlug}>
            {m.organizationName}
            {m.organizationStatus === "suspended" ? " (Sospesa)" : ""}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-rose-600">{error}</p>}
    </div>
  );
}
