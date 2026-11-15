"use client";

import { useRef, useState } from "react";
import type { SiteWordpressStateDto, SiteWordpressUpdateRequest } from "@hosting-panel/contracts";
import { TempPasswordBody } from "@/components/admin/create-customer-dialog";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { pendingWordpressUpdates } from "@/lib/site-wordpress";

export type WordpressUpdateTarget = SiteWordpressUpdateRequest;
export type WordpressResetResult = { ok: true; temporaryPassword: string } | { ok: false; error: string };

// Title and body of an update confirmation, shown from the stored state (text only, never markup).
function updateTexts(
  t: ReturnType<typeof useMessages>["site"]["wordpress"],
  target: WordpressUpdateTarget,
  state: SiteWordpressStateDto,
): { title: string; body: string } {
  if (target.scope === "all") {
    return { title: t.update.titleAll, body: format(t.update.bodyAll, { count: pendingWordpressUpdates(state) }) };
  }
  const unknown = t.tables.unknown;
  if (target.scope === "core") {
    return {
      title: t.update.titleCore,
      body: format(t.update.bodyOne, {
        name: t.tables.core,
        from: state.coreVersion ?? unknown,
        to: state.coreUpdate ?? unknown,
      }),
    };
  }
  const list = target.scope === "plugin" ? state.plugins : state.themes;
  const item = list.find((i) => i.name === target.name);
  const name = item?.title || target.name;
  return {
    title: format(t.update.titleOne, { name }),
    body: format(t.update.bodyOne, { name, from: item?.version ?? unknown, to: item?.updateVersion ?? unknown }),
  };
}

// Title and body: Radix parts inside a dialog, plain markup elsewhere (static renders).
function Header({ title, body, inDialog }: { title: string; body: string; inDialog?: boolean }) {
  if (!inDialog) {
    return (
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    );
  }
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription>{body}</DialogDescription>
    </DialogHeader>
  );
}

/** Body of the update confirmation: what changes, the downtime and the copy taken first (or not). */
export function UpdateConfirmView({
  target,
  state,
  backupsConfigured,
  inDialog,
}: {
  target: WordpressUpdateTarget;
  state: SiteWordpressStateDto;
  backupsConfigured: boolean;
  inDialog?: boolean;
}) {
  const t = useMessages().site.wordpress;
  const { title, body } = updateTexts(t, target, state);
  return (
    <>
      <Header title={title} body={body} inDialog={inDialog} />
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t.update.downtime}</p>
        <p>{backupsConfigured ? t.update.backupTaken : t.update.backupNone}</p>
        <p>{t.update.noAutoRestore}</p>
      </div>
    </>
  );
}

/** Body of the reset confirmation: the old password stops working and the person is signed out. */
export function ResetConfirmView({ login, inDialog }: { login: string; inDialog?: boolean }) {
  const t = useMessages().site.wordpress.reset;
  return (
    <>
      <Header title={format(t.title, { login })} body={format(t.body, { login })} inDialog={inDialog} />
      <p className="text-sm text-muted-foreground">{t.once}</p>
    </>
  );
}

// Cancel and confirm row: Cancel first and focused, no form so Enter never confirms.
function ConfirmButtons(props: {
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  cancel: string;
  confirm: string;
  working: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button ref={props.cancelRef} type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
        {props.cancel}
      </Button>
      <Button type="button" onClick={props.onConfirm} disabled={props.busy}>
        {props.busy ? props.working : props.confirm}
      </Button>
    </div>
  );
}

/** Update confirmation; onConfirm resolves to null when started or to the error to show. */
export function WordpressUpdateDialog({
  open,
  onOpenChange,
  target,
  state,
  backupsConfigured,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: WordpressUpdateTarget;
  state: SiteWordpressStateDto;
  backupsConfigured: boolean;
  onConfirm: () => Promise<string | null>;
}) {
  const t = useMessages().site.wordpress.update;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const message = await onConfirm().catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (message !== null) setError(message);
  }

  return (
    <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, onOpenChange)}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <div className="space-y-4">
          <UpdateConfirmView target={target} state={state} backupsConfigured={backupsConfigured} inDialog />
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <ConfirmButtons
            cancelRef={cancelRef}
            busy={busy}
            cancel={t.cancel}
            confirm={target.scope === "all" ? t.confirmAll : t.confirm}
            working={t.starting}
            onCancel={() => onOpenChange(false)}
            onConfirm={() => void confirm()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Reset confirmation, then the new password shown once; it lives only in this dialog's state. */
export function WordpressResetDialog({
  open,
  onOpenChange,
  login,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  login: string;
  onConfirm: () => Promise<WordpressResetResult>;
}) {
  const t = useMessages().site.wordpress.reset;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const busyRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  function close(next: boolean) {
    if (!next) setPassword(null);
    onOpenChange(next);
  }

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const result = await onConfirm().catch((): WordpressResetResult => ({ ok: false, error: t.failed.unknown }));
    busyRef.current = false;
    setBusy(false);
    if (result.ok) setPassword(result.temporaryPassword);
    else setError(result.error);
  }

  return (
    <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, close)}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        {password !== null ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t.doneTitle}</DialogTitle>
              <DialogDescription>{t.once}</DialogDescription>
            </DialogHeader>
            <TempPasswordBody password={password} who={login} t={t.created} />
            <div className="flex justify-end">
              <Button type="button" onClick={() => close(false)}>
                {t.done}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <ResetConfirmView login={login} inDialog />
            {error ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <ConfirmButtons
              cancelRef={cancelRef}
              busy={busy}
              cancel={t.cancel}
              confirm={t.confirm}
              working={t.resetting}
              onCancel={() => close(false)}
              onConfirm={() => void confirm()}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
