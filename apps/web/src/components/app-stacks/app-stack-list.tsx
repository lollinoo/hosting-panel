import Link from "next/link";
import type { AppStackSummaryDto, SiteSummaryDto } from "@hosting-panel/contracts";
import { StatusPill } from "@/components/customer/status-pill";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, type Locale, type Messages } from "@/i18n";
import { StackStatusBadge } from "./app-stack-status";
import { appEntries, appHref, appKindLabel, type AppEntry } from "./app-stack-view";

export function AppStackList({
  stacks,
  sites = [],
  siteAddresses = {},
  m,
  locale,
}: {
  stacks: readonly AppStackSummaryDto[];
  sites?: readonly SiteSummaryDto[];
  siteAddresses?: Readonly<Record<string, string>>;
  m: Messages;
  locale: Locale;
}) {
  const t = m.apps.list;
  const rows = appEntries(sites, stacks, locale);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t.empty} {m.shell.emptyBody}</p>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const dash = <span className="text-muted-foreground">—</span>;
  const updated = (e: AppEntry) => (e.kind === "stack" ? e.stack : e.site).updatedAt;
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.col.name}</TableHead>
              <TableHead>{t.col.status}</TableHead>
              <TableHead>{t.col.version}</TableHead>
              <TableHead>{t.col.address}</TableHead>
              <TableHead>{t.col.updated}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={`${e.kind}:${e.id}`}>
                <TableCell className="font-medium">
                  <Link href={appHref(e.kind, e.id)} className="hover:underline">{e.name}</Link>
                </TableCell>
                {e.kind === "stack" ? (
                  <>
                    <TableCell>
                      <StackStatusBadge status={e.stack.status} m={m} />
                      {e.stack.unhealthyCount > 0 && (
                        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{format(t.unhealthy, { n: e.stack.unhealthyCount })}</p>
                      )}
                    </TableCell>
                    <TableCell>{format(t.version, { name: e.stack.templateName, n: e.stack.templateVersionNumber })}</TableCell>
                    <TableCell>{e.stack.primaryHostname ?? <span className="text-muted-foreground">{t.noAddress}</span>}</TableCell>
                  </>
                ) : (
                  <>
                    <TableCell>
                      <StatusPill status={e.site.status} labels={m.site.status} />
                    </TableCell>
                    <TableCell>{appKindLabel(m, e) ?? dash}</TableCell>
                    <TableCell>{Object.hasOwn(siteAddresses, e.id) ? siteAddresses[e.id] : dash}</TableCell>
                  </>
                )}
                <TableCell>
                  <time dateTime={updated(e)}>{date.format(new Date(updated(e)))}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
