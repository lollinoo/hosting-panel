import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminBackups, fetchServerAdminBackupSites } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BackupSettings } from "@/components/admin/backup-settings";

export const dynamic = "force-dynamic";

/** Renders the server administrator's backup destination, test, and per-site status page. */
export default async function AdminBackupsPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, settings, sites] = await Promise.all([
    getRequestLocale().then(getMessages),
    fetchServerAdminBackups(),
    fetchServerAdminBackupSites(),
  ]);
  const t = m.admin.backups;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      {settings ? (
        <BackupSettings csrfToken={session.csrfToken} initial={settings} sites={sites} />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
