import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/server-session";
import { fetchServerHost, fetchServerHostAllocations } from "@/lib/server-api";
import { HostDetailActions } from "@/components/admin/host-detail-actions";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Cpu,
  HardDrive,
  ArrowLeft,
  Lock,
  Boxes,
  Activity,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminHostDetailPage({
  params,
}: {
  params: Promise<{ hostId: string }>;
}) {
  const { hostId } = await params;
  const session = await getServerSession();
  const host = await fetchServerHost(hostId);

  if (!host) {
    notFound();
  }

  const allocations = await fetchServerHostAllocations(hostId);
  const isInfraAdmin = !!session?.user.globalRoles.includes("infrastructure_admin");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="h-8 w-8">
            <Link href="/admin/hosts">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{host.name}</h1>
              <Badge variant="outline" className="font-mono text-xs border-blue-500/30 text-blue-600">
                {host.hostingMode}
              </Badge>
              <Badge variant={host.status === "ready" ? "success" : "secondary"} className="text-xs">
                {host.status}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Hostname: {host.hostname} &bull; IPv4: {host.ipv4Address}
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="overview">Panoramica & Capacità</TabsTrigger>
          <TabsTrigger value="allocations">Allocazioni Tenant</TabsTrigger>
          <TabsTrigger value="boundaries">Confini Runtime & Sicurezza</TabsTrigger>
        </TabsList>

        {/* Tab 1: Panoramica & Capacità */}
        <TabsContent value="overview" className="space-y-4 pt-3">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">Capacità CPU</CardTitle>
                <Cpu className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{host.totalCpuMilli / 1000} vCPU</div>
                <p className="text-[11px] text-muted-foreground mt-1">{host.totalCpuMilli} millicores fisici</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">Memoria RAM</CardTitle>
                <Activity className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {(Number(host.totalMemoryBytes) / (1024 * 1024 * 1024)).toFixed(1)} GB
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">{host.totalMemoryBytes} bytes totali</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">Storage Primario</CardTitle>
                <HardDrive className="h-4 w-4 text-purple-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {(Number(host.totalStorageBytes) / (1024 * 1024 * 1024)).toFixed(0)} GB
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">Storage NVMe locale isolato</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Configurazione e Metadati Hardware</CardTitle>
              <CardDescription className="text-xs">
                Parametri identificativi registrati nel piano di controllo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Identificativo Univoco:</span>
                  <div className="font-mono mt-1">{host.id}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Indirizzo IPv6:</span>
                  <div className="font-mono mt-1">{host.ipv6Address || "Non configurato"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Revisione di Sicurezza:</span>
                  <div className="mt-1">
                    {host.securityReviewed ? (
                      <Badge variant="success" className="text-[10px]">Approvato Fase 1</Badge>
                    ) : (
                      <Badge variant="warning" className="text-[10px]">Non Verificato</Badge>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">Approvazione Modalità Shared:</span>
                  <div className="mt-1">
                    <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">
                      Disabilitata (AC-F1-06)
                    </Badge>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Allocazioni Tenant */}
        <TabsContent value="allocations" className="space-y-4 pt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tenant Allocati su questo Host</CardTitle>
              <CardDescription className="text-xs">
                In modalità Dedicated, al più un tenant attivo può occupare questo nodo (AC-F1-01).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Allocazione ID</TableHead>
                    <TableHead>Organizzazione Tenant</TableHead>
                    <TableHead>Stato</TableHead>
                    <TableHead>Ambito Dedicated</TableHead>
                    <TableHead>Data Creazione</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">
                        Nessuna allocazione attiva su questo host (nodo libero per assegnazione dedicata).
                      </TableCell>
                    </TableRow>
                  ) : (
                    allocations.map((alloc) => (
                      <TableRow key={alloc.id}>
                        <TableCell className="font-mono text-xs">{alloc.id}</TableCell>
                        <TableCell className="font-medium text-xs">{alloc.organizationId}</TableCell>
                        <TableCell>
                          <Badge variant={alloc.status === "active" ? "success" : "secondary"} className="text-[10px]">
                            {alloc.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            {alloc.dedicatedScope ? "Esclusivo (AC-F1-01)" : "Shared"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          {new Date(alloc.createdAt).toLocaleDateString("it-IT")}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Confini Runtime & Sicurezza */}
        <TabsContent value="boundaries" className="space-y-4 pt-3">
          {/* Explicit AC-F1-10 Status Cards */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-amber-500/20 bg-amber-500/5">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Boxes className="h-4 w-4 text-amber-600" />
                    <CardTitle className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                      Docker Executor Runtime
                    </CardTitle>
                  </div>
                  <Badge variant="warning" className="text-[10px]">
                    AC-F1-10
                  </Badge>
                </div>
                <CardDescription className="text-xs text-amber-800/80 dark:text-amber-200/80 font-medium">
                  Boundary Logico Definito — Runtime previsto in Fase 2
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1.5">
                <p>
                  In Fase 1, l'esecutore Docker non avvia container né interagisce con `/var/run/docker.sock`.
                  I contratti di specifica (ApprovedServiceSpec) e il calcolo dei confini di sicurezza sono pienamente definiti nel layer di Policy.
                </p>
              </CardContent>
            </Card>

            <Card className="border-blue-500/20 bg-blue-500/5">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-blue-600" />
                    <CardTitle className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                      Host Agent Daemon
                    </CardTitle>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    AC-F1-10
                  </Badge>
                </div>
                <CardDescription className="text-xs text-blue-800/80 dark:text-blue-200/80 font-medium">
                  Boundary Logico Definito — Runtime previsto in Fase 2
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1.5">
                <p>
                  Nessun daemon di shell arbitrario è attivo sul server Linux. Le chiamate di manutenzione rispondono con `422 NOT_SUPPORTED`,
                  garantendo l'impossibilità di bypass dei confini di processo e filesystem.
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Interactive Gating & Maintenance Action Component */}
          <HostDetailActions
            hostId={host.id}
            csrfToken={session?.csrfToken}
            isInfraAdmin={isInfraAdmin}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
