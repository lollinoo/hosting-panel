"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APP_STACK_PRE_RESTORE_BACKUPS_KEPT,
  MANUAL_BACKUPS_KEPT,
  appStackBackupEnqueueTarget,
  type AppStackAllowedAction,
  type AppStackBackupDto,
  type AppStackBackupsDto,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatSize } from "@/lib/file-browser";
import { keyedSend } from "@/lib/keyed-send";
import { appStackBackupProblemText, appStackRefusalText, type Tone } from "./app-stack-view";

export const APP_STACK_BACKUP_STATUS_TONE: Readonly<Record<AppStackBackupDto["status"], Tone>> = {
  running: "secondary",
  succeeded: "success",
  partial: "warning",
  failed: "destructive",
};

const muted = "text-sm text-muted-foreground";

export function canConfirmRestore(typed: string, name: string, busy: boolean): boolean {
  return typed === name && !busy;
}

/** What the detail says of the application now: its list (`allowedActions`), an operation holding it, its status. */
export type AppStackBackupOffer = {
  actions: readonly AppStackAllowedAction[];
  /** An operation holds the application: the customer's own or work of the platform. */
  busy: boolean;
  /** The status shown. */
  status: AppStackStatus;
  /** It reads `unknown` only because the components could not be read lately; the stored status is another. */
  stale: boolean;
};

/**
 * Why a backup or a restore cannot be asked now, or null when it can: the backups' own reason first, then the
 * detail's list, never the status shown (issue #106). The line says only what is true: an operation holds the
 * application, or its status refuses (the one shown is the stored one unless the reading is stale), else the caller
 * may not. A refusal only the request knows (the hourly limit) is said when the request answers.
 */
export function appStackBackupBlock(
  m: Messages,
  backups: AppStackBackupsDto,
  kind: "stack.backup" | "stack.restore",
  offer: AppStackBackupOffer,
): string | null {
  if (backups.unavailableReason !== null) return m.apps.backups.unavailable[backups.unavailableReason];
  if (offer.actions.includes(kind)) return null;
  if (offer.busy) return m.apps.backups.busy;
  if (!offer.stale && appStackBackupEnqueueTarget(offer.status) === null) {
    return format(m.apps.reasons.status, { status: m.apps.status[offer.status] });
  }
  return m.apps.backups.notAllowed;
}

/**
 * Backups of an application (ADR-0038): made by hand, restored into the same application after its name is typed.
 * Both stop the application, so both are confirmed in a dialog that says so. The list is the server's: a 202 only
 * refreshes the page, which then follows the operation. No destination, path or snapshot is ever shown.
 */
export function AppStackBackups({
  orgId,
  stackId,
  csrfToken,
  stackName,
  status,
  stale,
  actions,
  busy: held,
  backups,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  stackName: string;
  status: AppStackStatus;
  stale: boolean;
  /** `allowedActions` of the detail: the buttons follow it, never the status shown. */
  actions: readonly AppStackAllowedAction[];
  busy: boolean;
  backups: AppStackBackupsDto | null;
}) {
  const m = useMessages();
  const t = m.apps.backups;
  const locale = useLocale();
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (backups === null) return <p className={muted}>{m.apps.detail.sectionError}</p>;
  // Nothing to list and nothing to offer: one sentence says why.
  if (backups.unavailableReason !== null && backups.backups.length === 0) return <p className={muted}>{t.unavailable[backups.unavailableReason]}</p>;

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const when = (iso: string) => <time dateTime={iso}>{date.format(new Date(iso))}</time>;
  const offer = { actions, busy: held, status, stale };
  const block = appStackBackupBlock(m, backups, "stack.backup", offer);
  const restoreBlock = appStackBackupBlock(m, backups, "stack.restore", offer);
  const line = block ?? restoreBlock;
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}/backups`;
  const source = backups.backups.find((b) => b.id === restoring);
  // A restore left the data half written: the server names the safety backup that holds them whole.
  const goBack = backups.goBackTo === null ? undefined : backups.backups.find((b) => b.id === backups.goBackTo);

  function show(backupId: string | null) {
    setTyped("");
    setError(null);
    setCreating(backupId === null);
    setRestoring(backupId);
  }

  function close() {
    if (busy) return;
    setCreating(false);
    setRestoring(null);
  }

  async function send(name: string, url: string, body: object) {
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, name, "POST", url, body);
    setBusy(false);
    if (!sent.ok) {
      setError(appStackRefusalText(m, sent.code, sent.reason));
      return;
    }
    setCreating(false);
    setRestoring(null);
    router.refresh();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    await send("create", base, {});
  }

  async function restore(e: React.FormEvent) {
    e.preventDefault();
    if (!source || !canConfirmRestore(typed, stackName, busy)) return;
    // One key per backup: a retry after a lost answer replays, another backup is another request.
    await send(`restore:${source.id}`, `${base}/${source.id}/restore`, { confirmName: typed });
  }

  const failure = error && (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  return (
    <div className="space-y-3">
      <p className={muted}>{t.intro}</p>
      <p className={muted}>{t.stopNote}</p>
      <div className="space-y-2">
        <Button type="button" disabled={block !== null} aria-describedby={block !== null ? "app-backup-block" : undefined} onClick={() => show(null)}>
          {t.create}
        </Button>
        {line !== null && (
          <p id="app-backup-block" className={muted}>
            {line}
          </p>
        )}
      </div>
      {goBack && (
        <Alert variant="warning" role="status">
          <AlertDescription>{format(t.restoreFailedNote, { date: date.format(new Date(goBack.startedAt)) })}</AlertDescription>
        </Alert>
      )}
      {backups.backups.length === 0 ? (
        <p className={muted}>{t.none}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {backups.backups.map((b) => {
            const good = b.copies.filter((c) => c.status === "succeeded").length;
            const failedCopy = b.copies.find((c) => c.status === "failed");
            return (
              <li key={b.id} className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{when(b.startedAt)}</span>
                  <span>{t.kind[b.kind]}</span>
                  <Badge variant={APP_STACK_BACKUP_STATUS_TONE[b.status]}>{t.status[b.status]}</Badge>
                  {b.sizeBytes !== null && <span className="text-muted-foreground">{formatSize(b.sizeBytes, locale)}</span>}
                  {b.restorable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      disabled={restoreBlock !== null}
                      aria-describedby={restoreBlock !== null ? "app-backup-block" : undefined}
                      aria-label={format(t.restoreNamed, { date: date.format(new Date(b.startedAt)) })}
                      onClick={() => show(b.id)}
                    >
                      {t.restore}
                    </Button>
                  )}
                </div>
                {b.copies.length > 1 && <p className="text-muted-foreground">{format(t.copies, { good, total: b.copies.length })}</p>}
                {b.incompleteData && <p className="text-muted-foreground">{t.incompleteNote}</p>}
                {b.status === "failed" && <p className="text-destructive">{appStackBackupProblemText(m, b.problem)}</p>}
                {b.status === "partial" && (
                  <p className="text-muted-foreground">
                    {t.partialNote} {appStackBackupProblemText(m, failedCopy?.problem ?? b.problem)}
                  </p>
                )}
                {b.restore && (
                  <p className={b.restore.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                    {t.lastRestore[b.restore.status]}
                    {b.restore.at && <> · {when(b.restore.at)}</>}
                  </p>
                )}
                {b.restore?.status === "failed" && <p className="text-muted-foreground">{appStackBackupProblemText(m, b.restore.problem)}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <p className={muted}>{format(t.keptNote, { kept: MANUAL_BACKUPS_KEPT, safety: APP_STACK_PRE_RESTORE_BACKUPS_KEPT })}</p>
      <Dialog open={creating} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <form onSubmit={create} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t.createTitle}</DialogTitle>
              <DialogDescription>{t.createBody}</DialogDescription>
            </DialogHeader>
            {failure}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {m.apps.actions.cancel}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t.starting : t.createConfirm}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={source !== undefined} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          {source && (
            <form onSubmit={restore} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t.restoreTitle}</DialogTitle>
                <DialogDescription>{format(t.restoreBody, { date: date.format(new Date(source.startedAt)) })}</DialogDescription>
              </DialogHeader>
              <p className={muted}>{t.restoreFailNote}</p>
              <div className="space-y-2">
                <Label htmlFor="app-restore-name">{format(t.typeName, { name: stackName })}</Label>
                <Input id="app-restore-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" readOnly={busy} />
              </div>
              {failure}
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={close}>
                  {m.apps.actions.cancel}
                </Button>
                <Button type="submit" variant="destructive" disabled={!canConfirmRestore(typed, stackName, busy)}>
                  {busy ? t.starting : t.restoreConfirm}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
