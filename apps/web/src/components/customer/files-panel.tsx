"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  isTerminalOperationStatus,
  SITE_FILE_BATCH_MAX,
  type OperationDto,
  type SiteFileEntryDto,
  type SiteFileListDto,
} from "@hosting-panel/contracts";
import { FolderPlus, RefreshCw, Upload } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FileEditorDialog } from "@/components/customer/file-editor";
import {
  DeleteFilesDialog,
  MoveDialog,
  NameDialog,
  ReplaceFilesDialog,
} from "@/components/customer/file-dialogs";
import { FileBreadcrumb, FileTable } from "@/components/customer/file-list";
import { UploadList, useUploadQueue } from "@/components/customer/file-uploads";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import {
  describeFileOpOutcome,
  isEditable,
  isValidName,
  isValidRelativePath,
  isZip,
  joinPath,
  MAX_UPLOAD_BYTES,
  mutationErrorFromResponse,
  precheckDownload,
  sortEntries,
  triggerBrowserDownload,
} from "@/lib/file-browser";

export { precheckDownload };

interface PendingOp {
  opId: string;
  kind: "archive" | "extract";
  name: string;
}

interface PendingConflicts {
  dir: string;
  conflicts: File[];
  fresh: File[];
}

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT_MS = 10 * 60_000;

function readStorage(key: string): PendingOp | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingOp>;
    if (
      typeof parsed?.opId === "string" &&
      (parsed.kind === "archive" || parsed.kind === "extract") &&
      typeof parsed.name === "string"
    ) {
      return { opId: parsed.opId, kind: parsed.kind, name: parsed.name };
    }
  } catch {
    // Ignore restricted storage access.
  }
  return null;
}

function writeStorage(key: string, value: PendingOp | null) {
  try {
    if (value) {
      window.sessionStorage.setItem(key, JSON.stringify(value));
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore restricted storage access.
  }
}

export function FilesNotReady() {
  const m = useMessages();
  return (
    <Alert role="status">
      <AlertDescription>{m.site.files.notReady}</AlertDescription>
    </Alert>
  );
}

/** Returns true when listing the site root folder answers 404/NOT_FOUND before setup finishes. */
export function isRootNotReadyResponse(folder: string, status: number, errorCode?: string): boolean {
  return folder === "" && (status === 404 || errorCode === "NOT_FOUND");
}

/** Renders the folder body, keeping the table mounted during reloads of an already loaded folder. */
export function FilesListBody({
  loading,
  loadError,
  entries,
  entriesFolder,
  folder,
  truncated = false,
  selected,
  onToggle,
  onToggleAll,
  onOpen,
  onRetry,
  locale,
}: {
  loading: boolean;
  loadError: string | null;
  entries: readonly SiteFileEntryDto[];
  entriesFolder: string | null;
  folder: string;
  truncated?: boolean;
  selected: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (entry: SiteFileEntryDto) => void;
  onRetry: () => void;
  locale: string;
}) {
  const m = useMessages();
  const hasLoadedRows = entriesFolder === folder && entries.length > 0;

  if (loading && !hasLoadedRows) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground" role="status">
          {m.site.files.loading}
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {m.site.files.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground">
          {m.site.files.empty}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          {m.site.files.loading}
        </p>
      ) : null}
      {truncated ? (
        <Alert role="status">
          <AlertDescription>{m.site.files.truncated}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="p-0">
          <FileTable
            entries={entries}
            folderName={folder || m.site.files.rootLabel}
            selected={selected}
            onToggle={onToggle}
            onToggleAll={onToggleAll}
            onOpen={onOpen}
            locale={locale}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function FilesPanel({
  apiBase,
  orgId,
  siteId,
  csrfToken,
}: {
  apiBase: string;
  orgId: string;
  siteId?: string;
  csrfToken: string;
}) {
  const m = useMessages();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const messagesRef = useRef(m);
  messagesRef.current = m;

  const rawPathParam = searchParams.get("path") ?? "";
  const initialFolder = isValidRelativePath(rawPathParam, true) ? rawPathParam : "";

  const [folder, setFolder] = useState(initialFolder);
  const folderRef = useRef(folder);
  folderRef.current = folder;

  const [liveCsrf, setLiveCsrf] = useState(csrfToken);
  useEffect(() => {
    setLiveCsrf(csrfToken);
  }, [csrfToken]);

  const [entries, setEntries] = useState<SiteFileEntryDto[]>([]);
  const [entriesFolder, setEntriesFolder] = useState<string | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reloadTick, setReloadTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SiteFileEntryDto | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [extractTarget, setExtractTarget] = useState<SiteFileEntryDto | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<SiteFileEntryDto | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<PendingConflicts | null>(null);

  const storageKey = `hp_files_op:${siteId ?? apiBase}`;
  const [activeOp, setActiveOp] = useState<PendingOp | null>(null);

  const breadcrumbRef = useRef<HTMLHeadingElement | null>(null);
  const firstToolbarBtnRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextFocusRef = useRef(true);

  useEffect(() => {
    const raw = searchParams.get("path") ?? "";
    const next = isValidRelativePath(raw, true) ? raw : "";
    if (next !== folderRef.current) {
      skipNextFocusRef.current = true;
      setFolder(next);
      setSelected(new Set());
    }
  }, [searchParams]);

  useEffect(() => {
    const onPopState = () => {
      const raw = new URLSearchParams(window.location.search).get("path") ?? "";
      const next = isValidRelativePath(raw, true) ? raw : "";
      skipNextFocusRef.current = true;
      setFolder(next);
      setSelected(new Set());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refresh = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setLoadError(null);
    setNotReady(false);

    void (async () => {
      try {
        const res = await fetch(`${apiBase}/files?path=${encodeURIComponent(folder)}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        const json = (await res.json().catch(() => null)) as {
          data?: SiteFileListDto;
          error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
        } | null;

        if (ctrl.signal.aborted) return;

        if (!res.ok) {
          if (isRootNotReadyResponse(folder, res.status, json?.error?.code)) {
            setNotReady(true);
            setLoadError(null);
          } else {
            setLoadError(mutationErrorFromResponse(messagesRef.current, res.status, json, "files"));
          }
          setEntries([]);
          setEntriesFolder(null);
          setTruncated(false);
          setLoading(false);
          return;
        }

        const list = json?.data;
        const sorted = sortEntries(list?.entries ?? [], locale);
        setEntries(sorted);
        setEntriesFolder(folder);
        setTruncated(Boolean(list?.truncated));
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const names = new Set(sorted.map((e) => e.name));
          const kept = new Set<string>();
          for (const item of prev) {
            if (names.has(item)) kept.add(item);
          }
          return kept;
        });
        setLoading(false);
        if (!skipNextFocusRef.current) {
          requestAnimationFrame(() => breadcrumbRef.current?.focus());
        }
        skipNextFocusRef.current = true;
      } catch {
        if (!ctrl.signal.aborted) {
          setLoadError(errorMessage(messagesRef.current, "NETWORK_ERROR"));
          setEntries([]);
          setEntriesFolder(null);
          setTruncated(false);
          setLoading(false);
        }
      }
    })();

    return () => ctrl.abort();
  }, [apiBase, folder, locale, reloadTick]);

  useEffect(() => {
    const restored = readStorage(storageKey);
    if (restored) {
      setActiveOp(restored);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!activeOp) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    const startedAt = Date.now();

    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/bff/orgs/${orgId}/operations/${activeOp.opId}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) {
          if (res.status === 404 || res.status === 401 || res.status === 403) {
            writeStorage(storageKey, null);
            if (!cancelled) {
              setActiveOp(null);
              if (res.status === 401) {
                setActionError(messagesRef.current.site.files.errors.UNAUTHENTICATED);
              }
            }
            return;
          }
        } else {
          const json = (await res.json().catch(() => null)) as { data?: OperationDto } | null;
          const op = json?.data;
          if (op && isTerminalOperationStatus(op.status)) {
            writeStorage(storageKey, null);
            if (cancelled) return;
            setActiveOp(null);
            if (op.status === "succeeded") {
              const stepKey = activeOp.kind === "archive" ? "archive_files" : "extract_files";
              const step = op.steps.find((s) => s.key === stepKey);
              const match = step?.message?.match(/\d+/);
              const count = match ? match[0] : "0";
              setNotice(
                activeOp.kind === "archive"
                  ? format(messagesRef.current.site.files.compress.done, {
                      name: activeOp.name,
                      count,
                    })
                  : format(messagesRef.current.site.files.extract.done, { count }),
              );
              setActionError(null);
              setSelected(new Set());
              refresh();
            } else {
              setActionError(describeFileOpOutcome(messagesRef.current, op));
            }
            return;
          }
        }
      } catch {
        if (cancelled) return;
      }

      if (Date.now() - startedAt >= POLL_LIMIT_MS) {
        writeStorage(storageKey, null);
        if (!cancelled) {
          setActiveOp(null);
          setActionError(errorMessage(messagesRef.current, "OPERATION_AMBIGUOUS"));
        }
        return;
      }

      if (!cancelled) {
        timer = setTimeout(() => {
          void poll();
        }, POLL_INTERVAL_MS);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [activeOp, orgId, refresh, storageKey]);

  const navigateTo = useCallback((nextPath: string) => {
    if (!isValidRelativePath(nextPath, true)) return;
    skipNextFocusRef.current = false;
    setFolder(nextPath);
    setSelected(new Set());
    setActionError(null);
    const url = nextPath ? `?path=${encodeURIComponent(nextPath)}` : window.location.pathname;
    window.history.pushState(null, "", url);
  }, []);

  const uploadQueue = useUploadQueue({
    apiBase,
    csrfToken: liveCsrf,
    onCsrfToken: setLiveCsrf,
    onFileDone: (dir) => {
      if (dir === folderRef.current) {
        refresh();
      }
    },
  });

  const enqueueIncomingFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const valid: File[] = [];
      let rejectedInvalid = false;
      for (const f of incoming) {
        if (!isValidName(f.name) || f.name.startsWith(".htpanel-")) {
          rejectedInvalid = true;
        } else {
          valid.push(f);
        }
      }
      if (rejectedInvalid) {
        setActionError(m.site.files.errors.VALIDATION_ERROR);
      } else {
        setActionError(null);
      }
      if (valid.length === 0) return;

      const oversized = valid.filter((f) => f.size > MAX_UPLOAD_BYTES);
      const withinLimit = valid.filter((f) => f.size <= MAX_UPLOAD_BYTES);
      if (oversized.length > 0) {
        uploadQueue.enqueue(
          oversized.map((file) => ({ file, path: joinPath(folder, file.name), overwrite: false })),
        );
      }
      if (withinLimit.length === 0) return;

      const existing = new Set(entries.map((e) => e.name));
      const conflicts = withinLimit.filter((f) => existing.has(f.name));
      const fresh = withinLimit.filter((f) => !existing.has(f.name));

      if (conflicts.length > 0) {
        setPendingConflicts({ dir: folder, conflicts, fresh });
        return;
      }

      uploadQueue.enqueue(
        fresh.map((file) => ({ file, path: joinPath(folder, file.name), overwrite: false })),
      );
    },
    [entries, folder, m.site.files.errors.VALIDATION_ERROR, uploadQueue],
  );

  const triggerDownload = useCallback(
    async (itemPath: string): Promise<string | null> => {
      const err = await precheckDownload({
        apiBase,
        path: itemPath,
        messages: messagesRef.current,
        triggerLink: triggerBrowserDownload,
      });
      if (err) {
        setActionError(err);
      }
      return err;
    },
    [apiBase],
  );

  function handleOpenEntry(entry: SiteFileEntryDto) {
    const entryPath = joinPath(folder, entry.name);
    if (entry.kind === "dir") {
      navigateTo(entryPath);
      return;
    }
    if (entry.kind === "file") {
      if (entry.writable && isEditable(entry)) {
        setEditingEntry(entry);
        return;
      }
      void triggerDownload(entryPath);
    }
  }

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.name)),
    [entries, selected],
  );
  const hasProtectedSelected = selectedEntries.some((e) => !e.writable);
  const singleSelected = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const canDownload = Boolean(singleSelected && singleSelected.kind === "file");
  const canEdit = Boolean(singleSelected && singleSelected.writable && isEditable(singleSelected));
  const canRename = Boolean(singleSelected && singleSelected.writable);
  const canMove = selectedEntries.length >= 1 && !hasProtectedSelected;
  const canCompress =
    selectedEntries.length >= 1 && selectedEntries.length <= SITE_FILE_BATCH_MAX && !activeOp;
  const canExtract = Boolean(
    singleSelected && singleSelected.kind === "file" && isZip(singleSelected.name) && !activeOp,
  );
  const canDelete =
    selectedEntries.length >= 1 &&
    selectedEntries.length <= SITE_FILE_BATCH_MAX &&
    !hasProtectedSelected;

  async function postJson<T = unknown>(
    subpath: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ ok: true; data: T | undefined } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${apiBase}/${subpath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": liveCsrf,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: T;
        error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
      } | null;
      if (!res.ok) {
        const scope = subpath === "files/archive" || subpath === "files/extract" ? "zip" : "files";
        return { ok: false, error: mutationErrorFromResponse(m, res.status, json, scope) };
      }
      return { ok: true, data: json?.data };
    } catch {
      return { ok: false, error: errorMessage(m, "NETWORK_ERROR") };
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);

    const droppedItems = Array.from(e.dataTransfer.items ?? []);
    const acceptedFiles: File[] = [];
    let sawFolder = false;

    if (droppedItems.length > 0 && typeof droppedItems[0]?.webkitGetAsEntry === "function") {
      for (const item of droppedItems) {
        if (item.kind !== "file") continue;
        const fsEntry = item.webkitGetAsEntry();
        if (fsEntry?.isDirectory) {
          sawFolder = true;
          continue;
        }
        const f = item.getAsFile();
        if (f) acceptedFiles.push(f);
      }
    } else {
      acceptedFiles.push(...Array.from(e.dataTransfer.files ?? []));
    }

    if (sawFolder) {
      setNotice(m.site.files.folderUploadHint);
    }
    enqueueIncomingFiles(acceptedFiles);
  }

  if (notReady) {
    return <FilesNotReady />;
  }

  return (
    <div
      className="space-y-4"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepthRef.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label={m.site.files.actions.upload}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          enqueueIncomingFiles(picked);
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <FileBreadcrumb path={folder} onOpen={navigateTo} headingRef={breadcrumbRef} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          aria-label={m.site.logs.refresh}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div
        role="toolbar"
        aria-label={m.site.files.actions.toolbar}
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          ref={firstToolbarBtnRef}
          type="button"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-1.5 size-4" aria-hidden="true" />
          {m.site.files.actions.upload}
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setNewFolderOpen(true)}
        >
          <FolderPlus className="mr-1.5 size-4" aria-hidden="true" />
          {m.site.files.actions.newFolder}
        </Button>

        {canDownload ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => singleSelected && void triggerDownload(joinPath(folder, singleSelected.name))}
          >
            {m.site.files.actions.download}
          </Button>
        ) : null}

        {canEdit ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => singleSelected && setEditingEntry(singleSelected)}
          >
            {m.site.files.actions.edit}
          </Button>
        ) : null}

        {canRename ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => singleSelected && setRenameTarget(singleSelected)}
          >
            {m.site.files.actions.rename}
          </Button>
        ) : null}

        {canMove ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMoveOpen(true)}
          >
            {m.site.files.actions.move}
          </Button>
        ) : null}

        {canCompress ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCompressOpen(true)}
          >
            {m.site.files.actions.compress}
          </Button>
        ) : null}

        {canExtract ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => singleSelected && setExtractTarget(singleSelected)}
          >
            {m.site.files.actions.extract}
          </Button>
        ) : null}

        {canDelete ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            {m.site.files.actions.delete}
          </Button>
        ) : null}

        {selected.size > 0 ? (
          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <span>{format(m.site.files.selected, { count: String(selected.size) })}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              {m.site.files.actions.clear}
            </Button>
          </div>
        ) : null}
      </div>

      {hasProtectedSelected ? (
        <p className="text-sm text-muted-foreground">{m.site.files.actions.protectedHint}</p>
      ) : null}

      {dragging ? (
        <Alert role="status">
          <AlertDescription>{m.site.files.dropHint}</AlertDescription>
        </Alert>
      ) : null}

      {activeOp ? (
        <Alert role="status">
          <AlertDescription>
            {activeOp.kind === "archive"
              ? m.site.files.compress.working
              : m.site.files.extract.working}
          </AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert role="status">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{notice}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setNotice(null)}>
              {m.site.files.upload.dismiss}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>{actionError}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setActionError(null)}>
              {m.site.files.upload.dismiss}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <UploadList
        items={uploadQueue.items}
        onCancel={uploadQueue.cancel}
        onRetry={(id) => void uploadQueue.retry(id)}
        onCancelAll={uploadQueue.cancelAll}
        onDismiss={uploadQueue.dismissDone}
      />

      <FilesListBody
        loading={loading}
        loadError={loadError}
        entries={entries}
        entriesFolder={entriesFolder}
        folder={folder}
        truncated={truncated}
        selected={selected}
        onToggle={(name) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
          })
        }
        onToggleAll={(checked) => {
          setSelected(checked ? new Set(entries.map((e) => e.name)) : new Set());
        }}
        onOpen={handleOpenEntry}
        onRetry={refresh}
        locale={locale}
      />

      <NameDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        title={m.site.files.newFolder.title}
        label={m.site.files.newFolder.label}
        hint={m.site.files.nameRule}
        initial=""
        submitLabel={m.site.files.newFolder.submit}
        workingLabel={m.site.files.newFolder.working}
        onSubmit={async (name) => {
          const result = await postJson("files/folders", { path: joinPath(folder, name) });
          if (!result.ok) return result.error;
          refresh();
          return null;
        }}
      />

      <NameDialog
        open={renameTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
        title={format(m.site.files.rename.title, { name: renameTarget?.name ?? "" })}
        label={m.site.files.rename.label}
        hint={m.site.files.nameRule}
        warning={m.site.files.rename.warning}
        initial={renameTarget?.name ?? ""}
        submitLabel={m.site.files.rename.submit}
        workingLabel={m.site.files.rename.working}
        onSubmit={async (nextName) => {
          if (!renameTarget) return null;
          if (nextName === renameTarget.name) return null;
          const result = await postJson("files/move", {
            from: joinPath(folder, renameTarget.name),
            to: joinPath(folder, nextName),
          });
          if (!result.ok) return result.error;
          setSelected(new Set());
          refresh();
          return null;
        }}
      />

      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        apiBase={apiBase}
        items={selectedEntries}
        from={folder}
        onMove={async (destDir) => {
          let movedAny = false;
          for (const item of selectedEntries) {
            const result = await postJson("files/move", {
              from: joinPath(folder, item.name),
              to: joinPath(destDir, item.name),
            });
            if (!result.ok) {
              if (movedAny) {
                setSelected(new Set());
                refresh();
              }
              return result.error;
            }
            movedAny = true;
          }
          setSelected(new Set());
          refresh();
          return null;
        }}
      />

      <NameDialog
        open={compressOpen}
        onOpenChange={setCompressOpen}
        title={m.site.files.compress.title}
        label={m.site.files.compress.label}
        hint={m.site.files.compress.hint}
        initial={m.site.files.compress.defaultName}
        submitLabel={m.site.files.compress.submit}
        workingLabel={m.site.files.compress.working}
        onSubmit={async (rawName) => {
          const archiveName = rawName.toLowerCase().endsWith(".zip") ? rawName : `${rawName}.zip`;
          const result = await postJson<{ operationId?: string }>(
            "files/archive",
            {
              paths: selectedEntries.map((e) => joinPath(folder, e.name)),
              to: joinPath(folder, archiveName),
            },
            { "Idempotency-Key": crypto.randomUUID() },
          );
          if (!result.ok) return result.error;
          const opId = result.data?.operationId;
          if (opId) {
            const nextOp: PendingOp = { opId, kind: "archive", name: archiveName };
            writeStorage(storageKey, nextOp);
            setActiveOp(nextOp);
          }
          return null;
        }}
      />

      <NameDialog
        open={extractTarget !== null}
        onOpenChange={(o) => {
          if (!o) setExtractTarget(null);
        }}
        title={format(m.site.files.extract.title, { name: extractTarget?.name ?? "" })}
        label={m.site.files.extract.label}
        hint={m.site.files.extract.hint}
        initial={extractTarget?.name.replace(/\.zip$/i, "") ?? ""}
        submitLabel={m.site.files.extract.submit}
        workingLabel={m.site.files.extract.working}
        allowEmpty
        allowNested
        onSubmit={async (rawDest) => {
          if (!extractTarget) return null;
          const targetDir = rawDest === "" ? folder : joinPath(folder, rawDest);
          const result = await postJson<{ operationId?: string }>(
            "files/extract",
            {
              path: joinPath(folder, extractTarget.name),
              to: targetDir,
            },
            { "Idempotency-Key": crypto.randomUUID() },
          );
          if (!result.ok) return result.error;
          const opId = result.data?.operationId;
          if (opId) {
            const nextOp: PendingOp = { opId, kind: "extract", name: extractTarget.name };
            writeStorage(storageKey, nextOp);
            setActiveOp(nextOp);
          }
          return null;
        }}
      />

      <DeleteFilesDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        items={selectedEntries}
        onAfterDelete={() => requestAnimationFrame(() => firstToolbarBtnRef.current?.focus())}
        onConfirm={async () => {
          const result = await postJson("files/delete", {
            paths: selectedEntries.map((e) => joinPath(folder, e.name)),
          });
          if (!result.ok) return result.error;
          setSelected(new Set());
          refresh();
          return null;
        }}
      />

      <ReplaceFilesDialog
        open={pendingConflicts !== null}
        names={pendingConflicts?.conflicts.map((f) => f.name) ?? []}
        onReplace={() => {
          if (!pendingConflicts) return;
          const { dir, conflicts, fresh } = pendingConflicts;
          setPendingConflicts(null);
          uploadQueue.enqueue([
            ...fresh.map((file) => ({ file, path: joinPath(dir, file.name), overwrite: false })),
            ...conflicts.map((file) => ({ file, path: joinPath(dir, file.name), overwrite: true })),
          ]);
        }}
        onSkip={() => {
          if (!pendingConflicts) return;
          const { dir, fresh } = pendingConflicts;
          setPendingConflicts(null);
          uploadQueue.enqueue(
            fresh.map((file) => ({ file, path: joinPath(dir, file.name), overwrite: false })),
          );
        }}
        onCancel={() => setPendingConflicts(null)}
      />

      <FileEditorDialog
        apiBase={apiBase}
        csrfToken={liveCsrf}
        entry={editingEntry}
        path={editingEntry ? joinPath(folder, editingEntry.name) : ""}
        open={editingEntry !== null}
        onOpenChange={(o) => {
          if (!o) setEditingEntry(null);
        }}
        onSaved={refresh}
        onDownload={triggerDownload}
      />
    </div>
  );
}
