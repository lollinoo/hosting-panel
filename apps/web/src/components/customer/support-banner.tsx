"use client";

import * as React from "react";
import { PLATFORM_OPS_ORG_ID, type SupportAccessDto } from "@hosting-panel/contracts";
import { Button } from "@/components/ui/button";
import { errorMessage, format } from "@/i18n";
import { useMessages } from "@/i18n/provider";

/** Support view mark: whose sites, until when, and Leave (ends the visit, back to the admin sites). */
export function SupportBanner({ support, csrfToken }: { support: SupportAccessDto; csrfToken: string }) {
  const m = useMessages();
  const t = m.shell.support;
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Formatted in the browser's time zone; the server render may differ, hence suppressHydrationWarning.
  const time = new Date(support.expiresAt).toLocaleTimeString(m.common.dateLocale, { hour: "2-digit", minute: "2-digit" });
  const text =
    support.organizationId === PLATFORM_OPS_ORG_ID
      ? format(t.markUnassigned, { time })
      : format(t.mark, { name: support.organizationName, time });

  async function leave() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/support-access", { method: "DELETE", headers: { "X-CSRF-Token": csrfToken } }).catch(() => null);
    if (res?.ok) return window.location.assign("/admin/sites");
    const body = (await res?.json().catch(() => null)) as { error?: { code?: string } } | null;
    setError(errorMessage(m, body?.error?.code ?? ""));
    setBusy(false);
  }

  return (
    <div role="status" className="border-b bg-amber-50 px-6 py-2 text-sm text-amber-900">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
        <span suppressHydrationWarning>{text}</span>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={leave}>
          {t.leave}
        </Button>
      </div>
      {error && <p role="alert" className="mx-auto mt-1 w-full max-w-5xl text-destructive">{error}</p>}
    </div>
  );
}
