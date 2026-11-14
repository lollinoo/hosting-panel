"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SiteFileChunkDto, SiteFileEntryDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import {
  baseName,
  bytesToBase64,
  EDITOR_MAX_BYTES,
  fromBase64,
  mutationErrorFromResponse,
  parentPath,
  precheckDownload,
} from "@/lib/file-browser";

export type OpenedFileMeta = {
  size: number;
  modifiedAt: string;
};

/** Normalizes line endings to LF for editing while remembering whether the file used CRLF. */
export function decodeEditorContent(rawText: string): { text: string; crlf: boolean } {
  return {
    crlf: rawText.includes("\r\n"),
    text: rawText.replace(/\r\n/g, "\n"),
  };
}

/** Restores CRLF line endings when saving a file that originally used CRLF. */
export function encodeEditorContent(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, "\r\n") : text;
}

async function fetchParentEntry(
  apiBase: string,
  path: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ entry: SiteFileEntryDto | null; truncated: boolean } | null> {
  try {
    const res = await fetchImpl(`${apiBase}/files?path=${encodeURIComponent(parentPath(path))}`, {
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      data?: { entries?: SiteFileEntryDto[]; truncated?: boolean };
    } | null;
    if (!json?.data || !Array.isArray(json.data.entries)) return null;
    const name = baseName(path);
    return {
      entry: json.data.entries.find((e) => e.name === name) ?? null,
      truncated: Boolean(json.data.truncated),
    };
  } catch {
    return null;
  }
}

/** Saves editor content after checking the parent listing for external changes unless forced. */
export async function saveEditorFile(opts: {
  apiBase: string;
  csrfToken: string;
  path: string;
  text: string;
  crlf: boolean;
  openedMeta: OpenedFileMeta | null;
  force?: boolean;
  messages: Messages;
  fetchFn?: typeof fetch;
}): Promise<
  | { status: "conflict" }
  | { status: "error"; message: string }
  | { status: "saved"; savedText: string; crlf: boolean; latestMeta: OpenedFileMeta | null }
> {
  const fetchImpl = opts.fetchFn ?? fetch;

  if (!opts.force && opts.openedMeta) {
    const listing = await fetchParentEntry(opts.apiBase, opts.path, fetchImpl);
    if (listing) {
      const current = listing.entry;
      const deleted = !current && !listing.truncated;
      const changed =
        current !== null &&
        (current.size !== opts.openedMeta.size || current.modifiedAt !== opts.openedMeta.modifiedAt);
      if (deleted || changed) {
        return { status: "conflict" };
      }
    }
  }

  const wireBytes = new TextEncoder().encode(encodeEditorContent(opts.text, opts.crlf));
  try {
    const res = await fetchImpl(`${opts.apiBase}/files/content`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": opts.csrfToken,
      },
      body: JSON.stringify({
        path: opts.path,
        uploadId: crypto.randomUUID(),
        offset: 0,
        dataBase64: bytesToBase64(wireBytes),
        final: true,
        overwrite: true,
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
    } | null;

    if (!res.ok) {
      return {
        status: "error",
        message: mutationErrorFromResponse(opts.messages, res.status, json, "files"),
      };
    }

    const refreshed = await fetchParentEntry(opts.apiBase, opts.path, fetchImpl);
    const latestMeta = refreshed?.entry
      ? { size: refreshed.entry.size, modifiedAt: refreshed.entry.modifiedAt }
      : opts.openedMeta;

    return {
      status: "saved",
      savedText: opts.text,
      crlf: opts.crlf,
      latestMeta,
    };
  } catch {
    return { status: "error", message: errorMessage(opts.messages, "NETWORK_ERROR") };
  }
}

interface FileEditorDialogProps {
  apiBase: string;
  csrfToken: string;
  entry: SiteFileEntryDto | null;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onDownload?: (path: string) => Promise<string | null>;
}

export function FileEditorDialog({
  apiBase,
  csrfToken,
  entry,
  path,
  open,
  onOpenChange,
  onSaved,
  onDownload,
}: FileEditorDialogProps) {
  const m = useMessages();
  const textareaId = useId();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [crlf, setCrlf] = useState(false);
  const [openedMeta, setOpenedMeta] = useState<OpenedFileMeta | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmChanged, setConfirmChanged] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const messagesRef = useRef(m);
  messagesRef.current = m;
  const prevReloadTickRef = useRef(0);

  const dirty = !loading && !loadError && text !== savedText;

  const encodedBytes = useMemo(
    () => new TextEncoder().encode(encodeEditorContent(text, crlf)),
    [crlf, text],
  );
  const tooBigNow = encodedBytes.byteLength > EDITOR_MAX_BYTES;

  useEffect(() => {
    const isReload = reloadTick > prevReloadTickRef.current;
    prevReloadTickRef.current = reloadTick;
    if (!open || !entry) return;

    setLoadError(null);
    setText("");
    setSavedText("");
    setCrlf(false);
    setOpenedMeta({ size: entry.size, modifiedAt: entry.modifiedAt });
    setSaveError(null);
    setSavedNotice(false);
    setConfirmDiscard(false);
    setConfirmChanged(false);

    if (entry.size > EDITOR_MAX_BYTES && !isReload) {
      setLoading(false);
      setLoadError(messagesRef.current.site.files.editor.tooBig);
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);

    void (async () => {
      try {
        const metaPromise = isReload
          ? fetchParentEntry(apiBase, path, fetch, ctrl.signal)
          : Promise.resolve(null);
        const res = await fetch(
          `${apiBase}/files/content?path=${encodeURIComponent(path)}&offset=0&length=${EDITOR_MAX_BYTES}`,
          { signal: ctrl.signal, cache: "no-store" },
        );
        const json = (await res.json().catch(() => null)) as {
          data?: SiteFileChunkDto;
          error?: { code?: string; details?: Array<{ field?: string; reason?: string }> };
        } | null;

        if (ctrl.signal.aborted) return;

        if (!res.ok) {
          setLoadError(mutationErrorFromResponse(messagesRef.current, res.status, json, "files"));
          setLoading(false);
          return;
        }

        const chunk = json?.data;
        if (!chunk || !chunk.eof || chunk.size > EDITOR_MAX_BYTES) {
          setLoadError(messagesRef.current.site.files.editor.tooBig);
          setLoading(false);
          return;
        }

        const bytes = fromBase64(chunk.dataBase64);
        if (bytes.includes(0)) {
          setLoadError(messagesRef.current.site.files.editor.notText);
          setLoading(false);
          return;
        }

        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          setLoadError(messagesRef.current.site.files.editor.notText);
          setLoading(false);
          return;
        }

        const latestListing = await metaPromise;
        if (ctrl.signal.aborted) return;
        if (latestListing?.entry) {
          setOpenedMeta({
            size: latestListing.entry.size,
            modifiedAt: latestListing.entry.modifiedAt,
          });
        }

        const normalized = decodeEditorContent(decoded);
        setCrlf(normalized.crlf);
        setText(normalized.text);
        setSavedText(normalized.text);
        setLoading(false);
      } catch {
        if (!ctrl.signal.aborted) {
          setLoadError(errorMessage(messagesRef.current, "NETWORK_ERROR"));
          setLoading(false);
        }
      }
    })();

    return () => ctrl.abort();
  }, [apiBase, entry, open, path, reloadTick]);

  const fileName = entry?.name ?? "";

  function requestClose() {
    if (saving) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    onOpenChange(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    requestClose();
  }

  async function handleSave(force = false) {
    if (saving || loading || loadError || tooBigNow) return;
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    try {
      const outcome = await saveEditorFile({
        apiBase,
        csrfToken,
        path,
        text,
        crlf,
        openedMeta,
        force,
        messages: m,
      });
      if (outcome.status === "conflict") {
        setConfirmChanged(true);
        return;
      }
      if (outcome.status === "error") {
        setSaveError(outcome.message);
        return;
      }
      setSavedText(outcome.savedText);
      setOpenedMeta(outcome.latestMeta);
      setSavedNotice(true);
      setConfirmDiscard(false);
      setConfirmChanged(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload() {
    const err = onDownload
      ? await onDownload(path)
      : await precheckDownload({ apiBase, path, messages: m });
    if (err) {
      setLoadError(err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{format(m.site.files.editor.title, { name: fileName })}</DialogTitle>
          <DialogDescription>{m.site.files.editor.warning}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-sm text-muted-foreground" role="status">
            {m.site.files.editor.loading}
          </p>
        ) : loadError ? (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
            <div className="flex flex-wrap justify-end gap-2">
              {entry ? (
                <Button type="button" variant="outline" onClick={() => void handleDownload()}>
                  {m.site.files.actions.download}
                </Button>
              ) : null}
              <Button type="button" onClick={() => onOpenChange(false)}>
                {m.site.files.editor.close}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <Label htmlFor={textareaId} className="sr-only">
                {format(m.site.files.editor.label, { name: fileName })}
              </Label>
              <Textarea
                id={textareaId}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setSavedNotice(false);
                  setSaveError(null);
                  setConfirmDiscard(false);
                  setConfirmChanged(false);
                }}
                className="min-h-[24rem] font-mono text-sm"
                spellCheck={false}
              />
            </div>

            {tooBigNow ? (
              <p role="alert" className="text-sm text-destructive">
                {m.site.files.editor.tooBigNow}
              </p>
            ) : null}

            {saveError ? (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            ) : null}

            {savedNotice ? (
              <p role="status" className="text-sm text-muted-foreground">
                {m.site.files.editor.saved}
              </p>
            ) : null}

            {confirmChanged ? (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{m.site.files.editor.changed}</span>
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => setReloadTick((n) => n + 1)}
                    >
                      {m.site.files.editor.reload}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={saving}
                      onClick={() => void handleSave(true)}
                    >
                      {m.site.files.editor.saveAnyway}
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            {confirmDiscard ? (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{m.site.files.editor.unsaved}</span>
                  <span className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDiscard(false)}>
                      {m.site.files.editor.keep}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        setConfirmDiscard(false);
                        onOpenChange(false);
                      }}
                    >
                      {m.site.files.editor.discard}
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" disabled={saving} onClick={requestClose}>
                {m.site.files.editor.close}
              </Button>
              <Button
                type="button"
                disabled={saving || tooBigNow || !dirty}
                onClick={() => void handleSave(false)}
              >
                {saving ? m.site.files.editor.saving : m.site.files.editor.save}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
