"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMessages } from "@/i18n/provider";
import { firewallErrorText } from "@/lib/admin-firewall";
import { followRestart } from "@/lib/admin-restart";
import { updatesErrorText } from "@/lib/admin-updates";
import { keyedSend } from "@/lib/keyed-send";

type Phase = "running" | "succeeded" | "failed" | "unknown" | "signedOut";

/** A button that sends one admin action, optionally after a dialog, and follows the operation it starts to its end. */
export function ConfirmAction(p: {
  csrfToken: string; name: string; url: string; method?: "POST" | "DELETE"; body?: Record<string, unknown>;
  label: string; ariaLabel?: string; variant?: "default" | "outline" | "destructive"; disabled?: boolean;
  dialog?: { title: string; body: string; confirm: string };
  /** Which sentences explain a refusal; "firewall-base" is the apply button, whose NOT_FOUND is the host row. */
  errors: "firewall" | "firewall-base" | "updates";
  follow?: { ms: number; reload?: boolean; running: string; done: string; failed: string; unknown: string };
  runningOperationId?: string | null;
}) {
  const m = useMessages();
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const busyRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase | null>(p.runningOperationId && p.follow ? "running" : null);
  const { follow, runningOperationId } = p;
  const errorText = (code: string, reason?: string) =>
    p.errors === "updates" ? updatesErrorText(m, code, reason) : firewallErrorText(m, code, reason, p.errors === "firewall-base");

  async function track(operationId: string) {
    if (!follow) return;
    setPhase("running");
    const end = await followRestart(operationId, undefined, follow.ms);
    setPhase(end);
    // Only a known end reloads; an unknown or signed-out end keeps its sentence on screen.
    if (follow.reload && (end === "succeeded" || end === "failed")) window.location.reload();
    else router.refresh();
  }

  React.useEffect(() => {
    if (runningOperationId) void track(runningOperationId);
    // Resume once per running operation, not on every render.
  }, [runningOperationId]);

  async function send() {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, p.csrfToken, p.name, p.method ?? "POST", p.url, p.body ?? {});
    busyRef.current = false;
    setBusy(false);
    if (!sent.ok) {
      setError(errorText(sent.code, sent.reason));
      return;
    }
    setOpen(false);
    const operationId = (sent.data as { data?: { operationId?: string | null } } | null)?.data?.operationId;
    if (follow && operationId) void track(operationId);
    else router.refresh();
  }

  const status = phase === "running" ? follow?.running
    : phase === "succeeded" ? follow?.done
    : phase === "failed" ? follow?.failed
    : phase === "unknown" ? follow?.unknown
    : phase === "signedOut" ? errorText("UNAUTHENTICATED")
    : null;
  const blocked = p.disabled || busy || phase === "running";
  const button = (
    <Button type="button" size="sm" variant={p.variant ?? "outline"} disabled={blocked} aria-label={p.ariaLabel}
      onClick={() => {
        setError(null);
        if (p.dialog) setOpen(true);
        else void send();
      }}>
      {p.label}
    </Button>
  );

  return (
    <div className="space-y-1">
      {button}
      {p.dialog && (
        <Dialog open={open} onOpenChange={guardDialogClose(() => busyRef.current, setOpen)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{p.dialog.title}</DialogTitle>
              <DialogDescription>{p.dialog.body}</DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{m.common.cancel}</Button>
              <Button type="button" variant={p.variant === "destructive" ? "destructive" : "default"} disabled={busy} onClick={() => void send()}>
                {p.dialog.confirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {error && !open && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p role="status" className="text-xs text-muted-foreground">{status}</p>
    </div>
  );
}
