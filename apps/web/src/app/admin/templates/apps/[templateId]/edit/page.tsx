import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminAppTemplate, fetchServerAdminAppTemplateVersion } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AppIssueList, AppTemplateEditor } from "@/components/admin/app-template-editor";
import { LoadError } from "@/components/shared/load-error";

export const dynamic = "force-dynamic";

/** A new version of an application template, starting from one of its versions (`?version=`, the default one without it). */
export default async function EditAppTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams?: Promise<{ version?: string | string[] }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { templateId } = await params;
  const query = (await searchParams)?.version;
  const m = await getRequestLocale().then(getMessages);
  const t = m.admin.appTemplates;

  const detail = await fetchServerAdminAppTemplate(templateId);
  if (!detail.ok && detail.outcome === "notFound") notFound();
  if (!detail.ok && detail.code === "NOT_SUPPORTED")
    return (
      <Alert variant="warning" role="status">
        <AlertDescription>{t.notAvailable}</AlertDescription>
      </Alert>
    );
  const baseId = detail.ok
    ? typeof query === "string" && query !== ""
      ? query
      : (detail.data.defaultVersionId ?? detail.data.versions[0]?.id)
    : undefined;
  const base = detail.ok && baseId ? await fetchServerAdminAppTemplateVersion(templateId, baseId) : null;
  if (!detail.ok || !base?.ok) return <LoadError m={m} />;
  const template = detail.data;
  const version = base.data;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/templates/apps" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          {t.back}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{template.name}</h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-mono">{template.slug}</span> · {format(t.versionLabel, { n: version.versionNumber })}
        </p>
      </div>
      {!version.valid && (
        <Alert variant="warning" role="status">
          <AlertDescription>
            <p>{t.editor.storedInvalid}</p>
            <AppIssueList issues={version.issues} />
          </AlertDescription>
        </Alert>
      )}
      <AppTemplateEditor
        key={version.id}
        csrfToken={session.csrfToken}
        target={{ kind: "version", templateId: template.id, archived: template.archivedAt !== null }}
        initialSource={version.source}
      />
    </div>
  );
}
