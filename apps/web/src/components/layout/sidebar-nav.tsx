"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Globe, Mail, Server, Shield, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMessages } from "@/i18n/provider";

export function SidebarNav() {
  const pathname = usePathname();
  const t = useMessages().admin.nav;
  const items = [
    { href: "/admin/hosts", label: t.server, icon: Server },
    { href: "/admin/sites", label: t.sites, icon: Globe },
    { href: "/admin/mail", label: t.mail, icon: Mail },
    { href: "/admin/users", label: t.users, icon: Users },
    { href: "/admin/audit", label: t.audit, icon: FileText },
  ];

  return (
    <aside className="w-64 border-r bg-muted/20 flex flex-col min-h-[calc(100vh-4rem)] p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 mb-2 flex items-center gap-1.5">
        <Shield aria-hidden className="h-3.5 w-3.5" />
        <span>{t.label}</span>
      </div>
      <nav aria-label={t.label} className="space-y-1">
        {items.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
