import { notFound } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "@/lib/server-session";
import { fetchServerMe, fetchServerOrgSite } from "@/lib/server-api";
import { SiteDetailInteractive } from "@/components/customer/site-detail-interactive";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import {
  ArrowLeft,
  AlertTriangle,
  ShieldCheck,
  Lock,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgSiteDetailPage({
  params,
}: {
  params: Promise<{ orgSlug: string; siteId: string }>;
}) {
  const { orgSlug, siteId } = await params;
  const session = await getServerSession();
  const me = await fetchServerMe();

  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const site = await fetchServerOrgSite(orgId, siteId);

  if (!site) {
    notFound();
  }

  const isDrifted = site.driftSummary?.overallDriftStatus === "drifted";

  return (
    <div className="space-y-6">
      {/* Back button & Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="h-8 w-8">
            <Link href={`/o/${orgSlug}/sites`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{site.name}</h1>
              <Badge variant={site.status === "ready" ? "success" : "secondary"} className="text-xs">
                {site.status}
              </Badge>
              {site.driftSummary && (
                <Badge
                  variant={isDrifted ? "warning" : "outline"}
                  className="text-xs"
                >
                  Drift: {site.driftSummary.overallDriftStatus}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Slug: {site.slug} &bull; Allocazione Host: {site.hostAllocationId}
            </p>
          </div>
        </div>
      </div>

      {/* Prominent Drift Alert when drifted */}
      {isDrifted && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="font-semibold">
            Rilevato Drift Operativo nello Stack (HCP-SPEC-002 §4.4)
          </AlertTitle>
          <AlertDescription className="text-xs mt-1 space-y-1">
            <p>
              Lo stato effettivo del server ispezionato tramite protocollo out-of-band differisce dalla specifica
              dichiarata nell'ultima revisione immutabile.
            </p>
            <p className="font-medium">
              Conformità Non-Distruttiva: La discrepanza viene evidenziata senza sovrascritture automatiche violente
              sui file dell'utente. È possibile analizzare le differenze o procedere a un redeploy controllato.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Detail Tabs */}
      <Tabs defaultValue="services" className="w-full">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="services">Servizi dello Stack</TabsTrigger>
          <TabsTrigger value="domains">Domini</TabsTrigger>
          <TabsTrigger value="governance">Governance & Limiti Runtime</TabsTrigger>
        </TabsList>

        {/* Tab 1: Servizi dello Stack */}
        <TabsContent value="services" className="space-y-4 pt-3">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Topologia Servizi e Revisioni Immutabili</CardTitle>
                  <CardDescription className="text-xs">
                    Ogni modifica produce una nuova revisione numerata progressivamente calcolata tramite digest SHA-256 (AC-F1-04).
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <SiteDetailInteractive
                orgId={orgId}
                siteId={site.id}
                csrfToken={session?.csrfToken}
                services={site.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  desiredStatus: s.desiredStatus,
                  currentRevisionId: s.currentRevisionId,
                }))}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Domini */}
        <TabsContent value="domains" className="space-y-4 pt-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Domini di Primo Livello e Instradamento</CardTitle>
              <CardDescription className="text-xs">
                Nomi a dominio associati a questo stack applicativo. (TLS/ACME automatico previsto in Fase 2 per AC-F1-10).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hostname FQDN</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Stato Verifica</TableHead>
                    <TableHead>Data Registrazione</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {site.domains.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-6 text-muted-foreground text-xs">
                        Nessun dominio configurato per questo sito.
                      </TableCell>
                    </TableRow>
                  ) : (
                    site.domains.map((dom) => (
                      <TableRow key={dom.id}>
                        <TableCell className="font-semibold text-xs font-mono">{dom.hostname}</TableCell>
                        <TableCell>
                          <Badge variant={dom.isPrimary ? "default" : "outline"} className="text-[10px]">
                            {dom.isPrimary ? "Primario" : "Secondario"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={dom.status === "active" ? "success" : "secondary"} className="text-[10px]">
                            {dom.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          {new Date(dom.createdAt).toLocaleDateString("it-IT")}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Governance & Limiti Runtime */}
        <TabsContent value="governance" className="space-y-4 pt-3">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  <CardTitle className="text-sm font-semibold">Regole di Validazione Stack (AC-F1-04)</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Vincoli dichiarativi verificati tassativamente prima del salvataggio di ogni revisione.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Container Privileged (`--privileged`)</span>
                  <Badge variant="destructive" className="text-[10px]">Vietato</Badge>
                </div>
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Mount Socket Docker (`/var/run/docker.sock`)</span>
                  <Badge variant="destructive" className="text-[10px]">Inaccessibile</Badge>
                </div>
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Modalità Host (`networkMode: host`, `pid: host`)</span>
                  <Badge variant="destructive" className="text-[10px]">Proibito</Badge>
                </div>
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Montaggi Filesystem Host Arbitrari</span>
                  <Badge variant="destructive" className="text-[10px]">Bloccato</Badge>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-blue-600" />
                  <CardTitle className="text-sm font-semibold">Invarianti di Revisione Immutabile</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Meccanismi di integrità crittografica e conformità ai contratti.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  &bull; <strong className="text-foreground">Append-Only:</strong> Le revisioni non possono mai essere cancellate o mutate.
                </p>
                <p>
                  &bull; <strong className="text-foreground">Spec Hash SHA-256:</strong> L'impronta hash univoca della configurazione dichiarativa assicura la perfetta tracciabilità tra release.
                </p>
                <p>
                  &bull; <strong className="text-foreground">Segretezza Referenziata:</strong> I segreti non risiedono mai in chiaro nelle revisioni, ma utilizzano riferimenti crittografati risolti al deployment.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
