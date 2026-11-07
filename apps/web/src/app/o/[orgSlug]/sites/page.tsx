import Link from "next/link";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgSites } from "@/lib/server-api";
import { NewSiteDialog } from "@/components/customer/new-site-dialog";
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
import { Globe, ArrowRight } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgSitesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const session = await getServerSession();
  const me = await fetchServerMe();

  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const sites = await fetchServerOrgSites(orgId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Siti & Stack Applicativi</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestione dei contenitori logici multi-servizio ospitati sull'infrastruttura dedicata.
          </p>
        </div>
        <NewSiteDialog
          orgId={orgId}
          csrfToken={session?.csrfToken}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Siti Web Attivi</CardTitle>
              <CardDescription className="text-xs">
                Seleziona uno stack per visualizzare le istanze di servizio, le revisioni immutabili e i domini.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs">
              {sites.length} Siti Registrati
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome Sito</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Stato</TableHead>
                <TableHead>Allocazione Host</TableHead>
                <TableHead>Data Creazione</TableHead>
                <TableHead className="text-right">Azioni</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">
                    Nessun sito configurato per questa organizzazione. Usa il pulsante in alto per creare il primo stack.
                  </TableCell>
                </TableRow>
              ) : (
                sites.map((site) => (
                  <TableRow key={site.id}>
                    <TableCell className="font-semibold text-xs">
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-blue-500" />
                        <span>{site.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {site.slug}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={site.status === "ready" ? "success" : "secondary"}
                        className="text-[10px]"
                      >
                        {site.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {site.hostAllocationId}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {new Date(site.createdAt).toLocaleDateString("it-IT")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost" className="gap-1 text-xs">
                        <Link href={`/o/${orgSlug}/sites/${site.id}`}>
                          <span>Gestisci Stack</span>
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
