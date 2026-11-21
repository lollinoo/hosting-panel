import Link from "next/link";
import { SITE_TYPE_KEYS, type AdminSiteTemplateSummaryDto } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, type Messages } from "@/i18n";

export type TemplateStatusKey = "builtIn" | "enabled" | "disabled" | "archived";

export const STATUS_BADGE_VARIANT = { enabled: "success", disabled: "secondary", archived: "outline", builtIn: "outline" } as const;

/** An archived template is only "archived" (a built-in one cannot be archived); otherwise built-in, then offered or not. */
export function templateStatusKeys(t: AdminSiteTemplateSummaryDto): TemplateStatusKey[] {
  if (t.archivedAt !== null) return ["archived"];
  return [...(t.builtIn ? (["builtIn"] as const) : []), t.enabled ? "enabled" : "disabled"];
}

const rank = (t: AdminSiteTemplateSummaryDto) => (t.archivedAt !== null ? 2 : t.builtIn ? 0 : 1);

/** Known modules in catalog order, unknown ones after (alphabetical); inside a group: built-in, live by name, archived. */
export function groupByModule(templates: readonly AdminSiteTemplateSummaryDto[]): { module: string; templates: AdminSiteTemplateSummaryDto[] }[] {
  const known = SITE_TYPE_KEYS as readonly string[];
  const order = (module: string) => known.indexOf(module);
  const modules = [...new Set(templates.map((t) => t.module as string))].sort((a, b) => {
    const [ia, ib] = [order(a), order(b)];
    if (ia >= 0 && ib >= 0) return ia - ib;
    return ia >= 0 ? -1 : ib >= 0 ? 1 : a.localeCompare(b);
  });
  return modules.map((module) => ({
    module,
    templates: templates.filter((t) => t.module === module).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
  }));
}

/** The catalog of templates, one card per module. Server-compatible: it holds no state and takes the messages as a prop. */
export function SiteTemplateList({ templates, m }: { templates: AdminSiteTemplateSummaryDto[]; m: Messages }) {
  const t = m.admin.templates;
  if (templates.length === 0) return <p className="text-sm text-muted-foreground">{t.empty}</p>;
  const moduleNames = t.modules as Record<string, string>;
  return (
    <div className="space-y-6">
      {groupByModule(templates).map((group) => (
        <Card key={group.module}>
          <CardHeader>
            <CardTitle>
              {moduleNames[group.module] ?? group.module}
              <span className="ml-2 text-sm font-normal text-muted-foreground">{format(t.moduleCount, { count: group.templates.length })}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.col.name}</TableHead>
                  <TableHead>{t.col.status}</TableHead>
                  <TableHead>{t.col.defaultVersion}</TableHead>
                  <TableHead>{t.col.versions}</TableHead>
                  <TableHead>{t.col.sites}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.templates.map((tpl) => (
                  <TableRow key={tpl.id} className={tpl.archivedAt !== null ? "opacity-60" : undefined}>
                    <TableCell className="font-medium">
                      <Link href={`/admin/templates/${tpl.id}`} className="hover:underline">{tpl.name}</Link>
                    </TableCell>
                    <TableCell className="space-x-1">
                      {templateStatusKeys(tpl).map((key) => (
                        <Badge key={key} variant={STATUS_BADGE_VARIANT[key]}>{t.status[key]}</Badge>
                      ))}
                    </TableCell>
                    <TableCell>{format(t.versionLabel, { version: tpl.defaultVersionNumber })}</TableCell>
                    <TableCell>{tpl.versionCount}</TableCell>
                    <TableCell>{tpl.siteCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
