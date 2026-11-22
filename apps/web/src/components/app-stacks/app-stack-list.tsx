import Link from "next/link";
import type { AppStackSummaryDto } from "@hosting-panel/contracts";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, type Locale, type Messages } from "@/i18n";
import { StackStatusBadge } from "./app-stack-status";

export function AppStackList({ stacks, m, locale }: { stacks: AppStackSummaryDto[]; m: Messages; locale: Locale }) {
  const t = m.apps.list;
  if (stacks.length === 0) return <p className="text-sm text-muted-foreground">{t.empty}</p>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
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
            {stacks.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">
                  <Link href={`/apps/${encodeURIComponent(s.id)}`} className="hover:underline">{s.name}</Link>
                </TableCell>
                <TableCell>
                  <StackStatusBadge status={s.status} m={m} />
                  {s.unhealthyCount > 0 && (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{format(t.unhealthy, { n: s.unhealthyCount })}</p>
                  )}
                </TableCell>
                <TableCell>{format(t.version, { name: s.templateName, n: s.templateVersionNumber })}</TableCell>
                <TableCell>{s.primaryHostname ?? <span className="text-muted-foreground">{t.noAddress}</span>}</TableCell>
                <TableCell>
                  <time dateTime={s.updatedAt}>{date.format(new Date(s.updatedAt))}</time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
