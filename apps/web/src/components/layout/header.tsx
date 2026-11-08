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
import {
  Server,
  Layers,
  Building2,
  LogOut,
  ChevronDown,
  Lock,
  Cpu,
} from "lucide-react";
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

  // The switch-context route is gone; the console is derived from the URL, so just navigate.
  const handleSwitchContext = (
    target: "infra" | "hosting" | "org",
    activeOrgSlug: string | null = null
  ) => {
    if (target === "infra") {
      router.push("/admin/hosts");
    } else if (target === "hosting") {
      router.push("/hosting/allocations");
    } else if (activeOrgSlug) {
      router.push(`/o/${activeOrgSlug}/overview`);
    }
  };

  const isInfraAdmin = session.user?.globalRoles.includes("infrastructure_admin");
  const isHostingAdmin =
    session.user?.globalRoles.includes("hosting_admin") || isInfraAdmin;

  const caps = session.platformCapabilities;
  const phaseLabel = caps?.phase === "phase-2" ? "Fase 2" : "Fase 1";
  const runtimeBackend = caps?.runtimeBackend ?? "disabled";

  const getRuntimeBadgeVariant = () => {
    if (runtimeBackend === "linux-systemd") return "success" as const;
    if (runtimeBackend === "local-simulator") return "default" as const;
    return "secondary" as const;
  };

  const currentConsoleLabel = () => {
    if (session.activeConsole === "admin") return "Console Admin";
    if (session.activeConsole === "customer") {
      const m = session.memberships?.find((item) => item.organizationSlug === session.activeOrgSlug);
      return m ? `Organizzazione: ${m.organizationName}` : "Pannello Organizzazione";
    }
    return "Seleziona Contesto";
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-card/95 backdrop-blur">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-extrabold text-sm shadow">
              HCP
            </span>
            <span>Hosting Control Panel</span>
          </Link>
          <Badge
            variant={caps?.phase === "phase-2" ? "default" : "outline"}
            className="hidden sm:inline-flex text-xs"
          >
            Docker-Native {phaseLabel}
          </Badge>
          <Badge
            variant={getRuntimeBadgeVariant()}
            className="hidden lg:inline-flex font-mono text-[11px] gap-1"
          >
            <Cpu className="h-3 w-3" />
            <span>runtime: {runtimeBackend}</span>
          </Badge>
        </div>

        <div className="flex items-center gap-3">
          {session.authenticated && (
            <>
              {/* Context Switcher */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 text-xs" disabled={loading}>
                    {session.activeConsole === "admin" && <Server className="h-3.5 w-3.5 text-blue-500" />}
                    {session.activeConsole === "customer" && <Building2 className="h-3.5 w-3.5 text-amber-500" />}
                    <span>{currentConsoleLabel()}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-50" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="text-xs">Passa a un&apos;altra Console</DropdownMenuLabel>
                  <DropdownMenuSeparator />

                  {isInfraAdmin && (
                    <DropdownMenuItem
                      onClick={() => handleSwitchContext("infra")}
                      className="gap-2 text-xs cursor-pointer"
                    >
                      <Server className="h-4 w-4 text-blue-500" />
                      <div>
                        <div className="font-medium">Infrastructure Admin</div>
                        <div className="text-[10px] text-muted-foreground">Host fisici &amp; confini runtime</div>
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
                        <div className="text-[10px] text-muted-foreground">Allocazioni &amp; Service Templates</div>
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

      {/* Truthful Capability Banner (HCP-SPEC-003 §8 / AC-F2-10) */}
      {session.authenticated && (
        <div className="border-t bg-muted/30 px-6 py-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">
              Stato Piattaforma ({phaseLabel}):
            </span>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
              Mode: dedicated
            </Badge>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 font-mono">
              Backend: {runtimeBackend}
            </Badge>
            <Badge
              variant={caps?.dockerExecutorRuntimeAvailable ? "success" : "secondary"}
              className="text-[10px] py-0 px-1.5"
            >
              Executor: {caps?.dockerExecutorRuntimeAvailable ? "Attivo" : "Disabilitato"}
            </Badge>
            <Badge
              variant={caps?.hostAgentRuntimeAvailable ? "success" : "secondary"}
              className="text-[10px] py-0 px-1.5"
            >
              Host Agent: {caps?.hostAgentRuntimeAvailable ? "Attivo" : "Disabilitato"}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Lock className="h-3 w-3 text-amber-600" />
            <span className="font-medium text-amber-800 dark:text-amber-300">
              Chiusi (AC-F2-10):
            </span>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/30 text-amber-700 dark:text-amber-300">
              Shared Hosting: Non attivo
            </Badge>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/30 text-amber-700 dark:text-amber-300">
              ACME/TLS: Non attivo
            </Badge>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/30 text-amber-700 dark:text-amber-300">
              SFTP: Non attivo
            </Badge>
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-500/30 text-amber-700 dark:text-amber-300">
              Backup: Non attivo
            </Badge>
          </div>
        </div>
      )}
    </header>
  );
}
