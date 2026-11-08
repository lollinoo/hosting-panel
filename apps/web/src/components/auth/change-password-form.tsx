"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PasswordForm } from "@/components/account/password-form";
import { useMessages } from "@/i18n/provider";

export function ChangePasswordForm({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  const [leaving, setLeaving] = React.useState(false);

  // The way out of the forced screen: same logout as the shells, then a hard navigation to /login.
  async function logout() {
    setLeaving(true);
    try {
      await fetch("/api/session/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{m.account.changePasswordTitle}</CardTitle>
        <CardDescription>{m.account.changePasswordHint}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Hard navigation: the root layout (and its locale) must re-render with the updated session. */}
        <PasswordForm csrfToken={csrfToken} autoFocus onDone={() => window.location.assign("/")} />
        <Button type="button" variant="ghost" className="mt-4 w-full" onClick={logout} disabled={leaving}>
          {m.common.logout}
        </Button>
      </CardContent>
    </Card>
  );
}
