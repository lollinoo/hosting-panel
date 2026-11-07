"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Server,
  FileText,
  Layers,
  Box,
  LayoutDashboard,
  Globe,
  Gauge,
  Users,
  Activity,
  Shield,
} from "lucide-react";

export interface SidebarNavProps {
  consoleContext: "infra" | "hosting" | "org";
  orgSlug?: string | null;
}

export function SidebarNav({ consoleContext, orgSlug }: SidebarNavProps) {
  const pathname = usePathname();

  let navItems: Array<{ href: string; label: string; icon: React.ComponentType<{ className?: string }> }> = [];

  if (consoleContext === "infra") {
    navItems = [
      {
        href: "/admin/hosts",
        label: "Nodi Host & Capacità",
        icon: Server,
      },
      {
        href: "/admin/audit",
        label: "Registro Audit Immutabile",
        icon: FileText,
      },
    ];
  } else if (consoleContext === "hosting") {
    navItems = [
      {
        href: "/hosting/allocations",
        label: "Allocazioni Host",
        icon: Layers,
      },
      {
        href: "/hosting/templates",
        label: "Catalogo Template",
        icon: Box,
      },
    ];
  } else if (consoleContext === "org" && orgSlug) {
    navItems = [
      {
        href: `/o/${orgSlug}/overview`,
        label: "Panoramica Organizzazione",
        icon: LayoutDashboard,
      },
      {
        href: `/o/${orgSlug}/sites`,
        label: "Siti & Applicazioni",
        icon: Globe,
      },
      {
        href: `/o/${orgSlug}/quotas`,
        label: "Quote & Risorse",
        icon: Gauge,
      },
      {
        href: `/o/${orgSlug}/members`,
        label: "Membri & Ruoli",
        icon: Users,
      },
      {
        href: `/o/${orgSlug}/operations`,
        label: "Cronologia Operazioni",
        icon: Activity,
      },
    ];
  }

  return (
    <aside className="w-64 border-r bg-muted/20 flex flex-col min-h-[calc(100vh-4rem)] p-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-3 mb-2 flex items-center gap-1.5">
        <Shield className="h-3.5 w-3.5" />
        <span>
          {consoleContext === "infra" && "Infrastructure Admin"}
          {consoleContext === "hosting" && "Hosting Admin"}
          {consoleContext === "org" && "Pannello Tenant"}
        </span>
      </div>
      <nav className="space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
