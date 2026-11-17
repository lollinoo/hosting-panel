import Link from "next/link";
import { redirect } from "next/navigation";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminOsPackages, fetchServerAdminUpdates } from "@/lib/server-api";
import { formatZonedDate } from "@/lib/admin-alerts";
import { restartWarning } from "@/lib/admin-restart";
import { JOB_FOLLOW_MS, canUpdatePanel, packageGroups } from "@/lib/admin-updates";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { SiteLogs } from "@/components/customer/site-logs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

/** The administrator's Updates page: the panel, its containers, the sites behind and the system's packages. */
export default async function AdminUpdatesPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, u, p] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminUpdates(), fetchServerAdminOsPackages()]);
  const t = m.admin.updates;
  const h = m.admin.health;
  const csrf = session.csrfToken;
  const time = (iso: string | null) => (iso ? formatZonedDate(iso, m.common.dateLocale) : "");
  const groups = p ? packageGroups(p) : null;
  const pkgTable = (rows: NonNullable<typeof groups>["main"]) => (
    <Table>
      <TableHeader>
        <TableRow><TableHead>{t.packages.colName}</TableHead><TableHead>{t.packages.colInstalled}</TableHead><TableHead>{t.packages.colNew}</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((x) => (
          <TableRow key={x.name}>
            <TableCell>
              {x.name}
              {x.origin === "security" ? <Badge variant="warning" className="ml-2">{t.packages.security}</Badge> : null}
            </TableCell>
            <TableCell>{x.installedVersion}</TableCell>
            <TableCell>{x.newVersion}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
  const pkgFollow = (done: string) => ({ ms: JOB_FOLLOW_MS, running: t.packages.running, done, failed: t.packages.failed, unknown: t.packages.unknown });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      <p className="text-sm text-muted-foreground">{t.pins}</p>

      {!u ? (
        <Alert variant="destructive" role="alert"><AlertDescription>{t.loadFailed}</AlertDescription></Alert>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle>{t.panel.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{format(t.panel.installed, { version: u.panel.installedVersion ?? "—" })}</p>
              <p>{format(t.panel.states[u.panel.check.state], { latest: u.panel.check.latestVersion ?? "", time: time(u.panel.check.checkedAt) })}</p>
              <div className="flex flex-wrap gap-3">
                <ConfirmAction csrfToken={csrf} name="updates:check" url="/api/admin/updates/panel/check" label={t.panel.check}
                  errors="updates" disabled={!!u.panel.running} />
                {/* A known end reloads the whole page at once, so done and failed keep the running sentence. */}
                {canUpdatePanel(u) || u.panel.running ? (
                  <ConfirmAction csrfToken={csrf} name="updates:panel" url="/api/admin/updates/panel/apply" label={t.panel.update}
                    variant="default" errors="updates" runningOperationId={u.panel.running?.operationId ?? null}
                    dialog={{ title: format(t.panel.updateTitle, { latest: u.panel.check.latestVersion ?? "" }), body: t.panel.updateFacts, confirm: t.panel.confirm }}
                    follow={{ ms: JOB_FOLLOW_MS, reload: true, running: t.panel.running, done: t.panel.running, failed: t.panel.running, unknown: t.panel.unknown }} />
                ) : null}
              </div>
              {u.panel.last ? (
                <p>{format(t.panel.results[u.panel.last.result === "succeeded" ? "updated" : u.panel.last.result], { time: time(u.panel.last.endedAt) })}</p>
              ) : null}
              <h3 className="font-medium">{t.panel.linesTitle}</h3>
              <SiteLogs url="/api/admin/logs/hp-panel-update?tail=50" admin journal />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.components.title}</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>{t.components.colComponent}</TableHead><TableHead>{t.components.colState}</TableHead><TableHead>{h.colActions}</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {u.components.map((c) => {
                    const name = h.components[c.component];
                    const behind = c.expected !== false && c.imageCurrent === false;
                    return (
                      <TableRow key={c.component}>
                        <TableCell>{name}</TableCell>
                        <TableCell>
                          {c.expected === false ? <Badge variant="secondary">{h.states.not_in_use}</Badge>
                            : c.imageCurrent === true ? <Badge variant="success">{t.components.current}</Badge>
                            : c.imageCurrent === false ? <Badge variant="warning">{t.components.behind}</Badge>
                            : <Badge variant="outline">{t.components.unknown}</Badge>}
                        </TableCell>
                        <TableCell>
                          {behind || c.runningOperationId ? (
                            <ConfirmAction csrfToken={csrf} name={`updates:component:${c.component}`} url={`/api/admin/updates/components/${c.component}/apply`}
                              label={t.components.apply} ariaLabel={format(t.components.applyLabel, { name })} errors="updates"
                              runningOperationId={c.runningOperationId}
                              dialog={{ title: format(t.components.applyTitle, { name }), body: `${restartWarning(m, { kind: "part", component: c.component })} ${t.components.applyExtra}`, confirm: t.components.apply }}
                              follow={{ ms: JOB_FOLLOW_MS, running: t.components.running, done: format(t.components.done, { name }), failed: format(t.components.failed, { name }), unknown: format(t.components.unknown2, { name }) }} />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.sites.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t.sites.intro}</p>
              {u.sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.sites.none}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.sites.colSite}</TableHead><TableHead>{t.sites.colOwner}</TableHead>
                      <TableHead>{t.sites.colPhp}</TableHead><TableHead>{h.colActions}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {u.sites.map((s) => {
                      const name = s.siteName;
                      return (
                        <TableRow key={s.siteId}>
                          <TableCell>{name}</TableCell>
                          <TableCell>{s.organizationName ?? h.unassigned}</TableCell>
                          <TableCell>{s.phpVersion}</TableCell>
                          <TableCell>
                            {s.stopped ? (
                              <p className="text-sm text-muted-foreground">{t.sites.stopped}</p>
                            ) : (
                              <ConfirmAction csrfToken={csrf} name={`updates:site:${s.siteId}`} url={`/api/admin/sites/${s.siteId}/image-update`}
                                label={t.sites.update} ariaLabel={format(t.sites.updateLabel, { name })} errors="updates"
                                dialog={{ title: format(t.sites.updateTitle, { name }), body: format(t.sites.updateBody, { name, php: s.phpVersion }), confirm: t.sites.update }}
                                follow={{ ms: JOB_FOLLOW_MS, running: t.sites.running, done: format(t.sites.done, { name }), failed: format(t.sites.failed, { name }), unknown: format(t.sites.unknown, { name }) }} />
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {u.sites.length < u.sitesTotal ? (
                <p className="text-sm text-muted-foreground">{format(t.sites.more, { count: u.sitesTotal - u.sites.length })}</p>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader><CardTitle>{t.packages.title}</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!p || !groups ? (
            <Alert variant="warning" role="alert"><AlertDescription>{t.packages.unreadable}</AlertDescription></Alert>
          ) : (
            <>
              <p>{p.packages.length ? format(t.packages.count, { count: p.packages.length, security: groups.security.length }) : t.packages.none}</p>
              <p className="text-muted-foreground">{p.listsReadAt ? format(t.packages.listsAt, { time: time(p.listsReadAt) }) : t.packages.listsNever}</p>
              {p.rebootRequired ? <Alert variant="warning" role="alert"><AlertDescription>{t.packages.reboot}</AlertDescription></Alert> : null}
              <div className="flex flex-wrap gap-3">
                <ConfirmAction csrfToken={csrf} name="updates:os-refresh" url="/api/admin/os-packages/refresh" label={t.packages.check} errors="updates"
                  disabled={p.running?.job === "os_upgrade"} runningOperationId={p.running?.job === "os_refresh" ? p.running.operationId : null}
                  follow={pkgFollow(t.packages.refreshDone)} />
                {(p.canUpgrade && groups.security.length !== 0) || p.running?.job === "os_upgrade" ? (
                  <ConfirmAction csrfToken={csrf} name="updates:os-upgrade" url="/api/admin/os-packages/upgrade" label={t.packages.install} variant="default"
                    errors="updates" disabled={p.running?.job === "os_refresh"} runningOperationId={p.running?.job === "os_upgrade" ? p.running.operationId : null}
                    dialog={{ title: t.packages.installTitle, body: t.packages.installBody, confirm: t.packages.confirm }}
                    follow={pkgFollow(t.packages.installDone)} />
                ) : null}
              </div>
              {!p.canUpgrade ? <p className="text-muted-foreground">{t.packages.cannotUpgrade}</p> : null}
              <Link href="/admin/logs?source=hp-os-upgrade" className="underline">{t.packages.logLink}</Link>
              {groups.main.length ? pkgTable(groups.main) : null}
            </>
          )}
        </CardContent>
      </Card>

      {groups && groups.other.length ? (
        <Card>
          <CardHeader><CardTitle>{t.packages.otherTitle}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t.packages.otherIntro}</p>
            {pkgTable(groups.other)}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
