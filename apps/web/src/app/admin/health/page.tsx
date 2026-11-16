import Link from "next/link";
import { PANEL_CONTAINERS, type HealthState } from "@hosting-panel/contracts";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminAlerts, fetchServerAdminHealth } from "@/lib/server-api";
import { alertLink, alertText, formatZonedDate } from "@/lib/admin-alerts";
import { formatSize } from "@/lib/file-browser";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const BADGE: Record<HealthState, "success" | "warning" | "destructive" | "secondary" | "outline"> = {
  ok: "success", degraded: "warning", down: "destructive", not_in_use: "secondary", unknown: "outline",
};
const isContainer = (c: string) => (PANEL_CONTAINERS as readonly string[]).includes(c);

/** The administrator's Health page: alerts, panel parts, site containers and disks. */
export default async function AdminHealthPage() {
  const [m, health, alerts] = await Promise.all([
    getRequestLocale().then(getMessages),
    fetchServerAdminHealth(),
    fetchServerAdminAlerts(),
  ]);
  const t = m.admin.health;
  const L = m.common.dateLocale;
  const seen = (iso: string | null) => (iso ? formatZonedDate(iso, L) : t.never);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      {!health ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.loadFailed}</AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>{t.alertsTitle}</CardTitle></CardHeader>
            <CardContent>
              {!alerts ? (
                <Alert variant="destructive" role="alert"><AlertDescription>{t.alertsFailed}</AlertDescription></Alert>
              ) : alerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noAlerts}</p>
              ) : (
                <ul className="space-y-3">
                  {alerts.map((a, i) => {
                    const link = alertLink(a);
                    return (
                      <li key={`${a.kind}:${a.subject}:${i}`} className="text-sm">
                        <Badge variant={a.severity === "critical" ? "destructive" : "warning"} className="mr-2">
                          {m.admin.alertLine.severity[a.severity]}
                        </Badge>
                        {alertText(m, a)}
                        {link ? <> <Link href={link.href} className="underline">{t[link.label]}</Link></> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.partsTitle}</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.colPart}</TableHead><TableHead>{t.colState}</TableHead>
                    <TableHead>{t.colWhy}</TableHead><TableHead>{t.colSeen}</TableHead><TableHead>{t.colLog}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.components.map((c) => (
                    <TableRow key={c.component}>
                      <TableCell>{t.components[c.component]}</TableCell>
                      <TableCell><Badge variant={BADGE[c.state]}>{t.states[c.state]}</Badge></TableCell>
                      <TableCell>{c.reason ? t.reasons[c.reason] : ""}</TableCell>
                      <TableCell>{seen(c.observedAt)}</TableCell>
                      <TableCell>
                        {isContainer(c.component) ? (
                          <Link href={`/admin/logs?source=${c.component}`} className="underline"
                            aria-label={format(t.openLogOf, { name: t.components[c.component] })}>{t.openLog}</Link>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.sitesTitle}</CardTitle></CardHeader>
            <CardContent>
              {health.siteContainers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noSites}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.colSite}</TableHead><TableHead>{t.colOwner}</TableHead><TableHead>{t.colWanted}</TableHead>
                      <TableHead>{t.colObserved}</TableHead><TableHead>{t.colDrift}</TableHead><TableHead>{t.colRestarts}</TableHead>
                      <TableHead>{t.colSeen}</TableHead><TableHead>{t.colLog}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.siteContainers.map((s) => (
                      <TableRow key={s.siteId}>
                        <TableCell>{s.siteName}</TableCell>
                        <TableCell>{s.organizationName ?? t.unassigned}</TableCell>
                        <TableCell>{t.wanted[s.desired]}</TableCell>
                        <TableCell>{t.seen[s.observed]}</TableCell>
                        <TableCell>{s.driftReason ? t.drift[s.driftReason] : t.noDrift}</TableCell>
                        <TableCell>{s.restartCount ?? "—"}</TableCell>
                        <TableCell>
                          {seen(s.observedAt)}
                          {s.stale ? <p className="text-xs text-muted-foreground">{t.stale}</p> : null}
                        </TableCell>
                        <TableCell>
                          <Link href={`/admin/logs?source=site:${s.siteId}`} className="underline"
                            aria-label={format(t.openLogOf, { name: s.siteName })}>{t.openLog}</Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.disksTitle}</CardTitle></CardHeader>
            <CardContent>
              {health.disks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noDisks}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>{t.colDisk}</TableHead><TableHead>{t.colUsed}</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.disks.map((d) => {
                      const names = d.paths.map((p) => t.disks[p]).join(", ");
                      return (
                        <TableRow key={d.paths.join("+")}>
                          <TableCell>{names}</TableCell>
                          <TableCell className="space-y-1">
                            <Progress value={d.usedPercent} aria-label={`${names}: ${format(t.usedPercent, { percent: d.usedPercent })}`} />
                            <p className="text-xs text-muted-foreground">
                              {format(t.usedPercent, { percent: d.usedPercent })} ·{" "}
                              {format(m.admin.host.usedOf, { used: formatSize(Number(d.usedBytes), L), total: formatSize(Number(d.totalBytes), L) })}
                            </p>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">{format(t.checkedAt, { time: formatZonedDate(health.generatedAt, L) })}</p>
        </>
      )}
    </div>
  );
}
