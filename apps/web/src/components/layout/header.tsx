"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Server, Layers, Building2, LogOut, ChevronDown } from "lucide-react";
import type { PublicSessionDto } from "@/lib/session";

export interface HeaderProps {
  session: PublicSessionDto;
}

export function Header({ session }: HeaderProps) {
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);

  const handleLogout = async () => {
    setLoading(true);
    try {
      await fetch("/api/session/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchContext = async (
    activeConsole: "infra" | "hosting" | "org",
    activeOrgSlug: string | null = null
  ) => {
    if (!session.csrfToken) return;
    setLoading(true);
    try {
      const res = await fetch("/api/session/switch-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        },
        body: JSON.stringify({ activeConsole, activeOrgSlug }),
      });

      if (res.ok) {
        if (activeConsole === "infra") {
          router.push("/admin/hosts");
        } else if (activeConsole === "hosting") {
          router.push("/hosting/allocations");
        } else if (activeConsole === "org" && activeOrgSlug) {
          router.push(`/o/${activeOrgSlug}/overview`);
        }
        router.refresh();
      }
    } finally {
      setLoading(false);
    }
  };

  const isInfraAdmin = session.user?.globalRoles.includes("infrastructure_admin");
  const isHostingAdmin =
    session.user?.globalRoles.includes("hosting_admin") || isInfraAdmin;

  const currentConsoleLabel = () => {
    if (session.activeConsole === "infra") return "Console Infrastructure Admin";
    if (session.activeConsole === "hosting") return "Console Hosting Admin";
    if (session.activeConsole === "org") {
      const m = session.memberships?.find((item) => item.organizationSlug === session.activeOrgSlug);
      return m ? `Organizzazione: ${m.organizationName}` : "Pannello Organizzazione";
    }
    return "Seleziona Contesto";
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-card/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-extrabold text-sm shadow">
              HCP
            </span>
            <span>Hosting Control Panel</span>
          </Link>
          <Badge variant="outline" className="hidden sm:inline-flex border-primary/20 text-xs">
            Docker-Native Fase 1
          </Badge>
        </div>

        <div className="flex items-center gap-3">
          {session.authenticated && (
            <>
              {/* Context Switcher */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 text-xs" disabled={loading}>
                    {session.activeConsole === "infra" && <Server className="h-3.5 w-3.5 text-blue-500" />}
                    {session.activeConsole === "hosting" && <Layers className="h-3.5 w-3.5 text-emerald-500" />}
                    {session.activeConsole === "org" && <Building2 className="h-3.5 w-3.5 text-amber-500" />}
                    <span>{currentConsoleLabel()}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs">Passa a un'altra Console</DropdownMenuLabel>
                  <DropdownMenuSeparator />

                  {isInfraAdmin && (
                    <DropdownMenuItem
                      onClick={() => handleSwitchContext("infra")}
                      className="gap-2 text-xs cursor-pointer"
                    >
                      <Server className="h-4 w-4 text-blue-500" />
                      <div>
                        <div className="font-medium">Infrastructure Admin</div>
                        <div className="text-[10px] text-muted-foreground">Host fisici & confini runtime</div>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {isHostingAdmin && (
                    <DropdownMenuItem
                      onClick={() => handleSwitchContext("hosting")}
                      className="gap-2 text-xs cursor-pointer"
                    >
                      <Layers className="h-4 w-4 text-emerald-500" />
                      <div>
                        <div className="font-medium">Hosting Admin</div>
                        <div className="text-[10px] text-muted-foreground">Allocazioni & Service Templates</div>
                      </div>
                    </DropdownMenuItem>
                  )}

                  {session.memberships && session.memberships.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                        Organizzazioni Tenant
                      </DropdownMenuLabel>
                      {session.memberships.map((m) => (
                        <DropdownMenuItem
                          key={m.organizationId}
                          onClick={() => handleSwitchContext("org", m.organizationSlug)}
                          className="gap-2 text-xs cursor-pointer"
                        >
                          <Building2 className="h-4 w-4 text-amber-500" />
                          <div className="flex-1 overflow-hidden">
                            <div className="font-medium truncate">{m.organizationName}</div>
                            <div className="text-[10px] text-muted-foreground">Ruolo: {m.role}</div>
                          </div>
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {/* User indicator & Logout */}
              <div className="flex items-center gap-2 border-l pl-3 ml-1">
                <div className="hidden md:flex flex-col text-right">
                  <span className="text-xs font-medium leading-none">{session.user?.name}</span>
                  <span className="text-[10px] text-muted-foreground">{session.user?.email}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleLogout}
                  title="Disconnetti"
                  disabled={loading}
                >
                  <LogOut className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
