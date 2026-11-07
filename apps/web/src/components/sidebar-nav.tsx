"use client";

import {
  Activity,
  AppWindow,
  Database,
  Globe,
  LayoutDashboard,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItemSpec {
  readonly href: string;
  readonly label: string;
  readonly icon:
    | "overview"
    | "servers"
    | "applications"
    | "databases"
    | "domains"
    | "operations"
    | "members"
    | "admin";
}

function renderNavIcon(icon: NavItemSpec["icon"]) {
  const cls = "h-4 w-4 shrink-0";
  switch (icon) {
    case "overview":
      return <LayoutDashboard className={cls} aria-hidden="true" />;
    case "servers":
      return <Server className={cls} aria-hidden="true" />;
    case "applications":
      return <AppWindow className={cls} aria-hidden="true" />;
    case "databases":
      return <Database className={cls} aria-hidden="true" />;
    case "domains":
      return <Globe className={cls} aria-hidden="true" />;
    case "operations":
      return <Activity className={cls} aria-hidden="true" />;
    case "members":
      return <Users className={cls} aria-hidden="true" />;
    case "admin":
      return <ShieldCheck className={cls} aria-hidden="true" />;
  }
}

export function SidebarNav({ items }: { readonly items: readonly NavItemSpec[] }) {
  const pathname = usePathname();

  return (
    <nav className="space-y-1" aria-label="Navigazione principale">
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-indigo-50 text-indigo-700"
                : "text-slate-700 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {renderNavIcon(item.icon)}
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
