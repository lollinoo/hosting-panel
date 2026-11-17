"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useMessages } from "@/i18n/provider";
import type { AuditEventDto } from "@hosting-panel/contracts";

export interface AuditTableProps {
  initialEvents: AuditEventDto[];
}

export function AuditTable({ initialEvents }: AuditTableProps) {
  const m = useMessages();
  const t = m.admin.audit;

  return (
    <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.colTime}</TableHead>
              <TableHead>{t.colActor}</TableHead>
              <TableHead>{t.colAction}</TableHead>
              <TableHead>{t.colOrg}</TableHead>
              <TableHead>{t.colTarget}</TableHead>
              <TableHead>{t.colDetails}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialEvents.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">
                  {t.empty}
                </TableCell>
              </TableRow>
            ) : (
              initialEvents.map((event) => (
                <TableRow key={event.id}>
                  <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                    {new Date(event.timestamp).toLocaleString(m.common.dateLocale)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="font-medium">{event.actorId || t.system}</div>
                    <Badge variant="outline" className="text-[9px]">
                      {event.actorType}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs font-semibold">
                    <Badge variant="secondary" className="text-[10px]">
                      {event.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs font-mono">
                    {event.organizationId || "-"}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">
                    {event.targetType}: {event.targetId || "-"}
                  </TableCell>
                  <TableCell className="text-xs font-mono max-w-xs truncate text-muted-foreground">
                    {JSON.stringify(event.details)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
    </div>
  );
}
