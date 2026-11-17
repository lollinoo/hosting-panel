"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RESTART_REASON_MAX_LENGTH } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { followRestart, restartErrorText, restartName, restartUrl, restartWarning, type RestartTarget } from "@/lib/admin-restart";
import { keyedSend } from "@/lib/keyed-send";

const targetKey = (t: RestartTarget) => (t.kind === "part" ? `part-${t.component}` : `site-${t.siteId}`);

/** The dialog's form: `onConfirm` resolves to null on success or to the message to show. */
export function RestartForm({
  target,
  onConfirm,
  onCancel,
}: {
  target: RestartTarget;
  onConfirm: (reason: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const m = useMessages();
  const r = m.admin.health.restart;
  const name = restartName(m, target);
  const id = `restart-reason-${targetKey(target)}`;
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return setError(r.reasonRequired);
    setBusy(true);
    setError(null);
    const message = await onConfirm(reason.trim());
    setBusy(false);
    if (message !== null) setError(message);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{format(r.title, { name })}</DialogTitle>
        <DialogDescription>{restartWarning(m, target)}</DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor={id}>{r.reasonLabel}</Label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} required
          maxLength={RESTART_REASON_MAX_LENGTH} autoFocus aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{r.reasonHint}</p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>{m.common.cancel}</Button>
        <Button type="submit" variant="destructive" disabled={busy}>{busy ? r.working : r.confirm}</Button>
      </DialogFooter>
    </form>
  );
}

/** Restart button of a Health row: asks for a reason, then follows the restart in the cell. */
export function RestartButton({ target, csrfToken }: { target: RestartTarget; csrfToken: string }) {
  const m = useMessages();
  const r = m.admin.health.restart;
  const name = restartName(m, target);
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const busyRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<"accepted" | "succeeded" | "failed" | "unknown" | null>(null);

  async function confirm(reason: string): Promise<string | null> {
    busyRef.current = true;
    const sent = await keyedSend(keys.current, csrfToken, `restart:${targetKey(target)}:${reason}`, "POST", restartUrl(target), { reason });
    busyRef.current = false;
    if (!sent.ok) return restartErrorText(m, name, sent.code);
    setOpen(false);
    setPhase("accepted");
    void follow((sent.data as { data?: { operationId?: string } } | null)?.data?.operationId);
    return null;
  }

  async function follow(operationId: string | undefined) {
    setPhase(operationId ? await followRestart(operationId) : "unknown");
    router.refresh();
  }

  const status = phase === "accepted" ? r.accepted
    : phase === "succeeded" ? format(r.done, { name })
    : phase === "failed" ? format(r.failed, { name })
    : phase === "unknown" ? format(r.unknown, { name })
    : null;

  return (
    <div className="space-y-1">
      <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, setOpen)}>
        <DialogTrigger asChild>
          {/* Focusable while followed so the dialog can give focus back; the click is cancelled before Radix opens. */}
          <Button type="button" size="sm" variant="outline" className="aria-disabled:opacity-50" aria-disabled={phase === "accepted"}
            onClick={(e) => phase === "accepted" && e.preventDefault()} aria-label={format(r.buttonLabel, { name })}>
            {r.button}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <RestartForm target={target} onConfirm={confirm} onCancel={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
      <p role="status" className="text-xs text-muted-foreground">{status}</p>
    </div>
  );
}
