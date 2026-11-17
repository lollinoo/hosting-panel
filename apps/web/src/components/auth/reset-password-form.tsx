"use client";

import { useEffect, useState } from "react";
import { PasswordResetConfirmInputSchema } from "@hosting-panel/contracts";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { LanguageSwitch } from "@/components/shared/language-switch";

// token: null until the fragment is read, "" when missing or refused.
type ResetState = { token: string | null; done: boolean; error: string | null };

// The done text replaces the form and its focused button: focus moves to it so a screen reader reads it.
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** Reads the token from the URL fragment and takes the fragment out of the address bar. */
export function takeFragmentToken(): string {
  const token = window.location.hash.slice(1);
  if (token) window.history.replaceState(null, "", window.location.pathname);
  // A token the confirm schema refuses (a link pasted with the words after it) is an invalid link, never sent.
  return PasswordResetConfirmInputSchema.shape.token.safeParse(token).success ? token : "";
}

/** Sends the token only in the body of the confirm call; returns the next state. */
export async function confirmReset(m: Messages, token: string, newPassword: string): Promise<ResetState> {
  try {
    const res = await fetch("/api/session/password-reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword }),
    });
    if (res.ok) return { token, done: true, error: null };
    const data = await res.json().catch(() => null);
    const code: string = data?.error?.code ?? "";
    if (code === "PASSWORD_RESET_INVALID") return { token: "", done: false, error: null };
    return { token, done: false, error: code === "VALIDATION_ERROR" ? m.account.passwordRule : errorMessage(m, code) };
  } catch {
    return { token, done: false, error: m.errors.generic };
  }
}

const linkClass = "block text-center text-sm text-primary underline underline-offset-4";

export function ResetPasswordView({
  token,
  done,
  error,
  busy,
  onSubmit,
}: ResetState & { busy: boolean; onSubmit: (e: React.FormEvent<HTMLFormElement>) => void }) {
  const m = useMessages();
  const t = m.login.reset;
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <>
            <p role="status" tabIndex={-1} ref={focusOnMount} className="text-sm outline-none">
              {t.done}
            </p>
            <Link href="/login" className={linkClass}>
              {t.signIn}
            </Link>
          </>
        ) : token === "" ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {m.errors.PASSWORD_RESET_INVALID}
            </p>
            <Link href="/forgot-password" className={linkClass}>
              {t.requestNew}
            </Link>
          </>
        ) : token !== null ? (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="reset-new">{m.account.newPassword}</Label>
              <Input
                id="reset-new"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={12}
                aria-describedby="reset-hint"
                required
                autoFocus
              />
              <p id="reset-hint" className="text-xs text-muted-foreground">
                {m.account.passwordRule}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-confirm">{m.account.confirmPassword}</Label>
              <Input id="reset-confirm" name="confirm" type="password" autoComplete="new-password" required />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {t.submit}
            </Button>
          </form>
        ) : null}
        <LanguageSwitch className="mt-6 justify-center" />
      </CardContent>
    </Card>
  );
}

export function ResetPasswordForm() {
  const m = useMessages();
  const [state, setState] = useState<ResetState>({ token: null, done: false, error: null });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = takeFragmentToken();
    // A second run (StrictMode) finds the fragment gone and keeps the token already read.
    setState((s) => ({ ...s, token: s.token || token }));
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    if (newPassword.length < 12) return setState((s) => ({ ...s, error: m.account.passwordRule }));
    if (newPassword !== form.get("confirm")) return setState((s) => ({ ...s, error: m.account.passwordMismatch }));
    setBusy(true);
    setState(await confirmReset(m, state.token ?? "", newPassword));
    setBusy(false);
  }

  return <ResetPasswordView {...state} busy={busy} onSubmit={submit} />;
}
