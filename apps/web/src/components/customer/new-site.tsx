"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SITE_LIMIT_REACHED_REASON } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { errorMessage, format, type Messages } from "@/i18n";
import { renewKeyAfter } from "@/lib/site-setup";
import { useMessages } from "@/i18n/provider";

export type SiteLimit = { used: number; max: number };

/** At the limit, or past it after the limit was lowered. */
export const isLimitFull = (limit: SiteLimit | null): boolean => limit !== null && limit.used >= limit.max;

/** What a refused creation shows: the field errors, the one sentence, and whether to reload the page's data. */
export function createErrorView(
  m: Messages,
  code: string,
  details: { field?: string; reason?: string }[],
): { error: string | null; fieldErrors: Record<string, string>; refresh: boolean } {
  const view = { error: null, fieldErrors: {}, refresh: false };
  if (code === "DOMAIN_CONFLICT") return { ...view, fieldErrors: { domain: m.site.create.domainConflict } };
  // Someone else may have used the last place: reloading shows the usage and the full state.
  if (code === "QUOTA_EXCEEDED" && details[0]?.reason === SITE_LIMIT_REACHED_REASON) {
    return { ...view, error: m.site.create.limitReachedSubmit, refresh: true };
  }
  if (code === "VALIDATION_ERROR" && details.some((d) => d.field)) {
    const fieldErrors: Record<string, string> = {};
    for (const d of details) if (d.field) fieldErrors[d.field.split(".").pop()!] = m.site.create.fieldInvalid;
    return { ...view, fieldErrors };
  }
  return { ...view, error: errorMessage(m, code) };
}

export function NewSite({ orgId, csrfToken, limit }: { orgId: string; csrfToken: string; limit: SiteLimit | null }) {
  const m = useMessages();
  const router = useRouter();
  // One key per page instance: a double click or a retry after a lost reply cannot create two sites.
  const idempotencyKey = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(body: SiteFormBody) {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/managed-sites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 202 && data?.data?.siteId) {
        router.push(`/sites/${data.data.siteId}`);
        return;
      }
      const view = createErrorView(m, data?.error?.code ?? "", data?.error?.details ?? []);
      setError(view.error);
      setFieldErrors(view.fieldErrors);
      if (view.refresh) router.refresh();
      // A 4xx is not stored under its key and a fixed form is a new request; after a 5xx the same key must replay.
      if (renewKeyAfter(res.status)) idempotencyKey.current = crypto.randomUUID();
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{m.site.create.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{m.site.create.intro}</p>
      </div>
      {limit && (
        <p className="text-sm text-muted-foreground" data-site-usage>
          {format(m.site.create.usage, limit)}
        </p>
      )}
      {limit && isLimitFull(limit) ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{format(m.site.create.limitReached, { max: limit.max })}</AlertDescription>
        </Alert>
      ) : (
        <>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* shortcut: creation takes the legacy type's form, there is no type chooser (ADR 0029). */}
          <SiteForm onSubmit={submit} submitting={busy} fieldErrors={fieldErrors} />
        </>
      )}
    </div>
  );
}
