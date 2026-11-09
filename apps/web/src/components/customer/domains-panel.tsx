"use client";

import { useEffect, useRef, useState } from "react";
import type { SiteDomainDto, SiteDomainsDto } from "@hosting-panel/contracts";
import { suggestWwwPair } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { domainView } from "@/lib/domain-view";

export { domainView };

const POLL_MS = 5000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const VARIANT = { ok: "success", warn: "warning", error: "destructive", muted: "secondary" } as const;

export function DomainsPanel({
  basePath,
  csrfToken,
  initial,
}: {
  basePath: string;
  csrfToken: string;
  initial: SiteDomainsDto;
}) {
  const m = useMessages();
  const t = m.site.domains;
  const locale = useLocale();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SiteDomainDto | null>(null);
  const [hostname, setHostname] = useState("");
  const [www, setWww] = useState<boolean | null>(null); // null = follow the suggestion
  const [copied, setCopied] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  const primary = data.domains.find((d) => d.isPrimary) ?? data.domains[0];
  const now = new Date();
  const views = new Map(data.domains.map((d) => [d.id, domainView(d, primary!, now)]));
  const needsPoll = data.routesPending || [...views.values()].some((v) => v.label === "securing" || v.label === "settingUp");

  useEffect(() => {
    if (!needsPoll) return;
    const timer = setInterval(async () => {
      if (Date.now() - startedAt.current > POLL_LIMIT_MS) return clearInterval(timer);
      try {
        const res = await fetch(basePath, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.data) setData(body.data);
      } catch {
        // the next tick tries again
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [needsPoll, basePath]);

  async function send(name: string, method: string, url: string, body?: unknown): Promise<boolean> {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.data) {
        startedAt.current = Date.now();
        setData(json.data);
        return true;
      }
      const code: string = json?.error?.code ?? "";
      setError(
        code === "DOMAIN_CONFLICT"
          ? t.conflict
          : code === "VALIDATION_ERROR" && typeof json?.error?.message === "string"
            ? json.error.message
            : errorMessage(m, code),
      );
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
    }
    return false;
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      // the value is on screen to select by hand
    }
  };

  // Moving the main address is only offered to a name with working HTTPS, or while no name has it yet.
  const onHttp = !data.domains.some((d) => d.certificate.status === "active");
  const when = (iso: string | null) =>
    iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "";
  const hintText = (d: SiteDomainDto) => {
    const key = views.get(d.id)!.hint;
    if (!key) return null;
    const time = when(d.certificate.retryAt ?? d.dns.nextCheckAt);
    // Without a time, drop the "We'll try again on {time}" sentence rather than print a gap.
    const text = time ? t.hint[key] : t.hint[key].split(/(?<=\.)\s+/).filter((s) => !s.includes("{time}")).join(" ");
    return format(text, { host: d.hostname, ip: data.serverIpv4, seen: d.dns.observedA.join(", "), time });
  };
  const suggested = suggestWwwPair(hostname.trim().toLowerCase());
  const includeWww = www ?? suggested;

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.recordsTitle}</CardTitle>
          <p className="text-sm text-muted-foreground">{t.recordsIntro}</p>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-4 font-medium">{t.type}</th>
                <th className="py-1 pr-4 font-medium">{t.name}</th>
                <th className="py-1 font-medium">{t.value}</th>
              </tr>
            </thead>
            <tbody>
              {data.domains.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="py-2 pr-4">A</td>
                  <td className="py-2 pr-4 font-mono">{d.hostname}</td>
                  <td className="py-2">
                    <span className="font-mono">{data.serverIpv4}</span>{" "}
                    <Button type="button" variant="outline" size="sm" aria-label={format(t.copyFor, { host: d.hostname })} onClick={() => copy(data.serverIpv4)}>
                      {copied === data.serverIpv4 ? t.copied : t.copy}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {data.routesPending && (
        <Alert role="status">
          <AlertDescription>{t.pending}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="divide-y p-0">
          {data.domains.map((d) => {
            const v = views.get(d.id)!;
            const hint = hintText(d);
            const canMakeMain = !d.isPrimary && (v.label === "secure" || onHttp);
            return (
              <div key={d.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium">{d.hostname}</span>
                  <Badge variant={VARIANT[v.tone]}>{t.state[v.label]}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {d.isPrimary ? t.mainAddress : format(t.redirectsTo, { host: primary!.hostname })}
                  </span>
                </div>
                {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
                <div className="flex flex-wrap gap-2">
                  {canMakeMain && (
                    <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => send(`primary:${d.id}`, "POST", `${basePath}/${d.id}/primary`)}>
                      {t.makeMain}
                    </Button>
                  )}
                  <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => send(`check:${d.id}`, "POST", `${basePath}/${d.id}/check`)}>
                    {busy === `check:${d.id}` ? t.checking : t.checkNow}
                  </Button>
                  {!d.isPrimary && (
                    <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setRemoving(d)}>
                      {t.remove}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.addTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await send("add", "POST", basePath, { hostname: hostname.trim().toLowerCase(), includeWww })) {
                setHostname("");
                setWww(null);
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="domain-hostname">{t.hostname}</Label>
              <Input id="domain-hostname" value={hostname} onChange={(e) => setHostname(e.target.value)} autoComplete="off" required />
              <p className="text-xs text-muted-foreground">{t.hostnameHint}</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeWww} onChange={(e) => setWww(e.target.checked)} />
              {t.alsoWww}
            </label>
            <Button type="submit" disabled={busy !== null}>
              {busy === "add" ? t.adding : t.add}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Dialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{format(t.removeTitle, { host: removing?.hostname ?? "" })}</DialogTitle>
            <DialogDescription>{format(t.removeConfirm, { host: removing?.hostname ?? "" })}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== null}
              onClick={async () => {
                const d = removing!;
                await send(`remove:${d.id}`, "DELETE", `${basePath}/${d.id}`);
                setRemoving(null);
              }}
            >
              {busy?.startsWith("remove:") ? t.removing : t.remove}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
