"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/provider";

/** `onConfirm` resolves to null on success or to a message to show; the caller decides where to go next. */
export type ConfirmDelete = (confirmName: string) => Promise<string | null>;

export function DeleteSiteForm({
  siteName,
  onConfirm,
  onCancel,
}: {
  siteName: string;
  onConfirm: ConfirmDelete;
  onCancel: () => void;
}) {
  const t = useMessages().site.delete;
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [before, after] = t.body.split("{name}");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const message = await onConfirm(typed);
    if (message !== null) {
      setError(message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t.title}</DialogTitle>
        <DialogDescription>
          {before}
          <strong>{siteName}</strong>
          {after}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="delete-site-name">{t.typeName.replace("{name}", siteName)}</Label>
        <Input id="delete-site-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
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
        <Button type="submit" variant="destructive" disabled={busy || typed !== siteName}>
          {busy ? t.deleting : t.confirm}
        </Button>
      </div>
    </form>
  );
}

export function DeleteSiteDialog({
  siteName,
  open,
  onOpenChange,
  onConfirm,
}: {
  siteName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: ConfirmDelete;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DeleteSiteForm siteName={siteName} onConfirm={onConfirm} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
