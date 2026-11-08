"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { LanguageSwitch } from "@/components/shared/language-switch";

export function LoginForm() {
  const m = useMessages();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, totpCode: needsTotp ? totpCode : undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorMessage(m, data?.error?.code ?? ""));
      } else if (data.status === "totp_required") {
        setNeedsTotp(true);
      } else {
        // Hard navigation: the root layout (and its locale) must re-render for the signed-in user.
        window.location.assign("/");
      }
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{m.login.title}</CardTitle>
        {needsTotp && <CardDescription>{m.login.totpHint}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          {needsTotp ? (
            <div className="space-y-2">
              <Label htmlFor="totp">{m.login.totp}</Label>
              <Input
                id="totp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                required
                autoFocus
              />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="email">{m.login.email}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{m.login.password}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {needsTotp ? m.login.verify : m.login.submit}
          </Button>
          {needsTotp && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setNeedsTotp(false);
                setTotpCode("");
                setPassword("");
                setError(null);
              }}
            >
              {m.login.back}
            </Button>
          )}
        </form>
        <LanguageSwitch className="mt-6 justify-center" />
      </CardContent>
    </Card>
  );
}
