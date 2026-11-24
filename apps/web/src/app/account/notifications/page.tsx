import Link from "next/link";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgNotifications } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CustomerTopBar } from "@/components/customer/top-bar";
import { NotificationSettings } from "@/components/shared/notification-settings";

export const dynamic = "force-dynamic";

/**
 * A customer's notifications: their own sites only (ADR-0040 N11). A server administrator has the server's
 * page, also during a support visit: the visit does not carry the permission to change a customer's channels.
 */
export default async function AccountNotificationsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (session.user.mustChangePassword) redirect("/account/change-password");
  if (session.user.isServerAdmin || session.activeConsole === "admin") redirect("/admin/notifications");

  const me = await fetchServerMe();
  const m = getMessages(await getRequestLocale());
  const t = m.notifications;
  const orgId = me?.memberships[0]?.organizationId ?? null;
  const settings = orgId ? await fetchServerOrgNotifications(orgId) : null;

  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <CustomerTopBar userName={session.user.name} csrfToken={session.csrfToken} />
      <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-6 py-8">
        <Link href="/account" className="text-sm text-muted-foreground hover:text-foreground">
          <span aria-hidden>← </span>
          {t.back}
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.intro}</p>
        </div>
        {settings?.ok ? (
          <NotificationSettings csrfToken={session.csrfToken} initial={settings.data} base={`/api/bff/orgs/${orgId}/notifications`} />
        ) : settings && settings.status === 403 ? (
          <Alert role="status">
            <AlertDescription>{t.notAllowed}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{m.shell.loadErrorBody}</AlertDescription>
          </Alert>
        )}
      </main>
    </div>
  );
}
