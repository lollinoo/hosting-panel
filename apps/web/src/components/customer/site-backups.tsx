"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ErrorCodeSchema, type SiteBackupDto, type SiteBackupsDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatDate, formatSize } from "@/lib/file-browser";

const DAY_MS = 86_400_000;

export const BACKUP_POLL_INTERVAL_MS = 2_000;
export const BACKUP_POLL_LIMIT_MS = 10 * 60_000;

export type BackupExpiry = Date | "keptLatest" | null;

export interface BackupErrorResult {
  kind: "notSetUp" | "notAvailable" | "error";
  message: string;
}

export interface SiteBackupsProps {
  basePath: string;
  initial: SiteBackupsDto;
  csrfToken: string;
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
  if (row.status !== "succeeded") return null;
  const startedMs = Date.parse(row.startedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || !Number.isFinite(retentionDays) || retentionDays < 0) {
    return null;
  }
  const expiresAtMs = startedMs + retentionDays * DAY_MS;
  if (expiresAtMs < nowMs) return "keptLatest";
  return new Date(expiresAtMs - DAY_MS);
}

// Map an HTTP status and API error envelope to localized customer-safe copy.
export function backupErrorText(m: Messages, status: number, body: unknown): BackupErrorResult {
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
  if (status === 422 || code === "NOT_SUPPORTED") {
    return { kind: "notAvailable", message: t.notAvailable };
  }
  if (status === 401 || code === "UNAUTHENTICATED") {
    return { kind: "error", message: m.site.files.errors.UNAUTHENTICATED };
  }
  if (code === "ORGANIZATION_SUSPENDED") {
    return { kind: "error", message: t.errors.ORGANIZATION_SUSPENDED };
  }
  if (code === "RESOURCE_LOCKED") {
    if (hasDetail("not_ready")) {
      return { kind: "error", message: t.errors.notReady };
    }
    return { kind: "error", message: errorMessage(m, "RESOURCE_LOCKED") };
  }
  if (status === 502 || status === 504 || code === "OPERATION_AMBIGUOUS") {
    return { kind: "error", message: t.errors.uncertain };
  }
  if (code) {
    return { kind: "error", message: errorMessage(m, code) };
  }
  return { kind: "error", message: t.loadFailed };
}

// Return the localized customer message when backup polling reaches its time limit.
export function backupGiveUpText(m: Messages): string {
  return m.site.backups.errors.stillRunning;
}

// Send at most one manual backup POST request while an in-flight request is pending.
export async function triggerSiteBackup(opts: {
  basePath: string;
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
    return await fetchImpl(opts.basePath, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": opts.csrfToken,
        "Idempotency-Key": makeKey(),
      },
      body: "{}",
    });
  } finally {
    opts.inFlightRef.current = false;
  }
}

export type SiteBackupTriggerOutcome =
  | { kind: "ignored" }
  | { kind: "started"; operationId: string }
  | { kind: "notAvailable" }
  | { kind: "notSetUp" }
  | { kind: "error"; message: string };

// Trigger a manual backup and unwrap { data: { operationId } }, treating missing data as a failed read.
export async function submitSiteBackup(opts: {
  basePath: string;
  csrfToken: string;
  inFlightRef: { current: boolean };
  messages: Messages;
  fetchImpl?: typeof fetch;
  makeIdempotencyKey?: () => string;
}): Promise<SiteBackupTriggerOutcome> {
  try {
    const res = await triggerSiteBackup({
      basePath: opts.basePath,
      csrfToken: opts.csrfToken,
      inFlightRef: opts.inFlightRef,
      fetchImpl: opts.fetchImpl,
      makeIdempotencyKey: opts.makeIdempotencyKey,
    });
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

    const mapped = backupErrorText(opts.messages, res.status, body);
    if (mapped.kind === "notAvailable") return { kind: "notAvailable" };
    if (mapped.kind === "notSetUp") return { kind: "notSetUp" };
    return { kind: "error", message: mapped.message };
  } catch {
    return { kind: "error", message: opts.messages.site.backups.loadFailed };
  }
}

// Poll site backups on a bounded timer until the running backup completes, fails auth, or hits the limit.
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
          const stillRunning =
            dto.runningOperationId !== null || dto.backups.some((row) => row.status === "running");
          if (!stillRunning) return;
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

// Render the customer backups tab state machine, action button, status list, and failure notes.
export function SiteBackups({ basePath, initial, csrfToken }: SiteBackupsProps) {
  const m = useMessages();
  const locale = useLocale();
  const t = m.site.backups;

  const [data, setData] = useState<SiteBackupsDto>(initial);
  const [submitting, setSubmitting] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const isRunning =
    data.runningOperationId !== null || data.backups.some((row) => row.status === "running");

  useEffect(() => {
    if (!isRunning || pollTimedOut) return;
    return startBackupPolling({
      basePath,
      onData: (dto) => {
        setData(dto);
      },
      onUnauthorized: (status) => {
        setPollTimedOut(true);
        setErrorText(backupErrorText(m, status, null).message);
      },
      onGiveUp: () => {
        setPollTimedOut(true);
        setErrorText(backupGiveUpText(m));
      },
    });
  }, [isRunning, pollTimedOut, basePath, m]);

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

  async function handleBackupNow() {
    if (inFlightRef.current || submitting || isRunning) return;
    setSubmitting(true);
    setErrorText(null);
    setPollTimedOut(false);

    try {
      const outcome = await submitSiteBackup({
        basePath,
        csrfToken,
        inFlightRef,
        messages: m,
      });
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "started") {
        setData((prev) => ({ ...prev, runningOperationId: outcome.operationId }));
        return;
      }
      if (outcome.kind === "notAvailable") {
        setData((prev) => ({ ...prev, available: false, configured: false, runningOperationId: null }));
        return;
      }
      if (outcome.kind === "notSetUp") {
        setData((prev) => ({ ...prev, configured: false, runningOperationId: null }));
        return;
      }
      setErrorText(outcome.message);
    } finally {
      setSubmitting(false);
    }
  }

  const now = new Date();

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
        <Button type="button" onClick={handleBackupNow} disabled={submitting || isRunning}>
          {t.backupNow}
        </Button>
      </div>

      {isRunning ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t.running}
        </p>
      ) : null}

      {errorText ? (
        <Alert variant="destructive">
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
                  const badgeVariant =
                    row.status === "succeeded"
                      ? "default"
                      : row.status === "failed"
                        ? "destructive"
                        : "secondary";
                  const problemText =
                    row.status === "failed" && row.problem
                      ? Object.hasOwn(t.problem, row.problem)
                        ? t.problem[row.problem]
                        : t.problem.other
                      : null;

                  return (
                    <Fragment key={row.id}>
                      <TableRow className={problemText ? "border-b-0" : undefined}>
                        <TableCell>{formatDate(row.startedAt, locale)}</TableCell>
                        <TableCell>{t.kind[row.kind]}</TableCell>
                        <TableCell>{sizeText}</TableCell>
                        <TableCell>
                          <Badge variant={badgeVariant}>{t.status[row.status]}</Badge>
                        </TableCell>
                        <TableCell>{expiryText}</TableCell>
                      </TableRow>
                      {problemText ? (
                        <TableRow>
                          <TableCell colSpan={5} className="border-t-0 pt-0 text-sm text-destructive">
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
    </div>
  );
}
