import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe } from "@/lib/server-api";
import { Header } from "@/components/layout/header";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Server, Layers, Building2, ArrowRight } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ChooseContextPage() {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const me = await fetchServerMe();
  const isInfraAdmin = session.user.globalRoles.includes("infrastructure_admin");
  const isHostingAdmin =
    session.user.globalRoles.includes("hosting_admin") || isInfraAdmin;

  return (
    <div className="min-h-screen flex flex-col bg-muted/20">
      <Header
        session={{
          authenticated: true,
          csrfToken: session.csrfToken,
          activeConsole: session.activeConsole,
          activeOrgSlug: session.activeOrgSlug,
          user: session.user,
          memberships: me?.memberships || [],
          platformCapabilities: me?.platformCapabilities,
        }}
      />

      <main className="flex-1 max-w-4xl w-full mx-auto p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Seleziona Console Operativa</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Sei autenticato come <span className="font-semibold text-foreground">{session.user.name}</span>.
            Scegli il perimetro operativo con cui desideri interagire.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Infrastructure Console */}
          {isInfraAdmin && (
            <Card className="hover:border-primary/50 transition-colors">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-blue-500" />
                    <Badge variant="default" className="text-[10px]">
                      infrastructure_admin
                    </Badge>
                  </div>
                </div>
                <CardTitle className="text-lg">Console Infrastruttura</CardTitle>
                <CardDescription className="text-xs">
                  Gestione nodi host fisici, allocazioni dedicate, politiche di sicurezza e audit log immutabile.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full gap-2 text-xs">
                  <Link href="/admin/hosts">
                    <span>Accedi a Console Infrastruttura</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Hosting Admin Console */}
          {isHostingAdmin && (
            <Card className="hover:border-primary/50 transition-colors">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-5 w-5 text-emerald-500" />
                    <Badge variant="secondary" className="text-[10px]">
                      hosting_admin
                    </Badge>
                  </div>
                </div>
                <CardTitle className="text-lg">Console Hosting Admin</CardTitle>
                <CardDescription className="text-xs">
                  Gestione assegnazione host ai tenant e catalogo Service Template (segregato da daemon host).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full gap-2 text-xs" variant="secondary">
                  <Link href="/hosting/allocations">
                    <span>Accedi a Console Hosting</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Tenant Orgs */}
        {me && me.memberships.length > 0 && (
          <div className="space-y-3 pt-4">
            <h2 className="text-base font-semibold">Organizzazioni Tenant Assegnate</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {me.memberships.map((m) => (
                <Card key={m.organizationId} className="hover:border-primary/50 transition-colors">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-amber-500" />
                        <span className="font-semibold text-sm">{m.organizationName}</span>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {m.role}
                      </Badge>
                    </div>
                    <CardDescription className="text-xs">
                      Stato: <span className="font-medium text-foreground">{m.organizationStatus}</span>
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button asChild className="w-full gap-2 text-xs" variant="outline">
                      <Link href={`/o/${m.organizationSlug}/overview`}>
                        <span>Apri Pannello Cliente</span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
