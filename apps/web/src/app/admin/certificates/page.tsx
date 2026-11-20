import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminDnsProvider } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { DnsProviderForm } from "@/components/admin/dns-provider-form";

export const dynamic = "force-dynamic";

export default async function AdminCertificatesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, settings] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminDnsProvider()]);
  const t = m.admin.certificates;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      {settings ? (
        <DnsProviderForm csrfToken={session.csrfToken} initial={settings} />
      ) : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{m.errors.generic}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
