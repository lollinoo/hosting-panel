import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMessages, format } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminSiteTemplate, fetchServerAdminSiteTemplateVersion } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";
import { Button } from "@/components/ui/button";
import { SiteTemplateEditor } from "@/components/admin/site-template-editor";
import { LoadError } from "@/components/shared/load-error";

export const dynamic = "force-dynamic";

/** A new version of a template, starting from one of its versions (`?version=`, the default one without it). */
export default async function EditSiteTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams?: Promise<{ version?: string | string[] }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { templateId } = await params;
  const version = (await searchParams)?.version;
  const m = await getRequestLocale().then(getMessages);
  const t = m.admin.templates;

  const detail = await fetchServerAdminSiteTemplate(templateId);
  if (!detail.ok && detail.outcome === "notFound") notFound();
  const base = detail.ok
    ? await fetchServerAdminSiteTemplateVersion(
        templateId,
        typeof version === "string" && version !== "" ? version : detail.data.defaultVersionId,
      )
    : null;
  if (!detail.ok || !base) return <LoadError m={m} />;
  const template = detail.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {/* Back to this template, so the link is named after it. */}
        <Button asChild variant="outline" size="icon" className="h-8 w-8">
          <Link href={`/admin/templates/${template.id}`} aria-label={template.name} title={template.name}>
            <ArrowLeft aria-hidden className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{format(t.editor.versionTitle, { name: template.name })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{format(t.editor.baseVersion, { version: base.versionNumber })}</p>
        </div>
      </div>
      <SiteTemplateEditor
        key={base.id}
        csrfToken={session.csrfToken}
        module={template.module}
        initialSource={base.source}
        target={{ kind: "version", templateId: template.id, archived: template.archivedAt !== null }}
      />
    </div>
  );
}
