"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, ChevronDown, CircleUser, LogOut, UserCog } from "lucide-react";
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
import { useMessages } from "@/i18n/provider";

type SiteLink = { id: string; name: string };

function SiteSwitcher({ sites }: { sites: SiteLink[] }) {
  const m = useMessages();
  const { siteId } = useParams<{ siteId?: string }>();
  const current = sites.find((s) => s.id === siteId);
  if (sites.length === 0) return null;
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
        {sites.map((s) => (
          <DropdownMenuItem key={s.id} asChild>
            <Link href={`/sites/${s.id}`} aria-current={s.id === siteId ? "page" : undefined}>
              <span className="flex-1 truncate">{s.name}</span>
              {s.id === siteId && <Check aria-hidden className="h-4 w-4" />}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CustomerTopBar({
  sites,
  userName,
  csrfToken,
}: {
  sites: SiteLink[];
  userName: string;
  csrfToken: string;
}) {
  const m = useMessages();
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
        <Link href="/sites" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
          >
            HP
          </span>
          <span className="sr-only sm:not-sr-only">{m.shell.productName}</span>
        </Link>
        <SiteSwitcher sites={sites} />
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
