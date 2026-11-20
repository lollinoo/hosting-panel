"use client";

import { useEffect, useRef, useState } from "react";
import { DNS_PROVIDERS, DNS_PROVIDER_FIELDS, DnsProviderSettingsInputSchema } from "@hosting-panel/contracts";
import type { DnsProvider, DnsProviderSettingsDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { startMailRelayPolling } from "@/lib/mail-relay-poll";

const BASE = "/api/admin/dns-provider";

export function DnsProviderForm({ csrfToken, initial }: { csrfToken: string; initial: DnsProviderSettingsDto }) {
  const m = useMessages();
  const t = m.admin.certificates;
  const [data, setData] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);
  const [provider, setProvider] = useState<DnsProvider | "">(initial.provider ?? "");
  const [values, setValues] = useState<Record<string, string>>({}); // write-only: never filled from the server
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [removing, setRemoving] = useState(false);
  const seq = useRef(0); // bumped by every write, so a poll that started earlier cannot overwrite it

  useEffect(() => {
    if (data.applied || gaveUp) return;
    return startMailRelayPolling({
      load: async () => {
        const started = seq.current;
        const res = await fetch(BASE, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (started !== seq.current) return null;
        return res.ok && body?.data ? (body.data as DnsProviderSettingsDto) : null;
      },
      onData: setData,
      onGiveUp: () => setGaveUp(true),
    });
  }, [data.applied, gaveUp]);

  const fieldText = (key: string): string | null => {
    const f = t.field as Record<string, string>;
    return Object.hasOwn(f, key) ? f[key]! : null;
  };
  const fields = provider ? DNS_PROVIDER_FIELDS[provider] : [];
  const stored = (name: string) => data.provider === provider && data.fieldsSet.includes(name);

  function choose(p: DnsProvider) {
    setProvider(p);
    setValues({});
    setFieldErrors({});
  }

  async function call(method: string, body?: unknown) {
    const res = await fetch(BASE, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => null) };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!provider) return;
    setError(null);
    setNotice(null);
    const input = { provider, credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "")) };
    const errs: Record<string, string> = {};
    let unknown = false;
    const parsed = DnsProviderSettingsInputSchema.safeParse(input);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        if (i.path[0] === "credentials" && typeof i.path[1] === "string") errs[i.path[1]] ??= i.message;
        else unknown = true;
      }
    }
    for (const f of fields) if (f.required && !input.credentials[f.name] && !stored(f.name)) errs[f.name] ??= "field_required";
    if (Object.values(errs).some((k) => !fieldText(k))) unknown = true;
    setFieldErrors(errs);
    if (unknown || Object.keys(errs).length) {
      if (unknown) setError(m.errors.VALIDATION_ERROR);
      return;
    }
    seq.current++;
    setBusy("save");
    try {
      const { res, json } = await call("PATCH", input);
      if (res.ok && json?.data) {
        seq.current++;
        setData(json.data);
        setGaveUp(false);
        setValues({});
        setNotice(t.saved);
        return;
      }
      const code: string = json?.error?.code ?? "";
      const details: { field?: string; message?: string }[] = json?.error?.details ?? [];
      const known = code === "VALIDATION_ERROR" ? details.filter((d) => d.message && fieldText(d.message)) : [];
      if (known.length) {
        setFieldErrors(Object.fromEntries(known.map((d) => [(d.field ?? "").replace(/^credentials\./, ""), d.message!])));
        setError(fieldText(known[0]!.message!));
      } else {
        setError(errorMessage(m, code));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    seq.current++;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      const { res, json } = await call("DELETE");
      if (res.ok && json?.data) {
        seq.current++;
        setData(json.data);
        setProvider("");
        setValues({});
        setFieldErrors({});
      } else {
        const details: { reason?: string }[] = json?.error?.details ?? [];
        setError(details.some((d) => d.reason === "dns_challenge_in_use") ? t.inUse : errorMessage(m, json?.error?.code ?? ""));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
      setRemoving(false);
    }
  }

  const status = !data.provider ? (
    <p>{t.notConfigured}</p>
  ) : !data.applied ? (
    <p role="status">{gaveUp ? t.notApplied : t.applying}</p>
  ) : data.ready === true ? (
    <p>
      <Badge variant="success">{t.ready}</Badge>
    </p>
  ) : (
    <p>{data.ready === false ? t.notReady : t.unknown}</p>
  );

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.providerTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={save} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="dns-provider">{t.provider}</Label>
              <select
                id="dns-provider"
                value={provider}
                onChange={(e) => choose(e.target.value as DnsProvider)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="" disabled>
                  {t.providerChoose}
                </option>
                {DNS_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {t.providers[p]}
                  </option>
                ))}
              </select>
            </div>
            {fields.length > 0 && <p className="text-xs text-muted-foreground">{t.fieldsHint}</p>}
            {fields.map((f) => {
              const id = `dns-${f.name}`;
              const err = fieldErrors[f.name];
              return (
                <div key={f.name} className="space-y-1.5">
                  <Label htmlFor={id} className="flex items-center gap-2">
                    <span className="font-mono">{f.name}</span>
                    {!f.required && <span className="text-xs text-muted-foreground">{t.optional}</span>}
                    {stored(f.name) && <Badge variant="secondary">{t.fieldSet}</Badge>}
                  </Label>
                  <Input
                    id={id}
                    type={f.name.endsWith("_ENDPOINT") ? "text" : "password"}
                    value={values[f.name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    autoComplete="new-password"
                    placeholder={stored(f.name) ? t.keep : undefined}
                    aria-invalid={!!err}
                    aria-describedby={err ? `${id}-err` : undefined}
                  />
                  {err && (
                    <p id={`${id}-err`} className="text-sm text-destructive">
                      {fieldText(err) ?? m.errors.VALIDATION_ERROR}
                    </p>
                  )}
                </div>
              );
            })}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null || !provider}>
                {busy === "save" ? t.saving : t.save}
              </Button>
              {data.provider && (
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setRemoving(true)}>
                  {t.remove}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.statusTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">{status}</CardContent>
      </Card>

      <Dialog open={removing} onOpenChange={(o) => !o && setRemoving(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeTitle}</DialogTitle>
            <DialogDescription>{t.removeConfirm}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(false)}>
              {t.cancel}
            </Button>
            <Button type="button" variant="destructive" disabled={busy !== null} onClick={remove}>
              {busy === "remove" ? t.removing : t.remove}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
