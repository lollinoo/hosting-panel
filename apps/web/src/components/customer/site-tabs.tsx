"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { WebSiteType } from "@/site-types";

// Later steps append tabs here.
export const SITE_TABS: {
  key: "overview" | "domains" | "files" | "database" | "backups" | "logs";
  href: (siteId: string) => string;
}[] = [
  { key: "overview", href: (siteId) => `/sites/${siteId}` },
  { key: "domains", href: (siteId) => `/sites/${siteId}/domains` },
  { key: "files", href: (siteId) => `/sites/${siteId}/files` },
  { key: "database", href: (siteId) => `/sites/${siteId}/database` },
  { key: "backups", href: (siteId) => `/sites/${siteId}/backups` },
  { key: "logs", href: (siteId) => `/sites/${siteId}/logs` },
];

// Route tabs are page links, so they are a nav with aria-current rather than an ARIA tablist.
// The site type's own tabs follow the overview; the layout passes them as plain data.
// A site with no known type is not managed (ADR 0029 §2): the routes behind every tab but the overview answer 404 for it.
export function SiteTabs({
  siteId,
  typeTabs = [],
  managed = true,
}: {
  siteId: string;
  typeTabs?: WebSiteType["tabs"];
  managed?: boolean;
}) {
  const m = useMessages();
  const pathname = usePathname();

  const tabs = managed
    ? [
        SITE_TABS[0]!,
        ...typeTabs.map((t) => ({ key: t.key, href: (id: string) => `/sites/${id}/${t.path}` })),
        ...SITE_TABS.slice(1),
      ]
    : [SITE_TABS[0]!];

  return (
    <nav aria-label={m.site.tabsLabel} className="border-b">
      <ul className="-mb-px flex gap-6">
        {tabs.map((tab, i) => {
          const href = tab.href(siteId);
          const active = pathname === href || (i > 0 && pathname.startsWith(`${href}/`));
          return (
            <li key={tab.key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-1 pb-3 text-sm font-medium transition-colors",
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {m.site.tabs[tab.key]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
