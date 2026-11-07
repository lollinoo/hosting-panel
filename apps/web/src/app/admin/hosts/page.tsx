import Link from "next/link";
import { getServerSession } from "@/lib/server-session";
import { fetchServerHosts } from "@/lib/server-api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Server, Cpu, ShieldAlert, ArrowRight, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminHostsPage() {
  const session = await getServerSession();
  const hosts = await fetchServerHosts();

  const isInfraAdmin = session?.user.globalRoles.includes("infrastructure_admin");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Inventario Nodi Host Fisici</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Supervisione della flotta server dedicati e garanzie di confinamento runtime (AC-F1-01, AC-F1-06).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={isInfraAdmin ? "default" : "secondary"}>
            {isInfraAdmin ? "Controllo Completo InfrastructureAdmin" : "Lettura Sola (HostingAdmin)"}
          </Badge>
        </div>
      </div>

      {!isInfraAdmin && (
        <Alert variant="warning">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Privilegi Segregati (AC-F1-03)</AlertTitle>
          <AlertDescription>
            Sei autenticato come Hosting Admin. L'accesso alle operazioni di manutenzione del daemon host,
            sicurezza kernel Linux e gating di modalità è riservato esclusivamente al ruolo InfrastructureAdmin.
          </AlertDescription>
        </Alert>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Totale Nodi Host</CardTitle>
            <Server className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{hosts.length}</div>
            <p className="text-[11px] text-muted-foreground mt-1">Modalità Dedicated enforcement attiva</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Capacità CPU Allocabile</CardTitle>
            <Cpu className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {hosts.reduce((acc, h) => acc + h.totalCpuMilli, 0) / 1000} vCPU
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Risorse hardware verificate</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Modalità Hosting Attiva</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">100% Dedicated</div>
            <p className="text-[11px] text-muted-foreground mt-1">Shared Mode disabilitata in Fase 1</p>
          </CardContent>
        </Card>
      </div>

      {/* Host Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Elenco Nodi Registrati</CardTitle>
          <CardDescription className="text-xs">
            Ispezione dettagliata dello stato, indirizzo IPv4 e parametri di confinamento.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Host / Nome</TableHead>
                <TableHead>Indirizzo IPv4</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Modalità</TableHead>
                <TableHead>Capacità Hardware</TableHead>
                <TableHead>Revisione Sicurezza</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hosts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-xs">
                    Nessun host registrato nel piano di controllo.
                  </TableCell>
                </TableRow>
              ) : (
                hosts.map((host) => (
                  <TableRow key={host.id}>
                    <TableCell className="font-medium">
                      <div>{host.name}</div>
                      <div className="text-[11px] font-mono text-muted-foreground">{host.hostname}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{host.ipv4Address}</TableCell>
                    <TableCell>
                      <Badge variant={host.status === "ready" ? "success" : "secondary"} className="text-[10px]">
                        {host.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] font-mono border-blue-500/30 text-blue-600">
                        {host.hostingMode}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>{host.totalCpuMilli / 1000} vCPU</div>
                      <div>{(Number(host.totalMemoryBytes) / (1024 * 1024 * 1024)).toFixed(1)} GB RAM</div>
                    </TableCell>
                    <TableCell>
                      {host.securityReviewed ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Verificato</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-600">In attesa</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost" className="gap-1 text-xs">
                        <Link href={`/admin/hosts/${host.id}`}>
                          <span>Dettaglio</span>
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
