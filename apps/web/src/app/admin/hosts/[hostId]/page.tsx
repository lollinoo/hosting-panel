import { notFound } from "next/navigation";
import Link from "next/link";
import type { HostDaemonStatus } from "@hosting-panel/contracts";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import {
  fetchServerMe,
  fetchServerHost,
  fetchServerHostAllocations,
  fetchServerHostTelemetry,
} from "@/lib/server-api";
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
import { Progress } from "@/components/ui/progress";
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
  Server,
  Clock,
} from "lucide-react";

export const dynamic = "force-dynamic";

function formatGib(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0 GB";
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function calcUsagePercent(usedStr: string, totalStr: string): number {
  const used = Number(usedStr);
  const total = Number(totalStr);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0m";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getDaemonBadgeVariant(status?: HostDaemonStatus) {
  switch (status) {
    case "online":
      return "success" as const;
    case "degraded":
      return "warning" as const;
    case "offline":
    default:
      return "secondary" as const;
  }
}

export default async function AdminHostDetailPage({
  params,
}: {
  params: Promise<{ hostId: string }>;
}) {
  const { hostId } = await params;
  const session = await getServerSession();
  const m = getMessages(await getRequestLocale());
  const t = m.admin.host;
  const dateLocale = m.common.dateLocale;
  const host = await fetchServerHost(hostId);

  if (!host) {
    notFound();
  }

  const [me, allocations, telemetryOverview] = await Promise.all([
    fetchServerMe(),
    fetchServerHostAllocations(hostId),
    fetchServerHostTelemetry(hostId),
  ]);

  const runtimeBackend =
    telemetryOverview?.runtimeBackend ??
    me?.platformCapabilities.runtimeBackend ??
    "disabled";
  const isRuntimeEnabled = runtimeBackend !== "disabled";
  const telemetry = telemetryOverview?.telemetry ?? null;
  const daemons = telemetryOverview?.daemons ?? [];

  const executorHeartbeat = daemons.find((d) => d.component === "docker_executor");
  const hostAgentHeartbeat = daemons.find((d) => d.component === "host_agent");

  const ramPercent = telemetry
    ? calcUsagePercent(telemetry.memoryUsedBytes, telemetry.memoryTotalBytes)
    : 0;
  const storagePercent = telemetry
    ? calcUsagePercent(telemetry.storageUsedBytes, telemetry.storageTotalBytes)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="h-8 w-8">
            <Link href="/admin/hosts" aria-label={t.back} title={t.back}>
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{host.name}</h1>
              <Badge variant="outline" className="font-mono text-xs border-blue-500/30 text-blue-600">
                {host.hostingMode}
              </Badge>
              <Badge variant={host.status === "ready" ? "success" : "secondary"} className="text-xs">
                {host.status}
              </Badge>
              <Badge
                variant={
                  runtimeBackend === "linux-systemd"
                    ? "success"
                    : runtimeBackend === "local-simulator"
                      ? "default"
                      : "secondary"
                }
                className="font-mono text-xs"
              >
                {format(t.backend, { backend: runtimeBackend })}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground font-mono mt-0.5">
              {format(t.hostLine, { hostname: host.hostname, ip: host.ipv4Address })}
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-3 max-w-lg">
          <TabsTrigger value="overview">{t.tabOverview}</TabsTrigger>
          <TabsTrigger value="allocations">{t.tabAllocations}</TabsTrigger>
          <TabsTrigger value="boundaries">{t.tabBoundaries}</TabsTrigger>
        </TabsList>

        {/* Tab 1: Panoramica, Telemetria Live & Capacità */}
        <TabsContent value="overview" className="space-y-4 pt-3">
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {format(t.cpuTitle, { n: host.totalCpuMilli / 1000 })}
                </CardTitle>
                <Cpu aria-hidden className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent className="space-y-2">
                {telemetry ? (
                  <>
                    <div className="text-2xl font-bold">
                      {telemetry.cpuUsagePercent.toFixed(1)}%
                    </div>
                    <Progress value={Math.round(telemetry.cpuUsagePercent)} className="h-2" />
                    <p className="text-[11px] text-muted-foreground">
                      {format(t.cpuLive, { n: host.totalCpuMilli })}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-bold">{format(m.admin.hosts.vcpu, { n: host.totalCpuMilli / 1000 })}</div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {format(t.cpuStatic, { n: host.totalCpuMilli })}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t.ramTitle}
                </CardTitle>
                <Activity aria-hidden className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent className="space-y-2">
                {telemetry ? (
                  <>
                    <div className="text-2xl font-bold">{ramPercent}%</div>
                    <Progress value={ramPercent} className="h-2" />
                    <p className="text-[11px] text-muted-foreground">
                      {format(t.usedOf, {
                        used: formatGib(telemetry.memoryUsedBytes),
                        total: formatGib(telemetry.memoryTotalBytes),
                      })}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-bold">{formatGib(host.totalMemoryBytes)}</div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {format(t.bytesTotal, { n: host.totalMemoryBytes })}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">
                  {t.storageTitle}
                </CardTitle>
                <HardDrive aria-hidden className="h-4 w-4 text-purple-500" />
              </CardHeader>
              <CardContent className="space-y-2">
                {telemetry ? (
                  <>
                    <div className="text-2xl font-bold">{storagePercent}%</div>
                    <Progress value={storagePercent} className="h-2" />
                    <p className="text-[11px] text-muted-foreground">
                      {format(t.usedOf, {
                        used: formatGib(telemetry.storageUsedBytes),
                        total: formatGib(telemetry.storageTotalBytes),
                      })}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-2xl font-bold">{formatGib(host.totalStorageBytes)}</div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {t.storageNote}
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Live Telemetry System Snapshot Card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Server aria-hidden className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">
                    {t.telemetryTitle}
                  </CardTitle>
                </div>
                {telemetry && (
                  <span className="text-[11px] font-mono text-muted-foreground flex items-center gap-1">
                    <Clock aria-hidden className="h-3 w-3" />
                    {format(t.updatedAt, { time: new Date(telemetry.collectedAt).toLocaleTimeString(dateLocale) })}
                  </span>
                )}
              </div>
              <CardDescription className="text-xs">
                {t.telemetryHint}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              {telemetry ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border p-3">
                    <span className="text-muted-foreground">{t.kernel}</span>
                    <div className="font-mono font-semibold mt-1">{telemetry.kernelVersion}</div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <span className="text-muted-foreground">{t.uptime}</span>
                    <div className="font-mono font-semibold mt-1">
                      {formatUptime(telemetry.uptimeSeconds)}
                    </div>
                  </div>
                  <div className="rounded-lg border p-3">
                    <span className="text-muted-foreground">{t.docker}</span>
                    <div className="mt-1">
                      <Badge
                        variant={telemetry.dockerEngineReachable ? "success" : "destructive"}
                        className="text-[10px]"
                      >
                        {telemetry.dockerEngineReachable ? t.reachable : t.unreachable}
                      </Badge>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-3 text-muted-foreground">
                  {format(t.noTelemetry, { backend: runtimeBackend })}
                </div>
              )}

              {/* Daemon Heartbeats */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border p-3 flex items-center justify-between">
                  <div>
                    <div className="font-semibold font-mono">{"hp-docker-executor"}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {executorHeartbeat
                        ? format(t.heartbeat, {
                            version: executorHeartbeat.version,
                            time: new Date(executorHeartbeat.lastSeenAt).toLocaleTimeString(dateLocale),
                          })
                        : t.noHeartbeat}
                    </div>
                  </div>
                  <Badge
                    variant={getDaemonBadgeVariant(executorHeartbeat?.status)}
                    className="text-[10px]"
                  >
                    {executorHeartbeat?.status ?? (isRuntimeEnabled ? t.waiting : t.disabled)}
                  </Badge>
                </div>

                <div className="rounded-lg border p-3 flex items-center justify-between">
                  <div>
                    <div className="font-semibold font-mono">{"hp-host-agent"}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {hostAgentHeartbeat
                        ? format(t.heartbeat, {
                            version: hostAgentHeartbeat.version,
                            time: new Date(hostAgentHeartbeat.lastSeenAt).toLocaleTimeString(dateLocale),
                          })
                        : t.noHeartbeat}
                    </div>
                  </div>
                  <Badge
                    variant={getDaemonBadgeVariant(hostAgentHeartbeat?.status)}
                    className="text-[10px]"
                  >
                    {hostAgentHeartbeat?.status ?? (isRuntimeEnabled ? t.waiting : t.disabled)}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t.configTitle}</CardTitle>
              <CardDescription className="text-xs">
                {t.configHint}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">{t.uniqueId}</span>
                  <div className="font-mono mt-1">{host.id}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">{t.ipv6}</span>
                  <div className="font-mono mt-1">{host.ipv6Address || t.notConfigured}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">{t.securityReview}</span>
                  <div className="mt-1">
                    {host.securityReviewed ? (
                      <Badge variant="success" className="text-[10px]">{t.approved}</Badge>
                    ) : (
                      <Badge variant="warning" className="text-[10px]">{t.notVerified}</Badge>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border p-3">
                  <span className="text-muted-foreground">{t.sharedApproval}</span>
                  <div className="mt-1">
                    <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">
                      {t.sharedDisabled}
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
              <CardTitle className="text-sm">{t.allocTitle}</CardTitle>
              <CardDescription className="text-xs">
                {t.allocHint}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.allocId}</TableHead>
                    <TableHead>{t.allocOrg}</TableHead>
                    <TableHead>{t.allocStatus}</TableHead>
                    <TableHead>{t.allocScope}</TableHead>
                    <TableHead>{t.allocCreated}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">
                        {t.allocEmpty}
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
                            {alloc.dedicatedScope ? t.exclusive : t.shared}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          {new Date(alloc.createdAt).toLocaleDateString(dateLocale)}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Demoni IPC, Manutenzione & Sicurezza */}
        <TabsContent value="boundaries" className="space-y-4 pt-3">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className={isRuntimeEnabled ? "border-emerald-500/20 bg-emerald-500/5" : "border-amber-500/20 bg-amber-500/5"}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Boxes aria-hidden className={isRuntimeEnabled ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-amber-600"} />
                    <CardTitle className="text-sm font-semibold">
                      {t.executorTitle}
                    </CardTitle>
                  </div>
                </div>
                <CardDescription className="text-xs font-medium">
                  {isRuntimeEnabled ? format(t.runtimeActive, { backend: runtimeBackend }) : t.runtimePlanned}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1.5">
                <p>{t.executorBody}</p>
              </CardContent>
            </Card>

            <Card className="border-blue-500/20 bg-blue-500/5">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Lock aria-hidden className="h-4 w-4 text-blue-600" />
                    <CardTitle className="text-sm font-semibold">
                      {t.agentTitle}
                    </CardTitle>
                  </div>
                </div>
                <CardDescription className="text-xs font-medium">
                  {isRuntimeEnabled ? format(t.runtimeActive, { backend: runtimeBackend }) : t.runtimePlanned}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-1.5">
                <p>{t.agentBody}</p>
              </CardContent>
            </Card>
          </div>

          <HostDetailActions
            hostId={host.id}
            csrfToken={session?.csrfToken}
            runtimeBackend={runtimeBackend}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
