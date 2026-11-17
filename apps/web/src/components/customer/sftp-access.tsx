"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  SITE_SFTP_MAX_USERS,
  type SiteSftpDto,
  type SiteSftpPasswordResetDto,
  type SiteSftpUserCreatedDto,
  type SiteSftpUserDto,
} from "@hosting-panel/contracts";
import { Check, Copy, Plus } from "lucide-react";
import { TempPasswordBody } from "@/components/admin/create-customer-dialog";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { formatDate } from "@/lib/file-browser";

const SFTP_SHORT_NAME_RE = /^[a-z0-9]{1,16}$/;

/** Validates the customer-chosen short suffix for a site SFTP user name. */
export function isValidSftpName(name: string): boolean {
  return SFTP_SHORT_NAME_RE.test(name);
}

/** Maps an SFTP API error code to plain customer-facing copy. */
export function sftpErrorText(m: Messages, code: string): string {
  const sftpErrors = m.site.files.sftp.errors as Record<string, string>;
  if (Object.hasOwn(sftpErrors, code)) return sftpErrors[code]!;
  if (code === "NOT_SUPPORTED") return m.site.files.sftp.unavailable;
  if (code === "OPERATION_AMBIGUOUS") return m.site.files.errors.OPERATION_AMBIGUOUS;
  if (code === "UNAUTHENTICATED") return m.site.files.errors.UNAUTHENTICATED;
  return errorMessage(m, code);
}

/** Builds the request body expected by POST /sftp/users. */
export function createSftpUserBody(name: string): { name: string } {
  return { name };
}

/** Sends the create SFTP user request with the CSRF header and schema-valid body. */
export function postSftpUser(basePath: string, csrfToken: string, name: string): Promise<Response> {
  return fetch(`${basePath}/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: JSON.stringify(createSftpUserBody(name)),
  });
}

export interface AddSftpUserError {
  message: string;
  fieldInvalid: boolean;
}

/** Maps an add-user error code to its message and whether the name input caused it. */
export function toAddSftpUserError(m: Messages, code: string): AddSftpUserError {
  return {
    message: sftpErrorText(m, code),
    fieldInvalid: code === "VALIDATION_ERROR" || code === "ALREADY_EXISTS",
  };
}

async function readErrorCode(res: Response): Promise<string> {
  if (res.status === 502 || res.status === 504) return "OPERATION_AMBIGUOUS";
  const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  return json?.error?.code ?? "";
}

type SftpDialog =
  | { kind: "add" }
  | { kind: "reset"; user: SiteSftpUserDto }
  | { kind: "delete"; user: SiteSftpUserDto }
  | { kind: "shownOnce"; title: string; username: string; password: string }
  | null;

export interface AddSftpUserFormProps {
  onSubmit: (name: string) => Promise<AddSftpUserError | null>;
  onCancel: () => void;
}

export interface AddSftpUserFormViewProps {
  name: string;
  busy: boolean;
  error: string | null;
  errorInvalid?: boolean;
  inputId: string;
  hintId: string;
  errorId: string;
  onNameChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

/** Pure view for AddSftpUserForm so tests can verify input accessibility states directly. */
export function AddSftpUserFormView({
  name,
  busy,
  error,
  errorInvalid,
  inputId,
  hintId,
  errorId,
  onNameChange,
  onSubmit,
  onCancel,
}: AddSftpUserFormViewProps) {
  const t = useMessages().site.files.sftp;
  const cancelLabel = useMessages().site.files.cancel;
  const invalid = Boolean(errorInvalid) || (name.length > 0 && !isValidSftpName(name));
  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t.create.title}</DialogTitle>
        <DialogDescription className="sr-only">{t.create.hint}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={inputId}>{t.create.label}</Label>
        <Input
          id={inputId}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          value={name}
          onChange={(e) => onNameChange(e.target.value.toLowerCase())}
          autoComplete="off"
          autoFocus
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t.create.hint}
        </p>
      </div>
      {error && (
        <Alert id={errorId} variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={busy || name.length === 0}>
          {busy ? t.create.working : t.create.submit}
        </Button>
      </div>
    </form>
  );
}

export function AddSftpUserForm({ onSubmit, onCancel }: AddSftpUserFormProps) {
  const t = useMessages().site.files.sftp;
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AddSftpUserError | null>(null);

  function handleNameChange(value: string) {
    setName(value);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidSftpName(name)) {
      setError({ message: t.errors.VALIDATION_ERROR, fieldInvalid: true });
      return;
    }
    setBusy(true);
    setError(null);
    const err = await onSubmit(name);
    if (err !== null) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <AddSftpUserFormView
      name={name}
      busy={busy}
      error={error?.message ?? null}
      errorInvalid={error?.fieldInvalid ?? false}
      inputId={inputId}
      hintId={hintId}
      errorId={errorId}
      onNameChange={handleNameChange}
      onSubmit={handleSubmit}
      onCancel={onCancel}
    />
  );
}

export interface ResetSftpPasswordFormProps {
  username: string;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}

export function ResetSftpPasswordForm({
  username,
  onConfirm,
  onCancel,
}: ResetSftpPasswordFormProps) {
  const t = useMessages().site.files.sftp;
  const cancelLabel = useMessages().site.files.cancel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const msg = await onConfirm();
    if (msg !== null) {
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{format(t.reset.title, { name: username })}</DialogTitle>
        <DialogDescription>{t.reset.body}</DialogDescription>
      </DialogHeader>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="button" onClick={handleConfirm} disabled={busy}>
          {busy ? t.reset.working : t.reset.confirm}
        </Button>
      </div>
    </div>
  );
}

export interface DeleteSftpUserFormProps {
  username: string;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}

export function DeleteSftpUserForm({
  username,
  onConfirm,
  onCancel,
}: DeleteSftpUserFormProps) {
  const t = useMessages().site.files.sftp;
  const cancelLabel = useMessages().site.files.cancel;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const msg = await onConfirm();
    if (msg !== null) {
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{format(t.remove.title, { name: username })}</DialogTitle>
        <DialogDescription>{format(t.remove.body, { name: username })}</DialogDescription>
      </DialogHeader>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="destructive" onClick={handleConfirm} disabled={busy}>
          {busy ? t.remove.working : t.remove.confirm}
        </Button>
      </div>
    </div>
  );
}

export interface SftpPasswordResultProps {
  title: string;
  username: string;
  password: string;
  onDone: () => void;
}

export function SftpPasswordResult({
  title,
  username,
  password,
  onDone,
}: SftpPasswordResultProps) {
  const t = useMessages().site.files.sftp.created;

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="font-mono text-foreground">{username}</DialogDescription>
      </DialogHeader>
      <TempPasswordBody password={password} who={username} t={t} />
      <div className="flex justify-end">
        <Button type="button" onClick={onDone}>
          {t.done}
        </Button>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  copyWhat,
  copied,
  copyLabel,
  copiedLabel,
  copyForTemplate,
  onCopy,
}: {
  label: string;
  value: string;
  copyWhat?: string;
  copied?: boolean;
  copyLabel: string;
  copiedLabel: string;
  copyForTemplate: string;
  onCopy?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2">
        <code className="select-all font-mono text-sm">{value}</code>
        {copyWhat && onCopy && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2"
            aria-label={copied ? copiedLabel : format(copyForTemplate, { what: copyWhat })}
            onClick={onCopy}
          >
            {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
            {copied ? copiedLabel : copyLabel}
          </Button>
        )}
      </dd>
    </div>
  );
}

/** Customer view of site SFTP connection details, user list, and one-time credentials. */
export function SftpAccess({
  basePath,
  csrfToken,
  initial,
}: {
  basePath: string;
  csrfToken: string;
  initial: SiteSftpDto;
}) {
  const m = useMessages();
  const t = m.site.files.sftp;
  const locale = useLocale();
  const [sftp, setSftp] = useState<SiteSftpDto>(initial);
  const [dialog, setDialog] = useState<SftpDialog>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const usersHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function refreshState() {
    try {
      const res = await fetch(basePath, { cache: "no-store" });
      if (!res.ok || !mountedRef.current) return;
      const json = (await res.json().catch(() => null)) as { data?: SiteSftpDto } | null;
      if (json?.data && mountedRef.current) {
        setSftp(json.data);
      }
    } catch {
      // Background reconciliation failed cleanly; existing view remains intact.
    }
  }

  async function copyDetail(field: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      if (!mountedRef.current) return;
      setCopiedField(field);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setCopiedField((prev) => (prev === field ? null : prev));
      }, 2000);
    } catch {
      if (mountedRef.current) setCopiedField(null);
    }
  }

  async function handleAddUser(name: string): Promise<AddSftpUserError | null> {
    busyRef.current = true;
    try {
      const res = await postSftpUser(basePath, csrfToken, name);
      if (!res.ok) {
        const code = await readErrorCode(res);
        if (res.status === 502 || res.status === 504) void refreshState();
        return toAddSftpUserError(m, code);
      }
      const json = (await res.json().catch(() => null)) as { data?: SiteSftpUserCreatedDto } | null;
      if (!json?.data) {
        return toAddSftpUserError(m, "INTERNAL_ERROR");
      }
      if (!mountedRef.current) return null;
      const created = json.data;
      setSftp((prev) => ({
        ...prev,
        users: [...prev.users, created.user],
      }));
      setDialog({
        kind: "shownOnce",
        title: t.created.title,
        username: created.user.username,
        password: created.temporaryPassword,
      });
      return null;
    } catch {
      return { message: errorMessage(m, "NETWORK_ERROR"), fieldInvalid: false };
    } finally {
      busyRef.current = false;
    }
  }

  async function handleResetPassword(user: SiteSftpUserDto): Promise<string | null> {
    busyRef.current = true;
    try {
      const res = await fetch(`${basePath}/users/${encodeURIComponent(user.id)}/reset-password`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (!res.ok) {
        const code = await readErrorCode(res);
        if (res.status === 502 || res.status === 504) void refreshState();
        return sftpErrorText(m, code);
      }
      const json = (await res.json().catch(() => null)) as { data?: SiteSftpPasswordResetDto } | null;
      if (!json?.data) {
        return sftpErrorText(m, "INTERNAL_ERROR");
      }
      if (!mountedRef.current) return null;
      const nowIso = new Date().toISOString();
      setSftp((prev) => ({
        ...prev,
        users: prev.users.map((u) => (u.id === user.id ? { ...u, passwordChangedAt: nowIso } : u)),
      }));
      setDialog({
        kind: "shownOnce",
        title: t.reset.doneTitle,
        username: user.username,
        password: json.data.temporaryPassword,
      });
      return null;
    } catch {
      return errorMessage(m, "NETWORK_ERROR");
    } finally {
      busyRef.current = false;
    }
  }

  async function handleDeleteUser(user: SiteSftpUserDto): Promise<string | null> {
    busyRef.current = true;
    try {
      const res = await fetch(`${basePath}/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": csrfToken },
      });
      if (!res.ok) {
        const code = await readErrorCode(res);
        if (res.status === 502 || res.status === 504) void refreshState();
        return sftpErrorText(m, code);
      }
      if (!mountedRef.current) return null;
      setSftp((prev) => ({
        ...prev,
        users: prev.users.filter((u) => u.id !== user.id),
      }));
      setDialog(null);
      return null;
    } catch {
      return errorMessage(m, "NETWORK_ERROR");
    } finally {
      busyRef.current = false;
    }
  }

  if (!sftp.available) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t.intro}</p>
        <p role="status" className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          {t.unavailable}
        </p>
      </div>
    );
  }

  const atLimit = sftp.users.length >= SITE_SFTP_MAX_USERS;
  const hasDetails = sftp.host !== null && sftp.port !== null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.details}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {hasDetails ? (
            <dl className="divide-y">
              <DetailRow
                label={t.protocol}
                value="SFTP"
                copyLabel={t.created.copy}
                copiedLabel={t.copied}
                copyForTemplate={t.copyFor}
              />
              <DetailRow
                label={t.host}
                value={sftp.host!}
                copyWhat={t.host}
                copied={copiedField === t.host}
                copyLabel={t.created.copy}
                copiedLabel={t.copied}
                copyForTemplate={t.copyFor}
                onCopy={() => copyDetail(t.host, sftp.host!)}
              />
              <DetailRow
                label={t.port}
                value={String(sftp.port!)}
                copyWhat={t.port}
                copied={copiedField === t.port}
                copyLabel={t.created.copy}
                copiedLabel={t.copied}
                copyForTemplate={t.copyFor}
                onCopy={() => copyDetail(t.port, String(sftp.port!))}
              />
            </dl>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t.detailsUnavailable}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t.usernameHint}</p>
          {sftp.hostKeyFingerprint !== null && (
            <details className="rounded-md border bg-muted/30 p-3 text-sm">
              <summary className="cursor-pointer font-medium">{t.fingerprintTitle}</summary>
              <p className="mt-2 text-muted-foreground">{t.fingerprintBody}</p>
              <code className="mt-2 block select-all break-all font-mono text-xs">
                {sftp.hostKeyFingerprint}
              </code>
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle ref={usersHeadingRef} tabIndex={-1} className="text-base outline-none">
              {t.users}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {format(t.count, { count: sftp.users.length, max: SITE_SFTP_MAX_USERS })}
            </p>
          </div>
          <Button
            ref={addBtnRef}
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={atLimit}
            onClick={(e) => {
              triggerRef.current = e.currentTarget;
              setDialog({ kind: "add" });
            }}
          >
            <Plus aria-hidden className="h-4 w-4" />
            {t.add}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {atLimit && (
            <p role="status" className="text-sm text-muted-foreground">
              {format(t.limit, { max: SITE_SFTP_MAX_USERS })}
            </p>
          )}

          {sftp.users.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.name}</TableHead>
                  <TableHead>{t.createdAt}</TableHead>
                  <TableHead>{t.passwordChanged}</TableHead>
                  <TableHead className="text-right">{t.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sftp.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <code className="font-mono text-sm">{user.username}</code>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(user.createdAt, locale)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(user.passwordChangedAt, locale)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            triggerRef.current = e.currentTarget;
                            setDialog({ kind: "reset", user });
                          }}
                        >
                          {t.reset.action}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            triggerRef.current = e.currentTarget;
                            setDialog({ kind: "delete", user });
                          }}
                        >
                          {t.remove.action}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dialog !== null}
        onOpenChange={guardDialogClose(
          () => busyRef.current,
          (open) => {
            if (!open) setDialog(null);
          },
        )}
      >
        <DialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const target = triggerRef.current;
            if (target && target.isConnected && !target.disabled) {
              target.focus();
            } else if (
              addBtnRef.current &&
              addBtnRef.current.isConnected &&
              !addBtnRef.current.disabled
            ) {
              addBtnRef.current.focus();
            } else {
              usersHeadingRef.current?.focus();
            }
            triggerRef.current = null;
          }}
        >
          {dialog?.kind === "add" && (
            <AddSftpUserForm onSubmit={handleAddUser} onCancel={() => setDialog(null)} />
          )}
          {dialog?.kind === "reset" && (
            <ResetSftpPasswordForm
              username={dialog.user.username}
              onConfirm={() => handleResetPassword(dialog.user)}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog?.kind === "delete" && (
            <DeleteSftpUserForm
              username={dialog.user.username}
              onConfirm={() => handleDeleteUser(dialog.user)}
              onCancel={() => setDialog(null)}
            />
          )}
          {dialog?.kind === "shownOnce" && (
            <SftpPasswordResult
              title={dialog.title}
              username={dialog.username}
              password={dialog.password}
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
