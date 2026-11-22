import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminAppTemplate, fetchServerAdminAppTemplateUsage } from "@/lib/server-api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/shared/load-error";
import { APP_TEMPLATE_STATE_BADGE } from "@/components/admin/app-template-list";
import { AppTemplateDetail } from "@/components/admin/app-template-detail";

export const dynamic = "force-dynamic";

export default async function AdminAppTemplatePage({ params }: { params: Promise<{ templateId: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { templateId } = await params;
  const [m, r, usage] = await Promise.all([
    getRequestLocale().then(getMessages),
    fetchServerAdminAppTemplate(templateId),
    fetchServerAdminAppTemplateUsage(templateId),
  ]);
  const t = m.admin.appTemplates;
  if (!r.ok) {
    if (r.outcome === "notFound") notFound();
    if (r.code === "NOT_SUPPORTED")
      return (
        <Alert variant="warning" role="status">
          <AlertDescription>{t.notAvailable}</AlertDescription>
        </Alert>
      );
    return <LoadError m={m} />;
  }
  const template = r.data;

  return (
    <div className="space-y-6">
      <Link href="/admin/templates/apps" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {t.back}
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{template.name}</h1>
          <Badge variant={APP_TEMPLATE_STATE_BADGE[template.state]}>{t.state[template.state]}</Badge>
        </div>
        <p className="font-mono text-sm text-muted-foreground mt-1">{template.slug}</p>
        {template.description && <p className="text-sm text-muted-foreground mt-1">{template.description}</p>}
      </div>
      <AppTemplateDetail template={template} usage={usage.ok ? usage.data : null} csrfToken={session.csrfToken} />
    </div>
  );
}
