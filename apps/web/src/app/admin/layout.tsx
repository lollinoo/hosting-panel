import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoutButton } from "@/components/logout-button";
import { SidebarNav, type NavItemSpec } from "@/components/sidebar-nav";
import { resolveAdminServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { session, me } = await resolveAdminServerContext();

  const navItems: readonly NavItemSpec[] = [
    { href: "/admin/overview", label: "Panoramica Piattaforma", icon: "overview" },
    { href: "/admin/providers", label: "Connessioni Provider", icon: "servers" },
    { href: "/admin/fleet", label: "Flotta Multi-Tenant", icon: "applications" },
    { href: "/admin/audit", label: "Registro Audit Immutabile", icon: "admin" },
  ];

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col justify-between border-b border-slate-200 bg-white p-4 lg:w-68 lg:border-r lg:border-b-0">
        <div className="space-y-5">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <Link
                href="/admin/overview"
                className="text-sm font-bold text-slate-900"
              >
                Platform Admin
              </Link>
              <p className="text-[11px] text-slate-500">Console Infrastrutturale</p>
            </div>
          </div>

          <SidebarNav items={navItems} />
        </div>

        <div className="mt-6 space-y-3 border-t border-slate-200 pt-4">
          {me.memberships.length > 0 && (
            <Link
              href="/choose-organization"
              className="block rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-center text-xs font-semibold text-slate-800 hover:bg-slate-100"
            >
              Passa a vista Organizzazione
            </Link>
          )}

          <div className="rounded-lg bg-slate-50 p-2.5 text-xs">
            <p className="font-semibold text-slate-900">{me.user.displayName}</p>
            <p className="truncate text-slate-500">{me.user.email}</p>
          </div>

          <LogoutButton csrfToken={session.csrfToken} />
        </div>
      </aside>

      <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
    </div>
  );
}
