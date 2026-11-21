import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminSiteTemplate } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/shared/load-error";
import { STATUS_BADGE_VARIANT, templateStatusKeys } from "@/components/admin/site-template-list";
import { SiteTemplateDetail } from "@/components/admin/site-template-detail";

export const dynamic = "force-dynamic";

export default async function AdminTemplatePage({ params }: { params: Promise<{ templateId: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { templateId } = await params;
  const [m, res] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSiteTemplate(templateId)]);
  if (!res.ok) {
    if (res.outcome === "notFound") notFound();
    return <LoadError m={m} />;
  }
  const template = res.data;
  const t = m.admin.templates;

  return (
    <div className="space-y-6">
      <Link href="/admin/templates" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {t.back}
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{template.name}</h1>
          {templateStatusKeys(template).map((key) => (
            <Badge key={key} variant={STATUS_BADGE_VARIANT[key]}>{t.status[key]}</Badge>
          ))}
        </div>
        {template.description && <p className="text-sm text-muted-foreground mt-1">{template.description}</p>}
      </div>
      <SiteTemplateDetail template={template} csrfToken={session.csrfToken} />
    </div>
  );
}
