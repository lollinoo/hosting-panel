import { notFound } from "next/navigation";
import Link from "next/link";
import type { DriftStatus, DriftSummary } from "@hosting-panel/contracts";
import { getServerSession } from "@/lib/server-session";
import {
  fetchServerMe,
  fetchServerOrgSite,
  fetchServerOrgSecrets,
} from "@/lib/server-api";
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

function formatSiteDriftLabel(status: DriftStatus): string {
  switch (status) {
    case "in_sync":
      return "In Sync";
    case "drifted":
      return "Drifted";
    case "unknown":
    default:
      return "Unknown";
  }
}

function getSiteDriftVariant(status: DriftStatus) {
  switch (status) {
    case "in_sync":
      return "success" as const;
    case "drifted":
      return "warning" as const;
    case "unknown":
    default:
      return "secondary" as const;
  }
}

function deriveServiceDriftStatus(summary?: DriftSummary): DriftStatus {
  if (!summary || summary.totalServices === 0) {
    return "unknown";
  }
  if (summary.inSyncCount === summary.totalServices) {
    return "in_sync";
  }
  if (summary.driftedCount === summary.totalServices) {
    return "drifted";
  }
  if (summary.unknownCount === summary.totalServices) {
    return "unknown";
  }
  return summary.overallDriftStatus;
}

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

  const secrets = await fetchServerOrgSecrets(orgId, site.id);
  const runtimeBackend = me?.platformCapabilities.runtimeBackend ?? "disabled";
  const overallDrift: DriftStatus = site.driftSummary?.overallDriftStatus ?? "unknown";
  const isDrifted = overallDrift === "drifted";
  const derivedPerServiceDrift = deriveServiceDriftStatus(site.driftSummary);

  return (
    <div className="space-y-6">
      {/* Back button & Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="h-8 w-8">
            <Link href={`/o/${orgSlug}/sites`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{site.name}</h1>
              <Badge variant={site.status === "ready" ? "success" : "secondary"} className="text-xs">
                {site.status}
              </Badge>
              <Badge variant={getSiteDriftVariant(overallDrift)} className="text-xs">
                Drift Sito: {formatSiteDriftLabel(overallDrift)}
              </Badge>
              {site.driftSummary && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  {site.driftSummary.inSyncCount}/{site.driftSummary.totalServices} in_sync
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              Slug: {site.slug} &bull; Allocazione Host: {site.hostAllocationId}
            </p>
          </div>
        </div>
      </div>

      {/* Prominent Drift Alert when drifted (Observe-Only Reconciler TH-10 / AC-F2-08) */}
      {isDrifted && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="font-semibold">
            Rilevato Drift Operativo Observe-Only nello Stack (TH-10 / AC-F2-08)
          </AlertTitle>
          <AlertDescription className="text-xs mt-1 space-y-1">
            <p>
              Lo stato effettivo osservato sul nodo differisce dall&apos;hash{" "}
              <code className="font-mono">specHash</code> della revisione dichiarativa attiva (
              {site.driftSummary.driftedCount} servizi drifted).
            </p>
            <p className="font-medium">
              Conformità Non-Distruttiva: Il Drift Reconciler registra un evento di audit ma non riavvia né termina
              autonomamente i container in esecuzione. Avvia un Deploy esplicito per riallineare lo stack.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Detail Tabs */}
      <Tabs defaultValue="services" className="w-full">
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="services">Servizi &amp; Segreti</TabsTrigger>
          <TabsTrigger value="domains">Domini</TabsTrigger>
          <TabsTrigger value="governance">Governance &amp; Limiti Runtime</TabsTrigger>
        </TabsList>

        {/* Tab 1: Servizi dello Stack & Segreti Cifrati */}
        <TabsContent value="services" className="space-y-4 pt-3">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">
                    Topologia Servizi, Lifecycle Asincrono e Segreti Cifrati
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Ogni modifica produce una revisione immutabile SHA-256 (AC-F1-04); le mutazioni lifecycle passano per Outbox transazionale (AC-F2-06).
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <SiteDetailInteractive
                orgId={orgId}
                siteId={site.id}
                csrfToken={session?.csrfToken}
                runtimeBackend={runtimeBackend}
                initialSecrets={secrets}
                services={site.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  desiredStatus: s.desiredStatus,
                  currentRevisionId: s.currentRevisionId,
                  driftStatus: derivedPerServiceDrift,
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
                Routing HTTP gestito via Traefik v3 Dynamic File Provider read-only senza docker.sock (ADR-014). ACME/TLS automatico resta non attivo in Fase 2 (AC-F2-10).
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
                  <CardTitle className="text-sm font-semibold">Regole di Validazione &amp; Confinamento (AC-F1-04 / AC-F2-03)</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Vincoli imposti sia dal Policy Engine sia da hp-docker-executor prima della creazione container.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Container Privileged (`Privileged: false`, `CapDrop: ALL`)</span>
                  <Badge variant="destructive" className="text-[10px]">Vietato</Badge>
                </div>
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Mount Socket Docker (`/var/run/docker.sock`)</span>
                  <Badge variant="destructive" className="text-[10px]">Inaccessibile</Badge>
                </div>
                <div className="rounded border p-2.5 flex items-center justify-between">
                  <span>Rete Dedicata per Sito (`hp_site_&lt;id&gt;_net`)</span>
                  <Badge variant="success" className="text-[10px]">Isolata</Badge>
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
                  <CardTitle className="text-sm font-semibold">Invarianti Crittografici &amp; Segreti JIT</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  Meccanismi di integrità crittografica e risoluzione segreti in RAM (ADR-015).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs text-muted-foreground">
                <p>
                  &bull; <strong className="text-foreground">Append-Only:</strong> Le revisioni non possono mai essere cancellate o mutate.
                </p>
                <p>
                  &bull; <strong className="text-foreground">Spec Hash SHA-256:</strong> L&apos;impronta hash univoca della configurazione dichiarativa assicura la perfetta tracciabilità tra release.
                </p>
                <p>
                  &bull; <strong className="text-foreground">Segretezza su tmpfs 0400:</strong> I segreti sono decifrati JIT dall&apos;Outbox Worker e montati come file read-only senza mai comparire in <code className="font-mono">Config.Env</code>.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
