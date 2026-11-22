import Link from "next/link";
import type { AdminAppTemplateSummaryDto } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, type Messages } from "@/i18n";

export const APP_TEMPLATE_STATE_BADGE = { draft: "secondary", published: "success", archived: "outline" } as const;

/** Chips shown per row: HTTP when the template publishes a web address, storage when it keeps data. Ports/Git: never (flags false, L0). */
export function appTemplateChips(t: Pick<AdminAppTemplateSummaryDto, "hasIngress" | "hasVolumes">): ("http" | "storage")[] {
  return [...(t.hasIngress ? (["http"] as const) : []), ...(t.hasVolumes ? (["storage"] as const) : [])];
}

/** The application templates, archived ones last. Server-compatible: it holds no state and takes the messages as a prop. */
export function AppTemplateList({ templates, m }: { templates: AdminAppTemplateSummaryDto[]; m: Messages }) {
  const t = m.admin.appTemplates;
  if (templates.length === 0) return <p className="text-sm text-muted-foreground">{t.empty}</p>;
  const categories: Record<string, string> = t.category;
  const archived = (tpl: AdminAppTemplateSummaryDto) => Number(tpl.state === "archived");
  const rows = [...templates].sort((a, b) => archived(a) - archived(b) || a.name.localeCompare(b.name));
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.col.name}</TableHead>
              <TableHead>{t.col.category}</TableHead>
              <TableHead>{t.col.version}</TableHead>
              <TableHead>{t.col.state}</TableHead>
              <TableHead>{t.col.installations}</TableHead>
              <TableHead>{t.col.capabilities}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((tpl) => (
              <TableRow key={tpl.id}>
                <TableCell className="font-medium">
                  <Link href={`/admin/templates/apps/${encodeURIComponent(tpl.id)}`} className="hover:underline">{tpl.name}</Link>
                </TableCell>
                <TableCell>{Object.hasOwn(categories, tpl.category) ? categories[tpl.category] : tpl.category}</TableCell>
                <TableCell>{tpl.defaultVersionNumber === null ? t.noVersion : format(t.versionLabel, { n: tpl.defaultVersionNumber })}</TableCell>
                <TableCell className="space-x-1">
                  <Badge variant={APP_TEMPLATE_STATE_BADGE[tpl.state]}>{t.state[tpl.state]}</Badge>
                  {tpl.builtIn && <Badge variant="outline">{t.builtIn}</Badge>}
                </TableCell>
                <TableCell>{tpl.installations}</TableCell>
                <TableCell className="space-x-1">
                  {appTemplateChips(tpl).map((chip) => (
                    <Badge key={chip} variant="outline">{t.chip[chip]}</Badge>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
