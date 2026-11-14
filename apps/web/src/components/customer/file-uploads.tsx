"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import {
  type ChunkSender,
  type UploadOutcome,
  fileErrorText,
  formatSize,
  LARGE_UPLOAD_HINT_BYTES,
  MAX_UPLOAD_BYTES,
  parentPath,
  uploadFile,
} from "@/lib/file-browser";

export type UploadStatus = "waiting" | "uploading" | "done" | "failed" | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  path: string;
  overwrite: boolean;
  sent: number;
  status: UploadStatus;
  error: string | null;
  resume?: { uploadId: string; offset: number };
  needsSessionRefresh?: boolean;
  lastFailedStatus?: number;
}

export interface QueuedUploadInput {
  file: File;
  path: string;
  overwrite: boolean;
}

/** Converts incoming files to upload items, failing >2 GiB files immediately without sending. */
export function prepareQueuedUploads(
  incoming: ReadonlyArray<QueuedUploadInput>,
  m: Messages,
): { items: UploadItem[]; startPump: boolean } {
  let startPump = false;
  const tooLargeMsg = fileErrorText(m, "QUOTA_EXCEEDED", "upload", [{ reason: "too_large" }]);
  const items: UploadItem[] = incoming.map((q) => {
    if (q.file.size > MAX_UPLOAD_BYTES) {
      return {
        id: crypto.randomUUID(),
        file: q.file,
        path: q.path,
        overwrite: q.overwrite,
        sent: 0,
        status: "failed",
        error: tooLargeMsg,
      };
    }
    startPump = true;
    return {
      id: crypto.randomUUID(),
      file: q.file,
      path: q.path,
      overwrite: q.overwrite,
      sent: 0,
      status: "waiting",
      error: null,
    };
  });
  return { items, startPump };
}

/** Intercepts same-origin link clicks while uploads run and cancels navigation if declined. */
export function createInAppNavigationHandler(opts: {
  hasActive: () => boolean;
  getWarning: () => string;
  confirm: (message: string) => boolean;
  currentOrigin: string;
  currentHref: string;
}): (e: MouseEvent) => void {
  return (e) => {
    if (!opts.hasActive()) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    const target = e.target as { closest?: (sel: string) => Element | null } | null;
    const link = target?.closest?.("a[href]");
    if (!link || link.hasAttribute("download")) return;
    const linkTarget = link.getAttribute("target");
    if (linkTarget && linkTarget !== "_self") return;

    const href = link.getAttribute("href");
    if (!href) return;
    let url: URL;
    let cur: URL;
    try {
      url = new URL(href, opts.currentHref);
      cur = new URL(opts.currentHref);
    } catch {
      return;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== opts.currentOrigin) {
      return;
    }
    if (url.pathname === cur.pathname && url.search === cur.search && url.hash !== "") {
      return;
    }
    if (!opts.confirm(opts.getWarning())) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
}

/** Sequentially drains waiting uploads, catching any per-item failure so the next item still runs. */
export async function drainUploadQueue(opts: {
  getNextWaiting: () => UploadItem | undefined;
  shouldStop: () => boolean;
  onStart: (id: string) => void;
  sendItem: (item: UploadItem, signal: AbortSignal) => Promise<UploadOutcome>;
  setAbortController: (ctrl: AbortController | null) => void;
  onOutcome: (item: UploadItem, outcome: UploadOutcome, aborted: boolean) => void;
  onUnexpectedError: (item: UploadItem) => void;
}): Promise<void> {
  while (!opts.shouldStop()) {
    const nextItem = opts.getNextWaiting();
    if (!nextItem) break;

    opts.onStart(nextItem.id);
    const ctrl = new AbortController();
    opts.setAbortController(ctrl);

    try {
      const outcome = await opts.sendItem(nextItem, ctrl.signal);
      opts.setAbortController(null);
      if (opts.shouldStop()) break;
      opts.onOutcome(nextItem, outcome, ctrl.signal.aborted);
    } catch {
      opts.setAbortController(null);
      if (opts.shouldStop()) break;
      opts.onUnexpectedError(nextItem);
    }
  }
}

interface UseUploadQueueOptions {
  apiBase: string;
  csrfToken: string;
  onCsrfToken: (token: string) => void;
  onFileDone: (dir: string) => void;
}

export function useUploadQueue({ apiBase, csrfToken, onCsrfToken, onFileDone }: UseUploadQueueOptions) {
  const m = useMessages();
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const runningRef = useRef(false);
  const pausedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const csrfRef = useRef(csrfToken);
  const unmountedRef = useRef(false);
  const messagesRef = useRef(m);
  messagesRef.current = m;
  csrfRef.current = csrfToken;

  const commit = useCallback((updater: (prev: UploadItem[]) => UploadItem[]) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    if (!unmountedRef.current) {
      setItems(next);
    }
  }, []);

  const updateOne = useCallback(
    (id: string, fn: (item: UploadItem) => UploadItem) => {
      commit((prev) => prev.map((it) => (it.id === id ? fn(it) : it)));
    },
    [commit],
  );

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  const hasActive = items.some((it) => it.status === "waiting" || it.status === "uploading");

  useEffect(() => {
    if (!hasActive) return;
    const getWarning = () => messagesRef.current.site.files.upload.leaveWarning;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = getWarning();
    };
    const onDocClick = createInAppNavigationHandler({
      hasActive: () => hasActive,
      getWarning,
      confirm: (msg) => window.confirm(msg),
      currentOrigin: window.location.origin,
      currentHref: window.location.href,
    });
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocClick, true);
    };
  }, [hasActive]);

  const pump = useCallback(async () => {
    if (runningRef.current || pausedRef.current || unmountedRef.current) return;
    runningRef.current = true;
    try {
      await drainUploadQueue({
        getNextWaiting: () => itemsRef.current.find((it) => it.status === "waiting"),
        shouldStop: () => pausedRef.current || unmountedRef.current,
        onStart: (id) => updateOne(id, (cur) => ({ ...cur, status: "uploading", error: null })),
        setAbortController: (ctrl) => {
          abortRef.current = ctrl;
        },
        sendItem: (nextItem, signal) => {
          const send: ChunkSender = async (chunk, s) => {
            const res = await fetch(`${apiBase}/files/content`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                "x-csrf-token": csrfRef.current,
              },
              body: JSON.stringify(chunk),
              signal: s,
            });
            const json = (await res.json().catch(() => null)) as {
              data?: { received?: number };
              error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
            } | null;
            return {
              status: res.status,
              received: json?.data?.received,
              code: json?.error?.code,
              reason: json?.error?.details?.[0]?.reason,
            };
          };
          return uploadFile(
            nextItem.file,
            nextItem.path,
            nextItem.overwrite,
            send,
            (sent) => updateOne(nextItem.id, (cur) => (cur.status === "uploading" ? { ...cur, sent } : cur)),
            signal,
            nextItem.resume,
          );
        },
        onOutcome: (nextItem, outcome, aborted) => {
          if (outcome.ok) {
            updateOne(nextItem.id, (cur) => ({
              ...cur,
              status: "done",
              sent: cur.file.size,
              error: null,
              resume: undefined,
              needsSessionRefresh: false,
              lastFailedStatus: undefined,
            }));
            onFileDone(parentPath(nextItem.path));
            return;
          }

          if (outcome.code === "cancelled" || aborted) {
            updateOne(nextItem.id, (cur) => ({
              ...cur,
              status: "cancelled",
              error: null,
            }));
            return;
          }

          const isSessionProblem =
            outcome.status === 401 ||
            outcome.code === "UNAUTHENTICATED" ||
            (outcome.status === 403 && outcome.code === "PERMISSION_DENIED" && outcome.reason !== "protected");

          if (isSessionProblem) {
            pausedRef.current = true;
            updateOne(nextItem.id, (cur) => ({
              ...cur,
              status: "failed",
              sent: outcome.resume.offset,
              resume: outcome.resume,
              needsSessionRefresh: true,
              lastFailedStatus: outcome.status,
              error: messagesRef.current.site.files.upload.sessionEnded,
            }));
            return;
          }

          const details = outcome.reason ? [{ reason: outcome.reason }] : undefined;
          updateOne(nextItem.id, (cur) => ({
            ...cur,
            status: "failed",
            sent: outcome.resume.offset,
            resume: outcome.resume,
            needsSessionRefresh: false,
            lastFailedStatus: outcome.status,
            error: fileErrorText(messagesRef.current, outcome.code, "upload", details),
          }));
        },
        onUnexpectedError: (nextItem) => {
          updateOne(nextItem.id, (cur) => ({
            ...cur,
            status: "failed",
            needsSessionRefresh: false,
            error: errorMessage(messagesRef.current, "INTERNAL_ERROR"),
          }));
        },
      });
    } finally {
      abortRef.current = null;
      runningRef.current = false;
    }
  }, [apiBase, onFileDone, updateOne]);

  const enqueue = useCallback(
    (incoming: QueuedUploadInput[]) => {
      if (incoming.length === 0) return;
      const { items: added, startPump } = prepareQueuedUploads(incoming, messagesRef.current);
      commit((prev) => [...prev, ...added]);
      if (startPump && !pausedRef.current) {
        void pump();
      }
    },
    [commit, pump],
  );

  const cancel = useCallback(
    (id: string) => {
      const target = itemsRef.current.find((it) => it.id === id);
      if (!target) return;
      if (target.status === "waiting") {
        updateOne(id, (cur) => ({ ...cur, status: "cancelled", error: null }));
        return;
      }
      if (target.status === "uploading") {
        updateOne(id, (cur) => ({ ...cur, status: "cancelled", error: null }));
        abortRef.current?.abort();
      }
    },
    [updateOne],
  );

  const cancelAll = useCallback(() => {
    pausedRef.current = false;
    commit((prev) =>
      prev.map((it) =>
        it.status === "waiting" || it.status === "uploading"
          ? { ...it, status: "cancelled", error: null }
          : it,
      ),
    );
    abortRef.current?.abort();
  }, [commit]);

  const retry = useCallback(
    async (id: string) => {
      const target = itemsRef.current.find((it) => it.id === id);
      if (!target || target.status !== "failed" || target.file.size > MAX_UPLOAD_BYTES) return;

      if (target.needsSessionRefresh) {
        try {
          const res = await fetch("/api/session", { cache: "no-store" });
          if (!res.ok) {
            pausedRef.current = true;
            return;
          }
          const json = (await res.json().catch(() => null)) as {
            authenticated?: boolean;
            csrfToken?: string;
          } | null;
          if (!json?.authenticated || !json.csrfToken) {
            pausedRef.current = true;
            updateOne(id, (cur) => ({
              ...cur,
              error: messagesRef.current.site.files.upload.sessionEnded,
            }));
            return;
          }
          if (target.lastFailedStatus === 403 && json.csrfToken === csrfRef.current) {
            pausedRef.current = false;
            updateOne(id, (cur) => ({
              ...cur,
              needsSessionRefresh: false,
              error: errorMessage(messagesRef.current, "PERMISSION_DENIED"),
            }));
            void pump();
            return;
          }
          csrfRef.current = json.csrfToken;
          onCsrfToken(json.csrfToken);
        } catch {
          pausedRef.current = true;
          return;
        }
      }

      pausedRef.current = false;
      updateOne(id, (cur) => ({
        ...cur,
        status: "waiting",
        error: null,
        needsSessionRefresh: false,
        lastFailedStatus: undefined,
        sent: cur.resume?.offset ?? 0,
      }));
      void pump();
    },
    [onCsrfToken, pump, updateOne],
  );

  const dismissDone = useCallback(() => {
    pausedRef.current = false;
    commit((prev) => prev.filter((it) => it.status === "waiting" || it.status === "uploading"));
  }, [commit]);

  return { items, hasActive, enqueue, cancel, cancelAll, retry, dismissDone };
}

interface UploadListProps {
  items: readonly UploadItem[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onCancelAll: () => void;
  onDismiss: () => void;
}

export function UploadList({ items, onCancel, onRetry, onCancelAll, onDismiss }: UploadListProps) {
  const m = useMessages();
  const locale = useLocale();
  if (items.length === 0) return null;

  const doneCount = items.filter((it) => it.status === "done").length;
  const hasActive = items.some((it) => it.status === "waiting" || it.status === "uploading");
  const hasLargeActive = items.some(
    (it) => (it.status === "waiting" || it.status === "uploading") && it.file.size > LARGE_UPLOAD_HINT_BYTES,
  );

  const statusText = (status: UploadStatus) => m.site.files.upload[status];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <div>
          <CardTitle className="text-base">{m.site.files.upload.title}</CardTitle>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {format(m.site.files.upload.summary, {
              done: String(doneCount),
              total: String(items.length),
            })}
          </p>
        </div>
        {hasActive ? (
          <Button type="button" variant="outline" size="sm" onClick={onCancelAll}>
            {m.site.files.upload.cancelAll}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            <X className="mr-1 size-4" aria-hidden="true" />
            {m.site.files.upload.dismiss}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {hasLargeActive ? (
          <p className="text-sm text-muted-foreground">{m.site.files.upload.largeHint}</p>
        ) : null}
        <ul className="space-y-3">
          {items.map((item) => {
            const total = item.file.size;
            const pct =
              total === 0
                ? item.status === "done"
                  ? 100
                  : 0
                : Math.min(100, Math.round((item.sent / total) * 100));
            return (
              <li key={item.id} className="space-y-1.5 rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{item.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {statusText(item.status)} ·{" "}
                      {format(m.site.files.upload.bytes, {
                        sent: formatSize(item.sent, locale),
                        total: formatSize(total, locale),
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.status === "waiting" || item.status === "uploading" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={format(m.site.files.upload.cancelOne, { name: item.file.name })}
                        onClick={() => onCancel(item.id)}
                      >
                        {m.site.files.cancel}
                      </Button>
                    ) : null}
                    {item.status === "failed" && item.file.size <= MAX_UPLOAD_BYTES ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={format(m.site.files.upload.retryOne, { name: item.file.name })}
                        onClick={() => onRetry(item.id)}
                      >
                        {m.site.files.retry}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {item.status !== "cancelled" && item.status !== "failed" ? (
                  <Progress value={pct} aria-label={item.file.name} />
                ) : null}
                {item.error ? (
                  <p role="alert" className="text-xs text-destructive">
                    {item.error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
