"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminSiteDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChangeOwnerDialog, type Customers } from "@/components/admin/change-owner-dialog";
import { DeleteSiteDialog, type ConfirmDelete } from "@/components/customer/delete-site-dialog";
import { StatusPill } from "@/components/customer/status-pill";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export function SitesTable({ sites, customers, csrfToken }: { sites: AdminSiteDto[]; customers: Customers; csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.sites;
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const [moving, setMoving] = React.useState<AdminSiteDto | null>(null);
  const [deleting, setDeleting] = React.useState<AdminSiteDto | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ error: boolean; text: string } | null>(null);

  async function retry(site: AdminSiteDto) {
    setBusy(site.id);
    setNotice(null);
    // Retrying a failed owner change re-issues it on the API side; the call is the same.
    const sent = await keyedSend(keys.current, csrfToken, `retry:${site.id}`, "POST", `/api/admin/sites/${site.id}/actions`, { action: "retry" });
    setBusy(null);
    setNotice(sent.ok ? { error: false, text: t.accepted } : { error: true, text: errorMessage(m, sent.code) });
    if (sent.ok) router.refresh();
  }

  const confirmDelete: ConfirmDelete = async (confirmName) => {
    const site = deleting!;
    const sent = await keyedSend(keys.current, csrfToken, `delete:${site.id}:${confirmName}`, "DELETE", `/api/admin/sites/${site.id}`, { confirmName });
    if (!sent.ok) return errorMessage(m, sent.code);
    setDeleting(null);
    router.refresh();
    return null;
  };

  if (sites.length === 0) return <p className="text-sm text-muted-foreground">{t.empty}</p>;

  return (
    <div className="space-y-3">
      {notice && (
        <Alert variant={notice.error ? "destructive" : "default"} role={notice.error ? "alert" : "status"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.colName}</TableHead>
            <TableHead>{t.colDomain}</TableHead>
            <TableHead>{t.colOwner}</TableHead>
            <TableHead>{t.colPhp}</TableHead>
            <TableHead>{t.colStatus}</TableHead>
            <TableHead>{t.colActions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sites.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{s.name}</TableCell>
              <TableCell>{s.primaryDomain ?? "-"}</TableCell>
              <TableCell>{s.owner?.name ?? t.unassigned}</TableCell>
              <TableCell>{s.phpVersion ?? "-"}</TableCell>
              <TableCell>
                <StatusPill status={s.status} labels={m.site.status} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setMoving(s)}>
                    {t.changeOwner}
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/admin/sites/${s.id}/domains`}>{t.domains}</Link>
                  </Button>
                  {s.status === "degraded" && (
                    <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => retry(s)}>
                      {busy === s.id ? t.working : t.retry}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="destructive" onClick={() => setDeleting(s)}>
                    {t.delete}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ChangeOwnerDialog site={moving} customers={customers} csrfToken={csrfToken} onClose={() => setMoving(null)} />
      <DeleteSiteDialog
        siteName={deleting?.name ?? ""}
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
