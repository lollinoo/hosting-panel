import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminNotifications } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { NotificationSettings } from "@/components/shared/notification-settings";

export const dynamic = "force-dynamic";

/** The server's notifications: every kind of alert of the Health page (ADR-0040 N11). */
export default async function AdminNotificationsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, settings] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminNotifications()]);
  const t = m.notifications;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{m.admin.notifications.intro}</p>
      </div>
      {settings ? (
        <NotificationSettings csrfToken={session.csrfToken} initial={settings} base="/api/admin/notifications" />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
