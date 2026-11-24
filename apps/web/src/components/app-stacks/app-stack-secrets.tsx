"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APP_STACK_PROCESS_MARK_PATTERN,
  APP_STACK_SECRET_MIN_LENGTH,
  SetAppStackSecretInputSchema,
  type AppStackDetailDto,
} from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appStackRefusalText, appStackSecretRefusalText } from "./app-stack-view";

/** Private values are write-only: a row says whether one is set; the typed value lives only in the field until it is sent. */
export function AppStackSecrets({
  orgId,
  stackId,
  csrfToken,
  secrets,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  secrets: AppStackDetailDto["secretParameters"];
}) {
  const m = useMessages();
  const t = m.apps.secrets;
  const locale = useLocale();
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const row = secrets.find((s) => s.key === editing);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  if (secrets.length === 0) return null;

  function open(key: string) {
    setFieldError(null);
    setError(null);
    setNotice(null);
    setEditing(key);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!row || busy) return;
    const value = inputRef.current?.value ?? "";
    if (!value) return setFieldError(m.apps.wizard.required);
    // The server refuses such a value with no reason a page can show: say it here (ADR-0041).
    if (APP_STACK_PROCESS_MARK_PATTERN.test(value)) return setFieldError(m.apps.wizard.valueReserved);
    // The proxy refuses a shorter value with no reason either; the log reader could not mask it (BUG-43).
    if (value.length < APP_STACK_SECRET_MIN_LENGTH) return setFieldError(appStackRefusalText(m, "VALIDATION_ERROR", "value_too_short"));
    setBusy(true);
    setFieldError(null);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, `secret:${row.key}`, "POST", `/api/bff/orgs/${orgId}/app-stacks/${stackId}/secrets`, {
      parameterKey: row.key,
      value,
    });
    if (inputRef.current) inputRef.current.value = "";
    setBusy(false);
    if (sent.ok) {
      setEditing(null);
      setNotice(t.replaced);
      router.refresh();
    } else if (sent.reason === "value_too_long" || sent.reason === "value_too_short") setFieldError(appStackSecretRefusalText(m, sent));
    else setError(appStackRefusalText(m, sent.code, sent.reason));
  }

  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">{t.title}</h3>
      <ul className="divide-y rounded-md border text-sm">
        {secrets.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.label}</span>
                <Badge variant={s.isSet ? "success" : "warning"}>{s.isSet ? t.set : t.unset}</Badge>
                {s.required && <span className="text-muted-foreground">{t.required}</span>}
              </div>
              {(s.version !== null || s.setAt) && (
                <p className="flex flex-wrap gap-x-3 text-muted-foreground">
                  {s.version !== null && <span>{format(m.apps.catalog.version, { n: s.version })}</span>}
                  {s.setAt && <time dateTime={s.setAt}>{date.format(new Date(s.setAt))}</time>}
                </p>
              )}
            </div>
            <Button type="button" variant="outline" size="sm" aria-label={format(t.replaceNamed, { label: s.label })} onClick={() => open(s.key)}>
              {s.isSet ? t.replace : t.setNow}
            </Button>
          </li>
        ))}
      </ul>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <Dialog open={row !== undefined} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent>
          {row && (
            <form onSubmit={submit} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{format(t.replaceNamed, { label: row.label })}</DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="app-secret-value">{format(t.newValue, { label: row.label })}</Label>
                <Input
                  id="app-secret-value"
                  ref={inputRef}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={SetAppStackSecretInputSchema.shape.value.maxLength ?? undefined}
                  readOnly={busy}
                  aria-describedby="app-secret-value-note"
                  aria-invalid={fieldError !== null || undefined}
                />
                <p id="app-secret-value-note" className="text-sm text-muted-foreground">
                  {t.writeOnly}
                </p>
                {fieldError && (
                  <p role="alert" className="text-sm text-destructive">
                    {fieldError}
                  </p>
                )}
              </div>
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                  {m.apps.actions.cancel}
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? t.saving : t.save}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
