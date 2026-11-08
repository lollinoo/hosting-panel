import Link from "next/link";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
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
import { Server, Cpu, ArrowRight, CheckCircle2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminHostsPage() {
  const [m, hosts] = await Promise.all([getRequestLocale().then(getMessages), fetchServerHosts()]);
  const t = m.admin.hosts;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t.total}</CardTitle>
            <Server aria-hidden className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{hosts.length}</div>
            <p className="text-[11px] text-muted-foreground mt-1">{t.totalNote}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t.cpu}</CardTitle>
            <Cpu aria-hidden className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {format(t.vcpu, { n: hosts.reduce((acc, h) => acc + h.totalCpuMilli, 0) / 1000 })}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">{t.cpuNote}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t.mode}</CardTitle>
            <CheckCircle2 aria-hidden className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{t.modeValue}</div>
            <p className="text-[11px] text-muted-foreground mt-1">{t.modeNote}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.listTitle}</CardTitle>
          <CardDescription className="text-xs">{t.listHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.colHost}</TableHead>
                <TableHead>{t.colIp}</TableHead>
                <TableHead>{t.colStatus}</TableHead>
                <TableHead>{t.colMode}</TableHead>
                <TableHead>{t.colHardware}</TableHead>
                <TableHead>{t.colSecurity}</TableHead>
                <TableHead className="text-right">{t.colActions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hosts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-6 text-muted-foreground text-xs">
                    {t.empty}
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
                      <div>{format(t.vcpu, { n: host.totalCpuMilli / 1000 })}</div>
                      <div>
                        {format(t.ram, { n: (Number(host.totalMemoryBytes) / (1024 * 1024 * 1024)).toFixed(1) })}
                      </div>
                    </TableCell>
                    <TableCell>
                      {host.securityReviewed ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                          <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                          <span>{t.reviewed}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-600">{t.pending}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost" className="gap-1 text-xs">
                        <Link href={`/admin/hosts/${host.id}`}>
                          <span>{t.detail}</span>
                          <ArrowRight aria-hidden className="h-3.5 w-3.5" />
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
