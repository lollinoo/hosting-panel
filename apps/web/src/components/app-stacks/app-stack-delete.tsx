"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appStackRefusalText } from "./app-stack-view";

export function canConfirmDelete(typed: string, name: string, busy: boolean): boolean {
  return typed === name && !busy;
}

export function AppStackDelete({
  orgId,
  stackId,
  csrfToken,
  stackName,
  hasData,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  stackName: string;
  hasData: boolean;
}) {
  const m = useMessages();
  const t = m.apps.delete;
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [destroyData, setDestroyData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [before, after] = t.body.split("{name}");

  function show() {
    setTyped("");
    setDestroyData(false);
    setError(null);
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canConfirmDelete(typed, stackName, busy)) return;
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, "delete", "DELETE", `/api/bff/orgs/${orgId}/app-stacks/${stackId}`, {
      confirmName: typed,
      destroyData,
    });
    if (sent.ok) {
      router.push("/apps");
      router.refresh();
      return;
    }
    setBusy(false);
    setError(appStackRefusalText(m, sent.code, sent.reason));
  }

  return (
    <>
      <Button type="button" variant="destructive" onClick={show}>
        {t.open}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && !busy && setOpen(false)}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t.title}</DialogTitle>
              <DialogDescription>
                {before}
                <strong>{stackName}</strong>
                {after}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="app-delete-name">{format(t.typeName, { name: stackName })}</Label>
              <Input id="app-delete-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" readOnly={busy} />
            </div>
            {hasData && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    id="app-delete-data"
                    type="checkbox"
                    checked={destroyData}
                    onChange={(e) => setDestroyData(e.target.checked)}
                    aria-describedby="app-delete-data-note"
                    disabled={busy}
                  />
                  <Label htmlFor="app-delete-data">{t.destroyData}</Label>
                </div>
                <p id="app-delete-data-note" className="text-sm text-muted-foreground">
                  {t.keepNote}
                </p>
                {destroyData && (
                  <p role="status" className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
                    {t.destroyWarning}
                  </p>
                )}
              </div>
            )}
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {m.apps.actions.cancel}
              </Button>
              <Button type="submit" variant="destructive" disabled={!canConfirmDelete(typed, stackName, busy)}>
                {busy ? t.deleting : destroyData ? t.confirmWithData : t.confirm}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
