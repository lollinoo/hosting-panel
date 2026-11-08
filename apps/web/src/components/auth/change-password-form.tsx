"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PasswordForm } from "@/components/account/password-form";
import { useMessages } from "@/i18n/provider";

export function ChangePasswordForm({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{m.account.changePasswordTitle}</CardTitle>
        <CardDescription>{m.account.changePasswordHint}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Hard navigation: the root layout (and its locale) must re-render with the updated session. */}
        <PasswordForm csrfToken={csrfToken} autoFocus onDone={() => window.location.assign("/")} />
      </CardContent>
    </Card>
  );
}
