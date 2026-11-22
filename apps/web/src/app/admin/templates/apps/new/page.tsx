import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { AppTemplateEditor } from "@/components/admin/app-template-editor";

export const dynamic = "force-dynamic";

/** A new application template, starting from the catalog's skeleton; no upstream read. */
export default async function NewAppTemplatePage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const t = (await getRequestLocale().then(getMessages)).admin.appTemplates;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/admin/templates/apps" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          {t.back}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{t.create}</h1>
      </div>
      <AppTemplateEditor csrfToken={session.csrfToken} target={{ kind: "create" }} initialSource={t.editor.starter} />
    </div>
  );
}
