"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminSetDomainTlsRequest, SiteDomainDto, SiteDomainsDto, TlsCertificateDto } from "@hosting-panel/contracts";
import { SiteDomainsDtoSchema, suggestWwwPair } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { TlsImportDialog } from "@/components/customer/tls-import-dialog";
import { domainErrorText, domainView, type DomainLabel } from "@/lib/domain-view";
import { keyedSend } from "@/lib/keyed-send";
import { certificatesCovering, expiryText, tlsErrorText } from "@/lib/tls-view";

export { domainView };

const POLL_MS = 5000;
const POLL_LIMIT_MS = 10 * 60 * 1000;
const VARIANT = { ok: "success", warn: "warning", error: "destructive", muted: "secondary" } as const;

/** The body of POST <domains>/<id>/tls. Never a challenge: the customer cannot pick one, the administrator has the select. */
export function tlsSwitchBody(mode: "acme"): AdminSetDomainTlsRequest;
export function tlsSwitchBody(mode: "manual", versionId: string, confirmHostname?: string): AdminSetDomainTlsRequest;
export function tlsSwitchBody(mode: "acme" | "manual", versionId?: string, confirmHostname?: string): AdminSetDomainTlsRequest {
  if (mode === "acme") return { mode };
  return confirmHostname ? { mode, versionId: versionId!, evictAcme: true, confirmHostname } : { mode, versionId: versionId! };
}

/** Administrator only: an address still on Let's Encrypt whose imported certificate was refused for the old automatic one in the way. */
export function evictionOffer(d: SiteDomainDto, certificates: TlsCertificateDto[]): { certificate: TlsCertificateDto; versionId: string } | null {
  if (d.tls.mode !== "acme") return null;
  for (const certificate of certificates) {
    const v = certificate.versions.find((x) => x.problem === "acme_eviction_required");
    if (v && certificate.coveredDomains.some((c) => c.domainId === d.id)) return { certificate, versionId: v.id };
  }
  return null;
}

/** One Idempotency-Key per (domain, body): kept for a retry after a 5xx or a lost reply, dropped after an answer. */
export function postTlsSwitch(keys: Record<string, string>, csrfToken: string, basePath: string, domainId: string, body: AdminSetDomainTlsRequest) {
  const action = `tls:${domainId}:${body.mode === "manual" ? body.versionId + ("evictAcme" in body ? ":evict" : "") : "acme"}`;
  return keyedSend(keys, csrfToken, action, "POST", `${basePath}/${domainId}/tls`, body);
}

/** Poll while the routes are pending, a name is being set up or secured, or a certificate change is applying. */
export function needsPoll(d: SiteDomainsDto, labels: readonly DomainLabel[]): boolean {
  return d.routesPending || d.domains.some((x) => x.tls.state === "applying") || labels.some((l) => l === "securing" || l === "settingUp");
}

/** The version a domain would use for a certificate: the active one, else the pending one. */
function usableVersion(c: TlsCertificateDto) {
  return c.versions.find((v) => v.id === c.activeVersionId) ?? c.versions.find((v) => v.status === "pending") ?? null;
}

type Pending =
  | { domain: SiteDomainDto; mode: "acme" }
  | { domain: SiteDomainDto; mode: "manual"; certificate: TlsCertificateDto; versionId: string; evict?: true };

export function DomainsPanel({
  basePath,
  csrfToken,
  initial,
  challenge,
  tls,
}: {
  basePath: string;
  csrfToken: string;
  initial: SiteDomainsDto;
  /** Admin only: lets the infrastructure admin pick how each certificate is obtained. */
  challenge?: { dnsAvailable: boolean };
  /** Imported certificates. Absent, or `manualAvailable` false: the panel is exactly as before. */
  tls?: { certificates: TlsCertificateDto[] | null; manualAvailable: boolean };
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
  const manualOn = tls?.manualAvailable === true;
  const [certificates, setCertificates] = useState<TlsCertificateDto[]>(tls?.certificates ?? []);
  const [choosing, setChoosing] = useState<Set<string>>(new Set()); // rows whose "imported certificate" radio is picked but not confirmed
  const [pending, setPending] = useState<Pending | null>(null);
  const [typed, setTyped] = useState("");
  const [importing, setImporting] = useState<{ domain: SiteDomainDto; certificate?: TlsCertificateDto } | null>(null);
  const tlsKeys = useRef<Record<string, string>>({});
  const siteBase = basePath.replace(/\/domains$/, "");

  const primary = data.domains.find((d) => d.isPrimary) ?? data.domains[0];
  const now = new Date();
  const views = new Map(data.domains.map((d) => [d.id, domainView(d, primary!, now)]));
  const polling = needsPoll(data, [...views.values()].map((v) => v.label));

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(async () => {
      if (Date.now() - startedAt.current > POLL_LIMIT_MS) return clearInterval(timer);
      try {
        const res = await fetch(basePath, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.data) setData(body.data);
        if (challenge && manualOn) await refreshCertificates();
      } catch {
        // the next tick tries again
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, basePath]);

  async function send(
    name: string,
    method: string,
    url: string,
    body?: unknown,
    errorText?: (code: string, details: { reason?: string }[]) => string | null,
  ): Promise<boolean> {
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
      const details = json?.error?.details ?? [];
      setError(errorText?.(code, details) ?? domainErrorText(t, code, details) ?? errorMessage(m, code));
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
    const noTime = t.hintNoTime as Partial<Record<typeof key, string>>;
    const text = (!time && noTime[key]) || t.hint[key];
    return format(text, { host: d.hostname, ip: data.serverIpv4, seen: d.dns.observedA.join(", "), time });
  };
  const adminError = (code: string, details: { reason?: string }[]) =>
    code === "VALIDATION_ERROR" && details.some((x) => x.reason === "dns_provider_missing") ? m.admin.sites.challenge.noProvider : null;
  const refreshCertificates = async () => {
    try {
      const res = await fetch(`${siteBase}/tls-certificates`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data)) setCertificates(body.data);
    } catch {
      // the list is refreshed on the next change
    }
  };
  const confirmSwitch = async () => {
    const p = pending!;
    setBusy(`tls:${p.domain.id}`);
    setError(null);
    const body = p.mode === "manual" ? tlsSwitchBody("manual", p.versionId, p.evict ? typed.trim().toLowerCase() : undefined) : tlsSwitchBody("acme");
    const res = await postTlsSwitch(tlsKeys.current, csrfToken, basePath, p.domain.id, body);
    setBusy(null);
    setPending(null);
    if (!res.ok) {
      const details = res.reason ? [{ reason: res.reason }] : [];
      setError(tlsErrorText(m, res.code, details) ?? domainErrorText(t, res.code, details) ?? errorMessage(m, res.code));
      return;
    }
    startedAt.current = Date.now();
    setChoosing((c) => (c.delete(p.domain.id), new Set(c)));
    const parsed = SiteDomainsDtoSchema.safeParse((res.data as { data?: unknown } | null)?.data);
    if (parsed.success) setData(parsed.data);
    else {
      const again = await fetch(basePath, { cache: "no-store" }).catch(() => null);
      const json = await again?.json().catch(() => null);
      if (again?.ok && json?.data) setData(json.data);
    }
    void refreshCertificates();
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

      {challenge && !challenge.dnsAvailable && (
        <Alert role="note">
          <AlertDescription>{m.admin.sites.challenge.noProvider}</AlertDescription>
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
                {manualOn && d.tls.state === "applying" && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {t.tls.applying}
                  </p>
                )}
                {manualOn && d.tls.state === "failed" && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>
                      {t.tls.failed} {(d.tls.problem && Object.hasOwn(t.tls.problem, d.tls.problem) ? (t.tls.problem as Record<string, string>)[d.tls.problem] : t.tls.problem.other)}
                    </AlertDescription>
                  </Alert>
                )}
                {challenge && manualOn && (() => {
                  const offer = evictionOffer(d, certificates);
                  return offer ? (
                    <Alert variant="warning" role="alert">
                      <AlertDescription className="space-y-2">
                        <p>{format(m.admin.sites.tlsEvict.offer, { host: d.hostname, name: offer.certificate.name })}</p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => {
                            setTyped("");
                            setPending({ domain: d, mode: "manual", certificate: offer.certificate, versionId: offer.versionId, evict: true });
                          }}
                        >
                          {m.admin.sites.tlsEvict.open}
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null;
                })()}
                {manualOn && (
                  <TlsSource
                    d={d}
                    certificates={certificates}
                    choosing={choosing.has(d.id)}
                    disabled={busy !== null}
                    when={now}
                    onAcme={() => {
                      if (d.tls.mode === "manual") setPending({ domain: d, mode: "acme" });
                      else setChoosing((c) => (c.delete(d.id), new Set(c)));
                    }}
                    onManual={() => setChoosing((c) => new Set(c).add(d.id))}
                    onPick={(c) => {
                      const v = usableVersion(c);
                      if (v && c.id !== d.tls.certificateId) setPending({ domain: d, mode: "manual", certificate: c, versionId: v.id });
                    }}
                    onImport={(c) => setImporting({ domain: d, certificate: c })}
                  />
                )}
                {manualOn && d.tls.mode === "manual" ? null : challenge ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Label htmlFor={`challenge-${d.id}`}>{m.admin.sites.challenge.label}</Label>
                    <select
                      id={`challenge-${d.id}`}
                      className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                      value={d.challenge}
                      disabled={busy !== null}
                      onChange={(e) => send(`challenge:${d.id}`, "PATCH", `${basePath}/${d.id}`, { challenge: e.target.value }, adminError)}
                    >
                      <option value="http-01">{m.admin.sites.challenge["http-01"]}</option>
                      <option value="dns-01" disabled={!challenge.dnsAvailable && d.challenge !== "dns-01"}>
                        {m.admin.sites.challenge["dns-01"]}
                      </option>
                    </select>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t.challenge[d.challenge]}</p>
                )}
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

      <Alert role="note">
        <AlertDescription>
          {data.mail.configured && data.mail.fromAddress
            ? format(t.mail.configured, { from: data.mail.fromAddress })
            : t.mail.notConfigured}
        </AlertDescription>
      </Alert>

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

      <Dialog open={pending !== null} onOpenChange={(o) => !o && busy === null && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{format(pending?.mode === "manual" && pending.evict ? m.admin.sites.tlsEvict.title : t.tls.confirmTitle, { host: pending?.domain.hostname ?? "" })}</DialogTitle>
            <DialogDescription>
              {pending?.mode === "manual" && pending.evict
                ? format(m.admin.sites.tlsEvict.body, { host: pending.domain.hostname, name: pending.certificate.name })
                : pending?.mode === "manual"
                ? format(t.tls.confirmBodyManual, { host: pending.domain.hostname, name: pending.certificate.name })
                : format(t.tls.confirmBodyAcme, { host: pending?.domain.hostname ?? "" })}
            </DialogDescription>
          </DialogHeader>
          {pending?.mode === "manual" && pending.evict && (
            <div className="space-y-2">
              <Label htmlFor="tls-evict-confirm">{format(m.admin.sites.tlsEvict.type, { host: pending.domain.hostname })}</Label>
              <Input id="tls-evict-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setPending(null)}>
              {t.tls.cancel}
            </Button>
            <Button
              type="button"
              disabled={busy !== null || (pending?.mode === "manual" && pending.evict === true && typed.trim().toLowerCase() !== pending.domain.hostname.toLowerCase())}
              onClick={confirmSwitch}
            >
              {busy?.startsWith("tls:") ? t.tls.confirming : t.tls.confirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {importing && (
        <TlsImportDialog
          basePath={siteBase}
          csrfToken={csrfToken}
          certificateId={importing.certificate?.id}
          certificateName={importing.certificate?.name}
          initialDomainId={importing.domain.id}
          domains={data.domains}
          onDone={(next) => {
            startedAt.current = Date.now();
            if (next) setData(next);
            void refreshCertificates();
          }}
          onClose={() => setImporting(null)}
        />
      )}

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

/** The source choice of one address: Let's Encrypt or an imported certificate, with the certificate select. */
function TlsSource({
  d,
  certificates,
  choosing,
  disabled,
  when,
  onAcme,
  onManual,
  onPick,
  onImport,
}: {
  d: SiteDomainDto;
  certificates: TlsCertificateDto[];
  choosing: boolean;
  disabled: boolean;
  when: Date;
  onAcme: () => void;
  onManual: () => void;
  onPick: (c: TlsCertificateDto) => void;
  onImport: (c?: TlsCertificateDto) => void;
}) {
  const m = useMessages();
  const locale = useLocale();
  const t = m.site.domains.tls;
  const isManual = d.tls.mode === "manual";
  const manualChecked = isManual || choosing;
  const covering = certificatesCovering(certificates, d.id).filter((c) => c.versions.some((v) => v.id === c.activeVersionId || v.status === "pending"));
  const current = certificates.find((c) => c.id === d.tls.certificateId);
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{t.sourceLegend}</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2" htmlFor={`tls-mode-${d.id}-acme`}>
          <input type="radio" id={`tls-mode-${d.id}-acme`} name={`tls-mode-${d.id}`} checked={!manualChecked} onChange={onAcme} />
          {t.acme}
        </label>
        <label className="flex items-center gap-2" htmlFor={`tls-mode-${d.id}-manual`}>
          <input type="radio" id={`tls-mode-${d.id}-manual`} name={`tls-mode-${d.id}`} checked={manualChecked} onChange={onManual} />
          {t.manual}
        </label>
      </div>
      {manualChecked && (
        <div className="space-y-2">
          {covering.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noCovering}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`tls-cert-${d.id}`}>{format(t.selectCertificate, { host: d.hostname })}</Label>
              <select
                id={`tls-cert-${d.id}`}
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                value={covering.some((c) => c.id === d.tls.certificateId) ? d.tls.certificateId! : ""}
                onChange={(e) => {
                  const c = covering.find((x) => x.id === e.target.value);
                  if (c) onPick(c);
                }}
              >
                <option value="" disabled>
                  {format(t.selectCertificate, { host: d.hostname })}
                </option>
                {covering.map((c) => {
                  const v = c.versions.find((x) => x.id === c.activeVersionId) ?? c.versions.find((x) => x.status === "pending")!;
                  return (
                    <option key={c.id} value={c.id}>
                      {format(t.option, { name: c.name, date: day(v.notAfter) })}
                    </option>
                  );
                })}
              </select>
            </div>
          )}
          {current && isManual && (
            <p className="text-sm text-muted-foreground">
              {current.name} · {expiryText(m, current.versions.find((v) => v.id === d.tls.versionId)?.notAfter ?? current.versions.at(-1)!.notAfter, when, locale)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onImport()}>
              {t.importNew}
            </Button>
            {isManual && current && (
              <Button type="button" variant="outline" size="sm" onClick={() => onImport(current)}>
                {t.replace}
              </Button>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}
