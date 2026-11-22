import Link from "next/link";
import type { AdminAppTemplateSummaryDto, AdminSiteTemplateSummaryDto } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APP_TEMPLATE_STATE_BADGE } from "@/components/admin/app-template-list";
import { STATUS_BADGE_VARIANT, groupByModule, templateStatusKeys } from "@/components/admin/site-template-list";
import { format, type Messages } from "@/i18n";

export type TemplateCatalogRow =
  | { kind: "site"; template: AdminSiteTemplateSummaryDto }
  | { kind: "app"; template: AdminAppTemplateSummaryDto };

/** WordPress templates first (groupByModule order: built-in, live by name, archived), then application templates (by name, archived last). */
export function templateCatalogRows(
  sites: readonly AdminSiteTemplateSummaryDto[],
  apps: readonly AdminAppTemplateSummaryDto[],
): TemplateCatalogRow[] {
  const archived = (t: AdminAppTemplateSummaryDto) => Number(t.state === "archived");
  return [
    ...groupByModule(sites).flatMap((g) => g.templates.map((template) => ({ kind: "site" as const, template }))),
    ...[...apps]
      .sort((a, b) => archived(a) - archived(b) || a.name.localeCompare(b.name))
      .map((template) => ({ kind: "app" as const, template })),
  ];
}

/** Both template kinds in one table. Server-compatible: it holds no state and takes the messages as a prop. */
export function TemplateCatalog({ sites, apps, m }: { sites: AdminSiteTemplateSummaryDto[]; apps: AdminAppTemplateSummaryDto[]; m: Messages }) {
  const t = m.admin.templates;
  const a = m.admin.appTemplates;
  const rows = templateCatalogRows(sites, apps);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t.empty}</p>;
  const moduleNames = t.modules as Record<string, string>;
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.col.name}</TableHead>
              <TableHead>{t.col.kind}</TableHead>
              <TableHead>{t.col.status}</TableHead>
              <TableHead>{t.col.defaultVersion}</TableHead>
              <TableHead>{t.col.sites}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) =>
              row.kind === "site" ? (
                <TableRow key={row.template.id} className={row.template.archivedAt !== null ? "opacity-60" : undefined}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/templates/${encodeURIComponent(row.template.id)}`} className="hover:underline">{row.template.name}</Link>
                  </TableCell>
                  <TableCell>{moduleNames[row.template.module] ?? row.template.module}</TableCell>
                  <TableCell className="space-x-1">
                    {templateStatusKeys(row.template).map((key) => (
                      <Badge key={key} variant={STATUS_BADGE_VARIANT[key]}>{t.status[key]}</Badge>
                    ))}
                  </TableCell>
                  <TableCell>{format(t.versionLabel, { version: row.template.defaultVersionNumber })}</TableCell>
                  <TableCell>{row.template.siteCount}</TableCell>
                </TableRow>
              ) : (
                <TableRow key={row.template.id} className={row.template.state === "archived" ? "opacity-60" : undefined}>
                  <TableCell className="font-medium">
                    <Link href={`/admin/templates/apps/${encodeURIComponent(row.template.id)}`} className="hover:underline">{row.template.name}</Link>
                  </TableCell>
                  <TableCell>{a.tabs.apps}</TableCell>
                  <TableCell className="space-x-1">
                    <Badge variant={APP_TEMPLATE_STATE_BADGE[row.template.state]}>{a.state[row.template.state]}</Badge>
                    {row.template.builtIn && <Badge variant="outline">{a.builtIn}</Badge>}
                  </TableCell>
                  <TableCell>
                    {row.template.defaultVersionNumber === null ? a.noVersion : format(a.versionLabel, { n: row.template.defaultVersionNumber })}
                  </TableCell>
                  <TableCell>{row.template.installations}</TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
