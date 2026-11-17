import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LoadError } from "@/components/shared/load-error";
import { TerminalConsole } from "@/components/admin/terminal-console";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminSites } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function AdminSiteTerminalPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");
  const m = getMessages(await getRequestLocale());
  const list = await fetchServerAdminSites();
  if (!list) return <LoadError m={m} />;
  const site = list.sites.find((s) => s.id === siteId);
  if (!site) notFound();
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/sites" className="text-sm text-muted-foreground hover:underline">
          {m.admin.terminal.back}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">{format(m.admin.terminal.title, { site: site.name })}</h1>
      </div>
      <TerminalConsole siteId={siteId} csrfToken={session.csrfToken} />
    </div>
  );
}
