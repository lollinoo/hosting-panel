"use client";

import * as React from "react";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Filter } from "lucide-react";
import { useMessages } from "@/i18n/provider";
import type { AuditEventDto } from "@hosting-panel/contracts";

export interface AuditTableProps {
  initialEvents: AuditEventDto[];
}

export function AuditTable({ initialEvents }: AuditTableProps) {
  const m = useMessages();
  const t = m.admin.audit;
  const [orgFilter, setOrgFilter] = React.useState("");
  const [actionFilter, setActionFilter] = React.useState("");

  const filtered = initialEvents.filter((event) => {
    const matchesOrg =
      !orgFilter ||
      (event.organizationId &&
        event.organizationId.toLowerCase().includes(orgFilter.toLowerCase()));
    const matchesAction =
      !actionFilter ||
      event.action.toLowerCase().includes(actionFilter.toLowerCase());
    return matchesOrg && matchesAction;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label={t.filterOrg}
            placeholder={t.filterOrg}
            value={orgFilter}
            onChange={(e) => setOrgFilter(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
        <div className="relative flex-1">
          <Filter aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label={t.filterAction}
            placeholder={t.filterAction}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="pl-8 text-xs"
          />
        </div>
      </div>

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
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground text-xs">
                  {t.empty}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((event) => (
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
    </div>
  );
}
