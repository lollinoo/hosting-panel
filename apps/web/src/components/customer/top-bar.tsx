"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Bell, Check, ChevronDown, CircleUser, LogOut, Plus, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LanguageSwitch } from "@/components/shared/language-switch";
import { appHref, type AppLink } from "@/components/app-stacks/app-stack-view";
import { useMessages } from "@/i18n/provider";

function AppSwitcher({ apps }: { apps: readonly AppLink[] }) {
  const m = useMessages();
  const { siteId, stackId } = useParams<{ siteId?: string; stackId?: string }>();
  const current = apps.find((a) => a.id === (a.kind === "site" ? siteId : stackId));
  if (apps.length === 0) return null;
  const label = current?.name ?? m.shell.yourSites;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[16rem] gap-2" aria-label={`${m.shell.switchSite}: ${label}`}>
          <span className="truncate">{label}</span>
          <ChevronDown aria-hidden className="h-4 w-4 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{m.shell.yourSites}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {apps.map((a) => (
          <DropdownMenuItem key={`${a.kind}:${a.id}`} asChild>
            <Link href={appHref(a.kind, a.id)} aria-current={a === current ? "page" : undefined}>
              <span className="flex-1 truncate">{a.name}</span>
              {a.label && <span className="text-xs text-muted-foreground">{a.label}</span>}
              {a === current && <Check aria-hidden className="h-4 w-4" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/apps/new">
            <Plus aria-hidden className="h-4 w-4" />
            {m.shell.newSite}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CustomerTopBar({ apps = [], userName, csrfToken }: { apps?: readonly AppLink[]; userName: string; csrfToken: string }) {
  const m = useMessages();
  const pathname = usePathname();
  const [leaving, setLeaving] = useState(false);

  async function logout() {
    setLeaving(true);
    try {
      await fetch("/api/session/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken } });
    } finally {
      // Hard navigation: the root layout drops the account's language with the session.
      window.location.assign("/login");
    }
  }

  return (
    <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-4 px-6">
        <Link href="/apps" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
          >
            HP
          </span>
          <span className="sr-only sm:not-sr-only">{m.shell.productName}</span>
        </Link>
        <Button asChild variant="ghost" size="sm">
          <Link href="/apps" aria-current={pathname.startsWith("/apps") || pathname.startsWith("/sites") ? "page" : undefined}>
            {m.apps.nav}
          </Link>
        </Button>
        <AppSwitcher apps={apps} />
        <div className="ml-auto flex items-center gap-4">
          <LanguageSwitch csrfToken={csrfToken} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2" aria-label={`${m.shell.accountMenu}: ${userName}`} disabled={leaving}>
                <CircleUser aria-hidden className="h-4 w-4" />
                <span className="hidden max-w-[10rem] truncate md:inline">{userName}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <UserCog aria-hidden className="h-4 w-4" />
                  {m.shell.account}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/account/notifications">
                  <Bell aria-hidden className="h-4 w-4" />
                  {m.shell.notifications}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout}>
                <LogOut aria-hidden className="h-4 w-4" />
                {m.common.logout}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
