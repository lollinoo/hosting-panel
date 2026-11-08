"use client";

import * as React from "react";
import Link from "next/link";
import { CircleUser, LogOut, UserCog } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LanguageSwitch } from "@/components/shared/language-switch";
import { useMessages } from "@/i18n/provider";

export interface HeaderProps {
  userName: string;
  email: string;
  csrfToken: string;
}

export function Header({ userName, email, csrfToken }: HeaderProps) {
  const m = useMessages();
  const [leaving, setLeaving] = React.useState(false);

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
    <header className="sticky top-0 z-40 w-full border-b bg-card/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between px-6">
        <Link href="/admin/hosts" className="flex items-center gap-2 font-bold tracking-tight text-lg">
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-extrabold text-sm shadow"
          >
            {"HP"}
          </span>
          <span>{m.shell.productName}</span>
        </Link>
        <div className="flex items-center gap-4">
          <LanguageSwitch csrfToken={csrfToken} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2" aria-label={`${m.shell.accountMenu}: ${userName}`} disabled={leaving}>
                <CircleUser aria-hidden className="h-4 w-4" />
                <span className="hidden max-w-[10rem] truncate md:inline">{userName}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">{email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <UserCog aria-hidden className="h-4 w-4" />
                  {m.shell.account}
                </Link>
              </DropdownMenuItem>
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
