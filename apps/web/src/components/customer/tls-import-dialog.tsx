"use client";

import { useEffect, useRef, useState } from "react";
import {
  checkPemShape,
  SiteDomainsDtoSchema,
  TlsCertificateDtoSchema,
  TLS_PEM_MAX_BYTES,
  type PemShapeField,
  type PemShapeReason,
  type SiteDomainDto,
  type SiteDomainsDto,
  type TlsCertificateDto,
  type TlsCertificateVersionDto,
} from "@hosting-panel/contracts";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { expiryText, tlsErrorText } from "@/lib/tls-view";

export interface PemFields {
  leafPem: string;
  chainPem: string;
  privateKeyPem: string;
}

export const EMPTY_PEM: PemFields = { leafPem: "", chainPem: "", privateKeyPem: "" };
/** A picked file larger than this is refused before it is read (the three texts together are bounded by the API). */
export const MAX_PEM_FILE_BYTES = TLS_PEM_MAX_BYTES;

export type ImportStep = "form" | "review" | "done";
export type ImportIssues = Partial<Record<PemShapeField, PemShapeReason>>;

/** One structural reason per field (name only for a new certificate); the API does the X.509 work. */
export function importFormIssues(v: PemFields & { name?: string }): ImportIssues {
  const issues: ImportIssues = {};
  for (const { field, reason } of checkPemShape(v)) issues[field] = reason;
  return issues;
}

export type ImportOutcome = { ok: true } | { ok: false; code: string; reason?: string; keyKept: boolean };

export interface ImportStepModel {
  step: "form" | "review";
  /** Zero the pasted texts: after success, and after a refusal (a transient failure keeps them for the replay). */
  clearPem: boolean;
  error: { code: string; reason?: string } | null;
}

/** Where the wizard goes after the import call. `keyKept`: keyedSend kept the Idempotency-Key (5xx or lost reply). */
export function importStepModel(o: ImportOutcome): ImportStepModel {
  if (o.ok) return { step: "review", clearPem: true, error: null };
  return { step: "form", clearPem: !o.keyKept, error: { code: o.code, reason: o.reason } };
}

/** Cancel deletes a certificate this wizard created; a new version of an older certificate is only left unused. */
export function cancelAction(replacing: boolean): "delete" | "close" {
  return replacing ? "close" : "delete";
}

/** The newest pending version of a certificate (the one just imported). */
export function pendingVersion(c: TlsCertificateDto): TlsCertificateVersionDto | null {
  const pending = c.versions.filter((v) => v.status === "pending");
  return pending.sort((a, b) => b.versionNumber - a.versionNumber)[0] ?? null;
}

export interface ReviewRow {
  key: "subject" | "issuer" | "names" | "wildcard" | "validity" | "fingerprint" | "key";
  label: string;
  value: string;
}

const fingerprintText = (hex: string): string => (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":");

/** The facts of a pending version, as label/value pairs (nothing here says the certificate is in use). */
export function reviewRows(v: TlsCertificateVersionDto, m: Messages, locale: string, now: Date = new Date()): ReviewRow[] {
  const w = m.site.domains.tls.wizard;
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const wildcards = v.sanDns.filter((n) => n.startsWith("*.")).map((n) => n.slice(2));
  const validity = `${format(w.reviewValidity, { from: day.format(new Date(v.notBefore)), to: day.format(new Date(v.notAfter)) })} · ${expiryText(m, v.notAfter, now, locale)}`;
  return [
    { key: "subject", label: w.reviewSubject, value: v.subject },
    { key: "issuer", label: w.reviewIssuer, value: v.issuer },
    { key: "names", label: w.reviewNames, value: v.sanDns.join(", ") },
    {
      key: "wildcard",
      label: "",
      value: wildcards.length > 0 ? format(w.reviewWildcard, { names: wildcards.join(", ") }) : w.reviewNoWildcard,
    },
    { key: "validity", label: "", value: validity },
    { key: "fingerprint", label: w.reviewFingerprint, value: fingerprintText(v.fingerprintSha256) },
    {
      key: "key",
      label: w.reviewKey,
      value: v.keyType === "rsa" ? format(w.reviewKeyRsa, { bits: v.keyBits }) : w.reviewKeyEc,
    },
  ];
}

export interface ReviewDomain {
  id: string;
  hostname: string;
  checked: boolean;
}

/**
 * The addresses of this site the certificate covers (per the API's `coveredDomains`), each with its default choice:
 * checked when already on this certificate or when the wizard was opened from it.
 */
export function reviewDomains(c: TlsCertificateDto, domains: readonly SiteDomainDto[], initialDomainId?: string): ReviewDomain[] {
  const covered = new Map(c.coveredDomains.map((d) => [d.domainId, d]));
  return domains
    .filter((d) => covered.has(d.id))
    .map((d) => ({ id: d.id, hostname: d.hostname, checked: covered.get(d.id)!.assigned || d.id === initialDomainId }));
}

const certificatesPath = (basePath: string) => `${basePath}/tls-certificates`;

/** `{data: X}` or X, parsed against the strict DTO; anything else is null. */
function unwrap(data: unknown): unknown {
  return data !== null && typeof data === "object" && "data" in data ? (data as { data: unknown }).data : data;
}

/** Sends the PEM (new certificate, or a new version of `certificateId`). Idempotency-Key rules are keyedSend's. */
export async function submitImport(
  keys: Record<string, string>,
  csrfToken: string,
  basePath: string,
  certificateId: string | undefined,
  name: string,
  pem: PemFields,
): Promise<{ model: ImportStepModel; certificate: TlsCertificateDto | null }> {
  const action = certificateId ? `version:${certificateId}` : "import";
  const url = certificateId ? `${certificatesPath(basePath)}/${certificateId}/versions` : certificatesPath(basePath);
  const body = { ...(certificateId ? {} : { name: name.trim() }), format: "pem", ...pem };
  const res = await keyedSend(keys, csrfToken, action, "POST", url, body);
  if (!res.ok) {
    return { model: importStepModel({ ok: false, code: res.code, reason: res.reason, keyKept: action in keys }), certificate: null };
  }
  const parsed = TlsCertificateDtoSchema.safeParse(unwrap(res.data));
  if (!parsed.success || !pendingVersion(parsed.data)) {
    return { model: importStepModel({ ok: false, code: "", keyKept: false }), certificate: null };
  }
  return { model: importStepModel({ ok: true }), certificate: parsed.data };
}

/** Confirm: put the pending version on the chosen addresses. 202 answers the site's domain list. */
export async function activateVersion(
  keys: Record<string, string>,
  csrfToken: string,
  basePath: string,
  certificateId: string,
  versionId: string,
  domainIds: string[],
): Promise<{ ok: true; domains: SiteDomainsDto | null } | { ok: false; code: string; reason?: string }> {
  const url = `${certificatesPath(basePath)}/${certificateId}/versions/${versionId}/activate`;
  const res = await keyedSend(keys, csrfToken, `activate:${versionId}`, "POST", url, { domainIds });
  if (!res.ok) return res;
  const parsed = SiteDomainsDtoSchema.safeParse(unwrap(res.data));
  return { ok: true, domains: parsed.success ? parsed.data : null };
}

/** Cancel of a brand-new certificate: delete it. */
export function discardCertificate(keys: Record<string, string>, csrfToken: string, basePath: string, certificateId: string) {
  return keyedSend(keys, csrfToken, `delete:${certificateId}`, "DELETE", `${certificatesPath(basePath)}/${certificateId}`, {});
}

const FIELD_IDS = {
  name: "tls-name",
  leafPem: "tls-leaf",
  chainPem: "tls-chain",
  privateKeyPem: "tls-key",
} as const;

export function ImportFormStep({
  isNew,
  pem,
  issues,
  fileErrors,
  busy,
  error,
  onName,
  onPem,
  onFile,
  onSubmit,
  onCancel,
}: {
  isNew: boolean;
  pem: PemFields;
  /** Shown reasons only: the caller leaves out fields still empty. */
  issues: ImportIssues;
  fileErrors: Partial<Record<keyof PemFields, string>>;
  busy: boolean;
  error: string | null;
  onName: (name: string) => void;
  onPem: (field: keyof PemFields, text: string) => void;
  onFile: (field: keyof PemFields, file: File) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const t = m.site.domains.tls;
  const w = t.wizard;
  const reasonText = (field: PemShapeField) => (issues[field] ? t.pemReason[issues[field]] : null);
  const fields: { field: keyof PemFields; label: string; hint: string }[] = [
    { field: "leafPem", label: w.leaf, hint: w.leafHint },
    { field: "chainPem", label: w.chain, hint: w.chainHint },
    { field: "privateKeyPem", label: w.key, hint: w.keyHint },
  ];
  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {isNew ? (
        <div className="space-y-1">
          <Label htmlFor={FIELD_IDS.name}>{w.name}</Label>
          <Input
            id={FIELD_IDS.name}
            autoComplete="off"
            maxLength={128}
            disabled={busy}
            aria-invalid={reasonText("name") ? true : undefined}
            aria-describedby={`${FIELD_IDS.name}-hint${reasonText("name") ? ` ${FIELD_IDS.name}-err` : ""}`}
            onChange={(e) => onName(e.target.value)}
          />
          <p id={`${FIELD_IDS.name}-hint`} className="text-xs text-muted-foreground">
            {w.nameHint}
          </p>
          {reasonText("name") ? (
            <p id={`${FIELD_IDS.name}-err`} className="text-xs text-destructive">
              {reasonText("name")}
            </p>
          ) : null}
        </div>
      ) : null}
      {fields.map(({ field, label, hint }) => {
        const id = FIELD_IDS[field];
        const problem = reasonText(field) ?? fileErrors[field] ?? null;
        return (
          <div key={field} className="space-y-1">
            <Label htmlFor={id}>{label}</Label>
            <Textarea
              id={id}
              className="font-mono text-xs"
              rows={field === "chainPem" ? 4 : 6}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${id}-hint${problem ? ` ${id}-err` : ""}`}
              value={pem[field]}
              onChange={(e) => onPem(field, e.target.value)}
            />
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {hint}
            </p>
            {problem ? (
              <p id={`${id}-err`} className="text-xs text-destructive">
                {problem}
              </p>
            ) : null}
            <label className="inline-block text-xs underline">
              {w.chooseFile}
              <input
                type="file"
                accept=".pem,.crt,.cer,.key,text/plain"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) onFile(field, file);
                }}
              />
            </label>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{w.keyNote}</p>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {w.submitting}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {w.cancel}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? w.submitting : w.submit}
        </Button>
      </div>
    </form>
  );
}

export function ReviewStep({
  rows,
  domains,
  busy,
  error,
  onToggle,
  onConfirm,
  onKeep,
  onCancel,
}: {
  rows: ReviewRow[];
  domains: ReviewDomain[];
  busy: "confirm" | "cancel" | null;
  error: string | null;
  onToggle: (id: string, checked: boolean) => void;
  onConfirm: () => void;
  onKeep: () => void;
  onCancel: () => void;
}) {
  const w = useMessages().site.domains.tls.wizard;
  return (
    <div className="space-y-4">
      <p className="text-sm">{w.reviewIntro}</p>
      <Alert variant="warning">
        <AlertDescription>{w.warningNoActiveYet}</AlertDescription>
      </Alert>
      <dl className="space-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.key}>
            {r.label ? <dt className="text-xs text-muted-foreground">{r.label}</dt> : null}
            <dd className="break-all">{r.value}</dd>
          </div>
        ))}
      </dl>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{w.reviewDomainsTitle}</legend>
        {domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">{w.reviewNoDomains}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{w.reviewDomainsHint}</p>
            {domains.map((d) => (
              <label key={d.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={d.checked}
                  disabled={busy !== null}
                  onChange={(e) => onToggle(d.id, e.target.checked)}
                />
                {d.hostname}
              </label>
            ))}
          </>
        )}
      </fieldset>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {busy ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {busy === "confirm" ? w.confirming : w.cancelling}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={onCancel}>
          {w.cancel}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={onKeep}>
          {w.keepForLater}
        </Button>
        <Button type="button" disabled={busy !== null || !domains.some((d) => d.checked)} onClick={onConfirm}>
          {busy === "confirm" ? w.confirming : w.confirm}
        </Button>
      </div>
    </div>
  );
}

export function TlsImportDialog({
  basePath,
  csrfToken,
  certificateId,
  certificateName,
  initialDomainId,
  domains,
  onDone,
  onClose,
}: {
  /** `/api/bff/orgs/:org/managed-sites/:site` (customer) or `/api/admin/sites/:site` (administrator). */
  basePath: string;
  csrfToken: string;
  /** Set to add a new version to this certificate; absent imports a new certificate. */
  certificateId?: string;
  certificateName?: string;
  /** The domain the wizard was opened from: pre-checked on the review step when covered. */
  initialDomainId?: string;
  domains: SiteDomainDto[];
  /** Something changed on the server (a certificate was kept or sent): the host refreshes. */
  onDone: (d: SiteDomainsDto | null) => void;
  onClose: () => void;
}) {
  const m = useMessages();
  const locale = useLocale();
  const w = m.site.domains.tls.wizard;
  const replacing = certificateId !== undefined;
  const keys = useRef<Record<string, string>>({});
  const [step, setStep] = useState<ImportStep>("form");
  const [name, setName] = useState("");
  const [pem, setPem] = useState<PemFields>(EMPTY_PEM);
  const [fileErrors, setFileErrors] = useState<Partial<Record<keyof PemFields, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"submit" | "confirm" | "cancel" | null>(null);
  const [created, setCreated] = useState<{ certificate: TlsCertificateDto; version: TlsCertificateVersionDto } | null>(null);
  const [picked, setPicked] = useState<ReviewDomain[]>([]);
  const [result, setResult] = useState<{ domains: SiteDomainsDto | null } | null>(null);
  const [attempted, setAttempted] = useState(false);

  const zeroPem = () => setPem(EMPTY_PEM);
  // The pasted texts live in this component's state only; leaving the dialog drops them.
  useEffect(() => zeroPem, []);

  const issues = importFormIssues({ ...pem, ...(replacing ? {} : { name }) });
  const shown: ImportIssues = {};
  if (!replacing && (attempted || name !== "") && issues.name) shown.name = issues.name;
  for (const f of ["leafPem", "chainPem", "privateKeyPem"] as const) {
    if ((attempted || pem[f] !== "") && issues[f]) shown[f] = issues[f];
  }

  function fail(code: string, reason?: string) {
    setError(tlsErrorText(m, code, reason ? [{ reason }] : []) ?? m.errors.generic);
  }

  function edit(change: () => void) {
    // A changed payload is a new request: it must not replay under the old Idempotency-Key.
    for (const k of Object.keys(keys.current)) if (k === "import" || k.startsWith("version:")) delete keys.current[k];
    setError(null);
    change();
  }

  async function readFile(field: keyof PemFields, file: File) {
    setFileErrors((e) => ({ ...e, [field]: undefined }));
    if (file.size > MAX_PEM_FILE_BYTES) {
      setFileErrors((e) => ({ ...e, [field]: w.fileTooLarge }));
      return;
    }
    try {
      const text = await file.text();
      edit(() => setPem((p) => ({ ...p, [field]: text })));
    } catch {
      setFileErrors((e) => ({ ...e, [field]: w.fileUnreadable }));
    }
  }

  async function submit() {
    if (busy) return;
    if (Object.keys(issues).length > 0) return setAttempted(true);
    setBusy("submit");
    setError(null);
    const out = await submitImport(keys.current, csrfToken, basePath, certificateId, name, pem);
    setBusy(null);
    if (out.model.clearPem) zeroPem();
    if (out.model.error) return fail(out.model.error.code, out.model.error.reason);
    const certificate = out.certificate!;
    setCreated({ certificate, version: pendingVersion(certificate)! });
    setPicked(reviewDomains(certificate, domains, initialDomainId));
    setStep(out.model.step);
  }

  async function confirm() {
    if (busy || !created) return;
    const ids = picked.filter((d) => d.checked).map((d) => d.id);
    if (ids.length === 0) return;
    setBusy("confirm");
    setError(null);
    const res = await activateVersion(keys.current, csrfToken, basePath, created.certificate.id, created.version.id, ids);
    setBusy(null);
    if (!res.ok) return fail(res.code, res.reason);
    setResult({ domains: res.domains });
    setStep("done");
  }

  function finish(domainsDto: SiteDomainsDto | null) {
    onDone(domainsDto);
    onClose();
  }

  function keep() {
    finish(null);
  }

  async function cancelReview() {
    if (busy || !created) return;
    if (cancelAction(replacing) === "close") return finish(null);
    setBusy("cancel");
    setError(null);
    const res = await discardCertificate(keys.current, csrfToken, basePath, created.certificate.id);
    setBusy(null);
    if (!res.ok) return fail(res.code, res.reason);
    onClose();
  }

  function dismiss() {
    if (step === "review") return void cancelReview();
    if (step === "done") return finish(result?.domains ?? null);
    zeroPem();
    onClose();
  }

  const title = replacing && certificateName ? format(w.titleReplace, { name: certificateName }) : w.title;
  const stepLabel = step === "form" ? w.stepForm : step === "review" ? w.stepReview : w.stepDone;

  return (
    <Dialog open onOpenChange={guardDialogClose(() => busy !== null, (open) => (open ? undefined : dismiss()))}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{step === "review" ? w.reviewTitle : step === "done" ? w.doneTitle : title}</DialogTitle>
          <DialogDescription>{stepLabel}</DialogDescription>
        </DialogHeader>
        {step === "form" ? (
          <ImportFormStep
            isNew={!replacing}
            pem={pem}
            issues={shown}
            fileErrors={fileErrors}
            busy={busy === "submit"}
            error={error}
            onName={(v) => edit(() => setName(v))}
            onPem={(field, text) => edit(() => setPem((p) => ({ ...p, [field]: text })))}
            onFile={(field, file) => void readFile(field, file)}
            onSubmit={() => void submit()}
            onCancel={dismiss}
          />
        ) : null}
        {step === "review" && created ? (
          <ReviewStep
            rows={reviewRows(created.version, m, locale)}
            domains={picked}
            busy={busy === "confirm" || busy === "cancel" ? busy : null}
            error={error}
            onToggle={(id, checked) => {
              for (const k of Object.keys(keys.current)) if (k.startsWith("activate:")) delete keys.current[k];
              setPicked((list) => list.map((d) => (d.id === id ? { ...d, checked } : d)));
            }}
            onConfirm={() => void confirm()}
            onKeep={keep}
            onCancel={() => void cancelReview()}
          />
        ) : null}
        {step === "done" ? (
          <div className="space-y-4">
            <p role="status" aria-live="polite" className="text-sm">
              {w.done}
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={() => finish(result?.domains ?? null)}>
                {w.close}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
