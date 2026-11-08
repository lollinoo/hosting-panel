"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/** Logged in (csrfToken given): saves the choice on the account. Logged out: remembers it in a cookie. */
export function LanguageSwitch({ csrfToken, className }: { csrfToken?: string; className?: string }) {
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function choose(next: Locale) {
    if (next === locale || busy) return;
    setFailed(false);
    if (csrfToken) {
      setBusy(true);
      try {
        const res = await fetch("/api/account/locale", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({ locale: next }),
        });
        if (!res.ok) return setFailed(true);
      } catch {
        return setFailed(true);
      } finally {
        setBusy(false);
      }
    } else {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    }
    // Re-renders the root layout too, which owns the I18nProvider locale.
    router.refresh();
  }

  return (
    <div className={cn("flex items-center gap-2 text-xs", className)}>
      <div role="group" aria-label={m.common.language} className="flex gap-2 text-muted-foreground">
        {(["it", "en"] as const).map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            onClick={() => choose(l)}
            aria-pressed={locale === l}
            disabled={busy}
            className={locale === l ? "font-semibold text-foreground" : "hover:underline"}
          >
            {l === "it" ? m.common.italian : m.common.english}
          </button>
        ))}
      </div>
      {failed && (
        <span role="alert" className="text-destructive">
          {m.errors.generic}
        </span>
      )}
    </div>
  );
}
