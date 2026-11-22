import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerMe } from "@/lib/server-api";
import { TemplatesTabs } from "@/components/admin/templates-tabs";

export const dynamic = "force-dynamic";

// The tabs exist only while application templates are on; otherwise the site-template pages render exactly as before.
export default async function AdminTemplatesLayout({ children }: { children: React.ReactNode }) {
  const me = await fetchServerMe();
  if (me?.platformCapabilities.applicationTemplatesAvailable !== true) return <>{children}</>;
  const m = getMessages(await getRequestLocale());
  return (
    <div className="space-y-6">
      <TemplatesTabs labels={m.admin.appTemplates.tabs} />
      {children}
    </div>
  );
}
