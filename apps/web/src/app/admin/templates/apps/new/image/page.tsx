import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerMe } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppTemplateImageForm } from "@/components/admin/app-template-image-form";

export const dynamic = "force-dynamic";

/**
 * A new application template from one image (ADR-0043): the form writes the source, the usual editor validates and
 * saves it. The only upstream read is the capability; the software offered is the panel's own allowlist.
 */
export default async function NewAppTemplateFromImagePage() {
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
        <h1 className="text-2xl font-bold tracking-tight">{t.imageForm.title}</h1>
      </div>
      <AppTemplateImageForm
        csrfToken={session.csrfToken}
        repositories={APP_IMAGE_ALLOWLIST.map((row) => row.repository)}
        categories={Object.keys(t.category)}
      />
    </div>
  );
}
