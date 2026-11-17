"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { LanguageSwitch } from "@/components/shared/language-switch";

type ForgotState = { sent: boolean; error: string | null };

// The answer replaces the form and its focused button: focus moves to the answer so a screen reader reads it.
const focusOnMount = (el: HTMLElement | null) => el?.focus();

/** Asks for a link; every success reads the same, whatever address was typed. */
export async function requestResetLink(m: Messages, email: string): Promise<ForgotState> {
  try {
    const res = await fetch("/api/session/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) return { sent: true, error: null };
    const data = await res.json().catch(() => null);
    const code: string = data?.error?.code ?? "";
    // The only field: the API refused the form of the address (never whether an account exists).
    return { sent: false, error: code === "VALIDATION_ERROR" ? m.login.forgot.badEmail : errorMessage(m, code) };
  } catch {
    return { sent: false, error: m.errors.generic };
  }
}

export function ForgotPasswordView({
  sent,
  error,
  email,
  busy,
  onEmail,
  onSubmit,
}: ForgotState & { email: string; busy: boolean; onEmail: (v: string) => void; onSubmit: (e: React.FormEvent) => void }) {
  const m = useMessages();
  const t = m.login.forgot;
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        {!sent && <CardDescription>{t.intro}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        {sent ? (
          <div role="status" tabIndex={-1} ref={focusOnMount} className="space-y-3 text-sm outline-none">
            <p>{t.sent}</p>
            <p className="text-muted-foreground">{t.noMail}</p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">{t.email}</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                maxLength={254}
                value={email}
                onChange={(e) => onEmail(e.target.value)}
                required
                autoFocus
              />
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
        )}
        <Link href="/login" className="block text-center text-sm text-primary underline underline-offset-4">
          {t.back}
        </Link>
        <LanguageSwitch className="mt-6 justify-center" />
      </CardContent>
    </Card>
  );
}

export function ForgotPasswordForm() {
  const m = useMessages();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<ForgotState>({ sent: false, error: null });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const next = await requestResetLink(m, email);
    if (next.sent) setEmail("");
    setState(next);
    setBusy(false);
  }

  return <ForgotPasswordView {...state} email={email} busy={busy} onEmail={setEmail} onSubmit={submit} />;
}
