"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import {
  ErrorCodeSchema,
  SiteWordpressDtoSchema,
  WORDPRESS_ITEM_NAME_PATTERN,
  type OperationStepStatus,
  type SiteWordpressDto,
  type SiteWordpressLastUpdateDto,
  type SiteWordpressStateDto,
} from "@hosting-panel/contracts";
import { BACKUP_POLL_INTERVAL_MS, BACKUP_POLL_LIMIT_MS, resolveQuotaRetryIso } from "@/components/customer/site-backups";
import {
  WordpressResetDialog,
  WordpressUpdateDialog,
  type WordpressResetResult,
  type WordpressUpdateTarget,
} from "@/components/customer/wordpress-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { formatDate } from "@/lib/file-browser";
import { keyFor, settleKey, type KeptKeys } from "@/lib/keyed-send";
import {
  pendingWordpressUpdates,
  wordpressNeedsCheck,
  wordpressOutcomeKey,
  wordpressStateProblemKey,
  wordpressStatusKey,
} from "@/lib/site-wordpress";

type RunningOperation = NonNullable<SiteWordpressDto["runningOperation"]>;
type Item = SiteWordpressStateDto["plugins"][number] | SiteWordpressStateDto["themes"][number];
type Dialog = { kind: "update"; target: WordpressUpdateTarget } | { kind: "reset"; id: number; login: string };
type Posted = { status: number; body: unknown; retryAfter: string | null };

const NOT_CHANGED = { config_broken: "configBroken", database_unreachable: "databaseUnreachable", not_installed: "notInstalled" } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Localized, customer-safe text for a failed WordPress request. */
export function wordpressErrorText(
  m: Messages,
  action: "check" | "update" | "reset",
  status: number,
  body: unknown,
  opts?: { retryAfter?: string | null; locale?: string; now?: Date },
): string {
  const t = m.site.wordpress;
  const err = isRecord(body) && isRecord(body.error) ? body.error : null;
  const parsed = ErrorCodeSchema.safeParse(err?.code);
  const code = parsed.success ? parsed.data : null;
  const details = err && Array.isArray(err.details) ? err.details : [];
  const reasons = details.flatMap((d) => (isRecord(d) && typeof d.reason === "string" ? [d.reason] : []));

  if (status === 401) return m.site.files.errors.UNAUTHENTICATED;
  if (status === 403 && code === "ORGANIZATION_SUSPENDED") return t.errors.suspended;
  if (status === 403) return errorMessage(m, "PERMISSION_DENIED");
  if (status === 422 || code === "NOT_SUPPORTED") return t.notAvailable;
  if (code === "QUOTA_EXCEEDED") {
    const iso = resolveQuotaRetryIso(details, opts?.retryAfter, opts?.now ?? new Date());
    return format(m.site.backups.errors.tooMany, { time: formatDate(iso, opts?.locale ?? m.common.dateLocale) });
  }
  if (code === "RESOURCE_LOCKED") return reasons.includes("not_ready") ? t.errors.notReady : errorMessage(m, "RESOURCE_LOCKED");
  if (reasons.includes("item_unknown")) return t.errors.itemUnknown;
  if (reasons.includes("administrator_unknown")) return t.errors.adminUnknown;
  const uncertain = status === 0 || status === 502 || status === 504 || code === "OPERATION_AMBIGUOUS";
  if (action === "reset") {
    const known = status === 503 ? reasons.find((r): r is keyof typeof NOT_CHANGED => Object.hasOwn(NOT_CHANGED, r)) : undefined;
    if (known) return t.reset.failed[NOT_CHANGED[known]];
    // The job may have run: never say the password is unchanged.
    if (uncertain || status === 503) return t.reset.failed.unknown;
  } else if (uncertain) {
    return t.errors.uncertain;
  }
  if (status >= 500) return errorMessage(m, "INTERNAL_ERROR");
  return code ? errorMessage(m, code) : m.errors.generic;
}

// POST JSON through the BFF; status 0 means no answer reached the browser.
// With `keys` the action (its url) keeps its Idempotency-Key until an answer ends it, so a retry replays.
export async function postJson(url: string, csrfToken: string, body: unknown, keys?: KeptKeys): Promise<Posted> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-csrf-token": csrfToken };
  const payload = JSON.stringify(body);
  if (keys) headers["Idempotency-Key"] = keyFor(keys, url, payload);
  try {
    const res = await fetch(url, { method: "POST", headers, body: payload, cache: "no-store" });
    if (keys) settleKey(keys, url, res.status);
    const json: unknown = await res.json().catch(() => null);
    return { status: res.status, body: json, retryAfter: res.headers.get("Retry-After") };
  } catch {
    return { status: 0, body: null, retryAfter: null };
  }
}

const operationId = (body: unknown) =>
  isRecord(body) && isRecord(body.data) && typeof body.data.operationId === "string" ? body.data.operationId : "pending";

export const stepWord = (s: OperationStepStatus) =>
  s === "succeeded" ? "done" : s === "running" ? "running" : s === "skipped" ? "skipped" : s === "failed" || s === "cancelled" ? "failed" : "waiting";

export const STEP_ICON = { done: CheckCircle2, running: Loader2, skipped: MinusCircle, failed: XCircle, waiting: Circle } as const;

/** Progress list of the running operation (exported for static-render tests). */
export function WordpressProgress({ operation }: { operation: RunningOperation }) {
  const t = useMessages().site.wordpress;
  const keys = operation.kind === "site.wordpress.update" ? (["backup", "update", "settle"] as const) : (["inspect"] as const);
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        {operation.kind === "site.wordpress.update" && <h3 className="font-medium">{t.progress.title}</h3>}
        <ol className="space-y-2 text-sm" aria-live="polite">
          {keys.map((key) => {
            const status = operation.steps.find((s) => s.key === key)?.status ?? "pending";
            const word = stepWord(status);
            const Icon = STEP_ICON[word];
            return (
              <li key={key} className="flex items-center gap-2" aria-current={word === "running" ? "step" : undefined}>
                <Icon aria-hidden className={`h-4 w-4 ${word === "running" ? "animate-spin" : ""}`} />
                <span>{key === "backup" && word === "skipped" ? t.progress.backupSkipped : t.progress[key]}</span>
                <span className="sr-only"> ({t.step[word]})</span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/** Card with the outcome of the last update (exported for static-render tests). */
export function WordpressLastUpdate({ last }: { last: SiteWordpressLastUpdateDto }) {
  const m = useMessages();
  const t = m.site.wordpress;
  const unknown = t.tables.unknown;
  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <h3 className="font-medium">{t.outcome.title}</h3>
        <p className="text-sm text-muted-foreground">
          {format(t.outcome.finishedAt, { date: formatDate(last.finishedAt, m.common.dateLocale) })}
        </p>
        <p className="text-sm">{t.outcome[wordpressOutcomeKey(last)]}</p>
        {last.backup === "taken" && <p className="text-sm">{t.outcome.backupTaken}</p>}
        {last.backup === "skipped" && <p className="text-sm">{t.outcome.backupSkipped}</p>}
        {last.items.length > 0 && (
          <Table>
            <TableCaption className="sr-only">{t.outcome.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t.outcome.item}</TableHead>
                <TableHead>{t.outcome.before}</TableHead>
                <TableHead>{t.outcome.after}</TableHead>
                <TableHead>{t.outcome.result}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {last.items.map((item, i) => (
                <TableRow key={`${item.type}-${item.name}-${i}`}>
                  <TableCell>
                    <span className="text-muted-foreground">{t.outcome.type[item.type]}</span> {item.name}
                  </TableCell>
                  <TableCell>{item.oldVersion ?? unknown}</TableCell>
                  <TableCell>{item.newVersion ?? unknown}</TableCell>
                  <TableCell>{item.status === "updated" ? t.outcome.updated : t.outcome.notUpdated}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// One table of plugins or themes; the Update button only for a known update and a valid name.
function ItemTable(props: {
  caption: string;
  empty: string;
  items: readonly Item[];
  known: boolean;
  locked: boolean;
  onUpdate: (name: string) => void;
}) {
  const t = useMessages().site.wordpress;
  return (
    <Table>
      <TableCaption className="sr-only">{props.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{t.tables.name}</TableHead>
          <TableHead>{t.tables.status}</TableHead>
          <TableHead>{t.tables.installed}</TableHead>
          <TableHead>{t.tables.available}</TableHead>
          <TableHead>{t.tables.actions}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="text-muted-foreground">
              {props.empty}
            </TableCell>
          </TableRow>
        ) : (
          props.items.map((item) => {
            const label = item.title || item.name;
            return (
              <TableRow key={item.name}>
                <TableCell className="font-medium">{label}</TableCell>
                <TableCell>{t.status[wordpressStatusKey(item.status)]}</TableCell>
                <TableCell>{item.version ?? t.tables.unknown}</TableCell>
                <TableCell>{props.known ? (item.updateVersion ?? t.tables.current) : t.tables.unknown}</TableCell>
                <TableCell>
                  {props.known && item.updateVersion !== null && WORDPRESS_ITEM_NAME_PATTERN.test(item.name) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={props.locked}
                      aria-label={format(t.tables.updateLabel, { name: label, version: item.updateVersion })}
                      onClick={() => props.onUpdate(item.name)}
                    >
                      {t.tables.update}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

/** The WordPress tab: stored versions, updates, administrators, progress and the last outcome. */
export function SiteWordpress({ basePath, initial, csrfToken }: { basePath: string; initial: SiteWordpressDto; csrfToken: string }) {
  const m = useMessages();
  const t = m.site.wordpress;
  const [data, setData] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<"checkFailed" | "slow" | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const inFlightRef = useRef(false);
  const autoRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // checkedAt seen before the followed check; undefined when no check is followed.
  const inspectFromRef = useRef<string | null | undefined>(
    initial.runningOperation?.kind === "site.wordpress.inspect" ? (initial.state?.checkedAt ?? null) : undefined,
  );
  // Check and update keys, kept until answered; a reload forgets them.
  const keysRef = useRef<KeptKeys>({});

  const op = data.runningOperation;
  const running = op !== null;
  const locked = running || checking;

  useEffect(() => {
    if (!running || pollStopped) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - startedAt >= BACKUP_POLL_LIMIT_MS) {
        setNotice("slow");
        setPollStopped(true);
        return;
      }
      try {
        const res = await fetch(basePath, { headers: { accept: "application/json" }, cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          setPageError(wordpressErrorText(m, "check", res.status, null));
          setPollStopped(true);
          return;
        }
        const parsed = res.ok ? SiteWordpressDtoSchema.safeParse(((await res.json()) as { data?: unknown })?.data) : null;
        if (cancelled) return;
        if (parsed?.success) {
          const next = parsed.data;
          if (next.runningOperation === null && inspectFromRef.current !== undefined) {
            if ((next.state?.checkedAt ?? null) === inspectFromRef.current) setNotice("checkFailed");
            inspectFromRef.current = undefined;
          }
          setData(next);
          if (next.runningOperation === null) return;
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
  }, [running, pollStopped, basePath, m]);

  const startRunning = (next: RunningOperation) => {
    setPollStopped(false);
    setNotice(null);
    setPageError(null);
    setData((prev) => ({ ...prev, runningOperation: next }));
  };

  const startCheck = useCallback(
    async (automatic: boolean) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setChecking(true);
      if (!automatic) setPageError(null);
      const from = data.state?.checkedAt ?? null;
      const r = await postJson(`${basePath}/refresh`, csrfToken, {}, keysRef.current);
      inFlightRef.current = false;
      setChecking(false);
      if (r.status >= 200 && r.status < 300) {
        inspectFromRef.current = from;
        startRunning({ id: operationId(r.body), kind: "site.wordpress.inspect", status: "queued", steps: [] });
      } else if (!automatic) {
        // An automatic check fails silently and is never retried.
        setPageError(wordpressErrorText(m, "check", r.status, r.body, { retryAfter: r.retryAfter }));
      }
    },
    [basePath, csrfToken, data.state, m],
  );

  useEffect(() => {
    if (autoRef.current) return;
    autoRef.current = true;
    if (wordpressNeedsCheck(initial, Date.now())) void startCheck(true);
  }, [initial, startCheck]);

  function openDialog(next: Dialog) {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    setDialog(next);
  }

  function closeDialog() {
    setDialog(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  async function confirmUpdate(target: WordpressUpdateTarget): Promise<string | null> {
    const r = await postJson(`${basePath}/updates`, csrfToken, target, keysRef.current);
    if (r.status >= 200 && r.status < 300) {
      startRunning({ id: operationId(r.body), kind: "site.wordpress.update", status: "queued", steps: [] });
      closeDialog();
      return null;
    }
    return wordpressErrorText(m, "update", r.status, r.body, { retryAfter: r.retryAfter });
  }

  async function confirmReset(id: number): Promise<WordpressResetResult> {
    const r = await postJson(`${basePath}/administrators/${encodeURIComponent(String(id))}/password-reset`, csrfToken, {});
    const pw = isRecord(r.body) && isRecord(r.body.data) ? r.body.data.temporaryPassword : undefined;
    if (r.status === 200 && typeof pw === "string" && pw.length > 0) return { ok: true, temporaryPassword: pw };
    // A success answer without a password: the password may have changed.
    if (r.status >= 200 && r.status < 300) return { ok: false, error: t.reset.failed.unknown };
    return { ok: false, error: wordpressErrorText(m, "reset", r.status, r.body) };
  }

  const state = data.state;
  const known = state !== null && state.problem === null && state.updatesKnown;
  const count = state ? pendingWordpressUpdates(state) : 0;
  const status = (text: string) => (
    <Alert role="status">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="font-medium">
          {state?.coreVersion ? format(t.header.version, { version: state.coreVersion }) : t.header.versionUnknown}
        </p>
        <p className="text-sm text-muted-foreground">
          {state ? format(t.header.checkedAt, { date: formatDate(state.checkedAt, m.common.dateLocale) }) : t.header.notChecked}
        </p>
        <Button type="button" variant="outline" className="ml-auto" disabled={locked} onClick={() => void startCheck(false)}>
          {checking || op?.kind === "site.wordpress.inspect" ? t.header.checking : t.header.checkNow}
        </Button>
      </div>

      {pageError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{pageError}</AlertDescription>
        </Alert>
      )}
      {notice && status(t.notices[notice])}
      {op?.kind === "site.wordpress.inspect" && status(t.notices.checking)}
      {op?.kind === "site.wordpress.update" && <WordpressProgress operation={op} />}
      {state === null && !running && status(t.notices.notCheckedYet)}
      {state?.problem && status(t.problem[wordpressStateProblemKey(state.problem)])}

      {state && state.problem === null && (
        <>
          {!state.updatesKnown ? status(t.notices.updatesUnknown) : count === 0 ? status(t.notices.upToDate) : null}
          {known && count > 0 && (
            <Button type="button" disabled={locked} onClick={() => openDialog({ kind: "update", target: { scope: "all" } })}>
              {format(t.tables.updateAll, { count })}
            </Button>
          )}

          <Table>
            <TableCaption className="sr-only">{t.tables.core}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t.tables.name}</TableHead>
                <TableHead>{t.tables.installed}</TableHead>
                <TableHead>{t.tables.available}</TableHead>
                <TableHead>{t.tables.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">{t.tables.core}</TableCell>
                <TableCell>{state.coreVersion ?? t.tables.unknown}</TableCell>
                <TableCell>{known ? (state.coreUpdate ?? t.tables.current) : t.tables.unknown}</TableCell>
                <TableCell>
                  {known && state.coreUpdate !== null && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={locked}
                      aria-label={format(t.tables.updateLabel, { name: t.tables.core, version: state.coreUpdate })}
                      onClick={() => openDialog({ kind: "update", target: { scope: "core" } })}
                    >
                      {t.tables.update}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>

          <h3 className="font-medium">{t.tables.plugins}</h3>
          <ItemTable
            caption={t.tables.plugins}
            empty={t.tables.emptyPlugins}
            items={state.plugins}
            known={known}
            locked={locked}
            onUpdate={(name) => openDialog({ kind: "update", target: { scope: "plugin", name } })}
          />
          <h3 className="font-medium">{t.tables.themes}</h3>
          <ItemTable
            caption={t.tables.themes}
            empty={t.tables.emptyThemes}
            items={state.themes}
            known={known}
            locked={locked}
            onUpdate={(name) => openDialog({ kind: "update", target: { scope: "theme", name } })}
          />

          <h3 className="font-medium">{t.admins.title}</h3>
          <Table>
            <TableCaption className="sr-only">{t.admins.title}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t.admins.login}</TableHead>
                <TableHead>{t.tables.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.administrators.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={2} className="text-muted-foreground">
                    {t.admins.empty}
                  </TableCell>
                </TableRow>
              ) : (
                state.administrators.map((admin) => (
                  <TableRow key={admin.id}>
                    <TableCell className="font-medium">{admin.login}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={locked}
                        aria-label={format(t.admins.resetLabel, { login: admin.login })}
                        onClick={() => openDialog({ kind: "reset", id: admin.id, login: admin.login })}
                      >
                        {t.admins.reset}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </>
      )}

      {data.lastUpdate && op?.kind !== "site.wordpress.update" && <WordpressLastUpdate last={data.lastUpdate} />}

      {dialog?.kind === "update" && state && (
        <WordpressUpdateDialog
          open
          onOpenChange={(open) => !open && closeDialog()}
          target={dialog.target}
          state={state}
          backupsConfigured={data.backupsConfigured}
          onConfirm={() => confirmUpdate(dialog.target)}
        />
      )}
      {dialog?.kind === "reset" && (
        <WordpressResetDialog
          open
          onOpenChange={(open) => !open && closeDialog()}
          login={dialog.login}
          onConfirm={() => confirmReset(dialog.id)}
        />
      )}
    </div>
  );
}
