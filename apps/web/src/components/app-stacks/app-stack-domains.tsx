"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_APP_STACK_DOMAINS, type AppStackDetailDto, type AppStackDomainDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appStackRefusalText } from "./app-stack-view";

const tone = (s: string) => (s === "active" ? "success" : s === "failed" ? "destructive" : "secondary");

/** Web addresses: adding and removing are synchronous, the answer is the whole list. */
export function AppStackDomains({
  orgId,
  stackId,
  csrfToken,
  initial,
  ingress,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  initial: AppStackDomainDto[] | null;
  ingress: AppStackDetailDto["ingress"];
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
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}/domains`;
  const confirming = rows.find((d) => d.id === removing);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const targetText = (componentKey: string, port: number) => format(m.apps.wizard.target, { component: componentKey, port });

  if (initial === null) return <p className="text-sm text-muted-foreground">{m.apps.detail.sectionError}</p>;

  async function send(name: string, method: string, url: string, body: object): Promise<boolean> {
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, name, method, url, body);
    setBusy(false);
    if (!sent.ok) {
      setError(appStackRefusalText(m, sent.code, sent.reason));
      return false;
    }
    const list = (sent.data as { data?: unknown } | null)?.data;
    if (Array.isArray(list)) setRows(list as AppStackDomainDto[]);
    router.refresh();
    return true;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const to = ingress[target];
    const h = hostname.trim().toLowerCase();
    if (busy || !to || !h) return;
    if (await send("add", "POST", base, { hostname: h, componentKey: to.componentKey, port: to.port })) setHostname("");
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
                {ingress.length > 1 && <p className="text-muted-foreground">{targetText(d.componentKey, d.port)}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={tone(d.status)}>{t.status[d.status]}</Badge>
                  <Badge variant={tone(d.certificateStatus)}>{t.certificate[d.certificateStatus]}</Badge>
                  {d.certificateStatus === "active" && d.certificateExpiresAt && (
                    <time dateTime={d.certificateExpiresAt} className="text-muted-foreground">
                      {format(t.expires, { date: date.format(new Date(d.certificateExpiresAt)) })}
                    </time>
                  )}
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(d.id)}>
                {t.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {ingress.length > 0 && rows.length < MAX_APP_STACK_DOMAINS && (
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
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
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
