import { AlertOctagon, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { OrgCommercialStatusBadge } from "@/components/badges";
import { LogoutButton } from "@/components/logout-button";
import { OrgSwitcher } from "@/components/org-switcher";
import { SidebarNav, type NavItemSpec } from "@/components/sidebar-nav";
import { formatRoleLabelIt } from "@/lib/format";
import { resolveOrgServerContext } from "@/lib/org-context";

export const dynamic = "force-dynamic";

export interface OrgLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{
    readonly orgSlug: string;
  }>;
}

export default async function OrganizationLayout({
  children,
  params,
}: OrgLayoutProps) {
  const { orgSlug } = await params;
  const { session, me, membership } = await resolveOrgServerContext(orgSlug);

  const navItems: readonly NavItemSpec[] = [
    { href: `/o/${orgSlug}/overview`, label: "Panoramica", icon: "overview" },
    { href: `/o/${orgSlug}/servers`, label: "Server", icon: "servers" },
    {
      href: `/o/${orgSlug}/applications`,
      label: "Applicazioni",
      icon: "applications",
    },
    { href: `/o/${orgSlug}/databases`, label: "Database", icon: "databases" },
    { href: `/o/${orgSlug}/domains`, label: "Domini & TLS", icon: "domains" },
    { href: `/o/${orgSlug}/operations`, label: "Operazioni", icon: "operations" },
    { href: `/o/${orgSlug}/members`, label: "Membri", icon: "members" },
  ];

  const isSuspended = membership.organizationStatus === "suspended";

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="flex w-full shrink-0 flex-col justify-between border-b border-slate-200 bg-white p-4 lg:w-68 lg:border-r lg:border-b-0">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <Link
              href={`/o/${orgSlug}/overview`}
              className="text-base font-bold tracking-tight text-slate-900"
            >
              Hosting Control Panel
            </Link>
            <OrgCommercialStatusBadge status={membership.organizationStatus} />
          </div>

          <OrgSwitcher
            currentOrgSlug={membership.organizationSlug}
            memberships={me.memberships}
            csrfToken={session.csrfToken}
          />

          <SidebarNav items={navItems} />
        </div>

        <div className="mt-6 space-y-3 border-t border-slate-200 pt-4">
          {me.user.isPlatformAdmin && (
            <Link
              href="/admin/overview"
              className="flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Console Platform Admin
            </Link>
          )}

          <div className="rounded-lg bg-slate-50 p-2.5 text-xs">
            <p className="font-semibold text-slate-900">{me.user.displayName}</p>
            <p className="truncate text-slate-500">{me.user.email}</p>
            <p className="mt-1 text-[11px] font-medium text-indigo-700">
              {membership.roles.map(formatRoleLabelIt).join(", ")}
            </p>
          </div>

          <LogoutButton csrfToken={session.csrfToken} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {isSuspended && (
          <div
            role="alert"
            className="border-b border-rose-200 bg-rose-50 px-6 py-3 text-sm text-rose-950"
          >
            <div className="flex items-center gap-2.5">
              <AlertOctagon
                className="h-5 w-5 shrink-0 text-rose-600"
                aria-hidden="true"
              />
              <div>
                <span className="font-semibold">
                  Organizzazione sospesa (modalità sola lettura):
                </span>{" "}
                la consultazione delle risorse resta disponibile, ma deploy, riavvii e
                modifiche operative sono temporaneamente bloccati (AC-021).
              </div>
            </div>
          </div>
        )}

        <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
