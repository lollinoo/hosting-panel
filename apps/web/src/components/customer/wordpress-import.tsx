"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";
import {
  SiteWordpressImportDtoSchema,
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_IMPORT_LEFT_OUT,
  WORDPRESS_IMPORT_STEP_KEYS,
  type SiteWordpressImportDto,
  type SiteWordpressImportSlotDto,
  type SiteWordpressLastImportDto,
  type WordpressImportReason,
  type WordpressImportSlot,
} from "@hosting-panel/contracts";
import { UploadList, useUploadQueue, type UploadFailure } from "@/components/customer/file-uploads";
import { canConfirmRestore } from "@/components/customer/restore-backup-dialog";
import { BACKUP_POLL_INTERVAL_MS, BACKUP_POLL_LIMIT_MS, resolveQuotaRetryIso } from "@/components/customer/site-backups";
import { STEP_ICON, postJson, stepWord, wordpressErrorText } from "@/components/customer/site-wordpress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatDate, formatSize, isValidRelativePath } from "@/lib/file-browser";
import type { KeptKeys } from "@/lib/keyed-send";

type ImportTexts = Messages["site"]["wordpress"]["import"];
type RunningImport = NonNullable<SiteWordpressImportDto["runningOperation"]>;
type ErrorOpts = { retryAfter?: string | null; locale?: string; now?: Date };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LINE_REASONS = ["dump_load_failed", "dump_statement_unsupported"] as const;
const FILE_NAME = { archive: /\.zip$/i, dump: /\.sql(\.gz)?$/i } as const;
// Chunk refusals the import words itself; the rest keep the upload queue's text.
const CHUNK_REASONS = ["not_a_zip", "dump_not_sql", "disk_full", "too_large", "import_running", "earlier_import_unfinished", "not_ready"];

/** The step that needs the customer now: 1 when the files cannot be read, 5 while an import runs. */
export function importStepNumber(dto: SiteWordpressImportDto): 1 | 2 | 3 | 4 | 5 {
  if (dto.runningOperation) return 5;
  if (!dto.slots) return 1;
  if (dto.slots.archive.state !== "complete") return 2;
  return dto.slots.dump.state === "complete" ? 4 : 3;
}

/** Sentence for a reason of the last import; the line only when the API knows it (W3.7). */
export function importReasonText(
  t: ImportTexts,
  reason: WordpressImportReason,
  at: { line: number | null; errorNumber: number | null },
): string {
  const lineReason = LINE_REASONS.find((r) => r === reason);
  if (!lineReason) return t.reasons[reason];
  const text = at.line === null ? t.reasons[lineReason] : format(t.reasonsAtLine[lineReason], { line: String(at.line) });
  return at.errorNumber === null ? text : `${text} ${format(t.outcome.errorNumber, { number: String(at.errorNumber) })}`;
}

/** Customer text for a refused import call; never the API's own message. */
export function importErrorText(m: Messages, status: number, body: unknown, opts?: ErrorOpts): string {
  const t = m.site.wordpress.import;
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = typeof err?.code === "string" ? err.code : null;
  const details = err && Array.isArray(err.details) ? (err.details as unknown[]) : [];
  const reasons = details.flatMap((d) => (isRecord(d) && typeof d.reason === "string" ? [d.reason] : []));
  const has = (r: string) => reasons.includes(r);

  if (has("earlier_import_unfinished")) return t.reasons.earlier_import_unfinished;
  if (has("import_running")) return t.errors.importRunning;
  if (has("files_incomplete")) return t.confirm.filesIncomplete;
  if (has("is_a_directory")) return t.pick.notAFile;
  if (has("invalid_path")) return t.pick.invalid;
  if (status === 404 && has("not_found")) return t.pick.notFound;
  if (has("not_a_zip")) return t.reasons.archive_not_zip;
  if (has("dump_not_sql")) return t.reasons.dump_not_sql;
  if (has("disk_full")) return t.reasons.disk_full;
  if (code === "QUOTA_EXCEEDED" && has("too_large")) return m.site.files.errors.uploadTooLarge;
  if (code === "QUOTA_EXCEEDED") {
    const iso = resolveQuotaRetryIso(details, opts?.retryAfter, opts?.now ?? new Date());
    return format(t.errors.tooMany, { time: formatDate(iso, opts?.locale ?? m.common.dateLocale) });
  }
  if (status === 403 && has("protected")) return m.site.files.errors.PERMISSION_DENIED;
  if (status === 403 && code === "PERMISSION_DENIED") return t.errors.permission;
  if (status === 0 || status === 502 || status === 504 || code === "OPERATION_AMBIGUOUS") return t.errors.uncertain;
  return wordpressErrorText(m, "update", status, body, opts);
}

/** Import sentence for a refused chunk; null keeps the upload queue's own text. */
export function importChunkErrorText(m: Messages, f: UploadFailure): string | null {
  const own =
    f.code !== "OPERATION_AMBIGUOUS" &&
    ((f.reason !== undefined && CHUNK_REASONS.includes(f.reason)) || f.code === "NOT_SUPPORTED" || f.code === "ORGANIZATION_SUSPENDED");
  return own ? importErrorText(m, f.status ?? 0, { error: { code: f.code, details: f.reason ? [{ reason: f.reason }] : [] } }) : null;
}

// GET the import state through the BFF; null when the answer is missing or does not parse.
async function fetchImportState(basePath: string): Promise<{ status: number; data: SiteWordpressImportDto | null }> {
  const res = await fetch(basePath, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) return { status: res.status, data: null };
  const parsed = SiteWordpressImportDtoSchema.safeParse(((await res.json()) as { data?: unknown })?.data);
  return { status: res.status, data: parsed.success ? parsed.data : null };
}

/** Follows a running import every 2 s for at most 10 minutes, as the WordPress tab does. */
export function useImportFollow(basePath: string, initial: SiteWordpressImportDto) {
  const m = useMessages();
  const [data, setData] = useState(initial);
  const [slow, setSlow] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const running = data.runningOperation !== null;

  useEffect(() => {
    if (!running || stopped) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt >= BACKUP_POLL_LIMIT_MS) {
        setSlow(true);
        setStopped(true);
        return;
      }
      try {
        const r = await fetchImportState(basePath);
        if (cancelled) return;
        if (r.status === 401 || r.status === 403 || r.status === 404) {
          setPageError(wordpressErrorText(m, "check", r.status, null));
          setStopped(true);
          return;
        }
        if (r.data) {
          setData(r.data);
          if (r.data.runningOperation === null) return;
        }
      } catch {
        // A lost answer: keep polling inside the time limit.
      }
      timer = setTimeout(() => void tick(), BACKUP_POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void tick(), BACKUP_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [running, stopped, basePath, m]);

  const reload = useCallback(async () => {
    try {
      const r = await fetchImportState(basePath);
      if (r.data) setData(r.data);
    } catch {
      // Keep the state shown; the next action or a reload brings the new one.
    }
  }, [basePath]);

  const follow = useCallback((operation: RunningImport) => {
    setStopped(false);
    setSlow(false);
    setPageError(null);
    setData((prev) => ({ ...prev, runningOperation: operation }));
  }, []);

  return { data, slow, pageError, reload, follow };
}

/** The six steps of a running import; an end not known yet is neither failed nor done (W3.6). */
export function ImportProgress({ operation }: { operation: RunningImport }) {
  const m = useMessages();
  const t = m.site.wordpress.import;
  const unsettled = operation.status === "unknown" || operation.steps.some((s) => s.status === "unknown");
  return (
    <div className="space-y-3">
      <ol className="space-y-2 text-sm" aria-live="polite">
        {WORDPRESS_IMPORT_STEP_KEYS.map((key) => {
          const status = operation.steps.find((s) => s.key === key)?.status ?? "pending";
          const plain = stepWord(status);
          const word = unsettled && (status === "unknown" || plain === "failed") ? "running" : plain;
          const Icon = STEP_ICON[word];
          return (
            <li key={key} className="flex items-center gap-2" aria-current={word === "running" ? "step" : undefined}>
              <Icon aria-hidden className={`h-4 w-4 ${word === "running" ? "animate-spin" : ""}`} />
              <span>{key === "backup" && word === "skipped" ? t.progress.backupSkipped : t.progress[key]}</span>
              <span className="sr-only"> ({m.site.wordpress.step[word]})</span>
            </li>
          );
        })}
      </ol>
      {unsettled && <p className="text-sm">{t.progress.unsettled}</p>}
    </div>
  );
}

/** The outcome of the last import; address, tables and left-out lines only when imported (W3.6, R170). */
export function ImportOutcome({ last, backupsHref }: { last: SiteWordpressLastImportDto; backupsHref: string }) {
  const m = useMessages();
  const t = m.site.wordpress.import;
  const date = formatDate(last.finishedAt, m.common.dateLocale);
  const imported = last.outcome === "imported";
  const headline =
    last.outcome === "imported"
      ? t.outcome.imported
      : last.outcome === "nothing_changed"
        ? t.outcome.nothingChanged
        : last.outcome === "site_restored"
          ? t.outcome.siteRestored
          : format(last.backup === "taken" ? t.outcome.undoTaken : t.outcome.undoNoCopy, { date });
  const Icon = imported ? CheckCircle2 : XCircle;
  return (
    <Alert role={imported ? "status" : "alert"} variant={last.outcome === "undo_incomplete" ? "destructive" : "default"}>
      <Icon aria-hidden className="h-4 w-4" />
      <AlertTitle>{t.outcome.title}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p className="text-muted-foreground">{format(t.outcome.finishedAt, { date })}</p>
        <p>{headline}</p>
        {last.reason && <p>{importReasonText(t, last.reason, last)}</p>}
        {/* The API keeps these after a failed switch; only an imported site really has them (R170.1). */}
        {imported && last.oldAddress && <p>{format(t.outcome.oldAddress, { address: last.oldAddress })}</p>}
        {imported && last.tables !== null && <p>{format(t.outcome.tables, { count: String(last.tables) })}</p>}
        {imported && last.leftOut.length > 0 && <p>{format(t.outcome.leftOut, { list: last.leftOut.join(", ") })}</p>}
        <p>{t.outcome.backup[last.backup]}</p>
        {last.outcome === "undo_incomplete" && (
          <Link href={backupsHref} className="underline">
            {t.backupsLink}
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Step 4: what happens, then the typed site name enables the one destructive button. */
export function ImportConfirmView(props: {
  backupsConfigured: boolean;
  siteName: string;
  typed: string;
  busy: boolean;
  error: string | null;
  onTyped: (value: string) => void;
  onConfirm: () => void;
}) {
  const t = useMessages().site.wordpress.import.confirm;
  const [before, after] = t.typeLabel.split("{name}");
  const ok = canConfirmRestore(props.typed, props.siteName);
  return (
    <div className="space-y-3 text-sm">
      <ul className="list-disc space-y-1 pl-5">
        <li>{t.replaces}</li>
        <li>{t.downtime}</li>
        <li>{props.backupsConfigured ? t.backupTaken : t.backupNone}</li>
        {props.backupsConfigured && <li>{t.oldestCopy}</li>}
        <li>{t.address}</li>
        <li>{format(t.leftOut, { list: WORDPRESS_IMPORT_LEFT_OUT.join(", ") })}</li>
        <li>{t.undo}</li>
      </ul>
      <div className="space-y-2">
        <Label htmlFor="import-site-name">
          {before}
          <strong>{props.siteName}</strong>
          {after}
        </Label>
        <Input
          id="import-site-name"
          value={props.typed}
          onChange={(e) => props.onTyped(e.target.value)}
          onKeyDown={(e) => {
            // Enter never starts the import.
            if (e.key === "Enter") e.preventDefault();
          }}
          autoComplete="off"
          disabled={props.busy}
        />
      </div>
      {props.error && (
        <Alert variant="destructive">
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      )}
      {!ok && (
        <p id="import-confirm-hint" className="text-muted-foreground">
          {t.typeHint}
        </p>
      )}
      <Button
        type="button"
        variant="destructive"
        disabled={props.busy || !ok}
        aria-describedby={ok ? undefined : "import-confirm-hint"}
        onClick={props.onConfirm}
      >
        {props.busy ? t.starting : t.go}
      </Button>
    </div>
  );
}

/** "Discard files" and its note; locked while a file is sent or picked, or the import is starting (R169.3, R171.6). */
export function ImportDiscardView(props: {
  hasFiles: boolean;
  sending: boolean;
  note: { text: string; failed: boolean } | null;
  onDiscard: () => void;
}) {
  const t = useMessages().site.wordpress.import;
  const { note, sending } = props;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {props.hasFiles && (
        <Button
          type="button"
          variant="outline"
          disabled={sending}
          aria-describedby={sending ? "import-discard-hint" : undefined}
          onClick={props.onDiscard}
        >
          {t.discard}
        </Button>
      )}
      {props.hasFiles && sending && (
        <p id="import-discard-hint" className="text-sm text-muted-foreground">
          {t.discardBusy}
        </p>
      )}
      {note && (
        <p role={note.failed ? "alert" : "status"} className={`text-sm ${note.failed ? "text-destructive" : ""}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}

// One of the two files: upload (resumable after a reload when the same file is chosen) or pick.
function ImportSlot(props: {
  slot: WordpressImportSlot;
  state: SiteWordpressImportSlotDto;
  basePath: string;
  csrfToken: string;
  onCsrfToken: (token: string) => void;
  onChanged: () => void;
  onSending: (slot: WordpressImportSlot, sending: boolean) => void;
}) {
  const { slot, state, basePath, csrfToken, onChanged, onSending } = props;
  const m = useMessages();
  const locale = useLocale();
  const t = m.site.wordpress.import;
  const chunkUrl = `${basePath}/files/${slot}`;
  const queue = useUploadQueue({
    apiBase: basePath,
    csrfToken,
    onCsrfToken: props.onCsrfToken,
    onFileDone: onChanged,
    chunkUrl,
    errorText: importChunkErrorText,
  });
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const storeKey = `hp-wp-import:${basePath}:${slot}`;
  const locked = queue.hasActive || picking;
  useEffect(() => onSending(slot, locked), [onSending, slot, locked]);

  function choose(file: File) {
    setError(null);
    if (!FILE_NAME[slot].test(file.name)) {
      setError(t.slot.wrongType[slot]);
      return;
    }
    let resume: { uploadId: string; offset: number } | undefined;
    try {
      const rec = JSON.parse(sessionStorage.getItem(storeKey) ?? "null") as Record<string, unknown> | null;
      const same = rec?.name === file.name && rec.size === file.size && rec.lastModified === file.lastModified;
      if (state.state === "partial" && state.uploadId && rec?.uploadId === state.uploadId && same) {
        resume = { uploadId: state.uploadId, offset: state.size };
      }
    } catch {
      // No record: a fresh upload.
    }
    resume ??= { uploadId: crypto.randomUUID(), offset: 0 };
    try {
      sessionStorage.setItem(
        storeKey,
        JSON.stringify({ uploadId: resume.uploadId, name: file.name, size: file.size, lastModified: file.lastModified }),
      );
    } catch {
      // Without storage only the resume after a reload is lost.
    }
    queue.enqueue([{ file, path: file.name, overwrite: true, resume }]);
  }

  async function pick() {
    setError(null);
    const p = path.trim();
    if (!isValidRelativePath(p, false)) {
      setError(t.pick.invalid);
      return;
    }
    setPicking(true);
    const r = await postJson(`${chunkUrl}/pick`, csrfToken, { path: p });
    setPicking(false);
    if (r.status >= 200 && r.status < 300) {
      setPath("");
      onChanged();
    } else {
      setError(importErrorText(m, r.status, r.body, { retryAfter: r.retryAfter }));
    }
  }

  const ids = { file: `import-file-${slot}`, pick: `import-pick-${slot}`, warn: `import-sftp-${slot}` };
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {state.state === "complete"
          ? format(t.slot.filled, { size: formatSize(state.size, locale) })
          : state.state === "partial"
            ? format(t.slot.partial, { received: formatSize(state.size, locale) })
            : t.slot.empty}
      </p>
      <div className="space-y-1">
        <Label htmlFor={ids.file}>{state.state === "complete" ? t.slot.replace : t.slot.choose}</Label>
        <Input
          id={ids.file}
          type="file"
          accept={slot === "archive" ? ".zip" : ".sql,.gz"}
          disabled={locked}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) choose(file);
          }}
        />
      </div>
      <UploadList
        items={queue.items}
        onCancel={queue.cancel}
        onRetry={(id) => void queue.retry(id)}
        onCancelAll={queue.cancelAll}
        onDismiss={queue.dismissDone}
      />
      <div className="space-y-1">
        <Label htmlFor={ids.pick}>{t.pick.label}</Label>
        <div className="flex gap-2">
          <Input
            id={ids.pick}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-describedby={ids.warn}
            autoComplete="off"
            disabled={locked}
          />
          <Button type="button" variant="outline" disabled={locked || path.trim() === ""} onClick={() => void pick()}>
            {t.pick.use}
          </Button>
        </div>
        <p id={ids.warn} className="text-xs text-muted-foreground">
          {t.pick.sftpWarning}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

type WizardProps = { basePath: string; siteName: string; csrfToken: string; backupsHref: string };

/** The import page: parses the loaded state; an answer that does not parse is "could not load". */
export function WordpressImport({ initial, ...props }: WizardProps & { initial: unknown }) {
  const m = useMessages();
  const parsed = SiteWordpressImportDtoSchema.safeParse(initial);
  const message = !parsed.success ? m.site.wordpress.import.loadFailed : !parsed.data.available ? m.site.wordpress.notAvailable : null;
  if (parsed.success && message === null) return <Wizard {...props} initial={parsed.data} />;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{m.site.wordpress.import.title}</h2>
      <Alert variant={parsed.success ? "default" : "destructive"}>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}

function Wizard({ basePath, siteName, csrfToken, backupsHref, initial }: WizardProps & { initial: SiteWordpressImportDto }) {
  const m = useMessages();
  const t = m.site.wordpress.import;
  const { data, slow, pageError, reload, follow } = useImportFollow(basePath, initial);
  const [csrf, setCsrf] = useState(csrfToken);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesNote, setFilesNote] = useState<{ text: string; failed: boolean } | null>(null);
  const runHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusRunRef = useRef(false);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const followedRef = useRef(initial.runningOperation !== null);
  // The start's key, kept until answered; a reload forgets it.
  const startKeysRef = useRef<KeptKeys>({});
  const onChanged = useCallback(() => void reload(), [reload]);
  const [sendingSlots, setSendingSlots] = useState<Record<WordpressImportSlot, boolean>>({ archive: false, dump: false });
  const onSending = useCallback(
    (name: WordpressImportSlot, active: boolean) => setSendingSlots((prev) => (prev[name] === active ? prev : { ...prev, [name]: active })),
    [],
  );

  const op = data.runningOperation;
  const slots = data.slots;
  const current = importStepNumber(data);
  const bothComplete = slots?.archive.state === "complete" && slots.dump.state === "complete";

  useEffect(() => {
    if (op) followedRef.current = true;
    if (op && focusRunRef.current) {
      focusRunRef.current = false;
      runHeadingRef.current?.focus();
    }
    // A followed import that ends moves focus to its outcome.
    if (!op && followedRef.current) {
      followedRef.current = false;
      outcomeRef.current?.focus();
    }
  }, [op]);

  async function start() {
    if (busy || !canConfirmRestore(typed, siteName)) return;
    setBusy(true);
    setError(null);
    const r = await postJson(basePath, csrf, { confirm: true }, startKeysRef.current);
    setBusy(false);
    if (r.status >= 200 && r.status < 300) {
      const body = r.body;
      const id = isRecord(body) && isRecord(body.data) && typeof body.data.operationId === "string" ? body.data.operationId : "pending";
      focusRunRef.current = true;
      setTyped("");
      follow({ id, kind: WORDPRESS_IMPORT_KIND, status: "queued", steps: [] });
    } else {
      setError(importErrorText(m, r.status, r.body, { retryAfter: r.retryAfter }));
    }
  }

  async function discard() {
    setFilesNote(null);
    let status = 0;
    let body: unknown = null;
    try {
      const res = await fetch(`${basePath}/files`, { method: "DELETE", headers: { "x-csrf-token": csrf }, cache: "no-store" });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      // status 0: no answer reached the browser.
    }
    if (status >= 200 && status < 300) {
      setFilesNote({ text: t.discardDone, failed: false });
      await reload();
    } else {
      setFilesNote({ text: importErrorText(m, status, body), failed: true });
    }
  }

  const step = (n: 1 | 2 | 3 | 4 | 5, title: string, children: ReactNode) => (
    <section
      aria-labelledby={`import-step-${n}`}
      aria-current={current === n ? "step" : undefined}
      className="space-y-3 rounded-lg border p-4"
    >
      <h3
        id={`import-step-${n}`}
        ref={n === 5 ? runHeadingRef : undefined}
        tabIndex={n === 5 ? -1 : undefined}
        className="font-medium outline-none"
      >
        {`${format(t.stepOf, { n: String(n) })} · ${title}`}
      </h3>
      {children}
    </section>
  );

  const slot = (name: WordpressImportSlot) =>
    slots && (
      <ImportSlot
        slot={name}
        state={slots[name]}
        basePath={basePath}
        csrfToken={csrf}
        onCsrfToken={setCsrf}
        onChanged={onChanged}
        onSending={onSending}
      />
    );

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t.title}</h2>
      {pageError && (
        <Alert variant="destructive">
          <AlertDescription>{pageError}</AlertDescription>
        </Alert>
      )}
      {!op && data.earlierImportUnfinished && (
        <Alert variant="warning">
          <AlertDescription className="space-y-1">
            <p>{t.reasons.earlier_import_unfinished}</p>
            <Link href={backupsHref} className="underline">
              {t.backupsLink}
            </Link>
          </AlertDescription>
        </Alert>
      )}
      {!op && data.lastImport && (
        <div ref={outcomeRef} tabIndex={-1} className="outline-none">
          <ImportOutcome last={data.lastImport} backupsHref={backupsHref} />
        </div>
      )}
      {op ? (
        step(
          5,
          t.steps.run,
          <>
            <p className="text-sm">{t.progress.title}</p>
            <ImportProgress operation={op} />
            {slow && <p className="text-sm text-muted-foreground">{t.progress.slow}</p>}
          </>,
        )
      ) : (
        <>
          {step(
            1,
            t.steps.intro,
            <div className="space-y-2 text-sm">
              <p>{t.intro.body}</p>
              <p>{t.intro.what}</p>
            </div>,
          )}
          {!slots ? (
            <Alert variant="destructive">
              <AlertDescription>{t.filesUnknown}</AlertDescription>
            </Alert>
          ) : (
            <>
              {step(2, t.steps.archive, slot("archive"))}
              {step(3, t.steps.dump, slot("dump"))}
              {(slots.archive.state !== "empty" || slots.dump.state !== "empty" || filesNote) && (
                <ImportDiscardView
                  hasFiles={slots.archive.state !== "empty" || slots.dump.state !== "empty"}
                  sending={sendingSlots.archive || sendingSlots.dump || busy}
                  note={filesNote}
                  onDiscard={() => void discard()}
                />
              )}
              {step(
                4,
                t.steps.confirm,
                data.earlierImportUnfinished ? (
                  <p className="text-sm">{t.reasons.earlier_import_unfinished}</p>
                ) : bothComplete ? (
                  <ImportConfirmView
                    backupsConfigured={data.backupsConfigured}
                    siteName={siteName}
                    typed={typed}
                    busy={busy}
                    error={error}
                    onTyped={setTyped}
                    onConfirm={() => void start()}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t.confirm.filesIncomplete}</p>
                ),
              )}
            </>
          )}
          {step(5, t.steps.run, null)}
        </>
      )}
    </div>
  );
}
