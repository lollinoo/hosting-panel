"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_APP_STACK_DOMAINS, type AppStackDetailDto, type AppStackDomainDto, type UpdateAppStackDomainInput } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { AppStackDomainOptions } from "./app-stack-domain-options";
import { appStackRefusalText } from "./app-stack-view";

const tone = (s: string) => (s === "active" ? "success" : s === "failed" ? "destructive" : "secondary");

/**
 * Web addresses: adding, removing and changing the options are synchronous, the answer is the whole list. `pending`
 * (ADR-0037): what is saved is not yet what the published routes hold, so no option is shown as active on its own. An
 * address being removed (issue #112) stays listed, with no button, until it stops answering; it takes no place in the limit.
 */
export function AppStackDomains({
  orgId,
  stackId,
  csrfToken,
  initial,
  ingress,
  pathTargets,
  pending,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  initial: AppStackDomainDto[] | null;
  ingress: AppStackDetailDto["ingress"];
  pathTargets: AppStackDetailDto["pathTargets"];
  pending: boolean;
}) {
  const m = useMessages();
  const t = m.apps.domains;
  const locale = useLocale();
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [rows, setRows] = useState<AppStackDomainDto[]>(initial ?? []);
  const [hostname, setHostname] = useState("");
  const [target, setTarget] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // router.refresh() keeps client state: take the fresh server rows.
  useEffect(() => {
    if (initial) setRows(initial);
  }, [initial]);
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}/domains`;
  const confirming = rows.find((d) => d.id === removing);
  const edited = rows.find((d) => d.id === editing);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const targetText = (componentKey: string, port: number) => format(m.apps.wizard.target, { component: componentKey, port });

  if (initial === null) return <p className="text-sm text-muted-foreground">{m.apps.detail.sectionError}</p>;

  /** The answer of the API, or null when it refused (the refusal is shown). */
  async function send(name: string, method: string, url: string, body: object): Promise<{ data?: unknown; applies?: unknown } | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const sent = await keyedSend(keys.current, csrfToken, name, method, url, body);
    setBusy(false);
    if (!sent.ok) {
      setError(appStackRefusalText(m, sent.code, sent.reason));
      return null;
    }
    const answer = (sent.data ?? {}) as { data?: unknown; applies?: unknown };
    if (Array.isArray(answer.data)) setRows(answer.data as AppStackDomainDto[]);
    router.refresh();
    return answer;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const to = ingress[target];
    const h = hostname.trim().toLowerCase();
    if (busy || !to || !h) return;
    // A new address starts with compression on (ADR-0037 R4); «Opzioni» turns it off.
    if (await send("add", "POST", base, { hostname: h, componentKey: to.componentKey, port: to.port, compression: true })) setHostname("");
  }

  function open(id: string) {
    setError(null);
    setNotice(null);
    setEditing(id);
  }

  // A refusal stays in the dialog, with what was typed (the password field is emptied on every send).
  async function saveOptions(id: string, body: UpdateAppStackDomainInput) {
    if (busy) return;
    const answer = await send(`options:${id}`, "PATCH", `${base}/${id}`, body);
    if (answer) {
      setEditing(null);
      // Nothing of the application is published: the options take effect when it starts.
      setNotice(answer.applies === "at_start" ? t.options.savedAtStart : t.options.saved);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    await send(`remove:${id}`, "DELETE", `${base}/${id}`, {});
    setRemoving(null);
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="space-y-1">
                <p className="font-medium">{d.hostname}</p>
                {d.removing && <p className="text-muted-foreground">{t.removingHint}</p>}
                {ingress.length > 1 && <p className="text-muted-foreground">{targetText(d.componentKey, d.port)}</p>}
                {d.redirectToDomainId !== null && (
                  <p className="text-muted-foreground">
                    {format(t.options.summary.redirect, { hostname: rows.find((r) => r.id === d.redirectToDomainId)?.hostname ?? "" })}
                  </p>
                )}
                {d.removing ? (
                  <Badge variant="outline">{t.removing}</Badge>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={tone(d.status)}>{t.status[d.status]}</Badge>
                    <Badge variant={tone(d.certificateStatus)}>{t.certificate[d.certificateStatus]}</Badge>
                    {d.protection !== null && <Badge variant="secondary">{t.options.summary.protected}</Badge>}
                    {d.pathRoutes.length > 0 && <Badge variant="secondary">{format(t.options.summary.paths, { n: d.pathRoutes.length })}</Badge>}
                    {pending && (d.redirectToDomainId !== null || d.protection !== null || d.pathRoutes.length > 0) && (
                      <Badge variant="outline">{t.options.summary.pending}</Badge>
                    )}
                    {d.certificateStatus === "active" && d.certificateExpiresAt && (
                      <time dateTime={d.certificateExpiresAt} className="text-muted-foreground">
                        {format(t.expires, { date: date.format(new Date(d.certificateExpiresAt)) })}
                      </time>
                    )}
                  </div>
                )}
              </div>
              {!d.removing && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={format(t.options.title, { hostname: d.hostname })}
                    onClick={() => open(d.id)}
                  >
                    {t.options.open}
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(d.id)}>
                    {t.remove}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {ingress.length > 0 && rows.filter((d) => !d.removing).length < MAX_APP_STACK_DOMAINS && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1 space-y-1">
            <Label htmlFor="app-domain-hostname">{m.apps.list.col.address}</Label>
            <Input
              id="app-domain-hostname"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              inputMode="url"
              autoComplete="off"
              readOnly={busy}
              aria-describedby="app-domain-hint"
            />
          </div>
          {ingress.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="app-domain-target">{m.apps.wizard.targetLabel}</Label>
              <select
                id="app-domain-target"
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {ingress.map((to, i) => (
                  <option key={i} value={i}>
                    {targetText(to.componentKey, to.port)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button type="submit" disabled={busy || hostname.trim() === ""}>
            {t.add}
          </Button>
        </form>
      )}
      <p id="app-domain-hint" className="text-sm text-muted-foreground">
        {t.hint}
      </p>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && !edited && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {edited && (
        <AppStackDomainOptions
          key={edited.id}
          domain={edited}
          rows={rows}
          ingress={pathTargets}
          busy={busy}
          error={error}
          onSave={(body) => saveOptions(edited.id, body)}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog open={confirming !== undefined} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeTitle}</DialogTitle>
            <DialogDescription>{format(t.removeBody, { hostname: confirming?.hostname ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {m.apps.actions.cancel}
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => confirming && remove(confirming.id)}>
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
