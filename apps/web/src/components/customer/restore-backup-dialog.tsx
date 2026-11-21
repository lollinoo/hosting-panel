"use client";

import { useRef, useState, type RefObject } from "react";
import type { SiteBackupDto } from "@hosting-panel/contracts";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatDate } from "@/lib/file-browser";

/**
 * Resolves to null on success (202 started) or to an inline error message to display.
 * `targetId` is given only when the backup has more than one restorable copy.
 */
export type ConfirmRestoreBackup = (confirmName: string, targetId?: string) => Promise<string | null>;

/** A copy the customer can restore from; the label is the neutral destination name. */
export interface RestoreSourceOption {
  targetId: string;
  label: string;
}

/** Texts the dialog shows; the customer's catalog block is the default. */
export type RestoreDialogTexts = Pick<
  Messages["site"]["backups"]["restore"],
  "title" | "body" | "unavailable" | "lostDatabases" | "backupFirst" | "typeName" | "cancel" | "starting" | "confirm"
>;

/**
 * Checks whether the typed confirmation matches the site's exact name.
 */
export function canConfirmRestore(typed: string, siteName: string): boolean {
  return siteName.length > 0 && typed === siteName;
}

/**
 * Renders the restore confirmation body, typed-name check, and explicit action buttons.
 *
 * Uses a plain container instead of `<form>` so pressing Enter never submits the
 * destructive restore; Cancel carries `autoFocus`.
 */
export function RestoreBackupForm({
  backup,
  siteName,
  onConfirm,
  onCancel,
  cancelButtonRef,
  onBusyChange,
  texts,
  copies,
}: {
  backup: Pick<SiteBackupDto, "id" | "startedAt">;
  siteName: string;
  onConfirm: ConfirmRestoreBackup;
  onCancel: () => void;
  cancelButtonRef?: RefObject<HTMLButtonElement | null>;
  onBusyChange?: (busy: boolean) => void;
  texts?: RestoreDialogTexts;
  copies?: RestoreSourceOption[];
}) {
  const customer = useMessages().site.backups.restore;
  const t = texts ?? customer;
  const locale = useLocale();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const [source, setSource] = useState<string | null>(null);
  const choosable = copies && copies.length > 1 ? copies : null;
  const selected = choosable ? (source ?? choosable[0]?.targetId) : undefined;

  const dateText = formatDate(backup.startedAt, locale);
  const [beforeName, afterName] = t.typeName.split("{name}");

  async function handleConfirm() {
    if (inFlightRef.current || busy || !canConfirmRestore(typed, siteName)) return;
    inFlightRef.current = true;
    onBusyChange?.(true);
    setBusy(true);
    setError(null);

    try {
      const message = await (selected === undefined ? onConfirm(typed) : onConfirm(typed, selected));
      if (message !== null) {
        setError(message);
        setBusy(false);
      }
    } catch {
      setBusy(false);
    } finally {
      inFlightRef.current = false;
      onBusyChange?.(false);
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{format(t.title, { date: dateText })}</DialogTitle>
        <DialogDescription>{format(t.body, { date: dateText })}</DialogDescription>
      </DialogHeader>

      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t.unavailable}</p>
        <p>{t.lostDatabases}</p>
        <p>{t.backupFirst}</p>
      </div>

      {choosable ? (
        <fieldset className="space-y-1.5" disabled={busy}>
          <legend className="text-sm font-medium">{customer.fromLabel}</legend>
          {choosable.map((c) => (
            <label key={c.targetId} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="restore-source"
                value={c.targetId}
                checked={selected === c.targetId}
                onChange={() => setSource(c.targetId)}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
      ) : copies?.length === 1 ? (
        <p className="text-sm">
          {customer.fromLabel}: <strong>{copies[0]!.label}</strong>
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="restore-site-name">
          {beforeName}
          <strong>{siteName}</strong>
          {afterName}
        </Label>
        <Input
          id="restore-site-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            // Keep Enter inert so a mistyped Enter cannot trigger or close unexpectedly.
            if (e.key === "Enter") {
              e.preventDefault();
            }
          }}
          autoComplete="off"
          disabled={busy}
        />
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          ref={cancelButtonRef}
          type="button"
          variant="outline"
          autoFocus
          onClick={onCancel}
          disabled={busy}
        >
          {t.cancel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy || !canConfirmRestore(typed, siteName)}
          onClick={() => void handleConfirm()}
        >
          {busy ? t.starting : t.confirm}
        </Button>
      </div>
    </div>
  );
}

/**
 * Confirmation modal for restoring a site back to a chosen backup.
 *
 * Purpose: focus Cancel initially, guard against Escape/backdrop close while
 * submitting, and gate confirmation behind typing the exact site name.
 */
export function RestoreBackupDialog({
  backup,
  siteName,
  open,
  onOpenChange,
  onConfirm,
  texts,
  copies,
}: {
  backup: Pick<SiteBackupDto, "id" | "startedAt"> | null;
  siteName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: ConfirmRestoreBackup;
  texts?: RestoreDialogTexts;
  copies?: RestoreSourceOption[];
}) {
  const busyRef = useRef(false);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open && backup !== null}
      onOpenChange={guardDialogClose(() => busyRef.current, onOpenChange)}
    >
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelButtonRef.current?.focus();
        }}
      >
        {backup ? (
          <RestoreBackupForm
            key={backup.id}
            backup={backup}
            siteName={siteName}
            onConfirm={onConfirm}
            texts={texts}
            copies={copies}
            onCancel={() => onOpenChange(false)}
            cancelButtonRef={cancelButtonRef}
            onBusyChange={(busy) => {
              busyRef.current = busy;
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
