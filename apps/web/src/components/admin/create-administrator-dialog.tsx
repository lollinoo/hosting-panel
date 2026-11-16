"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { CreateAdministratorResultDto } from "@hosting-panel/contracts";
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
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { TotpKey } from "@/components/account/totp-card";
import { TempPasswordBody } from "./create-customer-dialog";

/** The temporary password and the two-factor key of a new administrator, shown once. */
export function AdministratorCreatedBody({ result, name }: { result: CreateAdministratorResultDto; name: string }) {
  const t = useMessages().admin.users;
  return (
    <div className="space-y-4">
      <TempPasswordBody password={result.temporaryPassword} who={name} t={{ ...t, tempNote: t.administrators.tempNote }} />
      <div className="text-sm">
        <p className="font-medium">{t.administrators.totpTitle}</p>
        <TotpKey secretBase32={result.totpSecretBase32} otpauthUri={result.otpauthUri} />
        <p className="mt-2 text-muted-foreground">{t.administrators.totpNote}</p>
      </div>
    </div>
  );
}

export function CreateAdministratorDialog({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.users;
  const a = t.administrators;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CreateAdministratorResultDto | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) return;
    // Closing wipes the password and the key from state.
    const created = result !== null;
    setResult(null);
    setName("");
    setEmail("");
    setError(null);
    if (created) router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/administrators", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ email, name }),
      });
      const body = await res.json().catch(() => null);
      const data = body?.data;
      const code: string = body?.error?.code ?? "";
      if (res.ok && [data?.temporaryPassword, data?.totpSecretBase32, data?.otpauthUri].every((v) => typeof v === "string")) {
        setResult(data);
      } else setError(code === "VALIDATION_ERROR" ? a.invalid : errorMessage(m, code));
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {a.create}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? t.tempTitle : a.title}</DialogTitle>
          <DialogDescription>{result ? t.tempOnce : a.hint}</DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <AdministratorCreatedBody result={result} name={name} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t.close}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ca-name">{a.name}</Label>
              <Input id="ca-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ca-email">{a.email}</Label>
              <Input id="ca-email" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={busy}>
                {a.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
