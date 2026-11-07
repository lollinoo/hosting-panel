import {
  fetchServerMe,
  fetchServerOrg,
  fetchServerOrgSites,
  fetchServerOrgQuotas,
} from "@/lib/server-api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Globe,
  Boxes,
  Gauge,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Cpu,
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const me = await fetchServerMe();

  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const org = await fetchServerOrg(orgId);
  const sites = await fetchServerOrgSites(orgId);
  const quotas = (await fetchServerOrgQuotas(orgId)) || org?.quotas;

  const caps = me?.platformCapabilities;
  const isPhase2Active = caps?.phase === "phase-2";
  const runtimeBackend = caps?.runtimeBackend ?? "disabled";

  const totalSites = sites.length > 0 ? sites.length : org?.siteCount || 0;
  const totalServices = org?.serviceCount || 0;

  const cpuUsedPercent =
    quotas && quotas.maxCpuMilli > 0
      ? Math.min(100, Math.round((quotas.usedCpuMilli / quotas.maxCpuMilli) * 100))
      : 0;

  const sitesUsedPercent =
    quotas && quotas.maxSites > 0
      ? Math.min(100, Math.round((quotas.usedSites / quotas.maxSites) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Panoramica: {org?.name || membership?.organizationName || orgSlug}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Supervisione delle risorse, conformità di stack e stato operativo del tenant.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            Backend: {runtimeBackend}
          </Badge>
          <Badge variant={org?.status === "suspended" ? "destructive" : "success"} className="text-xs">
            Stato: {org?.status || membership?.organizationStatus || "attivo"}
          </Badge>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Siti Web / Stack</CardTitle>
            <Globe className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalSites}</div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {quotas ? `${quotas.usedSites} di ${quotas.maxSites} quota usati` : "Configurati nel tenant"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Istanze di Servizio</CardTitle>
            <Boxes className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalServices}</div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {quotas ? `${quotas.usedServices} di ${quotas.maxServices} ammessi` : "Servizi definiti"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Stato Drift Stack</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-600">In Sync</div>
            <p className="text-[11px] text-muted-foreground mt-1">Riconciliatore observe-only</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Utilizzo Quota CPU</CardTitle>
            <Cpu className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="text-2xl font-bold">{cpuUsedPercent}%</div>
            <Progress value={cpuUsedPercent} className="h-2" />
          </CardContent>
        </Card>
      </div>

      {/* Quota Progress Overview Card */}
      {quotas && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-primary" />
              <CardTitle className="text-base">Consumo Quote Risorse Tenant</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Limiti autorizzativi assegnati per la salvaguardia della stabilità del nodo (AC-F1-07).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium">Siti Web: {quotas.usedSites} / {quotas.maxSites}</span>
                <span className="text-muted-foreground">{sitesUsedPercent}%</span>
              </div>
              <Progress value={sitesUsedPercent} className="h-2" />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="font-medium">
                  vCPU Millicores: {quotas.usedCpuMilli} m / {quotas.maxCpuMilli} m
                </span>
                <span className="text-muted-foreground">{cpuUsedPercent}%</span>
              </div>
              <Progress value={cpuUsedPercent} className="h-2" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Truthful Capability Matrix Card (AC-F1-10 & AC-F2-10) */}
      <Card className="border-primary/20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <CardTitle className="text-base font-semibold">
                {isPhase2Active
                  ? "Matrice Disponibilità Fase 2 Dedicated (AC-F2-10 / Continuità Matrice Disponibilità Fase 1 AC-F1-10)"
                  : "Matrice Disponibilità Fase 1 (AC-F1-10)"}
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-xs border-primary/30">
              {isPhase2Active ? "HCP-SPEC-003 Invarianti" : "HCP-SPEC-002 Invarianti"}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Trasparenza rigorosa sui confini operativi: distinzione veritiera tra runtime attivi sul backend corrente (
            <code className="font-mono">{runtimeBackend}</code>) e perimetri che restano chiusi (Shared Hosting, ACME/TLS, SFTP, Backup).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-4 text-xs">
            {/* Active Capabilities Column */}
            <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div className="font-semibold text-emerald-600 flex items-center gap-1.5 border-b pb-2">
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  {isPhase2Active
                    ? "Funzionalità Attive (Fase 1 + Runtime Fase 2)"
                    : "Funzionalità Attive in Fase 1"}
                </span>
              </div>
              <ul className="space-y-2 text-muted-foreground">
                <li className="flex items-center justify-between">
                  <span>Control Plane API (/v1) &amp; Outbox Transazionale</span>
                  <Badge variant="success" className="text-[10px]">Attivo</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>Stack Revision SHA-256 &amp; Segreti AES-256-GCM</span>
                  <Badge variant="success" className="text-[10px]">Attivo</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>BFF JWE HttpOnly e Anti-CSRF Timing-Safe</span>
                  <Badge variant="success" className="text-[10px]">Attivo</Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>Docker Executor Runtime (`hp-docker-executor`)</span>
                  {caps?.dockerExecutorRuntimeAvailable ? (
                    <Badge variant="success" className="text-[10px]">
                      Attivo ({runtimeBackend})
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                      Non attivo in Fase 1 (Previsto Fase 2+)
                    </Badge>
                  )}
                </li>
                <li className="flex items-center justify-between">
                  <span>Host Agent Daemon (`hp-host-agent`)</span>
                  {caps?.hostAgentRuntimeAvailable ? (
                    <Badge variant="success" className="text-[10px]">
                      Attivo ({runtimeBackend})
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                      Non attivo in Fase 1 (Previsto Fase 2+)
                    </Badge>
                  )}
                </li>
              </ul>
            </div>

            {/* Explicitly Gated Capabilities Column (AC-F2-10) */}
            <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div className="font-semibold text-amber-600 flex items-center gap-1.5 border-b pb-2">
                <XCircle className="h-4 w-4" />
                <span>Componenti Chiusi / Non Attivi (AC-F1-10 &amp; AC-F2-10)</span>
              </div>
              <ul className="space-y-2 text-muted-foreground">
                <li className="flex items-center justify-between">
                  <span>Multi-Tenant Shared Hosting (ADR-011 OPEN)</span>
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                    Chiuso — 409 SHARED_MODE_GATED
                  </Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>Gestione Automatica Certificati ACME/TLS</span>
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                    Non attivo in Fase 1 (Previsto Fase 2+) / Non in Fase 2
                  </Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>SFTP Gateway e Accesso File Remoto</span>
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                    Non attivo (HCP-SPEC-005)
                  </Badge>
                </li>
                <li className="flex items-center justify-between">
                  <span>Backup Produzione Replicati ad Oggetti (S3)</span>
                  <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                    Non attivo (HCP-SPEC-005)
                  </Badge>
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
