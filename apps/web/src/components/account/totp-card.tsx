"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";

type Setup = { secretBase32: string; otpauthUri: string };

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

export function TotpCard({
  csrfToken,
  enabled,
  canDisable,
}: {
  csrfToken: string;
  enabled: boolean;
  canDisable: boolean;
}) {
  const m = useMessages();
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(path: string, body?: unknown): Promise<unknown | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/account/totp/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) return data ?? {};
      const errCode: string = data?.error?.code ?? "";
      setError(errCode === "INVALID_CREDENTIALS" ? m.account.currentPasswordWrong : errorMessage(m, errCode));
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function start() {
    const data = (await call("setup")) as { data?: Setup } | null;
    if (data?.data) setSetup(data.data);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if ((await call("enable", { code })) === null) return;
    setSetup(null);
    setCode("");
    setNotice(m.account.totpEnabled);
    router.refresh();
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    if ((await call("disable", { password, code })) === null) return;
    setPassword("");
    setCode("");
    router.refresh();
  }

  const codeField = (
    <div className="space-y-2">
      <Label htmlFor="totp-code">{m.login.totp}</Label>
      <Input
        id="totp-code"
        value={code}
        onChange={(e) => setCode(digits(e.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        pattern="[0-9]{6}"
        required
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.account.totpTitle}</CardTitle>
        <CardDescription>{enabled ? m.account.totpOnHint : m.account.totpOffHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && (
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
            {notice}
          </p>
        )}

        {enabled && !canDisable && (
          <p className="text-sm text-muted-foreground">{m.account.totpAdminRequired}</p>
        )}

        {enabled && canDisable && (
          <form onSubmit={disable} className="space-y-4">
            <p className="text-sm text-muted-foreground">{m.account.totpDisableHint}</p>
            <div className="space-y-2">
              <Label htmlFor="totp-password">{m.login.password}</Label>
              <Input
                id="totp-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {codeField}
            <Button type="submit" variant="outline" disabled={busy}>
              {m.account.totpDisable}
            </Button>
          </form>
        )}

        {!enabled && !setup && (
          <Button type="button" onClick={start} disabled={busy}>
            {m.account.totpStart}
          </Button>
        )}

        {!enabled && setup && (
          <form onSubmit={confirm} className="space-y-4">
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li>
                <p>{m.account.totpStep1}</p>
                <p className="mt-2">
                  <a href={setup.otpauthUri} className="font-medium text-primary underline underline-offset-4">
                    {m.account.totpOpenLink}
                  </a>
                </p>
                <p className="mt-2 text-muted-foreground">{m.account.totpManual}</p>
                <p className="mt-1 font-mono text-base tracking-wider select-all break-all">
                  {setup.secretBase32.match(/.{1,4}/g)?.join(" ")}
                </p>
              </li>
              <li>{m.account.totpStep2}</li>
            </ol>
            {codeField}
            <Button type="submit" disabled={busy}>
              {m.account.totpConfirm}
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
