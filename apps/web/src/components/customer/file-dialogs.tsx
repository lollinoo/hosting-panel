"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SiteFileEntryDto } from "@hosting-panel/contracts";
import { Folder } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FileBreadcrumb } from "@/components/customer/file-list";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import {
  fileErrorText,
  isValidName,
  isValidRelativePath,
  joinPath,
  sortEntries,
  validateMoveDest,
} from "@/lib/file-browser";

export interface NameDialogFormProps {
  title: string;
  label: string;
  hint?: string;
  warning?: string;
  initial: string;
  submitLabel: string;
  workingLabel: string;
  allowEmpty?: boolean;
  allowNested?: boolean;
  onSubmit: (value: string) => Promise<string | null>;
  onCancel: () => void;
}

export function NameDialogForm({
  title,
  label,
  hint,
  warning,
  initial,
  submitLabel,
  workingLabel,
  allowEmpty = false,
  allowNested = false,
  onSubmit,
  onCancel,
}: NameDialogFormProps) {
  const m = useMessages();
  const t = m.site.files;
  const inputId = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    const valid = allowNested ? isValidRelativePath(trimmed, allowEmpty) : trimmed === "" ? allowEmpty : isValidName(trimmed);
    if (!valid) {
      setError(t.nameRule);
      return;
    }
    setBusy(true);
    setError(null);
    const message = await onSubmit(trimmed);
    if (message !== null) {
      setError(message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {warning ? (
          <DialogDescription>{warning}</DialogDescription>
        ) : hint ? (
          <DialogDescription>{hint}</DialogDescription>
        ) : (
          <DialogDescription className="sr-only">{label}</DialogDescription>
        )}
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={inputId}>{label}</Label>
        <Input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={busy || (!allowEmpty && value.trim() === "")}>
          {busy ? workingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Prevents Escape or backdrop dismissal while a dialog mutation is in flight. */
export function guardDialogClose(
  isBusy: () => boolean,
  onOpenChange: (open: boolean) => void,
): (open: boolean) => void {
  return (nextOpen) => {
    if (!nextOpen && isBusy()) return;
    onOpenChange(nextOpen);
  };
}

/** Loads folders for MoveDialog while aborting and ignoring stale responses. */
export function createFolderLoader(opts: {
  apiBase: string;
  locale: string;
  messages: Messages;
  fetchFn?: typeof fetch;
  onLoading: (loading: boolean) => void;
  onFolders: (dirs: SiteFileEntryDto[]) => void;
  onError: (error: string | null) => void;
}) {
  let latestId = 0;
  let activeCtrl: AbortController | null = null;
  const fetchImpl = opts.fetchFn ?? fetch;

  const abort = () => {
    latestId += 1;
    activeCtrl?.abort();
    activeCtrl = null;
  };

  const load = async (target: string) => {
    const id = ++latestId;
    activeCtrl?.abort();
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    opts.onLoading(true);
    opts.onError(null);
    try {
      const res = await fetchImpl(`${opts.apiBase}/files?path=${encodeURIComponent(target)}`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const json = await res.json().catch(() => null);
      if (id !== latestId || ctrl.signal.aborted) return;
      if (res.ok && json?.data && Array.isArray(json.data.entries)) {
        const dirs = (json.data.entries as SiteFileEntryDto[]).filter((e) => e.kind === "dir");
        opts.onFolders(sortEntries(dirs, opts.locale));
      } else {
        opts.onError(fileErrorText(opts.messages, json?.error?.code ?? "", "files", json?.error?.details));
      }
    } catch {
      if (id !== latestId || ctrl.signal.aborted) return;
      opts.onError(opts.messages.errors.generic);
    } finally {
      if (id === latestId && !ctrl.signal.aborted) {
        opts.onLoading(false);
      }
    }
  };

  return { load, abort };
}

export function NameDialog({
  open,
  onOpenChange,
  ...formProps
}: Omit<NameDialogFormProps, "onCancel"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const busyRef = useRef(false);

  return (
    <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, onOpenChange)}>
      <DialogContent>
        {open && (
          <NameDialogForm
            {...formProps}
            onSubmit={async (v) => {
              busyRef.current = true;
              try {
                const err = await formProps.onSubmit(v);
                if (err === null) {
                  busyRef.current = false;
                  onOpenChange(false);
                }
                return err;
              } finally {
                busyRef.current = false;
              }
            }}
            onCancel={() => {
              if (!busyRef.current) onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialogForm({
  apiBase,
  items,
  from,
  onMove,
  onCancel,
}: {
  apiBase: string;
  items: readonly SiteFileEntryDto[];
  from: string;
  onMove: (dest: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const m = useMessages();
  const t = m.site.files;
  const locale = useLocale();
  const [dest, setDest] = useState(from);
  const [folders, setFolders] = useState<SiteFileEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const folderLoader = useMemo(
    () =>
      createFolderLoader({
        apiBase,
        locale,
        messages: m,
        onLoading: setLoading,
        onFolders: setFolders,
        onError: setLoadError,
      }),
    [apiBase, locale, m],
  );

  useEffect(() => {
    void folderLoader.load(dest);
    return () => folderLoader.abort();
  }, [dest, folderLoader]);

  const title =
    items.length === 1
      ? format(t.move.titleOne, { name: items[0]!.name })
      : format(t.move.titleMany, { count: items.length });
  const problem = validateMoveDest(from, items, dest);

  async function handleConfirm() {
    if (problem !== null) return;
    setBusy(true);
    setMoveError(null);
    const err = await onMove(dest);
    if (err !== null) {
      setMoveError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t.move.choose}</DialogDescription>
      </DialogHeader>

      <FileBreadcrumb path={dest} onOpen={(next) => !busy && setDest(next)} />

      {loading ? (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          {t.loading}
        </p>
      ) : loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription className="space-y-2">
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void folderLoader.load(dest)}>
              {t.retry}
            </Button>
          </AlertDescription>
        </Alert>
      ) : folders.length === 0 ? (
        <p className="rounded-md border py-6 text-center text-sm text-muted-foreground">{t.move.noFolders}</p>
      ) : (
        <ul className="max-h-60 divide-y overflow-y-auto rounded-md border">
          {folders.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDest(joinPath(dest, f.name))}
                aria-label={format(t.move.open, { name: f.name })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Folder aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{f.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {problem === "intoItself" && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.move.intoItself}</AlertDescription>
        </Alert>
      )}
      {problem === "sameFolder" && <p className="text-xs text-muted-foreground">{t.move.sameFolder}</p>}
      {moveError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{moveError}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="button" onClick={handleConfirm} disabled={busy || loading || problem !== null}>
          {busy ? t.move.working : t.move.here}
        </Button>
      </div>
    </div>
  );
}

export function MoveDialog({
  apiBase,
  items,
  from,
  onMove,
  open,
  onOpenChange,
}: {
  apiBase: string;
  items: readonly SiteFileEntryDto[];
  from: string;
  onMove: (dest: string) => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const busyRef = useRef(false);

  return (
    <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, onOpenChange)}>
      <DialogContent>
        {open && (
          <MoveDialogForm
            apiBase={apiBase}
            items={items}
            from={from}
            onMove={async (dest) => {
              busyRef.current = true;
              try {
                const err = await onMove(dest);
                if (err === null) {
                  busyRef.current = false;
                  onOpenChange(false);
                }
                return err;
              } finally {
                busyRef.current = false;
              }
            }}
            onCancel={() => {
              if (!busyRef.current) onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeleteFilesForm({
  items,
  onConfirm,
  onCancel,
}: {
  items: readonly SiteFileEntryDto[];
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const t = useMessages().site.files;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title =
    items.length === 1
      ? format(t.delete.titleOne, { name: items[0]!.name })
      : format(t.delete.titleMany, { count: items.length });
  const body =
    items.length === 1
      ? items[0]!.kind === "dir"
        ? t.delete.bodyFolder
        : t.delete.bodyFile
      : format(t.delete.bodyMany, { count: items.length });

  async function handleDelete() {
    setBusy(true);
    setError(null);
    const err = await onConfirm();
    if (err !== null) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="button" variant="destructive" onClick={handleDelete} disabled={busy}>
          {busy ? t.delete.working : t.delete.confirm}
        </Button>
      </div>
    </div>
  );
}

export function DeleteFilesDialog({
  items,
  onConfirm,
  open,
  onOpenChange,
  onAfterDelete,
}: {
  items: readonly SiteFileEntryDto[];
  onConfirm: () => Promise<string | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterDelete?: () => void;
}) {
  const deletedRef = useRef(false);
  const busyRef = useRef(false);

  return (
    <Dialog
      open={open}
      onOpenChange={guardDialogClose(() => busyRef.current, (next) => {
        if (next) deletedRef.current = false;
        onOpenChange(next);
      })}
    >
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (deletedRef.current && onAfterDelete) {
            e.preventDefault();
            deletedRef.current = false;
            onAfterDelete();
          }
        }}
      >
        {open && (
          <DeleteFilesForm
            items={items}
            onConfirm={async () => {
              busyRef.current = true;
              try {
                const err = await onConfirm();
                if (err === null) {
                  busyRef.current = false;
                  deletedRef.current = true;
                  onOpenChange(false);
                }
                return err;
              } finally {
                busyRef.current = false;
              }
            }}
            onCancel={() => {
              if (!busyRef.current) onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReplaceFilesForm({
  names,
  onReplace,
  onSkip,
  onCancel,
}: {
  names: readonly string[];
  onReplace: () => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const t = useMessages().site.files;

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t.upload.replaceTitle}</DialogTitle>
        <DialogDescription>{format(t.upload.replaceBody, { names: names.join(", ") })}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t.cancel}
        </Button>
        <Button type="button" variant="secondary" onClick={onSkip}>
          {t.upload.skip}
        </Button>
        <Button type="button" variant="destructive" onClick={onReplace}>
          {t.upload.replace}
        </Button>
      </div>
    </div>
  );
}

export function ReplaceFilesDialog({
  names,
  onReplace,
  onSkip,
  onCancel,
  open,
}: {
  names: readonly string[];
  onReplace: () => void;
  onSkip: () => void;
  onCancel: () => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        {open && (
          <ReplaceFilesForm names={names} onReplace={onReplace} onSkip={onSkip} onCancel={onCancel} />
        )}
      </DialogContent>
    </Dialog>
  );
}
