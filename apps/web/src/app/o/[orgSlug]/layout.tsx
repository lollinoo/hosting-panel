import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrg } from "@/lib/server-api";
import { Header } from "@/components/layout/header";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Ban } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const me = await fetchServerMe();
  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const isGlobalAdmin =
    session.user.globalRoles.includes("infrastructure_admin") ||
    session.user.globalRoles.includes("hosting_admin");

  if (!membership && !isGlobalAdmin) {
    redirect("/");
  }

  const orgId = membership?.organizationId || orgSlug;
  const org = await fetchServerOrg(orgId);
  const isSuspended =
    membership?.organizationStatus === "suspended" || org?.status === "suspended";

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header
        session={{
          authenticated: true,
          csrfToken: session.csrfToken,
          activeConsole: "customer",
          activeOrgSlug: orgSlug,
          user: session.user,
          memberships: me?.memberships || [],
          platformCapabilities: me?.platformCapabilities,
        }}
      />
      <div className="flex flex-1">
        <SidebarNav consoleContext="org" orgSlug={orgSlug} />
        <main className="flex-1 p-8 overflow-y-auto space-y-6">
          {isSuspended && (
            <Alert variant="destructive">
              <Ban className="h-4 w-4" />
              <AlertTitle>Organizzazione Sospesa</AlertTitle>
              <AlertDescription>
                Questa organizzazione si trova in stato sospeso. Le operazioni di modifica, deployment e
                assegnazione risorse sono temporaneamente bloccate in conformità alle policy di sicurezza.
              </AlertDescription>
            </Alert>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
