"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { errorMessage, format } from "@/i18n";
import { useMessages } from "@/i18n/provider";

/** Shows a temporary password once. It lives only in the caller's state: never logged or stored. */
export function TempPasswordBody({ password, who }: { password: string; who: string }) {
  const t = useMessages().admin.users;
  const [copy, setCopy] = React.useState<"idle" | "done" | "unavailable">("idle");

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopy("done");
    } catch {
      setCopy("unavailable");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">{format(t.tempFor, { name: who })}</p>
      <div className="flex items-center gap-2">
        <code
          data-testid="temp-password"
          className="flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm"
        >
          {password}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copyPassword} className="gap-1.5">
          {copy === "done" ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
          {copy === "done" ? t.copied : t.copy}
        </Button>
      </div>
      <p role="status" className="text-xs text-destructive">
        {copy === "unavailable" ? t.copyUnavailable : ""}
      </p>
      <p className="text-sm text-muted-foreground">
        {t.tempNote} {t.tempOnce}
      </p>
    </div>
  );
}

export function CreateCustomerDialog({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.users;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [organizationName, setOrganizationName] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [ownerEmail, setOwnerEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [temp, setTemp] = React.useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) return;
    // Closing wipes the password; refreshing then hides this button, as a customer exists.
    const created = temp !== null;
    setTemp(null);
    setOrganizationName("");
    setOwnerName("");
    setOwnerEmail("");
    setError(null);
    if (created) router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/customer-account", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ organizationName, ownerEmail, ownerName }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body?.data?.temporaryPassword === "string") {
        setTemp(body.data.temporaryPassword);
      } else if (res.status === 409) {
        setError(t.conflict);
      } else {
        setError(errorMessage(m, body?.error?.code ?? ""));
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">{t.create}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{temp ? t.tempTitle : t.createTitle}</DialogTitle>
          <DialogDescription>{temp ? t.tempOnce : t.createHint}</DialogDescription>
        </DialogHeader>
        {temp ? (
          <>
            <TempPasswordBody password={temp} who={ownerName} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t.close}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-org">{t.orgName}</Label>
              <Input id="cc-org" required maxLength={120} value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-name">{t.ownerName}</Label>
              <Input id="cc-name" required maxLength={120} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-email">{t.ownerEmail}</Label>
              <Input id="cc-email" type="email" required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {t.createSubmit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
