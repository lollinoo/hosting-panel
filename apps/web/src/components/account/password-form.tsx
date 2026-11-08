"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";

/** Change-password fields; `onDone` runs after the server accepted the new password. */
export function PasswordForm({
  csrfToken,
  onDone,
  autoFocus,
}: {
  csrfToken: string;
  onDone: () => void;
  autoFocus?: boolean;
}) {
  const m = useMessages();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 12) return setError(m.account.passwordRule);
    if (newPassword !== confirm) return setError(m.account.passwordMismatch);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirm("");
        onDone();
        return;
      }
      const data = await res.json().catch(() => null);
      const code: string = data?.error?.code ?? "";
      setError(
        code === "INVALID_CREDENTIALS"
          ? m.account.currentPasswordWrong
          : code === "VALIDATION_ERROR"
            ? m.account.passwordRule
            : errorMessage(m, code),
      );
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current">{m.account.currentPassword}</Label>
        <Input
          id="current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          autoFocus={autoFocus}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new">{m.account.newPassword}</Label>
        <Input
          id="new"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={12}
          aria-describedby="new-hint"
          required
        />
        <p id="new-hint" className="text-xs text-muted-foreground">
          {m.account.passwordRule}
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{m.account.confirmPassword}</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {m.account.changePasswordSubmit}
      </Button>
    </form>
  );
}

export function AccountPasswordCard({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.account.passwordTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <PasswordForm csrfToken={csrfToken} onDone={() => setSaved(true)} />
        {saved && (
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
            {m.account.passwordSaved}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
