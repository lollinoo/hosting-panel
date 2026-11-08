import { CustomerTopBar } from "@/components/customer/top-bar";
import { getCustomerContext, getSites } from "./data";

export const dynamic = "force-dynamic";

export default async function SitesLayout({ children }: { children: React.ReactNode }) {
  const { session, orgId } = await getCustomerContext();
  const sites = await getSites(orgId);
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <CustomerTopBar
        sites={sites.map((s) => ({ id: s.id, name: s.name }))}
        userName={session.user.name}
        csrfToken={session.csrfToken}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
