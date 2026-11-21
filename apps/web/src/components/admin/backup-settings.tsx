"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackupSettingsInputSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  type AdminSiteBackupStatusDto,
  type BackupLastRestoreDto,
  type BackupProblem,
  type BackupSettingsDto,
  type BackupSettingsInput,
  type BackupStatus,
  type BackupTestResultDto,
} from "@hosting-panel/contracts";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { RestoreBackupDialog } from "@/components/customer/restore-backup-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatSize } from "@/lib/file-browser";

const BASE = "/api/admin/backups";
const EMPTY_CELL = "\u2014";

export const BACKUP_SITES_POLL_INTERVAL_MS = 5_000;

export type BackupFieldKey =
  | "endpoint"
  | "region"
  | "bucket"
  | "prefix"
  | "accessKeyId"
  | "secretAccessKey"
  | "scheduleHourUtc"
  | "retentionDays";

export type BackupFieldErrors = Partial<Record<BackupFieldKey, string>>;

export interface BackupFormDraft {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  scheduleHourUtc: number;
  retentionInput: string;
}

export interface BackupTargetDiff {
  endpoint: string;
  bucket: string;
  prefix: string;
}

export type PollLoadResult =
  | { kind: "ok"; sites: AdminSiteBackupStatusDto[] }
  | { kind: "stale" }
  | { kind: "error"; stop: boolean };

interface ApiErrorDetail {
  field?: string;
  message?: string;
  reason?: string;
}

const VALID_FIELD_KEYS: ReadonlySet<string> = new Set<BackupFieldKey>([
  "endpoint",
  "region",
  "bucket",
  "prefix",
  "accessKeyId",
  "secretAccessKey",
  "scheduleHourUtc",
  "retentionDays",
]);

const SITE_BADGE_VARIANT: Record<BackupStatus | "never", "success" | "destructive" | "warning" | "secondary"> = {
  succeeded: "success",
  failed: "destructive",
  running: "warning",
  partial: "warning",
  never: "secondary",
};

/** Formats a UTC hour (0-23) as HH:00. */
export function formatUtcHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Converts a UTC hour today into the reader's local HH:MM string. */
export function formatLocalHour(hour: number, locale: string): string {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** Formats an ISO timestamp in the active locale. */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

/** Formats the last nightly run date (YYYY-MM-DD) or returns the never-run label. */
export function formatNightlyDate(dateStr: string | null, locale: string, neverLabel: string): string {
  if (!dateStr) return neverLabel;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${dateStr}T00:00:00Z`),
    );
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(dateStr));
}

/** Checks whether endpoint, bucket, or prefix differs from the currently saved target. */
export function isBackupTargetChanged(
  saved: BackupSettingsDto,
  draft: BackupTargetDiff,
): boolean {
  if (!saved.configured) return false;
  return (
    draft.endpoint.trim() !== (saved.endpoint ?? "") ||
    draft.bucket.trim() !== (saved.bucket ?? "") ||
    draft.prefix.trim() !== saved.prefix
  );
}

/** Resolves a backup form field message key against the i18n catalog. */
export function backupFieldText(t: Messages["admin"]["backups"], key: string): string | null {
  const fields = t.field as Record<string, string>;
  return Object.hasOwn(fields, key) ? fields[key]! : null;
}

/** Maps a backup problem code to its catalog description, falling back to other. */
export function backupProblemText(
  t: Messages["admin"]["backups"],
  problem: BackupProblem | null | undefined,
): string {
  return t.problem[problem ?? "other"] ?? t.problem.other;
}

/** Validates the backup settings form with BackupSettingsInputSchema and required-secret rules. */
export function validateBackupSettingsForm(
  draft: BackupFormDraft,
  secretAlreadySet: boolean,
): { input: BackupSettingsInput; fieldErrors: BackupFieldErrors; hasUnknownError: boolean } {
  const retentionText = draft.retentionInput.trim();
  const input = {
    endpoint: draft.endpoint.trim(),
    region: draft.region.trim(),
    bucket: draft.bucket.trim(),
    prefix: draft.prefix.trim(),
    accessKeyId: draft.accessKeyId.trim(),
    ...(draft.secretAccessKey ? { secretAccessKey: draft.secretAccessKey } : {}),
    scheduleHourUtc: draft.scheduleHourUtc,
    retentionDays: retentionText === "" ? Number.NaN : Number(retentionText),
  };

  const fieldErrors: BackupFieldErrors = {};
  const parsed = BackupSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (VALID_FIELD_KEYS.has(key)) {
        fieldErrors[key as BackupFieldKey] ??= issue.message;
      }
    }
  }
  if (!draft.secretAccessKey && !secretAlreadySet) {
    fieldErrors.secretAccessKey = "secret_access_key_required";
  }

  const hasUnknownError = !parsed.success && Object.keys(fieldErrors).length === 0;
  return {
    input: parsed.success ? parsed.data : (input as BackupSettingsInput),
    fieldErrors,
    hasUnknownError,
  };
}

/** Maps an upstream backup BFF error payload and HTTP status to actionable localized text. */
export function backupApiErrorText(
  m: Messages,
  status: number,
  json: unknown,
  scope: "settings" | "test" | "sites",
): string {
  const t = m.admin.backups;
  const errObj = (json as { error?: { code?: unknown; details?: unknown } } | null)?.error;
  const code = typeof errObj?.code === "string" ? errObj.code : "";
  const details = Array.isArray(errObj?.details) ? (errObj.details as ApiErrorDetail[]) : [];

  // Fetch timeouts produce status 504 with INTERNAL_ERROR in upstream.ts; show the ambiguous test message.
  if (scope === "test" && (status === 504 || code === "OPERATION_AMBIGUOUS")) {
    return t.testAmbiguous;
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return m.site.files.errors.UNAUTHENTICATED;
  }
  if (code === "NOT_SUPPORTED") {
    return t.state.notAvailable;
  }
  if (code === "VALIDATION_ERROR") {
    if (details.some((d) => d.message === "not_configured" || d.reason === "not_configured")) {
      return t.errors.notConfigured;
    }
    const fieldMsg = details.map((d) => d.message).find((k) => k && backupFieldText(t, k));
    if (fieldMsg) return backupFieldText(t, fieldMsg)!;
  }
  if (code === "RESOURCE_LOCKED") {
    if (details.some((d) => d.message === "not_ready" || d.reason === "not_ready")) {
      return t.errors.notReady;
    }
    return errorMessage(m, "RESOURCE_LOCKED");
  }
  return errorMessage(m, code);
}

/** Text under a site's badge for its last restore, or null. */
export function adminRestoreText(
  t: Messages["admin"]["backups"],
  r: BackupLastRestoreDto | null,
  locale: string,
): string | null {
  if (!r) return null;
  const date = formatDateTime(r.backupStartedAt, locale);
  if (r.status === "running") return format(t.restore.running, { date });
  if (r.status === "succeeded") return r.problem ? backupProblemText(t, r.problem) : format(t.restore.done, { date });
  return `${format(t.restore.failed, { date })} ${backupProblemText(t, r.problem)}`;
}

/** Maps an administrator restore error to a text with a next step. */
export function adminRestoreErrorText(m: Messages, status: number, json: unknown): string {
  const details = (json as { error?: { details?: unknown } } | null)?.error?.details;
  const fields = Array.isArray(details) ? details.map((d) => (d as ApiErrorDetail | null)?.field) : [];
  if (fields.includes("confirmName")) return m.admin.backups.restore.wrongName;
  if (fields.includes("backupId")) return m.admin.backups.restore.noCopy;
  return backupApiErrorText(m, status, json, "sites");
}

/** True while a backup or a restore of the site runs. */
function isSiteBusy(row: AdminSiteBackupStatusDto): boolean {
  return row.lastStatus === "running" || row.lastRestore?.status === "running";
}

/** Polls the admin sites backup list via non-overlapping setTimeout calls while any site is running. */
export function startBackupSitesPolling(opts: {
  load: () => Promise<PollLoadResult>;
  onSites: (sites: AdminSiteBackupStatusDto[]) => void;
  onError: () => void;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = opts.intervalMs ?? BACKUP_SITES_POLL_INTERVAL_MS;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      if (stopped) return;
      const result = await opts
        .load()
        .catch((): PollLoadResult => ({ kind: "error", stop: false }));
      if (stopped) return;
      if (result.kind === "stale") {
        schedule();
        return;
      }
      if (result.kind === "error") {
        if (result.stop) {
          stopped = true;
          return;
        }
        opts.onError();
        schedule();
        return;
      }
      opts.onSites(result.sites);
      if (result.sites.some(isSiteBusy)) {
        schedule();
      } else {
        stopped = true;
      }
    }, intervalMs);
  };

  schedule();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

function draftFromSettings(settings: BackupSettingsDto): BackupFormDraft {
  return {
    endpoint: settings.endpoint ?? "",
    region: settings.region ?? "",
    bucket: settings.bucket ?? "",
    prefix: settings.prefix,
    accessKeyId: settings.accessKeyId ?? "",
    secretAccessKey: "",
    scheduleHourUtc: settings.scheduleHourUtc,
    retentionInput: String(settings.retentionDays),
  };
}

function emptySettingsFrom(current: BackupSettingsDto): BackupSettingsDto {
  return {
    available: current.available,
    configured: false,
    endpoint: null,
    region: null,
    bucket: null,
    prefix: "",
    accessKeyId: null,
    secretAccessKeySet: false,
    scheduleHourUtc: DEFAULT_BACKUP_HOUR_UTC,
    retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    lastNightlyRunOn: null,
    lastTest: null,
    updatedAt: null,
    // Clearing deletes the settings row (panel line) and the recorded copies (their total).
    lastPanelBackup: null,
    newestBackupsTotalBytes: 0,
  };
}

/** Confirmation dialog body when saving changes to endpoint, bucket, or prefix. */
export function ConfirmTargetChangeBody({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useMessages().admin.backups;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.save}</DialogTitle>
        <DialogDescription>{t.changeWarning}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t.removeCancel}
        </Button>
        <Button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? t.saving : t.save}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Confirmation dialog body when removing the configured backup target. */
export function RemoveBackupTargetBody({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useMessages().admin.backups;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.removeTitle}</DialogTitle>
        <DialogDescription>{t.removeConfirm}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t.removeCancel}
        </Button>
        <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
          {t.removeAction}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Admin backup settings form, connection test, removal dialog, and per-site status table. */
export function BackupSettings({
  csrfToken,
  initial,
  sites: initialSites,
}: {
  csrfToken: string;
  initial: BackupSettingsDto;
  sites: AdminSiteBackupStatusDto[] | null;
}) {
  const m = useMessages();
  const t = m.admin.backups;
  const locale = useLocale();

  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<BackupFormDraft>(() => draftFromSettings(initial));
  const [sites, setSites] = useState<AdminSiteBackupStatusDto[] | null>(initialSites);
  const [fieldErrors, setFieldErrors] = useState<BackupFieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | "test" | null>(null);
  const [confirmingChange, setConfirmingChange] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testResult, setTestResult] = useState<BackupTestResultDto | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [sitesError, setSitesError] = useState<string | null>(null);
  const [startingSiteId, setStartingSiteId] = useState<string | null>(null);
  const [restoreRow, setRestoreRow] = useState<AdminSiteBackupStatusDto | null>(null);
  const sitesSeq = useRef(0);

  const refreshSites = useCallback(async () => {
    const requestSeq = ++sitesSeq.current;
    try {
      const res = await fetch(`${BASE}/sites`, { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (requestSeq !== sitesSeq.current) return;
      if (res.ok && Array.isArray(json?.data)) {
        setSites(json.data as AdminSiteBackupStatusDto[]);
        setSitesError(null);
      } else {
        setSitesError(backupApiErrorText(m, res.status, json, "sites"));
      }
    } catch {
      if (requestSeq === sitesSeq.current) {
        setSitesError(t.sitesLoadFailed);
      }
    }
  }, [m, t.sitesLoadFailed]);

  const anyRunning =
    data.available && (sites?.some(isSiteBusy) ?? false);

  useEffect(() => {
    if (!anyRunning) return;
    return startBackupSitesPolling({
      load: async () => {
        const started = sitesSeq.current;
        const res = await fetch(`${BASE}/sites`, { cache: "no-store" });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          if (res.status === 401) setSitesError(m.site.files.errors.UNAUTHENTICATED);
          return { kind: "error", stop: true };
        }
        const json = await res.json().catch(() => null);
        if (started !== sitesSeq.current) return { kind: "stale" };
        if (!res.ok || !Array.isArray(json?.data)) return { kind: "error", stop: false };
        return { kind: "ok", sites: json.data as AdminSiteBackupStatusDto[] };
      },
      onSites: (next) => {
        setSitesError(null);
        setSites(next);
      },
      onError: () => {
        setSitesError(t.sitesLoadFailed);
      },
    });
  }, [anyRunning, m.site.files.errors.UNAUTHENTICATED, t.sitesLoadFailed]);

  async function callApi(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "X-CSRF-Token": csrfToken,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, json: await res.json().catch(() => null) };
  }

  const updateDraft = (patch: Partial<BackupFormDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  async function submitSave(input: BackupSettingsInput) {
    sitesSeq.current++;
    setBusy("save");
    try {
      const { res, json } = await callApi("PATCH", BASE, input);
      if (res.ok && json?.data) {
        const next = json.data as BackupSettingsDto;
        setData(next);
        setDraft(draftFromSettings(next));
        setFieldErrors({});
        setTestResult(null);
        setTestError(null);
        setNotice(t.saved);
        void refreshSites();
        return;
      }
      const code = typeof json?.error?.code === "string" ? json.error.code : "";
      const details: ApiErrorDetail[] = Array.isArray(json?.error?.details) ? json.error.details : [];
      const known =
        code === "VALIDATION_ERROR"
          ? details.filter((d) => d.message && backupFieldText(t, d.message))
          : [];
      if (known.length !== 0) {
        setFieldErrors(
          Object.fromEntries(
            known.map((d) => [
              d.field && VALID_FIELD_KEYS.has(d.field) ? d.field : "endpoint",
              d.message!,
            ]),
          ) as BackupFieldErrors,
        );
        setError(backupFieldText(t, known[0]!.message!));
      } else {
        setError(backupApiErrorText(m, res.status, json, "settings"));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
      setConfirmingChange(false);
    }
  }

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const { input, fieldErrors: nextErrors, hasUnknownError } = validateBackupSettingsForm(
      draft,
      data.secretAccessKeySet,
    );
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length !== 0 || hasUnknownError) {
      if (hasUnknownError) setError(m.errors.VALIDATION_ERROR);
      return;
    }
    if (isBackupTargetChanged(data, draft)) {
      setConfirmingChange(true);
      return;
    }
    await submitSave(input);
  }

  async function handleConfirmTargetChange() {
    const { input, fieldErrors: nextErrors, hasUnknownError } = validateBackupSettingsForm(
      draft,
      data.secretAccessKeySet,
    );
    if (Object.keys(nextErrors).length !== 0 || hasUnknownError) {
      setFieldErrors(nextErrors);
      setConfirmingChange(false);
      if (hasUnknownError) setError(m.errors.VALIDATION_ERROR);
      return;
    }
    await submitSave(input);
  }

  async function handleRemoveTarget() {
    sitesSeq.current++;
    setBusy("remove");
    setError(null);
    setNotice(null);
    try {
      const { res, json } = await callApi("DELETE", BASE);
      if (res.ok) {
        const next = json?.data ? (json.data as BackupSettingsDto) : emptySettingsFrom(data);
        setData(next);
        setDraft(draftFromSettings(next));
        setFieldErrors({});
        setTestResult(null);
        setTestError(null);
        setNotice(t.removed);
        void refreshSites();
      } else {
        setError(backupApiErrorText(m, res.status, json, "settings"));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(null);
      setRemoving(false);
    }
  }

  async function handleRunTest() {
    setBusy("test");
    setError(null);
    setNotice(null);
    setTestResult(null);
    setTestError(null);
    try {
      const { res, json } = await callApi("POST", `${BASE}/test`);
      if (res.ok && json?.data) {
        const result = json.data as BackupTestResultDto;
        setTestResult(result);
        setData((prev) => ({
          ...prev,
          lastTest: {
            outcome: result.outcome,
            problem: result.problem,
            at: new Date().toISOString(),
          },
        }));
      } else {
        setTestError(backupApiErrorText(m, res.status, json, "test"));
      }
    } catch {
      setTestError(m.errors.generic);
    } finally {
      setBusy(null);
    }
  }

  async function handleRunSiteBackup(siteId: string) {
    setStartingSiteId(siteId);
    setSitesError(null);
    try {
      const { res, json } = await callApi(
        "POST",
        `${BASE}/sites/${encodeURIComponent(siteId)}/run`,
        {},
        { "Idempotency-Key": crypto.randomUUID() },
      );
      if (res.ok) {
        const opId = typeof json?.data?.operationId === "string" ? json.data.operationId : null;
        setSites((prev) =>
          prev
            ? prev.map((row) =>
                row.siteId === siteId
                  ? { ...row, lastStatus: "running", problem: null, runningOperationId: opId }
                  : row,
              )
            : prev,
        );
        void refreshSites();
      } else {
        setSitesError(backupApiErrorText(m, res.status, json, "sites"));
      }
    } catch {
      setSitesError(m.errors.generic);
    } finally {
      setStartingSiteId(null);
    }
  }

  async function handleConfirmRestore(confirmName: string) {
    const row = restoreRow;
    if (!row?.lastSuccessAt) return null;
    try {
      const { res, json } = await callApi(
        "POST",
        `${BASE}/sites/${encodeURIComponent(row.siteId)}/restore`,
        { backupId: row.lastSuccessBackupId ?? undefined, confirmName },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      if (!res.ok) return adminRestoreErrorText(m, res.status, json);
      const lastRestore: BackupLastRestoreDto = {
        backupId: row.lastSuccessBackupId ?? "",
        backupStartedAt: row.lastSuccessAt,
        status: "running",
        finishedAt: null,
        problem: null,
      };
      setRestoreRow(null);
      setSites((prev) => prev?.map((r) => (r.siteId === row.siteId ? { ...r, lastRestore } : r)) ?? prev);
      void refreshSites();
      return null;
    } catch {
      return m.errors.generic;
    }
  }

  const fieldErrorNode = (key: BackupFieldKey) => {
    const msgKey = fieldErrors[key];
    if (!msgKey) return null;
    const text = backupFieldText(t, msgKey);
    if (!text) return null;
    return (
      <p id={`backup-${key}-err`} className="text-sm text-destructive">
        {text}
      </p>
    );
  };

  const renderStateBanner = () => {
    if (!data.available) {
      return (
        <Alert variant="warning" role="alert">
          <AlertDescription>{t.state.notAvailable}</AlertDescription>
        </Alert>
      );
    }
    if (!data.configured) {
      return (
        <Alert role="status">
          <AlertDescription>{t.state.neverSetUp}</AlertDescription>
        </Alert>
      );
    }
    if (data.lastTest?.outcome === "failed") {
      return (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-1">
            <p>{format(t.state.lastTestFailed, { when: formatDateTime(data.lastTest.at, locale) })}</p>
            <p>{backupProblemText(t, data.lastTest.problem)}</p>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert role="status">
        <AlertDescription>
          {format(t.state.working, {
            utc: formatUtcHour(data.scheduleHourUtc),
            local: formatLocalHour(data.scheduleHourUtc, locale),
            date: formatNightlyDate(data.lastNightlyRunOn, locale, t.state.nightlyNever),
          })}
        </AlertDescription>
      </Alert>
    );
  };

  const renderPanelLine = () => {
    if (!data.available || !data.configured) return null;
    const line = data.lastPanelBackup;
    if (line?.status === "failed") {
      const panelProblem = t.panelProblem as Partial<Record<BackupProblem, string>>;
      return (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-1">
            <p>{format(t.panel.failed, { date: formatDateTime(line.at, locale) })}</p>
            <p>{panelProblem[line.problem ?? "other"] ?? backupProblemText(t, line.problem)}</p>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert role="status">
        <AlertDescription>
          {line ? format(t.panel.made, { date: formatDateTime(line.at, locale) }) : t.panel.never}
        </AlertDescription>
      </Alert>
    );
  };

  const targetChanged = isBackupTargetChanged(data, draft);

  return (
    <div className="space-y-6">
      <Alert variant="destructive" role="alert">
        <AlertDescription>{t.keyWarning}</AlertDescription>
      </Alert>

      {renderStateBanner()}
      {renderPanelLine()}

      {data.available && (
        <>
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
            <CardContent className="pt-6">
              <form className="space-y-4" onSubmit={handleFormSubmit} noValidate>
                <div className="space-y-1.5">
                  <Label htmlFor="backup-endpoint">{t.endpoint}</Label>
                  <Input
                    id="backup-endpoint"
                    value={draft.endpoint}
                    onChange={(e) => updateDraft({ endpoint: e.target.value })}
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.endpoint}
                    aria-describedby={
                      fieldErrors.endpoint
                        ? "backup-endpoint-hint backup-endpoint-err"
                        : "backup-endpoint-hint"
                    }
                  />
                  <p id="backup-endpoint-hint" className="text-xs text-muted-foreground">
                    {t.endpointHint}
                  </p>
                  {fieldErrorNode("endpoint")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-region">{t.region}</Label>
                  <Input
                    id="backup-region"
                    value={draft.region}
                    onChange={(e) => updateDraft({ region: e.target.value })}
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.region}
                    aria-describedby={
                      fieldErrors.region
                        ? "backup-region-hint backup-region-err"
                        : "backup-region-hint"
                    }
                  />
                  <p id="backup-region-hint" className="text-xs text-muted-foreground">
                    {t.regionHint}
                  </p>
                  {fieldErrorNode("region")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-bucket">{t.bucket}</Label>
                  <Input
                    id="backup-bucket"
                    value={draft.bucket}
                    onChange={(e) => updateDraft({ bucket: e.target.value })}
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.bucket}
                    aria-describedby={fieldErrors.bucket ? "backup-bucket-err" : undefined}
                  />
                  {fieldErrorNode("bucket")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-prefix">{t.prefix}</Label>
                  <Input
                    id="backup-prefix"
                    value={draft.prefix}
                    onChange={(e) => updateDraft({ prefix: e.target.value })}
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.prefix}
                    aria-describedby={
                      fieldErrors.prefix
                        ? "backup-prefix-hint backup-prefix-err"
                        : "backup-prefix-hint"
                    }
                  />
                  <p id="backup-prefix-hint" className="text-xs text-muted-foreground">
                    {t.prefixHint}
                  </p>
                  {fieldErrorNode("prefix")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-access-key">{t.accessKeyId}</Label>
                  <Input
                    id="backup-access-key"
                    value={draft.accessKeyId}
                    onChange={(e) => updateDraft({ accessKeyId: e.target.value })}
                    autoComplete="off"
                    aria-invalid={!!fieldErrors.accessKeyId}
                    aria-describedby={fieldErrors.accessKeyId ? "backup-accessKeyId-err" : undefined}
                  />
                  {fieldErrorNode("accessKeyId")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-secret">{t.secretAccessKey}</Label>
                  <Input
                    id="backup-secret"
                    type="password"
                    value={draft.secretAccessKey}
                    onChange={(e) => updateDraft({ secretAccessKey: e.target.value })}
                    autoComplete="new-password"
                    placeholder={data.secretAccessKeySet ? t.secretKeep : undefined}
                    aria-invalid={!!fieldErrors.secretAccessKey}
                    aria-describedby={
                      fieldErrors.secretAccessKey
                        ? "backup-secret-hint backup-secretAccessKey-err"
                        : "backup-secret-hint"
                    }
                  />
                  <p id="backup-secret-hint" className="text-xs text-muted-foreground">
                    {format(t.secretIs, {
                      state: data.secretAccessKeySet ? t.secretSet : t.secretNotSet,
                    })}
                  </p>
                  {fieldErrorNode("secretAccessKey")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-hour">{t.hour}</Label>
                  <select
                    id="backup-hour"
                    value={draft.scheduleHourUtc}
                    onChange={(e) => updateDraft({ scheduleHourUtc: Number(e.target.value) })}
                    aria-invalid={!!fieldErrors.scheduleHourUtc}
                    aria-describedby={
                      fieldErrors.scheduleHourUtc ? "backup-scheduleHourUtc-err" : undefined
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  >
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>
                        {format(t.hourOption, {
                          utc: formatUtcHour(hour),
                          local: formatLocalHour(hour, locale),
                        })}
                      </option>
                    ))}
                  </select>
                  {fieldErrorNode("scheduleHourUtc")}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="backup-retention">{t.retention}</Label>
                  <Input
                    id="backup-retention"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={draft.retentionInput}
                    onChange={(e) => updateDraft({ retentionInput: e.target.value })}
                    aria-invalid={!!fieldErrors.retentionDays}
                    aria-describedby={
                      fieldErrors.retentionDays
                        ? "backup-retention-hint backup-retentionDays-err"
                        : "backup-retention-hint"
                    }
                  />
                  <p id="backup-retention-hint" className="text-xs text-muted-foreground">
                    {t.retentionHint}
                  </p>
                  {fieldErrorNode("retentionDays")}
                </div>

                {targetChanged && (
                  <Alert variant="warning" role="status">
                    <AlertDescription>{t.changeWarning}</AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy !== null}>
                    {busy === "save" ? t.saving : t.save}
                  </Button>
                  {data.configured && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => setRemoving(true)}
                    >
                      {t.removeButton}
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.testTitle}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!data.configured ? (
                <p className="text-sm text-muted-foreground">{t.testSaveFirst}</p>
              ) : (
                <>
                    <p className="text-sm text-muted-foreground">{t.testHelp}</p>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={handleRunTest}
                    >
                      {busy === "test" ? t.testing : t.testButton}
                    </Button>
                    {testResult && (
                      <Alert
                        variant={testResult.outcome === "ok" ? "default" : "destructive"}
                        role={testResult.outcome === "ok" ? "status" : "alert"}
                      >
                        <AlertDescription>
                          {testResult.outcome === "ok"
                            ? t.outcome.ok
                            : backupProblemText(t, testResult.problem)}
                        </AlertDescription>
                      </Alert>
                    )}
                    {testError && (
                      <Alert variant="destructive" role="alert">
                        <AlertDescription>{testError}</AlertDescription>
                      </Alert>
                    )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.sitesTitle}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sitesError && (
                <Alert variant="destructive" role="alert">
                  <AlertDescription>{sitesError}</AlertDescription>
                </Alert>
              )}
              {sites === null ? (
                !sitesError && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{t.sitesLoadFailed}</AlertDescription>
                  </Alert>
                )
              ) : sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.sitesEmpty}</p>
              ) : (
                <>
                <p className="text-sm text-muted-foreground">
                  {format(t.sitesTotal, { size: formatSize(data.newestBackupsTotalBytes, locale) })}
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.columns.site}</TableHead>
                      <TableHead>{t.columns.owner}</TableHead>
                      <TableHead>{t.columns.lastSuccess}</TableHead>
                      <TableHead>{t.columns.size}</TableHead>
                      <TableHead>{t.columns.lastAttempt}</TableHead>
                      <TableHead>{t.columns.state}</TableHead>
                      <TableHead>{t.columns.action}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sites.map((row) => {
                      const stateKey = row.lastStatus ?? "never";
                      const rowBusy = isSiteBusy(row);
                      const restoreText = adminRestoreText(t, row.lastRestore, locale);
                      return (
                        <TableRow key={row.siteId}>
                          <TableCell className="font-medium">{row.siteName}</TableCell>
                          <TableCell>{row.organizationName}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {row.lastSuccessAt
                              ? formatDateTime(row.lastSuccessAt, locale)
                              : EMPTY_CELL}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {row.lastSuccessSizeBytes === null
                              ? EMPTY_CELL
                              : formatSize(row.lastSuccessSizeBytes, locale)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {row.lastAttemptAt
                              ? formatDateTime(row.lastAttemptAt, locale)
                              : EMPTY_CELL}
                          </TableCell>
                          <TableCell>
                            <Badge variant={SITE_BADGE_VARIANT[stateKey]} className="gap-1">
                              {stateKey === "partial" && <AlertTriangle className="size-3" aria-hidden="true" />}
                              {t.siteState[stateKey]}
                            </Badge>
                            {(row.lastStatus === "failed" || (row.lastStatus === "partial" && row.problem)) && (
                              <p className="mt-1 text-xs text-destructive">
                                {backupProblemText(t, row.problem)}
                              </p>
                            )}
                            {restoreText && (
                              <p
                                role="status"
                                className={`mt-1 text-xs ${row.lastRestore?.problem ? "text-destructive" : "text-muted-foreground"}`}
                              >
                                {restoreText}
                              </p>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={
                                  !data.configured ||
                                  rowBusy ||
                                  busy !== null ||
                                  startingSiteId !== null
                                }
                                onClick={() => handleRunSiteBackup(row.siteId)}
                              >
                                {row.lastStatus === "failed" ? t.retry : t.runNow}
                              </Button>
                              {row.lastSuccessAt !== null && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  aria-label={`${t.restore.button} ${row.siteName}`}
                                  disabled={!data.configured || rowBusy || busy !== null}
                                  onClick={() => setRestoreRow(row)}
                                >
                                  {t.restore.button}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                </>
              )}
            </CardContent>
          </Card>

          <RestoreBackupDialog
            backup={restoreRow?.lastSuccessAt ? { id: restoreRow.siteId, startedAt: restoreRow.lastSuccessAt } : null}
            siteName={restoreRow?.siteName ?? ""}
            open={restoreRow !== null}
            onOpenChange={(open) => {
              if (!open) setRestoreRow(null);
            }}
            onConfirm={handleConfirmRestore}
            texts={t.restore}
          />

          <Dialog
            open={confirmingChange}
            onOpenChange={(open) => !open && busy === null && setConfirmingChange(false)}
          >
            <DialogContent>
              <ConfirmTargetChangeBody
                busy={busy === "save"}
                onConfirm={handleConfirmTargetChange}
                onCancel={() => setConfirmingChange(false)}
              />
            </DialogContent>
          </Dialog>

          <Dialog
            open={removing}
            onOpenChange={(open) => !open && busy === null && setRemoving(false)}
          >
            <DialogContent>
              <RemoveBackupTargetBody
                busy={busy === "remove"}
                onConfirm={handleRemoveTarget}
                onCancel={() => setRemoving(false)}
              />
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
