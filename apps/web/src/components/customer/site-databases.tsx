"use client";

import { useCallback, useId, useRef, useState } from "react";
import {
  SITE_DATABASE_SUFFIX_PATTERN,
  siteDatabaseFullName,
  type SiteDatabaseCreatedDto,
  type SiteDatabaseDto,
  type SiteDatabasePasswordResetDto,
  type SiteDatabasesDto,
  type SiteDatabaseUserCreatedDto,
  type SiteDatabaseUserDto,
} from "@hosting-panel/contracts";
import { TempPasswordBody } from "@/components/admin/create-customer-dialog";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

export const PHPMYADMIN_OPEN_TIMEOUT_MS = 130_000;

export type DatabaseKind = "database" | "user";

export type DatabaseRequestResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string };

export interface PhpMyAdminWindowHandle {
  opener: unknown;
  location: { href: string };
  close: () => void;
}

export function isValidDatabaseSuffix(raw: string): boolean {
  return SITE_DATABASE_SUFFIX_PATTERN.test(raw);
}

// Reloads the site's database state from the BFF and returns null if the reload fails.
export async function fetchSiteDatabasesState(basePath: string): Promise<SiteDatabasesDto | null> {
  const res = await requestJson<SiteDatabasesDto>(`${basePath}/databases`, {
    method: "GET",
    cache: "no-store",
  });
  return res.ok && res.data ? res.data : null;
}

// Reloads state after an unresolved error, falling back when the reload fails too.
export async function resolveDatabaseFailureText(
  m: Messages,
  status: number | undefined,
  code: string | undefined,
  refresh: () => Promise<boolean>,
  prefixText?: string
): Promise<string> {
  const baseText = databaseErrorText(m, code);
  const fullText = prefixText ? `${prefixText} ${baseText}` : baseText;
  const needsRefresh = Boolean(prefixText) || (status !== undefined && isUnresolvedStatus(status));
  if (!needsRefresh) {
    return fullText;
  }
  if (await refresh()) {
    return fullText;
  }
  const fallback = m.site.database.errors.DOCKER_ENGINE_UNAVAILABLE;
  return prefixText ? `${prefixText} ${fallback}` : fallback;
}

export function databaseErrorText(m: Messages, code: string | undefined): string {
  if (!code) return m.errors.generic;
  if (code === "popupBlocked") return m.site.database.phpmyadmin.popupBlocked;
  if (code === "UNAUTHENTICATED") return m.site.files.errors.UNAUTHENTICATED;
  const known = m.site.database.errors as Record<string, string>;
  if (Object.hasOwn(known, code)) return known[code]!;
  return errorMessage(m, code);
}

export function toAddDatabaseNameError(m: Messages, _kind: DatabaseKind, code: string): string {
  return databaseErrorText(m, code);
}

export function diffDatabaseAccess(
  current: readonly string[],
  selected: readonly string[]
): { toGrant: string[]; toRevoke: string[] } {
  const currentSet = new Set(current);
  const selectedSet = new Set(selected);
  return {
    toGrant: selected.filter((db) => !currentSet.has(db)),
    toRevoke: current.filter((db) => !selectedSet.has(db)),
  };
}

function isUnresolvedStatus(status: number): boolean {
  return status === 0 || status === 404 || status === 502 || status === 503 || status === 504;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<DatabaseRequestResult<T>> {
  try {
    const res = await fetch(url, init);
    const parsed = (await res.json().catch(() => null)) as
      | { data?: T; error?: { code?: unknown } }
      | null;
    if (!res.ok) {
      const code =
        parsed?.error && typeof parsed.error.code === "string"
          ? parsed.error.code
          : res.status === 401
            ? "UNAUTHENTICATED"
            : "INTERNAL_ERROR";
      return { ok: false, status: res.status, code };
    }
    return { ok: true, status: res.status, data: (parsed?.data ?? undefined) as T };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { ok: false, status: 0, code: isAbort ? "OPERATION_AMBIGUOUS" : "CONNECTION_FAILED" };
  }
}

export async function postDatabaseName(
  basePath: string,
  kind: "database",
  suffix: string,
  csrfToken: string
): Promise<DatabaseRequestResult<SiteDatabaseCreatedDto>>;
export async function postDatabaseName(
  basePath: string,
  kind: "user",
  suffix: string,
  csrfToken: string
): Promise<DatabaseRequestResult<SiteDatabaseUserCreatedDto>>;
export async function postDatabaseName(
  basePath: string,
  kind: DatabaseKind,
  suffix: string,
  csrfToken: string
): Promise<DatabaseRequestResult<SiteDatabaseCreatedDto | SiteDatabaseUserCreatedDto>> {
  const segment = kind === "database" ? "databases" : "database-users";
  return requestJson(`${basePath}/${segment}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify({ name: suffix }),
  });
}

export async function setDatabaseAccess(
  basePath: string,
  userName: string,
  databaseName: string,
  granted: boolean,
  csrfToken: string
): Promise<DatabaseRequestResult<void>> {
  return requestJson<void>(
    `${basePath}/database-users/${encodeURIComponent(userName)}/grants/${encodeURIComponent(databaseName)}`,
    {
      method: granted ? "PUT" : "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }
  );
}

export async function openPhpMyAdmin(
  basePath: string,
  csrfToken: string,
  win: PhpMyAdminWindowHandle | null
): Promise<{ ok: true } | { ok: false; code: string; status?: number }> {
  if (!win) {
    return { ok: false, code: "popupBlocked" };
  }
  // Cut window.opener before navigating to the signed-in session URL.
  win.opener = null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHPMYADMIN_OPEN_TIMEOUT_MS);
  try {
    const res = await requestJson<{ url?: unknown }>(`${basePath}/databases/phpmyadmin`, {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
      signal: controller.signal,
    });
    if (!res.ok) {
      win.close();
      return { ok: false, status: res.status, code: res.code };
    }
    const url = typeof res.data?.url === "string" ? res.data.url : "";
    if (!url) {
      win.close();
      return { ok: false, status: res.status, code: "INTERNAL_ERROR" };
    }
    win.location.href = url;
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface AddDatabaseNameFormViewProps {
  kind: DatabaseKind;
  prefix: string;
  value: string;
  error: string | null;
  busy: boolean;
  errorInvalid?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function AddDatabaseNameFormView({
  kind,
  prefix,
  value,
  error,
  busy,
  errorInvalid,
  onChange,
  onSubmit,
  onCancel,
}: AddDatabaseNameFormViewProps) {
  const m = useMessages();
  const uid = useId();
  const inputId = `${uid}-suffix`;
  const hintId = `${uid}-hint`;
  const previewId = `${uid}-preview`;
  const errorId = `${uid}-error`;

  const copy = kind === "database" ? m.site.database.databases.create : m.site.database.users.create;
  const isNameInvalid =
    errorInvalid ??
    ((value.length > 0 && !isValidDatabaseSuffix(value)) ||
      error === m.site.database.errors.VALIDATION_ERROR ||
      error === m.site.database.errors.ALREADY_EXISTS);
  const previewName = value ? siteDatabaseFullName(prefix, value) : `${prefix}_…`;
  const describedBy = error ? `${hintId} ${previewId} ${errorId}` : `${hintId} ${previewId}`;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
      noValidate
    >
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{copy.label}</Label>
        <div className="flex items-stretch rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
          <span className="inline-flex items-center border-r border-input bg-muted/50 px-3 font-mono text-xs text-muted-foreground select-none">
            {prefix}_
          </span>
          <Input
            id={inputId}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={describedBy}
            aria-invalid={isNameInvalid ? "true" : undefined}
            className="border-0 font-mono shadow-none focus-visible:ring-0"
          />
        </div>
        <p id={hintId} className="text-xs text-muted-foreground">
          {copy.hint}
        </p>
        <p id={previewId} className="font-mono text-xs text-foreground">
          {format(copy.preview, { name: previewName })}
        </p>
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {m.common.cancel}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? copy.working : copy.submit}
        </Button>
      </div>
    </form>
  );
}

export function AddDatabaseNameForm({
  kind,
  prefix,
  basePath,
  csrfToken,
  onCreated,
  onUnresolved,
  onCancel,
}: {
  kind: DatabaseKind;
  prefix: string;
  basePath: string;
  csrfToken: string;
  onCreated: (created: SiteDatabaseCreatedDto | SiteDatabaseUserCreatedDto) => void;
  onUnresolved?: () => Promise<boolean>;
  onCancel: () => void;
}) {
  const m = useMessages();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorInvalid, setErrorInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    const trimmed = value.trim();
    if (!isValidDatabaseSuffix(trimmed)) {
      setError(m.site.database.errors.VALIDATION_ERROR);
      setErrorInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    setErrorInvalid(false);
    try {
      const res =
        kind === "database"
          ? await postDatabaseName(basePath, "database", trimmed, csrfToken)
          : await postDatabaseName(basePath, "user", trimmed, csrfToken);
      if (!res.ok) {
        setError(
          await resolveDatabaseFailureText(
            m,
            res.status,
            res.code,
            async () => (onUnresolved ? await onUnresolved() : true)
          )
        );
        setErrorInvalid(res.code === "VALIDATION_ERROR" || res.code === "ALREADY_EXISTS");
        return;
      }
      onCreated(res.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AddDatabaseNameFormView
      kind={kind}
      prefix={prefix}
      value={value}
      error={error}
      errorInvalid={errorInvalid}
      busy={busy}
      onChange={(next) => {
        setValue(next.toLowerCase());
        setError(null);
        setErrorInvalid(false);
      }}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}

function ConfirmActionView({
  body,
  error,
  busy,
  confirmLabel,
  workingLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  body: string;
  error: string | null;
  busy: boolean;
  confirmLabel: string;
  workingLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{body}</p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? workingLabel : confirmLabel}
        </Button>
      </div>
    </div>
  );
}

export function DeleteDatabaseForm({
  databaseName,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  databaseName: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  return (
    <ConfirmActionView
      body={format(m.site.database.databases.remove.body, { name: databaseName })}
      error={error}
      busy={busy}
      confirmLabel={m.site.database.databases.remove.confirm}
      workingLabel={m.site.database.databases.remove.working}
      cancelLabel={m.common.cancel}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function DeleteDatabaseUserForm({
  userName,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  userName: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  return (
    <ConfirmActionView
      body={format(m.site.database.users.remove.body, { name: userName })}
      error={error}
      busy={busy}
      confirmLabel={m.site.database.users.remove.confirm}
      workingLabel={m.site.database.users.remove.working}
      cancelLabel={m.common.cancel}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function ResetDatabasePasswordForm({
  userName: _userName,
  error,
  busy,
  onConfirm,
  onCancel,
}: {
  userName: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  return (
    <ConfirmActionView
      body={m.site.database.users.reset.body}
      error={error}
      busy={busy}
      confirmLabel={m.site.database.users.reset.confirm}
      workingLabel={m.site.database.users.reset.working}
      cancelLabel={m.common.cancel}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function DatabasePasswordResult({
  userName,
  temporaryPassword,
  onDone,
}: {
  userName: string;
  temporaryPassword: string;
  onDone: () => void;
}) {
  const m = useMessages();
  return (
    <div className="space-y-4">
      <TempPasswordBody
        password={temporaryPassword}
        who={userName}
        t={m.site.database.users.created}
      />
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          {m.site.database.users.created.done}
        </Button>
      </div>
    </div>
  );
}

export function DatabaseAccessForm({
  userName,
  databases,
  selected,
  error,
  busy,
  onToggle,
  onSubmit,
  onCancel,
}: {
  userName: string;
  databases: readonly SiteDatabaseDto[];
  selected: readonly string[];
  error: string | null;
  busy: boolean;
  onToggle: (databaseName: string, checked: boolean) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const selectedSet = new Set(selected);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4"
    >
      <fieldset disabled={busy} className="space-y-2.5">
        <legend className="text-sm text-muted-foreground">
          {format(m.site.database.users.grants.hint, { name: userName })}
        </legend>
        {databases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.site.database.users.grants.noDatabases}</p>
        ) : (
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {databases.map((db) => {
              const checked = selectedSet.has(db.name);
              return (
                <label
                  key={db.name}
                  className="flex cursor-pointer items-center gap-2.5 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onToggle(db.name, e.target.checked)}
                    className="h-4 w-4 rounded border-input"
                  />
                  <span className="font-mono text-xs">{db.name}</span>
                  {db.primary ? (
                    <Badge variant="secondary">{m.site.database.primaryBadge}</Badge>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {m.common.cancel}
        </Button>
        <Button type="submit" disabled={busy || databases.length === 0}>
          {busy ? m.site.database.users.grants.working : m.site.database.users.grants.save}
        </Button>
      </div>
    </form>
  );
}

type ModalState =
  | { kind: "addDatabase" }
  | { kind: "addUser" }
  | { kind: "deleteDatabase"; databaseName: string }
  | { kind: "deleteUser"; userName: string }
  | { kind: "resetPassword"; userName: string }
  | { kind: "grants"; userName: string; selected: string[] }
  | { kind: "password"; title: string; userName: string; temporaryPassword: string };

export interface SiteDatabasesProps {
  siteId?: string;
  orgId?: string;
  basePath?: string;
  initial: SiteDatabasesDto;
  csrfToken: string;
}

export function SiteDatabases({ siteId = "", orgId = "", basePath, initial, csrfToken }: SiteDatabasesProps) {
  const m = useMessages();
  const locale = useLocale();
  const resolvedBasePath =
    basePath ?? `/api/bff/orgs/${encodeURIComponent(orgId)}/managed-sites/${encodeURIComponent(siteId)}`;

  const [state, setState] = useState<SiteDatabasesDto>(initial);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [pmaBusy, setPmaBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const returnFocusRef = useRef<HTMLElement | null>(null);
  const addDbBtnRef = useRef<HTMLButtonElement | null>(null);
  const addUserBtnRef = useRef<HTMLButtonElement | null>(null);

  const extraDbCount = state.databases.filter((d) => !d.primary).length;
  const extraUserCount = state.users.filter((u) => !u.primary).length;
  const atDbLimit = extraDbCount >= state.limits.databases;
  const atUserLimit = extraUserCount >= state.limits.users;

  const restoreFocus = useCallback((fallback?: HTMLElement | null) => {
    const target = returnFocusRef.current?.isConnected ? returnFocusRef.current : fallback;
    returnFocusRef.current = null;
    if (target) {
      requestAnimationFrame(() => target.focus());
    }
  }, []);

  const openModal = useCallback((next: ModalState) => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    setModalError(null);
    setModal(next);
  }, []);

  const closeModal = useCallback(
    (fallback?: HTMLElement | null) => {
      setModal(null);
      setModalError(null);
      restoreFocus(fallback);
    },
    [restoreFocus]
  );

  const refreshState = useCallback(async (): Promise<boolean> => {
    const next = await fetchSiteDatabasesState(resolvedBasePath);
    if (!next) {
      return false;
    }
    setState(next);
    return true;
  }, [resolvedBasePath]);

  const handleOpenPhpMyAdmin = async () => {
    if (pmaBusy) return;
    setPageError(null);
    // Open the new window synchronously inside the click so popup blockers allow it.
    const win = window.open("", "_blank");
    if (!win) {
      setPageError(m.site.database.phpmyadmin.popupBlocked);
      return;
    }
    setPmaBusy(true);
    try {
      const result = await openPhpMyAdmin(resolvedBasePath, csrfToken, win);
      if (!result.ok) {
        setPageError(
          await resolveDatabaseFailureText(m, result.status, result.code, refreshState)
        );
      }
    } finally {
      setPmaBusy(false);
    }
  };

  const handleDeleteDatabase = async (databaseName: string) => {
    setModalBusy(true);
    setModalError(null);
    try {
      const res = await requestJson<void>(
        `${resolvedBasePath}/databases/${encodeURIComponent(databaseName)}`,
        {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfToken },
        }
      );
      if (!res.ok) {
        setModalError(await resolveDatabaseFailureText(m, res.status, res.code, refreshState));
        return;
      }
      setState((prev) => ({
        ...prev,
        databases: prev.databases.filter((d) => d.name !== databaseName),
        users: prev.users.map((u) => ({
          ...u,
          databases: u.databases.filter((d) => d !== databaseName),
        })),
      }));
      closeModal(addDbBtnRef.current);
    } finally {
      setModalBusy(false);
    }
  };

  const handleDeleteUser = async (userName: string) => {
    setModalBusy(true);
    setModalError(null);
    try {
      const res = await requestJson<void>(
        `${resolvedBasePath}/database-users/${encodeURIComponent(userName)}`,
        {
          method: "DELETE",
          headers: { "X-CSRF-Token": csrfToken },
        }
      );
      if (!res.ok) {
        setModalError(await resolveDatabaseFailureText(m, res.status, res.code, refreshState));
        return;
      }
      setState((prev) => ({
        ...prev,
        users: prev.users.filter((u) => u.name !== userName),
      }));
      closeModal(addUserBtnRef.current);
    } finally {
      setModalBusy(false);
    }
  };

  const handleResetPassword = async (userName: string) => {
    setModalBusy(true);
    setModalError(null);
    try {
      const res = await requestJson<SiteDatabasePasswordResetDto>(
        `${resolvedBasePath}/database-users/${encodeURIComponent(userName)}/reset-password`,
        {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken },
        }
      );
      if (!res.ok) {
        setModalError(await resolveDatabaseFailureText(m, res.status, res.code, refreshState));
        return;
      }
      setModal({
        kind: "password",
        title: m.site.database.users.reset.doneTitle,
        userName,
        temporaryPassword: res.data.temporaryPassword,
      });
    } finally {
      setModalBusy(false);
    }
  };

  const handleSaveGrants = async (userName: string, selected: readonly string[]) => {
    const existing = state.users.find((u) => u.name === userName);
    if (!existing) {
      closeModal(addUserBtnRef.current);
      return;
    }
    const { toGrant, toRevoke } = diffDatabaseAccess(existing.databases, selected);
    if (toGrant.length === 0 && toRevoke.length === 0) {
      closeModal();
      return;
    }

    setModalBusy(true);
    setModalError(null);
    let appliedCount = 0;
    try {
      const steps: Array<{ db: string; grant: boolean }> = [
        ...toGrant.map((db) => ({ db, grant: true })),
        ...toRevoke.map((db) => ({ db, grant: false })),
      ];
      for (const step of steps) {
        const res = await setDatabaseAccess(
          resolvedBasePath,
          userName,
          step.db,
          step.grant,
          csrfToken
        );
        if (!res.ok) {
          const prefixText = appliedCount > 0 ? m.site.database.users.grants.partial : undefined;
          setModalError(
            await resolveDatabaseFailureText(m, res.status, res.code, refreshState, prefixText)
          );
          return;
        }
        appliedCount += 1;
      }
      const order = new Set(selected);
      const nextDatabases = state.databases.map((d) => d.name).filter((name) => order.has(name));
      setState((prev) => ({
        ...prev,
        users: prev.users.map((u) => (u.name === userName ? { ...u, databases: nextDatabases } : u)),
      }));
      closeModal();
    } finally {
      setModalBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{m.site.database.intro}</p>
        <p>{format(m.site.database.prefixNote, { prefix: state.prefix })}</p>
        <p>{m.site.database.primaryNote}</p>
      </div>

      {pageError ? (
        <Alert variant="destructive">
          <AlertDescription>{pageError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{m.site.database.databases.heading}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {format(m.site.database.databases.count, {
                count: extraDbCount,
                max: state.limits.databases,
              })}
            </p>
          </div>
          <Button
            ref={addDbBtnRef}
            type="button"
            onClick={() => openModal({ kind: "addDatabase" })}
            disabled={atDbLimit}
          >
            {m.site.database.databases.add}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {atDbLimit ? (
            <p className="text-xs text-muted-foreground">
              {format(m.site.database.databases.limit, { max: state.limits.databases })}
            </p>
          ) : null}
          {state.databases.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.site.database.databases.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.site.database.name}</TableHead>
                  <TableHead>{m.site.database.databases.size}</TableHead>
                  <TableHead className="text-right">{m.site.database.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.databases.map((db) => (
                  <TableRow key={db.name}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-xs">{db.name}</code>
                        {db.primary ? (
                          <Badge variant="secondary">{m.site.database.primaryBadge}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatSize(db.sizeBytes, locale)}
                    </TableCell>
                    <TableCell className="text-right">
                      {db.primary ? (
                        <span aria-hidden="true" className="text-xs text-muted-foreground">
                          —
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => openModal({ kind: "deleteDatabase", databaseName: db.name })}
                        >
                          {m.site.database.databases.remove.action}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle className="text-base">{m.site.database.users.heading}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {format(m.site.database.users.count, {
                count: extraUserCount,
                max: state.limits.users,
              })}
            </p>
          </div>
          <Button
            ref={addUserBtnRef}
            type="button"
            onClick={() => openModal({ kind: "addUser" })}
            disabled={atUserLimit}
          >
            {m.site.database.users.add}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {atUserLimit ? (
            <p className="text-xs text-muted-foreground">
              {format(m.site.database.users.limit, { max: state.limits.users })}
            </p>
          ) : null}
          {state.users.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.site.database.users.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.site.database.name}</TableHead>
                  <TableHead>{m.site.database.users.access}</TableHead>
                  <TableHead className="text-right">{m.site.database.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.users.map((u: SiteDatabaseUserDto) => (
                  <TableRow key={u.name}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-xs">{u.name}</code>
                        {u.primary ? (
                          <Badge variant="secondary">{m.site.database.primaryBadge}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      {u.databases.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          {m.site.database.users.noAccess}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {u.databases.map((dbName) => (
                            <code
                              key={dbName}
                              className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                            >
                              {dbName}
                            </code>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {u.primary ? (
                        <span aria-hidden="true" className="text-xs text-muted-foreground">
                          —
                        </span>
                      ) : (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              openModal({
                                kind: "grants",
                                userName: u.name,
                                selected: [...u.databases],
                              })
                            }
                          >
                            {m.site.database.users.grants.action}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openModal({ kind: "resetPassword", userName: u.name })}
                          >
                            {m.site.database.users.reset.action}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => openModal({ kind: "deleteUser", userName: u.name })}
                          >
                            {m.site.database.users.remove.action}
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.site.database.phpmyadmin.heading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{m.site.database.phpmyadmin.body}</p>
          <div className="rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
            {m.site.database.phpmyadmin.warning}
          </div>
          <p className="text-xs text-muted-foreground">{m.site.database.phpmyadmin.importNote}</p>
          {state.phpMyAdminAvailable ? (
            <div>
              <Button type="button" onClick={handleOpenPhpMyAdmin} disabled={pmaBusy}>
                {pmaBusy ? m.site.database.phpmyadmin.opening : m.site.database.phpmyadmin.open}
                <span className="sr-only"> {m.site.opensNewTab}</span>
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {m.site.database.phpmyadmin.unavailable}
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={modal !== null}
        onOpenChange={guardDialogClose(
          () => modalBusy,
          (open) => {
            if (!open) closeModal();
          }
        )}
      >
        <DialogContent>
          {modal?.kind === "addDatabase" ? (
            <>
              <DialogHeader>
                <DialogTitle>{m.site.database.databases.create.title}</DialogTitle>
                <DialogDescription className="sr-only">
                  {m.site.database.databases.create.hint}
                </DialogDescription>
              </DialogHeader>
              <AddDatabaseNameForm
                kind="database"
                prefix={state.prefix}
                basePath={resolvedBasePath}
                csrfToken={csrfToken}
                onCreated={(created) => {
                  const createdDb = created as SiteDatabaseCreatedDto;
                  setState((prev) => ({
                    ...prev,
                    databases: [...prev.databases, createdDb.database],
                  }));
                  closeModal();
                }}
                onUnresolved={refreshState}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "addUser" ? (
            <>
              <DialogHeader>
                <DialogTitle>{m.site.database.users.create.title}</DialogTitle>
                <DialogDescription className="sr-only">
                  {m.site.database.users.create.hint}
                </DialogDescription>
              </DialogHeader>
              <AddDatabaseNameForm
                kind="user"
                prefix={state.prefix}
                basePath={resolvedBasePath}
                csrfToken={csrfToken}
                onCreated={(created) => {
                  const createdUser = created as SiteDatabaseUserCreatedDto;
                  setState((prev) => ({
                    ...prev,
                    users: [...prev.users, createdUser.user],
                  }));
                  setModal({
                    kind: "password",
                    title: m.site.database.users.created.title,
                    userName: createdUser.user.name,
                    temporaryPassword: createdUser.temporaryPassword,
                  });
                }}
                onUnresolved={refreshState}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "deleteDatabase" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {format(m.site.database.databases.remove.title, { name: modal.databaseName })}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {format(m.site.database.databases.remove.body, { name: modal.databaseName })}
                </DialogDescription>
              </DialogHeader>
              <DeleteDatabaseForm
                databaseName={modal.databaseName}
                error={modalError}
                busy={modalBusy}
                onConfirm={() => handleDeleteDatabase(modal.databaseName)}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "deleteUser" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {format(m.site.database.users.remove.title, { name: modal.userName })}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {format(m.site.database.users.remove.body, { name: modal.userName })}
                </DialogDescription>
              </DialogHeader>
              <DeleteDatabaseUserForm
                userName={modal.userName}
                error={modalError}
                busy={modalBusy}
                onConfirm={() => handleDeleteUser(modal.userName)}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "resetPassword" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {format(m.site.database.users.reset.title, { name: modal.userName })}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {m.site.database.users.reset.body}
                </DialogDescription>
              </DialogHeader>
              <ResetDatabasePasswordForm
                userName={modal.userName}
                error={modalError}
                busy={modalBusy}
                onConfirm={() => handleResetPassword(modal.userName)}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "grants" ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {format(m.site.database.users.grants.title, { name: modal.userName })}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {format(m.site.database.users.grants.hint, { name: modal.userName })}
                </DialogDescription>
              </DialogHeader>
              <DatabaseAccessForm
                userName={modal.userName}
                databases={state.databases}
                selected={modal.selected}
                error={modalError}
                busy={modalBusy}
                onToggle={(dbName, checked) =>
                  setModal((prev) => {
                    if (!prev || prev.kind !== "grants") return prev;
                    const next = checked
                      ? prev.selected.includes(dbName)
                        ? prev.selected
                        : [...prev.selected, dbName]
                      : prev.selected.filter((d) => d !== dbName);
                    return { ...prev, selected: next };
                  })
                }
                onSubmit={() => handleSaveGrants(modal.userName, modal.selected)}
                onCancel={() => closeModal()}
              />
            </>
          ) : null}

          {modal?.kind === "password" ? (
            <>
              <DialogHeader>
                <DialogTitle>{modal.title}</DialogTitle>
                <DialogDescription className="sr-only">
                  {m.site.database.users.created.tempOnce}
                </DialogDescription>
              </DialogHeader>
              <DatabasePasswordResult
                userName={modal.userName}
                temporaryPassword={modal.temporaryPassword}
                onDone={() => closeModal()}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
