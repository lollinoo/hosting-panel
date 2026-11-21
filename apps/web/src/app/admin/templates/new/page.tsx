import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { BUILT_IN_WORDPRESS_SOURCE } from "@hosting-panel/contracts";
import { getMessages, format } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminSiteTemplate, fetchServerAdminSiteTemplateVersion } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";
import { Button } from "@/components/ui/button";
import { SiteTemplateEditor } from "@/components/admin/site-template-editor";
import { LoadError } from "@/components/shared/load-error";

export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);

/** A new template: the built-in WordPress definition to start from, or a copy of a version (`?from=` and `?version=`). */
export default async function NewSiteTemplatePage({
  searchParams,
}: {
  searchParams?: Promise<{ from?: string | string[]; version?: string | string[] }>;
} = {}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const query = (await searchParams) ?? {};
  const from = one(query.from);
  const m = await getRequestLocale().then(getMessages);
  const t = m.admin.templates;

  let start = { module: "wordpress" as const, name: "", description: "", source: BUILT_IN_WORDPRESS_SOURCE };
  if (from) {
    const detail = await fetchServerAdminSiteTemplate(from);
    const base = detail.ok
      ? await fetchServerAdminSiteTemplateVersion(from, one(query.version) ?? detail.data.defaultVersionId)
      : null;
    if (!detail.ok || !base) return <LoadError m={m} />;
    start = {
      module: detail.data.module,
      // The editor's name field stops at 80 characters, so a copy of a long name is cut to fit.
      name: format(t.editor.duplicateName, { name: detail.data.name }).slice(0, 80),
      description: detail.data.description ?? "",
      source: base.source,
    };
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="outline" size="icon" className="h-8 w-8">
          <Link href="/admin/templates" aria-label={t.back} title={t.back}>
            <ArrowLeft aria-hidden className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">{t.editor.newTitle}</h1>
      </div>
      <SiteTemplateEditor
        // A copy of another version is a different editor: its text must not carry over.
        key={`${from ?? ""}:${one(query.version) ?? ""}`}
        csrfToken={session.csrfToken}
        module={start.module}
        initialSource={start.source}
        target={{ kind: "create", name: start.name, description: start.description }}
      />
    </div>
  );
}
