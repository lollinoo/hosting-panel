"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SITE_LIMIT_REACHED_REASON, type CustomerSiteTypeDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SITE_FORM_FIELDS, SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { SiteTypeChooser } from "@/components/customer/site-type-chooser";
import { errorMessage, format, type Messages } from "@/i18n";
import { renewKeyAfter } from "@/lib/site-setup";
import { useMessages } from "@/i18n/provider";

export type SiteLimit = { used: number; max: number };

/** At the limit, or past it after the limit was lowered. */
export const isLimitFull = (limit: SiteLimit | null): boolean => limit !== null && limit.used >= limit.max;

/**
 * What a refused creation shows: the field errors, the one sentence, and whether to reload the page's data.
 * `siteTypeSent`: the request named a site type, so "not found" means that type is gone.
 * `optionKeys`: the options the form shows, each with a note of its own; a refusal naming anything else is not left silent.
 */
export function createErrorView(
  m: Messages,
  code: string,
  details: { field?: string; reason?: string }[],
  siteTypeSent = false,
  optionKeys: readonly string[] = [],
): { error: string | null; fieldErrors: Record<string, string>; refresh: boolean } {
  const view = { error: null, fieldErrors: {}, refresh: false };
  if (code === "DOMAIN_CONFLICT") return { ...view, fieldErrors: { domain: m.site.create.domainConflict } };
  // Someone else may have used the last place: reloading shows the usage and the full state.
  if (code === "QUOTA_EXCEEDED" && details[0]?.reason === SITE_LIMIT_REACHED_REASON) {
    return { ...view, error: m.site.create.limitReachedSubmit, refresh: true };
  }
  // The list changed under the customer: reloading shows what is offered now.
  const reason = details[0]?.reason;
  if (code === "NOT_FOUND" && (siteTypeSent || reason === "template_unavailable")) return { ...view, error: m.site.create.siteTypeUnavailable, refresh: true };
  // An archived or no longer valid site type stays so: "retry" would mislead, the refreshed list shows what is offered now.
  if (code === "RESOURCE_LOCKED" && (reason === "template_archived" || reason === "template_invalid")) {
    return { ...view, error: m.site.create.siteTypeUnavailable, refresh: true };
  }
  // An option, or the PHP choice, that the form still shows but the type's current version dropped or kept for administrators: the type is
  // still offered and no retry of this form can pass, the refreshed page shows the real one.
  const optionGone = (d: { field?: string; reason?: string }) =>
    d.field?.startsWith("parameters.")
      ? d.reason === "unknown" || d.reason === "not_customer"
      : d.field === "phpVersion" && (d.reason === "not_customer" || d.reason === "not_applicable");
  if (code === "VALIDATION_ERROR" && details.some(optionGone)) return { ...view, error: m.site.create.optionsChanged, refresh: true };
  // Without a control to point at, the general sentence must not send the customer to highlighted fields (it names the form's fields instead).
  const general = code === "VALIDATION_ERROR" ? m.site.create.invalid : errorMessage(m, code);
  if (code === "VALIDATION_ERROR" && details.some((d) => d.field)) {
    const fieldErrors: Record<string, string> = {};
    // An option is reported as parameters.<key> and sits under its own control; any other field by its last part.
    for (const d of details) {
      if (d.field) fieldErrors[d.field.startsWith("parameters.") ? `param:${d.field.slice("parameters.".length)}` : d.field.split(".").pop()!] = m.site.create.fieldInvalid;
    }
    // A field with no control (an option reported by its array index, or by a key the form does not show) must not fail silently.
    const shown = new Set([...SITE_FORM_FIELDS, ...optionKeys.map((key) => `param:${key}`)]);
    return { ...view, error: Object.keys(fieldErrors).every((key) => shown.has(key)) ? null : general, fieldErrors };
  }
  return { ...view, error: general };
}

export function NewSite({
  orgId,
  csrfToken,
  siteTypes,
  limit,
  noSiteTypes = false,
}: {
  orgId: string;
  csrfToken: string;
  siteTypes: readonly CustomerSiteTypeDto[];
  limit: SiteLimit | null;
  /** The list was read and is empty (not: could not be read), so there is nothing to create. */
  noSiteTypes?: boolean;
}) {
  const m = useMessages();
  const router = useRouter();
  // One key per page instance: a double click or a retry after a lost reply cannot create two sites.
  const idempotencyKey = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [typeId, setTypeId] = useState<string | null>(siteTypes[0]?.id ?? null);
  // A choice that is no longer offered (the list was reloaded) falls back to the first one, as the chooser shows.
  const selected = siteTypes.find((type) => type.id === typeId) ?? siteTypes[0] ?? null;

  async function submit(form: SiteFormBody) {
    const body = selected ? { ...form, templateId: selected.id } : form;
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
      const view = createErrorView(m, data?.error?.code ?? "", data?.error?.details ?? [], selected !== null, selected?.parameters.map((p) => p.key));
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

  // The limit comes first: it is the cause the customer can act on, and the list may be empty for the same reason.
  const blocked = limit && isLimitFull(limit) ? format(m.site.create.limitReached, { max: limit.max }) : noSiteTypes ? m.site.create.noSiteTypes : null;

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
      {blocked ? (
        <Alert variant="warning" role="status">
          <AlertDescription>{blocked}</AlertDescription>
        </Alert>
      ) : (
        <>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {siteTypes.length > 1 && <SiteTypeChooser siteTypes={siteTypes} value={selected?.id ?? null} onChange={setTypeId} />}
          <SiteForm onSubmit={submit} submitting={busy} fieldErrors={fieldErrors} siteType={selected} />
        </>
      )}
    </div>
  );
}
