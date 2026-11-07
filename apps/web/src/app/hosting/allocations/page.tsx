import { getServerSession } from "@/lib/server-session";
import { fetchServerAllocations } from "@/lib/server-api";
import { NewAllocationDialog } from "@/components/hosting/new-allocation-dialog";
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
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ShieldAlert, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HostingAllocationsPage() {
  const session = await getServerSession();
  const allocations = await fetchServerAllocations();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Allocazioni Host Multi-Tenant</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestione delle assegnazioni di server fisici alle organizzazioni tenant con vincoli di isolamento (AC-F1-01).
          </p>
        </div>
        <NewAllocationDialog csrfToken={session?.csrfToken} />
      </div>

      <Alert variant="warning">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Segregazione Privilegi Operativi (AC-F1-03)</AlertTitle>
        <AlertDescription>
          In qualità di Hosting Admin, hai visibilità e controllo sull'assegnazione dei server fisici ai clienti.
          I privilegi di accesso kernel, configurazione daemon Docker e manutenzione OS restano rigorosamente confinati a InfrastructureAdmin.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Elenco Allocazioni Attive</CardTitle>
              <CardDescription className="text-xs">
                Ogni allocazione garantisce l'esclusività hardware del nodo per il tenant designato.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs">
              {allocations.length} Allocazioni Registrate
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Allocazione ID</TableHead>
                <TableHead>Host Fisico (Nodo)</TableHead>
                <TableHead>Organizzazione Tenant</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Modalità Hosting</TableHead>
                <TableHead>Ambito Esclusivo</TableHead>
                <TableHead>Data Assegnazione</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-xs">
                    Nessuna allocazione registrata. Usa il pulsante in alto per assegnare un host.
                  </TableCell>
                </TableRow>
              ) : (
                allocations.map((alloc) => (
                  <TableRow key={alloc.id}>
                    <TableCell className="font-mono text-xs font-semibold">{alloc.id}</TableCell>
                    <TableCell className="font-mono text-xs text-blue-600">{alloc.hostId}</TableCell>
                    <TableCell className="font-medium text-xs">{alloc.organizationId}</TableCell>
                    <TableCell>
                      <Badge variant={alloc.status === "active" ? "success" : "secondary"} className="text-[10px]">
                        {alloc.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px] font-mono border-blue-500/30 text-blue-600">
                        {alloc.hostingMode}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {alloc.dedicatedScope ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Dedicated (AC-F1-01)</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-600">Shared</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {new Date(alloc.createdAt).toLocaleString("it-IT")}
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
