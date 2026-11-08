import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe } from "@/lib/server-api";
import { Header } from "@/components/layout/header";
import { SidebarNav } from "@/components/layout/sidebar-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  if (!session.user.isServerAdmin) redirect("/");
  if (session.user.mustChangePassword) redirect("/account/change-password");
  await fetchServerMe(); // a revoked/expired API session redirects to login instead of rendering empty tables

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header userName={session.user.name} email={session.user.email} csrfToken={session.csrfToken} />
      <div className="flex flex-1">
        <SidebarNav />
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
