import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminMailRelay } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MailRelayForm } from "@/components/admin/mail-relay-form";

export const dynamic = "force-dynamic";

export default async function AdminMailPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, settings] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminMailRelay()]);
  const t = m.admin.mail;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      {settings ? (
        <MailRelayForm csrfToken={session.csrfToken} initial={settings} adminEmail={session.user.email} />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
