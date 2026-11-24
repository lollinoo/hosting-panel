import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppStackUnavailable } from "@/components/admin/app-stack-unavailable";
import { TerminalConsole } from "@/components/admin/terminal-console";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminAppStack } from "@/lib/server-api";
import { getServerSession } from "@/lib/server-session";

export const dynamic = "force-dynamic";

/** The terminal in one component of a customer's application (ADR-0041); the component must be one the application has. */
export default async function AdminAppStackTerminalPage({ params }: { params: Promise<{ stackId: string; componentKey: string }> }) {
  const { stackId, componentKey } = await params;
  const session = await getServerSession();
  if (!session) redirect("/login");
  const m = getMessages(await getRequestLocale());
  const r = await fetchServerAdminAppStack(stackId);
  if (!r.ok) {
    if (r.outcome === "notFound") notFound();
    return <AppStackUnavailable m={m} code={r.code} />;
  }
  const stack = r.data;
  if (!stack.components.some((c) => c.key === componentKey)) notFound();
  const t = m.admin.appStack.terminal;
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/admin/apps/${stack.id}`} className="text-sm text-muted-foreground hover:underline">
          {format(t.back, { name: stack.name })}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">
          {format(t.title, { component: componentKey, name: stack.name, customer: stack.organizationName })}
        </h1>
      </div>
      <TerminalConsole component={{ stackId: stack.id, componentKey }} csrfToken={session.csrfToken} />
    </div>
  );
}
