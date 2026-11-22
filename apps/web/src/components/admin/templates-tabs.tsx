"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type TemplatesTab = "sites" | "apps";

const TABS = [
  { key: "sites", href: "/admin/templates" },
  { key: "apps", href: "/admin/templates/apps" },
] as const;

/** "/admin/templates/apps" and below → "apps"; everything else under /admin/templates → "sites". */
export function templatesTab(pathname: string): TemplatesTab {
  return pathname === "/admin/templates/apps" || pathname.startsWith("/admin/templates/apps/") ? "apps" : "sites";
}

// Page links, so a nav with aria-current rather than an ARIA tablist (as SiteTabs).
export function TemplatesTabs({ labels }: { labels: { label: string; sites: string; apps: string } }) {
  const active = templatesTab(usePathname());
  return (
    <nav aria-label={labels.label} className="flex gap-1 border-b">
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={active === tab.key ? "page" : undefined}
          className={cn(
            "-mb-px inline-block border-b-2 px-3 pb-3 text-sm font-medium transition-colors",
            active === tab.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {labels[tab.key]}
        </Link>
      ))}
    </nav>
  );
}
