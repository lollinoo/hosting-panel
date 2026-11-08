"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";

export function NewSite({ orgId, csrfToken }: { orgId: string; csrfToken: string }) {
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
      const code: string = data?.error?.code ?? "";
      const details: { field?: string }[] = data?.error?.details ?? [];
      if (code === "DOMAIN_CONFLICT") {
        setFieldErrors({ domain: m.site.create.domainConflict });
      } else if (code === "VALIDATION_ERROR" && details.some((d) => d.field)) {
        const found: Record<string, string> = {};
        for (const d of details) if (d.field) found[d.field.split(".").pop()!] = m.site.create.fieldInvalid;
        setFieldErrors(found);
      } else {
        setError(errorMessage(m, code));
      }
      // A rejected request is not stored under its key, but a fixed form is a new request anyway.
      idempotencyKey.current = crypto.randomUUID();
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
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <SiteForm onSubmit={submit} submitting={busy} fieldErrors={fieldErrors} />
    </div>
  );
}
