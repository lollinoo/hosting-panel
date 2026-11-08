import Link from "next/link";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgSites } from "@/lib/server-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerTopBar } from "@/components/customer/top-bar";
import { AccountPasswordCard } from "@/components/account/password-form";
import { TotpCard } from "@/components/account/totp-card";
import { LanguageSwitch } from "@/components/shared/language-switch";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword) redirect("/account/change-password");

  const isAdmin = session.user.isServerAdmin || session.activeConsole === "admin";
  const me = await fetchServerMe();
  const orgId = me?.memberships[0]?.organizationId;
  const sites = (!isAdmin && orgId ? await fetchServerOrgSites(orgId) : []) ?? [];
  const m = getMessages(await getRequestLocale());

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      {!isAdmin && (
        <CustomerTopBar
          sites={sites.map((s) => ({ id: s.id, name: s.name }))}
          userName={session.user.name}
          csrfToken={session.csrfToken}
        />
      )}
      <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-6 py-8">
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
          <span aria-hidden>← </span>
          {m.account.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{m.account.title}</h1>
        <AccountPasswordCard csrfToken={session.csrfToken} />
        {/* No 2FA controls without knowing its real state (a dead session already redirected to login). */}
        {me ? (
          <TotpCard
            csrfToken={session.csrfToken}
            enabled={me.user.totpEnabled}
            canDisable={!session.user.isServerAdmin}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{m.account.totpTitle}</CardTitle>
            </CardHeader>
            <CardContent>
              <p role="alert" className="text-sm text-muted-foreground">
                {m.account.loadError}
              </p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>{m.account.languageTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <LanguageSwitch csrfToken={session.csrfToken} className="text-sm" />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
