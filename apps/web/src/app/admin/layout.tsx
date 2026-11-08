import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe } from "@/lib/server-api";
import { Header } from "@/components/layout/header";
import { SidebarNav } from "@/components/layout/sidebar-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const isInfra = session.user.globalRoles.includes("infrastructure_admin");
  const isHosting = session.user.globalRoles.includes("hosting_admin");
  if (!isInfra && !isHosting) {
    redirect("/");
  }

  const me = await fetchServerMe();

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header
        session={{
          authenticated: true,
          csrfToken: session.csrfToken,
          activeConsole: "admin",
          activeOrgSlug: session.activeOrgSlug,
          user: session.user,
          memberships: me?.memberships || [],
          platformCapabilities: me?.platformCapabilities,
        }}
      />
      <div className="flex flex-1">
        <SidebarNav consoleContext="infra" />
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
