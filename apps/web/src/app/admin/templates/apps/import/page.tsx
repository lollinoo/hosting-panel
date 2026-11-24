import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerMe } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppTemplateComposeImport } from "@/components/admin/app-template-compose-import";

export const dynamic = "force-dynamic";

/** A new application template from a pasted Compose file; the only upstream read is the capability. */
export default async function ImportAppTemplatePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, me] = await Promise.all([getRequestLocale().then(getMessages), fetchServerMe()]);
  const t = m.admin.appTemplates;
  if (me?.platformCapabilities.applicationTemplatesAvailable !== true)
    return (
      <Alert variant="warning" role="status">
        <AlertDescription>{t.notAvailable}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/templates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          {t.back}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{t.importer.title}</h1>
        <p className="text-sm text-muted-foreground">{t.importer.subtitle}</p>
      </div>
      <AppTemplateComposeImport csrfToken={session.csrfToken} />
    </div>
  );
}
