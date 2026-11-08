"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/provider";
import { LAST_SITE_COOKIE } from "@/app/sites/landing";
import { cn } from "@/lib/utils";

// Later steps append tabs here.
export const SITE_TABS: { key: "overview"; href: (siteId: string) => string }[] = [
  { key: "overview", href: (siteId) => `/sites/${siteId}` },
];

// Route tabs are page links, so they are a nav with aria-current rather than an ARIA tablist.
export function SiteTabs({ siteId }: { siteId: string }) {
  const m = useMessages();
  const pathname = usePathname();

  // Server layouts cannot set cookies, so the last-visited site is remembered here.
  useEffect(() => {
    document.cookie = `${LAST_SITE_COOKIE}=${encodeURIComponent(siteId)}; path=/; max-age=31536000; samesite=lax`;
  }, [siteId]);

  return (
    <nav aria-label={m.site.tabsLabel} className="border-b">
      <ul className="-mb-px flex gap-6">
        {SITE_TABS.map((tab, i) => {
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
