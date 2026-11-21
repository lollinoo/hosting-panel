"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleHelp, Clock, XCircle } from "lucide-react";
import {
  ErrorCodeSchema,
  type BackupArchiveDto,
  type BackupLastRestoreDto,
  type SiteBackupDto,
  type SiteBackupPolicyDto,
  type SiteBackupsDto,
} from "@hosting-panel/contracts";
import { RestoreBackupDialog } from "@/components/customer/restore-backup-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import {
  choiceLabels,
  hasRestorableCopy,
  labelledCopies,
  restorableCopies,
  statusView,
  type BackupCopy,
  type StatusView,
} from "@/lib/backup-copies";
import { formatDate, formatSize } from "@/lib/file-browser";

const DAY_MS = 86_400_000;
const QUOTA_FALLBACK_WINDOW_MS = 60 * 60_000;

export const BACKUP_POLL_INTERVAL_MS = 2_000;
export const BACKUP_POLL_LIMIT_MS = 10 * 60_000;

export type BackupExpiry = Date | "keptLatest" | null;
export type BackupActionKind = "backup" | "restore" | "download";

export interface BackupErrorResult {
  kind: "notSetUp" | "notAvailable" | "error";
  message: string;
}

export interface SiteBackupsProps {
  basePath: string;
  initial: SiteBackupsDto;
  csrfToken: string;
  siteName?: string;
  initialDownloadError?: "gone" | "failed" | null;
  /** The destination choice; null or without choices hides the chooser. */
  policy?: SiteBackupPolicyDto | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Unwrap { data: SiteBackupsDto } returned by the customer backups route; reject bodies without valid data.
function parseSiteBackupsEnvelope(body: unknown): SiteBackupsDto | null {
  if (!isPlainRecord(body) || !isPlainRecord(body.data)) return null;
  const dto = body.data;
  if (
    typeof dto.available !== "boolean" ||
    typeof dto.configured !== "boolean" ||
    typeof dto.retentionDays !== "number" ||
    typeof dto.manualKept !== "number" ||
    (dto.runningOperationId !== null && typeof dto.runningOperationId !== "string") ||
    !Array.isArray(dto.backups)
  ) {
    return null;
  }
  return dto as unknown as SiteBackupsDto;
}

function defaultIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatExpiryDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "it" ? "it-IT" : "en-US", {
    dateStyle: "medium",
  }).format(date);
}

// Compute the last full day a backup is guaranteed kept, "keptLatest" if past retention, or null when uncompleted.
export function backupExpiry(
  row: Pick<SiteBackupDto, "status" | "startedAt">,
  retentionDays: number,
  now: Date = new Date(),
): BackupExpiry {
  // A partial backup keeps a restorable copy, so it expires like a completed one.
  if (row.status !== "succeeded" && (row.status as string) !== "partial") return null;
  const startedMs = Date.parse(row.startedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || !Number.isFinite(retentionDays) || retentionDays < 0) {
    return null;
  }
  const expiresAtMs = startedMs + retentionDays * DAY_MS;
  if (expiresAtMs < nowMs) return "keptLatest";
  return new Date(expiresAtMs - DAY_MS);
}

function isBackupRunningDto(dto: SiteBackupsDto): boolean {
  return dto.runningOperationId !== null || dto.backups.some((row) => row.status === "running");
}

// True when a backup, restore, or archive preparation is currently active for the site.
export function siteBackupsBusy(dto: SiteBackupsDto): boolean {
  return (
    isBackupRunningDto(dto) ||
    dto.lastRestore?.status === "running" ||
    dto.backups.some((row) => row.archive?.status === "preparing")
  );
}

// True only while an archive is ready and not yet expired on the given clock.
export function isArchiveReady(archive: BackupArchiveDto | null, now: Date = new Date()): boolean {
  if (!archive || archive.status !== "ready" || archive.readyUntil === null) return false;
  const readyUntilMs = Date.parse(archive.readyUntil);
  return Number.isFinite(readyUntilMs) && readyUntilMs > now.getTime();
}

// Optimistically mark a restore as running in local state once the POST returns 202.
export function applyRestoreStarted(
  prev: SiteBackupsDto,
  backup: Pick<SiteBackupDto, "id" | "startedAt">,
): SiteBackupsDto {
  return {
    ...prev,
    lastRestore: {
      backupId: backup.id,
      backupStartedAt: backup.startedAt,
      status: "running",
      finishedAt: null,
      problem: null,
    },
  };
}

// Optimistically mark the chosen row as preparing (and clear any prior single-site archive).
export function applyArchivePreparing(prev: SiteBackupsDto, backupId: string): SiteBackupsDto {
  return {
    ...prev,
    backups: prev.backups.map((row) => {
      if (row.id === backupId) {
        return {
          ...row,
          archive: { status: "preparing", readyUntil: null, problem: null },
        };
      }
      if (row.archive !== null) {
        return { ...row, archive: null };
      }
      return row;
    }),
  };
}

export interface RestoreBannerModel {
  variant: "default" | "warning" | "destructive";
  role: "status" | "alert";
  text: string;
}

// Build the restore status/outcome banner shown above the backups table (R78: undo_incomplete stands alone).
export function restoreBanner(
  m: Messages,
  lastRestore: BackupLastRestoreDto | null,
  locale: string,
): RestoreBannerModel | null {
  if (!lastRestore) return null;
  const t = m.site.backups;
  const date = formatDate(lastRestore.backupStartedAt, locale);

  if (lastRestore.status === "running") {
    return { variant: "default", role: "status", text: format(t.restore.running, { date }) };
  }

  if (lastRestore.status === "succeeded") {
    if (lastRestore.problem === null) {
      return { variant: "default", role: "status", text: format(t.restore.done, { date }) };
    }
    return {
      variant: "warning",
      role: "status",
      text: format(t.restore.doneAddressNotSet, { date }),
    };
  }

  if (lastRestore.problem === "undo_incomplete") {
    return {
      variant: "destructive",
      role: "alert",
      text: t.copyProblem.undo_incomplete,
    };
  }

  const problemKey =
    lastRestore.problem && Object.hasOwn(t.copyProblem, lastRestore.problem)
      ? lastRestore.problem
      : "other";
  return {
    variant: "destructive",
    role: "alert",
    text: `${t.restore.failed} ${t.copyProblem[problemKey]}`,
  };
}

export function resolveQuotaRetryIso(rawDetails: unknown[], retryAfter: string | null | undefined, now: Date): string {
  for (const detail of rawDetails) {
    if (
      isPlainRecord(detail) &&
      detail.field === "retryAt" &&
      typeof detail.message === "string" &&
      !Number.isNaN(Date.parse(detail.message))
    ) {
      return detail.message;
    }
  }
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      return new Date(now.getTime() + Number(trimmed) * 1_000).toISOString();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date(now.getTime() + QUOTA_FALLBACK_WINDOW_MS).toISOString();
}

// Map an HTTP status and API error envelope to localized customer-safe copy.
export function backupErrorText(
  m: Messages,
  status: number,
  body: unknown,
  opts?: {
    action?: BackupActionKind;
    retryAfter?: string | null;
    locale?: string;
    now?: Date;
  },
): BackupErrorResult {
  const t = m.site.backups;
  const errObj = isPlainRecord(body) && isPlainRecord(body.error) ? body.error : null;
  const parsedCode = errObj ? ErrorCodeSchema.safeParse(errObj.code) : null;
  const code = parsedCode?.success ? parsedCode.data : null;
  const topMessage = errObj && typeof errObj.message === "string" ? errObj.message : "";
  const rawDetails = errObj && Array.isArray(errObj.details) ? errObj.details : [];

  const hasDetail = (key: string) =>
    topMessage === key ||
    rawDetails.some(
      (detail) =>
        isPlainRecord(detail) && (detail.reason === key || detail.message === key),
    );

  if ((status === 400 || code === "VALIDATION_ERROR") && hasDetail("not_configured")) {
    return { kind: "notSetUp", message: t.notSetUp };
  }
  if (
    (status === 400 || code === "VALIDATION_ERROR") &&
    rawDetails.some((detail) => isPlainRecord(detail) && detail.field === "confirmName")
  ) {
    return { kind: "error", message: t.restore.wrongName };
  }
  if (status === 422 || code === "NOT_SUPPORTED") {
    return { kind: "notAvailable", message: t.notAvailable };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return { kind: "error", message: m.site.files.errors.UNAUTHENTICATED };
  }
  if (code === "ORGANIZATION_SUSPENDED") {
    return { kind: "error", message: t.errors.ORGANIZATION_SUSPENDED };
  }
  if (code === "QUOTA_EXCEEDED") {
    const iso = resolveQuotaRetryIso(rawDetails, opts?.retryAfter, opts?.now ?? new Date());
    const formattedTime = formatDate(iso, opts?.locale ?? m.common.dateLocale);
    return { kind: "error", message: format(t.errors.tooMany, { time: formattedTime }) };
  }
  if (code === "RESOURCE_LOCKED") {
    if (hasDetail("not_ready")) {
      return { kind: "error", message: t.errors.notReady };
    }
    return { kind: "error", message: errorMessage(m, "RESOURCE_LOCKED") };
  }
  if (status === 502 || status === 504 || code === "OPERATION_AMBIGUOUS") {
    const action = opts?.action ?? "backup";
    return {
      kind: "error",
      message: action === "backup" ? t.errors.uncertain : t.errors.uncertainAction,
    };
  }
  if (code) {
    return { kind: "error", message: errorMessage(m, code) };
  }
  return { kind: "error", message: t.loadFailed };
}

// Return the localized customer message when polling reaches its time limit.
export function backupGiveUpText(m: Messages, dto?: SiteBackupsDto): string {
  if (dto && !isBackupRunningDto(dto)) {
    return m.site.backups.errors.stillWorking;
  }
  return m.site.backups.errors.stillRunning;
}

async function postBackupEndpoint(opts: {
  url: string;
  body: unknown;
  csrfToken: string;
  inFlightRef: { current: boolean };
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
}): Promise<Response | null> {
  if (opts.inFlightRef.current) return null;
  opts.inFlightRef.current = true;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const makeKey = opts.makeIdempotencyKey ?? defaultIdempotencyKey;

  try {
    return await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": opts.csrfToken,
        "Idempotency-Key": makeKey(),
      },
      body: JSON.stringify(opts.body),
    });
  } finally {
    opts.inFlightRef.current = false;
  }
}

// Send at most one manual backup POST request while an in-flight request is pending.
export async function triggerSiteBackup(opts: {
  basePath: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
}): Promise<Response | null> {
  return postBackupEndpoint({
    url: opts.basePath,
    body: {},
    csrfToken: opts.csrfToken,
    inFlightRef: opts.inFlightRef,
    fetchImpl: opts.fetchImpl,
    makeIdempotencyKey: opts.makeIdempotencyKey,
  });
}

// Send at most one restore POST request for a backup with typed confirmName.
export async function triggerRestoreBackup(opts: {
  basePath: string;
  backupId: string;
  confirmName: string;
  /** Only when the backup has more than one restorable copy. */
  targetId?: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
}): Promise<Response | null> {
  return postBackupEndpoint({
    url: `${opts.basePath}/${encodeURIComponent(opts.backupId)}/restore`,
    body: { confirmName: opts.confirmName, ...(opts.targetId ? { targetId: opts.targetId } : {}) },
    csrfToken: opts.csrfToken,
    inFlightRef: opts.inFlightRef,
    fetchImpl: opts.fetchImpl,
    makeIdempotencyKey: opts.makeIdempotencyKey,
  });
}

// Send at most one download-preparation POST request for a backup row.
export async function triggerPrepareDownload(opts: {
  basePath: string;
  backupId: string;
  /** Only when the backup has more than one restorable copy. */
  targetId?: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
}): Promise<Response | null> {
  return postBackupEndpoint({
    url: `${opts.basePath}/${encodeURIComponent(opts.backupId)}/download`,
    body: opts.targetId ? { targetId: opts.targetId } : {},
    csrfToken: opts.csrfToken,
    inFlightRef: opts.inFlightRef,
    fetchImpl: opts.fetchImpl,
    makeIdempotencyKey: opts.makeIdempotencyKey,
  });
}

export type SiteBackupTriggerOutcome =
  | { kind: "ignored" }
  | { kind: "started"; operationId: string }
  | { kind: "notAvailable" }
  | { kind: "notSetUp" }
  | { kind: "error"; message: string };

async function submitBackupAction(opts: {
  action: BackupActionKind;
  send: () => Promise<Response | null>;
  messages: Messages;
  locale?: string;
}): Promise<SiteBackupTriggerOutcome> {
  try {
    const res = await opts.send();
    if (!res) return { kind: "ignored" };

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    if (res.ok) {
      const operationId =
        isPlainRecord(body) && isPlainRecord(body.data) && typeof body.data.operationId === "string"
          ? body.data.operationId
          : null;
      if (operationId !== null) {
        return { kind: "started", operationId };
      }
      return { kind: "error", message: opts.messages.site.backups.loadFailed };
    }

    const mapped = backupErrorText(opts.messages, res.status, body, {
      action: opts.action,
      retryAfter: res.headers?.get?.("Retry-After") ?? null,
      locale: opts.locale,
    });
    if (mapped.kind === "notAvailable") return { kind: "notAvailable" };
    if (mapped.kind === "notSetUp") return { kind: "notSetUp" };
    return { kind: "error", message: mapped.message };
  } catch {
    return { kind: "error", message: opts.messages.site.backups.loadFailed };
  }
}

// Trigger a manual backup and unwrap { data: { operationId } }, treating missing data as a failed read.
export async function submitSiteBackup(opts: {
  basePath: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  messages: Messages;
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
  locale?: string;
}): Promise<SiteBackupTriggerOutcome> {
  return submitBackupAction({
    action: "backup",
    messages: opts.messages,
    locale: opts.locale,
    send: () => triggerSiteBackup(opts),
  });
}

// Trigger a backup restore and map 202 or error envelopes (confirmName, E11, ambiguous, etc.).
export async function submitRestoreBackup(opts: {
  basePath: string;
  backupId: string;
  confirmName: string;
  targetId?: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  messages: Messages;
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
  locale?: string;
}): Promise<SiteBackupTriggerOutcome> {
  return submitBackupAction({
    action: "restore",
    messages: opts.messages,
    locale: opts.locale,
    send: () => triggerRestoreBackup(opts),
  });
}

// Trigger preparation of a single-zip backup download archive and map 202 or error envelopes.
export async function submitPrepareDownload(opts: {
  basePath: string;
  backupId: string;
  targetId?: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  messages: Messages;
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
  locale?: string;
}): Promise<SiteBackupTriggerOutcome> {
  return submitBackupAction({
    action: "download",
    messages: opts.messages,
    locale: opts.locale,
    send: () => triggerPrepareDownload(opts),
  });
}

// Poll site backups on a bounded timer until backups, restore, and archive prep finish, fail auth, or hit the limit.
export function startBackupPolling(opts: {
  basePath: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  limitMs?: number;
  now?: () => number;
  onData: (dto: SiteBackupsDto) => void;
  onUnauthorized: (status: number) => void;
  onGiveUp: () => void;
}): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const intervalMs = opts.intervalMs ?? BACKUP_POLL_INTERVAL_MS;
  const limitMs = opts.limitMs ?? BACKUP_POLL_LIMIT_MS;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (cancelled) return;
    if (now() - startedAt >= limitMs) {
      opts.onGiveUp();
      return;
    }
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    if (cancelled) return;
    if (now() - startedAt >= limitMs) {
      opts.onGiveUp();
      return;
    }

    try {
      const res = await fetchImpl(opts.basePath, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (cancelled) return;

      if (res.status === 401 || res.status === 403 || res.status === 404) {
        opts.onUnauthorized(res.status);
        return;
      }

      if (res.ok) {
        const dto = parseSiteBackupsEnvelope(await res.json());
        if (cancelled) return;
        if (dto) {
          opts.onData(dto);
          if (!siteBackupsBusy(dto)) return;
        }
      }
    } catch {
      // Transient fetch failure: keep polling within the bounded window.
    }

    scheduleNext();
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Saves the site's destination choice; null returns to the provider's default. Resolves to true on 2xx. */
export async function saveSiteBackupPolicy(opts: {
  policyPath: string;
  targetIds: string[] | null;
  csrfToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.policyPath, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": opts.csrfToken },
      body: JSON.stringify({ targetIds: opts.targetIds }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const STATUS_ICONS = {
  check: CheckCircle2,
  x: XCircle,
  clock: Clock,
  alert: AlertTriangle,
  help: CircleHelp,
} as const;

function StatusIcon({ icon }: { icon: StatusView["icon"] }) {
  const Icon = STATUS_ICONS[icon];
  return <Icon aria-hidden="true" className="mr-1 h-3.5 w-3.5 shrink-0" />;
}

/** One line per copy: where, its state (text and icon), its size and, when it failed, what to do. */
function CopiesList({ copies, t, locale }: { copies: BackupCopy[]; t: Messages["site"]["backups"]; locale: string }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground" aria-label={t.copies.title}>
      {labelledCopies(t.target, copies).map((c) => {
        const view = statusView(c.status);
        const status = t.copies.status[view.textKey as keyof typeof t.copies.status];
        const text =
          c.sizeBytes === null
            ? format(t.copies.withoutSize, { label: c.label, status })
            : format(t.copies.withSize, { label: c.label, status, size: formatSize(c.sizeBytes, locale) });
        const problem = c.problem ? (Object.hasOwn(t.problem, c.problem) ? t.problem[c.problem] : t.problem.other) : null;
        return (
          <li key={c.targetId}>
            <span className="inline-flex items-center">
              <StatusIcon icon={view.icon} />
              {text}
            </span>
            {problem ? <span className="block pl-5 text-destructive">{problem}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Radio choice between the provider's default and one of the destinations the customer may use. */
function BackupTargetChooser({
  policy,
  policyPath,
  csrfToken,
}: {
  policy: SiteBackupPolicyDto;
  policyPath: string;
  csrfToken: string;
}) {
  const t = useMessages().site.backups.target;
  const labels = choiceLabels(t, policy.choices);
  const initial = policy.inherited || policy.targetIds.length === 0 ? "inherit" : (policy.targetIds[0] ?? "inherit");
  const [saved, setSaved] = useState(initial);
  const [selected, setSelected] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const kind = policy.choices.find((c) => c.id === selected)?.kind;

  async function save() {
    setState("saving");
    const ok = await saveSiteBackupPolicy({
      policyPath,
      targetIds: selected === "inherit" ? null : [selected],
      csrfToken,
    });
    if (ok) setSaved(selected);
    setState(ok ? "saved" : "failed");
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <fieldset className="space-y-2" disabled={state === "saving"}>
          <legend className="text-sm font-medium">{t.title}</legend>
          <p className="text-xs text-muted-foreground">{t.intro}</p>
          {[{ id: "inherit", label: t.inherit }, ...policy.choices.map((c, i) => ({ id: c.id, label: labels[i] }))].map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="backup-target"
                value={o.id}
                checked={selected === o.id}
                onChange={() => {
                  setSelected(o.id);
                  setState("idle");
                }}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
        {kind === "local" ? (
          <Alert variant="warning">
            <AlertDescription>{t.localWarning}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" disabled={state === "saving" || selected === saved} onClick={() => void save()}>
            {state === "saving" ? t.saving : t.save}
          </Button>
          {state === "saved" ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t.saved}
            </p>
          ) : null}
          {state === "failed" ? (
            <p className="text-sm text-destructive" role="alert">
              {t.failed}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// Render the customer backups tab state machine, restore/download actions, and failure notes.
export function SiteBackups({
  basePath,
  initial,
  csrfToken,
  siteName = "",
  initialDownloadError = null,
  policy = null,
}: SiteBackupsProps) {
  const m = useMessages();
  const locale = useLocale();
  const t = m.site.backups;
  const onlyOneHintId = useId();

  const [data, setData] = useState<SiteBackupsDto>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<"gone" | "failed" | null>(initialDownloadError);
  const [restoreTarget, setRestoreTarget] = useState<SiteBackupDto | null>(null);
  const [downloadSource, setDownloadSource] = useState<Record<string, string>>({});
  const inFlightRef = useRef(false);
  const latestDataRef = useRef<SiteBackupsDto>(initial);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  const busy = siteBackupsBusy(data);
  const isBackupRunning = isBackupRunningDto(data);

  useEffect(() => {
    if (!busy || pollTimedOut) return;
    return startBackupPolling({
      basePath,
      onData: (dto) => {
        setData(dto);
      },
      onUnauthorized: (status) => {
        setPollTimedOut(true);
        setErrorText(backupErrorText(m, status, null, { locale: m.common.dateLocale }).message);
      },
      onGiveUp: () => {
        setPollTimedOut(true);
        setErrorText(backupGiveUpText(m, latestDataRef.current));
      },
    });
  }, [busy, pollTimedOut, basePath, m]);

  if (!data.available) {
    return (
      <Alert>
        <AlertDescription>{t.notAvailable}</AlertDescription>
      </Alert>
    );
  }

  if (!data.configured) {
    return (
      <Alert>
        <AlertDescription>{t.notSetUp}</AlertDescription>
      </Alert>
    );
  }

  function applyNonStartOutcome(outcome: SiteBackupTriggerOutcome, setPageError: boolean): string | null {
    if (outcome.kind === "ignored" || outcome.kind === "started") return null;
    if (outcome.kind === "notAvailable") {
      setData((prev) => ({ ...prev, available: false, configured: false, runningOperationId: null }));
      return null;
    }
    if (outcome.kind === "notSetUp") {
      setData((prev) => ({ ...prev, configured: false, runningOperationId: null }));
      return null;
    }
    if (setPageError) {
      setErrorText(outcome.message);
    }
    return outcome.message;
  }

  async function handleBackupNow() {
    if (inFlightRef.current || submitting || busy) return;
    setSubmitting(true);
    setErrorText(null);
    setDownloadError(null);
    setPollTimedOut(false);

    try {
      const outcome = await submitSiteBackup({
        basePath,
        csrfToken,
        inFlightRef,
        messages: m,
        locale,
      });
      if (outcome.kind === "started") {
        setData((prev) => ({ ...prev, runningOperationId: outcome.operationId }));
        return;
      }
      applyNonStartOutcome(outcome, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePrepareDownload(row: SiteBackupDto) {
    if (inFlightRef.current || submitting || busy) return;
    setSubmitting(true);
    setErrorText(null);
    setDownloadError(null);
    setPollTimedOut(false);

    const sources = restorableCopies(row);
    const chosen = downloadSource[row.id];
    const targetId =
      sources.length > 1 ? (sources.find((c) => c.targetId === chosen) ?? sources[0])?.targetId : undefined;

    try {
      const outcome = await submitPrepareDownload({
        basePath,
        backupId: row.id,
        targetId,
        csrfToken,
        inFlightRef,
        messages: m,
        locale,
      });
      if (outcome.kind === "started") {
        setData((prev) => applyArchivePreparing(prev, row.id));
        return;
      }
      applyNonStartOutcome(outcome, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmRestore(confirmName: string, targetId?: string): Promise<string | null> {
    if (!restoreTarget) return null;
    const target = restoreTarget;
    setErrorText(null);
    setDownloadError(null);
    setPollTimedOut(false);

    const outcome = await submitRestoreBackup({
      basePath,
      backupId: target.id,
      confirmName,
      targetId,
      csrfToken,
      inFlightRef,
      messages: m,
      locale,
    });
    if (outcome.kind === "ignored") return null;
    if (outcome.kind === "started") {
      setRestoreTarget(null);
      setData((prev) => applyRestoreStarted(prev, target));
      return null;
    }
    if (outcome.kind === "notAvailable" || outcome.kind === "notSetUp") {
      setRestoreTarget(null);
      applyNonStartOutcome(outcome, false);
      return null;
    }
    return outcome.message;
  }

  const now = new Date();
  const hasReadyArchive = data.backups.some((row) => isArchiveReady(row.archive, now));
  const currentRestoreBanner = restoreBanner(m, data.lastRestore, locale);
  const policyPath = basePath.replace(/\/backups$/, "/backup-policy");
  const restoreSources = restoreTarget ? labelledCopies(t.target, restorableCopies(restoreTarget)) : [];
  const restoreOptions = restoreSources.length > 0 ? restoreSources : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {format(t.subtitle, { days: data.retentionDays })}
          </p>
          <p className="text-xs text-muted-foreground">
            {format(t.backupNowHint, { kept: data.manualKept })}
          </p>
        </div>
        <Button type="button" onClick={handleBackupNow} disabled={submitting || busy}>
          {t.backupNow}
        </Button>
      </div>

      {policy && policy.choices.length > 0 ? (
        <BackupTargetChooser policy={policy} policyPath={policyPath} csrfToken={csrfToken} />
      ) : null}

      {isBackupRunning ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t.running}
        </p>
      ) : null}

      {currentRestoreBanner ? (
        <Alert variant={currentRestoreBanner.variant} role={currentRestoreBanner.role}>
          <AlertDescription>{currentRestoreBanner.text}</AlertDescription>
        </Alert>
      ) : null}

      {downloadError ? (
        <Alert variant={downloadError === "gone" ? "warning" : "destructive"} role="alert">
          <AlertDescription>
            {downloadError === "gone" ? t.download.gone : t.download.fetchFailed}
          </AlertDescription>
        </Alert>
      ) : null}

      {errorText ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{errorText}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {data.backups.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.date}</TableHead>
                  <TableHead>{t.columns.kind}</TableHead>
                  <TableHead>{t.columns.size}</TableHead>
                  <TableHead>{t.columns.status}</TableHead>
                  <TableHead>{t.columns.expires}</TableHead>
                  <TableHead>{t.columns.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.backups.map((row) => {
                  const expiry = backupExpiry(row, data.retentionDays, now);
                  const expiryText =
                    expiry === null
                      ? "—"
                      : expiry === "keptLatest"
                        ? t.keptLatest
                        : formatExpiryDate(expiry, locale);
                  const sizeText = row.sizeBytes === null ? "—" : formatSize(row.sizeBytes, locale);
                  const view = statusView(row.status);
                  const copies = row.copies ?? [];
                  const sources = restorableCopies(row);
                  const canUse = hasRestorableCopy(row);
                  // One succeeded off-server copy is the pre-existing single destination: nothing new to say.
                  const only = copies.length === 1 ? copies[0] : undefined;
                  const showCopies = copies.length > 1 || (only !== undefined && (only.kind !== "s3" || only.status !== "succeeded"));
                  const problemText =
                    row.status === "failed" && row.problem
                      ? Object.hasOwn(t.problem, row.problem)
                        ? t.problem[row.problem]
                        : t.problem.other
                      : null;

                  const archive = row.archive;
                  const rowReady = isArchiveReady(archive, now);
                  const rowExpired = archive?.status === "ready" && !rowReady;
                  const rowPreparing = archive?.status === "preparing";
                  const rowArchiveProblem =
                    archive?.status === "failed"
                      ? archive.problem && Object.hasOwn(t.copyProblem, archive.problem)
                        ? t.copyProblem[archive.problem]
                        : t.copyProblem.other
                      : null;

                  const showPrepare = canUse && !busy && !rowReady && !rowPreparing;
                  const showRestore = canUse && !busy;

                  return (
                    <Fragment key={row.id}>
                      <TableRow className={problemText ? "border-b-0" : undefined}>
                        <TableCell>{formatDate(row.startedAt, locale)}</TableCell>
                        <TableCell>{t.kind[row.kind]}</TableCell>
                        <TableCell>{sizeText}</TableCell>
                        <TableCell>
                          <Badge
                            variant={view.variant}
                            title={view.textKey === "partial" ? t.status.partialLong : undefined}
                          >
                            <StatusIcon icon={view.icon} />
                            {t.status[view.textKey as keyof typeof t.status]}
                          </Badge>
                          {showCopies ? (
                            <>
                              <CopiesList copies={copies} t={t} locale={locale} />
                              {view.textKey === "partial" ? (
                                <p className="mt-1 text-xs text-muted-foreground">{t.copies.partialHelp}</p>
                              ) : null}
                            </>
                          ) : null}
                        </TableCell>
                        <TableCell>{expiryText}</TableCell>
                        <TableCell>
                          {!canUse ? (
                            "—"
                          ) : (
                            <div className="space-y-1.5">
                              {rowPreparing ? (
                                <p className="text-sm text-muted-foreground" role="status">
                                  {t.download.preparing}
                                </p>
                              ) : null}

                              {rowReady && archive?.readyUntil ? (
                                <div className="space-y-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <a
                                      href={`${basePath}/${encodeURIComponent(row.id)}/download`}
                                      download
                                      className={buttonVariants({ variant: "outline", size: "sm" })}
                                    >
                                      {t.download.fetch}
                                    </a>
                                    <span className="text-xs text-muted-foreground">
                                      {format(t.download.readyUntil, {
                                        time: formatDate(archive.readyUntil, locale),
                                      })}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {t.download.warning}
                                  </p>
                                </div>
                              ) : null}

                              {rowExpired ? (
                                <p className="text-xs text-muted-foreground">{t.download.gone}</p>
                              ) : null}

                              {rowArchiveProblem ? (
                                <p className="text-xs text-destructive">
                                  {`${t.download.failed} ${rowArchiveProblem}`}
                                </p>
                              ) : null}

                              {showPrepare || showRestore ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  {showPrepare && sources.length > 1 ? (
                                    <select
                                      aria-label={t.restore.fromLabel}
                                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                                      disabled={submitting}
                                      value={downloadSource[row.id] ?? sources[0]?.targetId}
                                      onChange={(e) =>
                                        setDownloadSource((prev) => ({ ...prev, [row.id]: e.target.value }))
                                      }
                                    >
                                      {labelledCopies(t.target, sources).map((c) => (
                                        <option key={c.targetId} value={c.targetId}>
                                          {c.label}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                  {showPrepare ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      disabled={submitting}
                                      aria-describedby={hasReadyArchive ? onlyOneHintId : undefined}
                                      onClick={() => void handlePrepareDownload(row)}
                                    >
                                      {t.download.prepare}
                                    </Button>
                                  ) : null}
                                  {showRestore ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      disabled={submitting}
                                      onClick={() => setRestoreTarget(row)}
                                    >
                                      {t.restore.button}
                                    </Button>
                                  ) : null}
                                </div>
                              ) : !rowPreparing && !rowReady && !rowExpired && !rowArchiveProblem ? (
                                "—"
                              ) : null}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                      {problemText ? (
                        <TableRow>
                          <TableCell colSpan={6} className="border-t-0 pt-0 text-sm text-destructive">
                            {problemText}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {hasReadyArchive ? (
        <p id={onlyOneHintId} className="text-xs text-muted-foreground">
          {t.download.onlyOne}
        </p>
      ) : null}

      <RestoreBackupDialog
        backup={restoreTarget}
        siteName={siteName}
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        onConfirm={handleConfirmRestore}
        copies={restoreOptions}
      />
    </div>
  );
}
