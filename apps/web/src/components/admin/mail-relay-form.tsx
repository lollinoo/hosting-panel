"use client";

import { useEffect, useRef, useState } from "react";
import { MAIL_RELAY_PORTS, MailRelaySettingsInputSchema } from "@hosting-panel/contracts";
import type { MailFailureDto, MailRelaySettingsDto, MailTestResult } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { startMailRelayPolling } from "@/lib/mail-relay-poll";

const EXAMPLE_HOST = "smtp.example.com"; // examples, not copy
const EXAMPLE_DOMAIN = "hotel.it";
const BASE = "/api/admin/mail-relay";
type FieldErrors = Partial<Record<"host" | "port" | "username" | "password" | "senderDomain", string>>;

export function MailRelayForm({
  csrfToken,
  initial,
  adminEmail,
}: {
  csrfToken: string;
  initial: MailRelaySettingsDto;
  adminEmail: string;
}) {
  const m = useMessages();
  const t = m.admin.mail;
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [gaveUp, setGaveUp] = useState(false);
  const [host, setHost] = useState(initial.host ?? "");
  const [port, setPort] = useState(initial.port ?? 587);
  const [username, setUsername] = useState(initial.username ?? "");
  const [password, setPassword] = useState(""); // write-only: never filled from the server
  const [senderDomain, setSenderDomain] = useState(initial.senderDomain ?? "");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | "test" | null>(null);
  const [removing, setRemoving] = useState(false);
  const seq = useRef(0); // bumped by every write, so a poll that started earlier cannot overwrite it
  const [to, setTo] = useState(adminEmail);
  const [testResult, setTestResult] = useState<(MailTestResult & { to: string }) | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (data.applied || gaveUp) return;
    return startMailRelayPolling({
      load: async () => {
        const started = seq.current;
        const res = await fetch(BASE, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (started !== seq.current) return null;
        return res.ok && body?.data ? (body.data as MailRelaySettingsDto) : null;
      },
      onData: setData,
      onGiveUp: () => setGaveUp(true),
    });
  }, [data.applied, gaveUp]);

  const fieldText = (key: string): string | null => {
    const f = t.field as Record<string, string>;
    return Object.hasOwn(f, key) ? f[key]! : null;
  };

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => null) };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const input = { host: host.trim(), port, username, senderDomain: senderDomain.trim(), ...(password ? { password } : {}) };
    const errs: FieldErrors = {};
    const parsed = MailRelaySettingsInputSchema.safeParse(input);
    if (!parsed.success) {
      for (const i of parsed.error.issues) errs[i.path[0] as keyof FieldErrors] ??= i.message;
    }
    const unknown = Object.values(errs).some((k) => !fieldText(k!));
    if (!password && !data.passwordSet) errs.password = "password_required";
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      if (unknown) setError(m.errors.VALIDATION_ERROR);
      return;
    }
    seq.current++;
    setBusy("save");
    try {
      const { res, json } = await call("PATCH", BASE, input);
      if (res.ok && json?.data) {
        seq.current++;
        setData(json.data);
        setGaveUp(false);
        setPassword("");
        setNotice(t.saved);
        return;
      }
      const code: string = json?.error?.code ?? "";
      const details: { field?: string; message?: string }[] = json?.error?.details ?? [];
      const known = code === "VALIDATION_ERROR" ? details.filter((d) => d.message && fieldText(d.message)) : [];
      if (known.length) {
        setFieldErrors(Object.fromEntries(known.map((d) => [d.field ?? "host", d.message!])));
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
      const { res, json } = await call("DELETE", BASE);
      if (res.ok && json?.data) {
        seq.current++;
        setData(json.data);
        setPassword("");
        setHost("");
        setUsername("");
        setSenderDomain("");
        setPort(587);
        setTestResult(null);
      } else {
        setError(errorMessage(m, json?.error?.code ?? ""));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
      setRemoving(false);
    }
  }

  async function sendTest(e: React.FormEvent) {
    e.preventDefault();
    setBusy("test");
    const sentTo = to.trim();
    setTestResult(null);
    setTestError(null);
    try {
      const { res, json } = await call("POST", `${BASE}/test`, { to: sentTo });
      if (res.ok && json?.data) setTestResult({ ...json.data, to: sentTo });
      else {
        const code: string = json?.error?.code ?? "";
        const key = (json?.error?.details ?? []).map((d: { message?: string }) => d.message).find((k: string | undefined) => k && fieldText(k));
        // A timed-out send may still have gone out: say so instead of "failed".
        setTestError(code === "OPERATION_AMBIGUOUS" ? t.testAmbiguous : (code === "VALIDATION_ERROR" && key && fieldText(key)) || errorMessage(m, code));
      }
    } catch {
      setTestError(m.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  const problemText = (p: MailFailureDto["problem"]) => format(t.problem[p], { host: data.host ?? "", port: data.port ?? "" });
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const running = data.relayRunning === null ? t.unknown : data.relayRunning ? t.running : t.notRunning;
  const err = (k: keyof FieldErrors) => (fieldErrors[k] ? <p id={`mail-${k}-err`} className="text-sm text-destructive">{fieldText(fieldErrors[k]!)}</p> : null);

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
          <CardTitle className="text-base">{t.settingsTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={save} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="mail-host">{t.host}</Label>
              <Input id="mail-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" placeholder={EXAMPLE_HOST} aria-invalid={!!fieldErrors.host} aria-describedby={fieldErrors.host ? "mail-host-err" : undefined} />
              {err("host")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-port">{t.port}</Label>
              <select
                id="mail-port"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {MAIL_RELAY_PORTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-user">{t.username}</Label>
              <Input id="mail-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" aria-invalid={!!fieldErrors.username} aria-describedby={fieldErrors.username ? "mail-username-err" : undefined} />
              {err("username")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-password">{t.password}</Label>
              <Input
                id="mail-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={data.passwordSet ? t.passwordKeep : undefined}
                aria-invalid={!!fieldErrors.password}
                aria-describedby={fieldErrors.password ? "mail-password-hint mail-password-err" : "mail-password-hint"}
              />
              <p id="mail-password-hint" className="text-xs text-muted-foreground">{format(t.passwordIs, { state: data.passwordSet ? t.passwordSet : t.passwordNotSet })}</p>
              {err("password")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-domain">{t.senderDomain}</Label>
              <Input id="mail-domain" value={senderDomain} onChange={(e) => setSenderDomain(e.target.value)} autoComplete="off" placeholder={EXAMPLE_DOMAIN} aria-invalid={!!fieldErrors.senderDomain} aria-describedby={fieldErrors.senderDomain ? "mail-senderDomain-err" : undefined} />
              <p className="text-xs text-muted-foreground">{t.senderHint}</p>
              {err("senderDomain")}
              {senderDomain.trim() && <p className="text-sm text-muted-foreground">{format(t.domainHint, { domain: senderDomain.trim() })}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy !== null}>
                {busy === "save" ? t.saving : t.save}
              </Button>
              {data.configured && (
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
        <CardContent className="space-y-1 text-sm">
          {!data.configured ? (
            <p>{t.notConfigured}</p>
          ) : data.applied ? (
            <>
              <p>
                <Badge variant={data.relayRunning ? "success" : "secondary"}>{running}</Badge>
              </p>
              {data.sentLast24h !== null && <p>{format(t.sentLast24h, { count: data.sentLast24h })}</p>}
            </>
          ) : (
            <p role="status">{gaveUp ? t.notStarted : t.starting}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.testTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={sendTest}>
            <div className="space-y-1.5">
              <Label htmlFor="mail-to">{t.testTo}</Label>
              <Input id="mail-to" type="email" required value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button type="submit" disabled={busy !== null || !data.applied}>
              {busy === "test" ? t.testSending : t.testSend}
            </Button>
          </form>
          <div role="status" className="mt-3 space-y-1 text-sm">
            {testResult && (
              <>
                <p>{format(t.outcome[testResult.outcome], { to: testResult.to })}</p>
                {testResult.problem && <p>{problemText(testResult.problem)}</p>}
                {testResult.detail && <p className="font-mono text-xs text-muted-foreground">{testResult.detail}</p>}
              </>
            )}
            {testError && <p className="text-destructive">{testError}</p>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.failuresTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.failures.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noFailures}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 pr-4 font-medium">{t.colWhen}</th>
                  <th className="py-1 pr-4 font-medium">{t.colTo}</th>
                  <th className="py-1 pr-4 font-medium">{t.colState}</th>
                  <th className="py-1 font-medium">{t.colProblem}</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((f, i) => (
                  <tr key={`${f.at}-${i}`} className="border-t align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{when(f.at)}</td>
                    <td className="py-2 pr-4">{f.recipient}</td>
                    <td className="py-2 pr-4">{t.state[f.status]}</td>
                    <td className="py-2">
                      <p>{problemText(f.problem)}</p>
                      {f.detail && <p className="font-mono text-xs text-muted-foreground">{f.detail}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
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
