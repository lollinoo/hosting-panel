"use client";

import { useState } from "react";
import { NOTIFICATION_CHANNEL_KINDS, NOTIFICATION_MAX_RECIPIENTS } from "@hosting-panel/contracts";
import type {
  NotificationChannelKind,
  NotificationDeliveryDto,
  NotificationGroup,
  NotificationSettingsDto,
  NotificationTestResultDto,
} from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { notificationChannelInput, notificationInputErrors } from "@/lib/notification-form";
import type { NotificationField as Field, NotificationFieldErrors as FieldErrors } from "@/lib/notification-form";

const EXAMPLE_ADDRESS = "https://hooks.example.com/alerts"; // examples, not copy
const EXAMPLE_CHAT = "-1001234567890";

interface ChannelCardProps {
  kind: NotificationChannelKind;
  data: NotificationSettingsDto;
  base: string;
  csrfToken: string;
  onData: (next: NotificationSettingsDto) => void;
}

/** One channel: what is saved, the fields to change it, a test message and its removal. */
function ChannelCard({ kind, data, base, csrfToken, onData }: ChannelCardProps) {
  const m = useMessages();
  const t = m.notifications;
  const saved = data.channels[kind];
  const hook = data.channels.webhook;
  const bot = data.channels.telegram;
  const forServer = data.audience === "server";
  const target = `${base}/channels/${kind}`;
  const [enabled, setEnabled] = useState(saved?.enabled ?? true);
  const [groups, setGroups] = useState<readonly NotificationGroup[]>(saved?.groups ?? data.groups);
  const [recipients, setRecipients] = useState((data.channels.email?.recipients ?? []).join("\n"));
  const [url, setUrl] = useState(""); // write-only: never filled from the server
  const [signingKey, setSigningKey] = useState(""); // write-only
  const [dropKey, setDropKey] = useState(false);
  const [botToken, setBotToken] = useState(""); // write-only
  const [chat, setChat] = useState(bot?.chat ?? "");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tested, setTested] = useState<NotificationTestResultDto | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | "test" | null>(null);
  const [removing, setRemoving] = useState(false);

  const fieldText = (key: string): string | null => {
    const f = t.field as Record<string, string>;
    return Object.hasOwn(f, key) ? format(f[key]!, { max: NOTIFICATION_MAX_RECIPIENTS }) : null;
  };

  async function call(method: string, to: string, body?: unknown) {
    const res = await fetch(to, {
      method,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => null) };
  }

  function start() {
    setError(null);
    setNotice(null);
    setTested(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    start();
    const values = { enabled, groups, recipients, url, signingKey, dropKey, botToken, chat };
    const input = notificationChannelInput(kind, data.audience, data.groups, values);
    const errs = notificationInputErrors(kind, data.audience, saved === null, input);
    setFieldErrors(errs.fields);
    if (errs.other) setError(m.errors.VALIDATION_ERROR);
    if (errs.other || Object.keys(errs.fields).length) return;
    setBusy("save");
    try {
      const { res, json } = await call("PUT", target, input);
      if (res.ok && json?.data) {
        onData(json.data as NotificationSettingsDto);
        setUrl("");
        setSigningKey("");
        setDropKey(false);
        setBotToken("");
        setNotice(t.saved);
        return;
      }
      const code: string = json?.error?.code ?? "";
      const details: { field?: string; message?: string }[] = json?.error?.details ?? [];
      const known = code === "VALIDATION_ERROR" ? details.filter((d) => d.message && fieldText(d.message)) : [];
      if (known.length) setFieldErrors(Object.fromEntries(known.map((d) => [d.field ?? "groups", d.message!])));
      else setError(errorMessage(m, code));
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    start();
    setBusy("remove");
    try {
      const { res, json } = await call("DELETE", target);
      if (res.ok && json?.data) {
        onData(json.data as NotificationSettingsDto);
        setEnabled(true);
        setGroups(data.groups);
        setRecipients("");
        setChat("");
        setUrl("");
        setSigningKey("");
        setDropKey(false);
        setBotToken("");
        setFieldErrors({});
        setNotice(t.removed);
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

  async function sendTest() {
    start();
    setBusy("test");
    try {
      const { res, json } = await call("POST", `${target}/test`);
      if (res.ok && json?.data) {
        setTested(json.data as NotificationTestResultDto);
        // The message is in the list of the latest ones now.
        const fresh = await fetch(base, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (fresh?.data) onData(fresh.data as NotificationSettingsDto);
      } else {
        const code: string = json?.error?.code ?? "";
        setError(code === "RATE_LIMITED" ? t.testTooSoon : code === "NOT_SUPPORTED" ? t.testNoRecipient : errorMessage(m, code));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  const id = (name: string) => `notify-${kind}-${name}`;
  const err = (k: Field) =>
    fieldErrors[k] ? (
      <p id={id(`${k}-err`)} className="text-sm text-destructive">
        {fieldText(fieldErrors[k]!)}
      </p>
    ) : null;
  const described = (k: Field, hint?: string) => [hint, fieldErrors[k] ? id(`${k}-err`) : null].filter(Boolean).join(" ") || undefined;
  const intro = kind === "email" ? t.email.intro[data.audience] : t[kind].intro;
  const state = saved === null ? t.state.none : saved.enabled ? t.state.on : t.state.off;
  const groupText = t.group[data.audience] as Record<string, string>;
  const hintClass = "text-xs text-muted-foreground";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{t[kind].title}</CardTitle>
          <Badge variant={saved?.enabled ? "success" : "secondary"}>{state}</Badge>
        </div>
        <CardDescription>{intro}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save} noValidate>
          {kind === "email" && !data.mailReady && (
            <Alert role="status">
              <AlertDescription>{t.mailNotReady[data.audience]}</AlertDescription>
            </Alert>
          )}
          {kind === "email" && forServer && (
            <div className="space-y-1.5">
              <Label htmlFor={id("recipients")}>{t.email.recipients}</Label>
              <Textarea
                id={id("recipients")}
                rows={3}
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!fieldErrors.recipients}
                aria-describedby={described("recipients", id("recipients-hint"))}
              />
              <p id={id("recipients-hint")} className={hintClass}>
                {format(t.email.recipientsHint, { max: NOTIFICATION_MAX_RECIPIENTS })}
              </p>
              {err("recipients")}
            </div>
          )}
          {kind === "webhook" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={id("url")}>{t.webhook.url}</Label>
                <Input
                  id={id("url")}
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={EXAMPLE_ADDRESS}
                  aria-invalid={!!fieldErrors.url}
                  aria-describedby={described("url", id("url-hint"))}
                />
                <p id={id("url-hint")} className={hintClass}>
                  {hook ? format(t.webhook.urlStored, { host: hook.host }) : t.webhook.urlHint}
                </p>
                {err("url")}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id("signingKey")}>{t.webhook.signingKey}</Label>
                <Input
                  id={id("signingKey")}
                  type="password"
                  value={signingKey}
                  onChange={(e) => setSigningKey(e.target.value)}
                  autoComplete="new-password"
                  disabled={dropKey}
                  placeholder={hook?.signed ? t.webhook.keyKeep : undefined}
                  aria-invalid={!!fieldErrors.signingKey}
                  aria-describedby={described("signingKey", id("signingKey-hint"))}
                />
                <div id={id("signingKey-hint")} className={hintClass}>
                  <p>{format(t.webhook.keyIs, { state: hook?.signed ? t.webhook.keySet : t.webhook.keyNotSet })}</p>
                  <p>{t.webhook.signingKeyHint}</p>
                </div>
                {hook?.signed && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={dropKey} onChange={(e) => setDropKey(e.target.checked)} />
                    {t.webhook.dropKey}
                  </label>
                )}
                {err("signingKey")}
              </div>
            </>
          )}
          {kind === "telegram" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={id("botToken")}>{t.telegram.botToken}</Label>
                <Input
                  id={id("botToken")}
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  autoComplete="new-password"
                  placeholder={bot ? t.telegram.tokenKeep : undefined}
                  aria-invalid={!!fieldErrors.botToken}
                  aria-describedby={described("botToken", id("botToken-hint"))}
                />
                <p id={id("botToken-hint")} className={hintClass}>
                  {format(t.telegram.tokenIs, { state: bot ? t.telegram.tokenSet : t.telegram.tokenNotSet })}
                </p>
                {err("botToken")}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={id("chat")}>{t.telegram.chat}</Label>
                <Input
                  id={id("chat")}
                  value={chat}
                  onChange={(e) => setChat(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={EXAMPLE_CHAT}
                  aria-invalid={!!fieldErrors.chat}
                  aria-describedby={described("chat", id("chat-hint"))}
                />
                <p id={id("chat-hint")} className={hintClass}>
                  {t.telegram.chatHint}
                </p>
                {err("chat")}
              </div>
            </>
          )}

          <fieldset className="space-y-2" aria-describedby={described("groups")}>
            <legend className="text-sm font-medium">{t.groupsLegend}</legend>
            {data.groups.map((g) => (
              <label key={g} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={groups.includes(g)}
                  onChange={(e) => setGroups(e.target.checked ? [...groups, g] : groups.filter((x) => x !== g))}
                />
                {groupText[g]}
              </label>
            ))}
            {err("groups")}
          </fieldset>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t.enabled}
          </label>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null}>
              {busy === "save" ? t.saving : t.save}
            </Button>
            {saved && (
              <>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={sendTest}>
                  {busy === "test" ? t.testing : t.test}
                </Button>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setRemoving(true)}>
                  {t.remove}
                </Button>
              </>
            )}
          </div>
          {saved && <p className={hintClass}>{t.testHint}</p>}
          <div role="status" className="space-y-1 text-sm">
            {notice && <p>{notice}</p>}
            {tested && (
              <>
                <p>{tested.outcome === "sent" ? t.testSent : t.testFailed}</p>
                {tested.problem && <p>{t.problem[tested.problem]}</p>}
                {tested.problem && tested.httpStatus !== null && <p>{format(t.httpStatus, { status: tested.httpStatus })}</p>}
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      </CardContent>

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
    </Card>
  );
}

/**
 * The notification settings of one scope, the server's or a customer's (ADR-0040 N11): three channels and the
 * latest messages. A stored address, key or token never comes back from the API, so the page shows only that it is set.
 */
export function NotificationSettings({
  csrfToken,
  initial,
  base,
}: {
  csrfToken: string;
  initial: NotificationSettingsDto;
  base: string;
}) {
  const m = useMessages();
  const t = m.notifications;
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  // Only a mail keeps where it went; a webhook or a chat message does not, and its channel may point elsewhere now.
  const to = (d: NotificationDeliveryDto): string => d.recipient ?? t[d.channel].title;

  return (
    <div className="space-y-6">
      {NOTIFICATION_CHANNEL_KINDS.map((kind) => (
        <ChannelCard key={kind} kind={kind} data={data} base={base} csrfToken={csrfToken} onData={setData} />
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.deliveries.title}</CardTitle>
          <CardDescription>{t.deliveries.hint}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.deliveries.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-4 font-medium">{t.deliveries.colWhen}</th>
                    <th className="py-1 pr-4 font-medium">{t.deliveries.colChannel}</th>
                    <th className="py-1 pr-4 font-medium">{t.deliveries.colWhat}</th>
                    <th className="py-1 pr-4 font-medium">{t.deliveries.colTo}</th>
                    <th className="py-1 font-medium">{t.deliveries.colOutcome}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deliveries.map((d) => (
                    <tr key={d.id} className="border-t align-top">
                      <td className="py-2 pr-4 whitespace-nowrap">{when(d.createdAt)}</td>
                      <td className="py-2 pr-4">{t[d.channel].title}</td>
                      <td className="py-2 pr-4">
                        {d.test ? t.deliveries.test : format(t.deliveries.events, { opened: d.opened, closed: d.closed })}
                      </td>
                      <td className="py-2 pr-4 break-all">{to(d)}</td>
                      <td className="py-2">
                        <p>{t.deliveries.status[d.status]}</p>
                        {d.problem && <p className="text-muted-foreground">{t.problem[d.problem]}</p>}
                        {d.problem && d.httpStatus !== null && (
                          <p className="text-muted-foreground">{format(t.httpStatus, { status: d.httpStatus })}</p>
                        )}
                        {d.status === "pending" && d.attempts !== 0 && (
                          <p className="text-muted-foreground">{format(t.deliveries.attempts, { count: d.attempts })}</p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
