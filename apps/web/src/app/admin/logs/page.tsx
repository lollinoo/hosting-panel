import Link from "next/link";
import { PANEL_CONTAINERS } from "@hosting-panel/contracts";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAdminSites } from "@/lib/server-api";
import { LOG_TAIL_CHOICES, logUrl, parseLogSource, parseTail } from "@/lib/admin-address";
import { SiteLogs } from "@/components/customer/site-logs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const selectClass = "flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm";

export default async function AdminLogsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const [m, sites] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminSites()]);
  const t = m.admin.logs;
  const source = parseLogSource(one(q.source));
  const tail = parseTail(one(q.tail));
  const url = source ? logUrl(source, tail) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{t.services}</p>
        <p>{t.siteNote}</p>
        <p>
          <Link href="/admin/audit" className="underline">
            {t.auditLink}
          </Link>
        </p>
      </div>
      {!sites && (
        <Alert variant="warning" role="alert">
          <AlertDescription>{t.sitesFailed}</AlertDescription>
        </Alert>
      )}
      <form method="get" action="/admin/logs" className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="log-source">{t.source}</Label>
          <select id="log-source" name="source" defaultValue={one(q.source) ?? ""} className={selectClass}>
            <optgroup label={t.panelGroup}>
              {PANEL_CONTAINERS.map((c) => (
                <option key={c} value={c}>
                  {m.admin.health.components[c]}
                </option>
              ))}
            </optgroup>
            {sites && (
              <optgroup label={t.sitesGroup}>
                {sites.sites.map((s) => (
                  <option key={s.id} value={`site:${s.id}`}>
                    {format(t.siteOption, { name: s.name, owner: s.owner?.name ?? m.admin.health.unassigned })}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="log-tail">{t.tail}</Label>
          <select id="log-tail" name="tail" defaultValue={String(tail)} className={selectClass}>
            {LOG_TAIL_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" size="sm">
          {t.show}
        </Button>
      </form>
      {url ? <SiteLogs key={url} url={url} admin /> : <p className="text-sm text-muted-foreground">{t.choose}</p>}
    </div>
  );
}
