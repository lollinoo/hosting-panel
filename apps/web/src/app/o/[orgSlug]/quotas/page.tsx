import { fetchServerMe, fetchServerOrg, fetchServerOrgQuotas } from "@/lib/server-api";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Cpu, Globe } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function OrgQuotasPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const me = await fetchServerMe();
  const membership = me?.memberships.find((m) => m.organizationSlug === orgSlug);
  const orgId = membership?.organizationId || orgSlug;
  const org = await fetchServerOrg(orgId);
  const quotas = (await fetchServerOrgQuotas(orgId)) || org?.quotas;

  const cpuPercent = quotas && quotas.maxCpuMilli > 0
    ? Math.min(100, Math.round((quotas.usedCpuMilli / quotas.maxCpuMilli) * 100))
    : 0;

  const sitesPercent = quotas && quotas.maxSites > 0
    ? Math.min(100, Math.round((quotas.usedSites / quotas.maxSites) * 100))
    : 0;

  const svcPercent = quotas && quotas.maxServices > 0
    ? Math.min(100, Math.round((quotas.usedServices / quotas.maxServices) * 100))
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Quote & Risorse Tenant</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Limiti massimi di dimensionamento e capacità hardware allocata all'organizzazione (AC-F1-05).
          </p>
        </div>
      </div>

      {!quotas ? (
        <Card>
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            Nessuna quota di risorse configurata esplicitamente per questa organizzazione.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Sites & Services */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-blue-500" />
                <CardTitle className="text-sm font-semibold">Stack & Istanze Applicative</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Contenitori logici e processi container allocati.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium">Siti Web: {quotas.usedSites} / {quotas.maxSites}</span>
                  <span className="text-muted-foreground">{sitesPercent}%</span>
                </div>
                <Progress value={sitesPercent} className="h-2" />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium">Servizi: {quotas.usedServices} / {quotas.maxServices}</span>
                  <span className="text-muted-foreground">{svcPercent}%</span>
                </div>
                <Progress value={svcPercent} className="h-2" />
              </div>
            </CardContent>
          </Card>

          {/* Compute & Memory */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-emerald-500" />
                <CardTitle className="text-sm font-semibold">Capacità di Calcolo & Memoria</CardTitle>
              </div>
              <CardDescription className="text-xs">
                Risorse computazionali garantite dal server fisico dedicato.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="font-medium">
                    CPU Millicores: {quotas.usedCpuMilli} m / {quotas.maxCpuMilli} m
                  </span>
                  <span className="text-muted-foreground">{cpuPercent}%</span>
                </div>
                <Progress value={cpuPercent} className="h-2" />
              </div>

              <div className="pt-2 text-xs space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <span>RAM Massima Assegnata:</span>
                  <span className="font-mono font-medium text-foreground">
                    {(Number(quotas.maxMemoryBytes) / (1024 * 1024 * 1024)).toFixed(1)} GB
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Storage Dedicato:</span>
                  <span className="font-mono font-medium text-foreground">
                    {(Number(quotas.maxStorageBytes) / (1024 * 1024 * 1024)).toFixed(0)} GB
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
