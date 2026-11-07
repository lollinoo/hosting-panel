import { fetchServerMe, fetchServerOrgOperations } from "@/lib/server-api";
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

export const dynamic = "force-dynamic";

export default async function OrgOperationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const me = await fetchServerMe();
  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const operations = await fetchServerOrgOperations(orgId);

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "succeeded":
        return "success" as const;
      case "failed":
        return "destructive" as const;
      case "processing":
      case "reconciling":
        return "warning" as const;
      default:
        return "secondary" as const;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cronologia Operazioni Asincrone</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Registro delle riconciliazioni, lifecycle dei servizi e deploy eseguiti nello stack (HCP-SPEC-002 §4.3).
          </p>
        </div>
        <Badge variant="outline" className="text-xs">
          {operations.length} Operazioni Registrate
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Eventi Operativi</CardTitle>
              <CardDescription className="text-xs">
                Transizioni di stato tracciate dal Transactional Outbox e dal Reconciler.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operazione ID</TableHead>
                <TableHead>Tipo Operazione</TableHead>
                <TableHead>Risorsa Coinvolta</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Sottomessa il</TableHead>
                <TableHead>Completata il</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">
                    Nessuna operazione asincrona registrata per questa organizzazione.
                  </TableCell>
                </TableRow>
              ) : (
                operations.map((op) => (
                  <TableRow key={op.id}>
                    <TableCell className="font-mono text-xs font-semibold">{op.id}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <Badge variant="outline" className="text-[10px]">
                        {op.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">
                      {op.resourceType}: {op.resourceId}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(op.status)} className="text-[10px]">
                        {op.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {new Date(op.submittedAt).toLocaleString("it-IT")}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono">
                      {op.completedAt ? new Date(op.completedAt).toLocaleString("it-IT") : "-"}
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
