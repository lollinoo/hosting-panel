"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminAppTemplateDetailDto, AdminAppTemplateUsageDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";

/** A built-in template is part of the product and an archived one is already gone from the catalog. */
export function canArchiveAppTemplate(t: Pick<AdminAppTemplateDetailDto, "archivedAt" | "builtIn">): boolean {
  return t.archivedAt === null && !t.builtIn;
}

/** One application template: whether customers are offered it, its versions (make default, new from), its installations and archiving. */
export function AppTemplateDetail({ template, usage, csrfToken }: {
  template: AdminAppTemplateDetailDto;
  usage: AdminAppTemplateUsageDto | null;
  csrfToken: string;
}) {
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const t = m.admin.appTemplates;
  const keys = useRef<Record<string, string>>({});
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archived = template.archivedAt !== null;
  const url = `/api/admin/app-templates/${encodeURIComponent(template.id)}`;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  /** One change at a time; the page is read again afterwards so it always shows the server's truth. */
  async function run(action: string, method: string, target: string, body: unknown, done: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    const sent = await keyedSend(keys.current, csrfToken, action, method, target, body);
    busyRef.current = false;
    setBusy(null);
    if (!sent.ok) {
      setNotice({ ok: false, text: appTemplateRefusalText(m, sent.code, sent.reason) });
      return;
    }
    setNotice({ ok: true, text: done });
    router.refresh();
  }

  async function archive() {
    await run("archive", "POST", `${url}/archive`, {}, t.detail.archived);
    setArchiving(false);
  }

  return (
    <div className="space-y-6">
      {busy !== null ? (
        <p role="status" className="text-sm text-muted-foreground">{t.detail.working}</p>
      ) : (
        notice && (
          <Alert variant={notice.ok ? "default" : "destructive"} role={notice.ok ? "status" : "alert"}>
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex items-start gap-2 text-sm">
            <input
              id="app-template-enabled"
              type="checkbox"
              role="switch"
              className="mt-1"
              aria-describedby="app-template-enabled-hint"
              checked={template.enabled}
              disabled={archived || template.defaultVersionId === null || busy !== null}
              onChange={(e) => void run(`enabled:${e.target.checked}`, "PATCH", url, { enabled: e.target.checked }, t.detail.saved)}
            />
            <div>
              <Label htmlFor="app-template-enabled">{t.detail.enabled}</Label>
              <p id="app-template-enabled-hint" className="text-muted-foreground">{t.detail.enabledHint}</p>
            </div>
          </div>
          {canArchiveAppTemplate(template) && (
            <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => setArchiving(true)}>
              {t.detail.archive}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.detail.versions}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.admin.templates.col.version}</TableHead>
                <TableHead>{t.detail.createdAt}</TableHead>
                <TableHead>{t.col.installations}</TableHead>
                <TableHead>{m.admin.templates.col.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {template.versions.map((v) => {
                const isDefault = v.id === template.defaultVersionId;
                return (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">
                      {format(t.versionLabel, { n: v.versionNumber })}
                      {isDefault && <Badge variant="success" className="ml-2">{t.detail.isDefault}</Badge>}
                    </TableCell>
                    <TableCell><time dateTime={v.createdAt}>{date.format(new Date(v.createdAt))}</time></TableCell>
                    <TableCell>{v.installations}</TableCell>
                    <TableCell className="space-x-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/templates/apps/${encodeURIComponent(template.id)}/edit?version=${encodeURIComponent(v.id)}`}>
                          {t.detail.newFrom}
                        </Link>
                      </Button>
                      {!isDefault && !archived && (
                        <Button type="button" size="sm" variant="outline" disabled={busy !== null}
                          onClick={() => void run(`default:${v.id}`, "PATCH", url, { defaultVersionId: v.id }, t.detail.saved)}>
                          {t.detail.makeDefault}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.detail.usage}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {usage === null ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t.detail.usageError}</AlertDescription>
            </Alert>
          ) : usage.stacks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.detail.usageEmpty}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.col.name}</TableHead>
                    <TableHead>{t.detail.usageCustomer}</TableHead>
                    <TableHead>{t.col.version}</TableHead>
                    <TableHead>{t.col.state}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.stacks.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell>{s.organizationName}</TableCell>
                      <TableCell>{format(t.versionLabel, { n: s.versionNumber })}</TableCell>
                      <TableCell><Badge variant="outline">{t.stackStatus[s.status]}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {usage.truncated && <p className="text-sm text-muted-foreground">{t.detail.usageTruncated}</p>}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={archiving} onOpenChange={(open) => { if (!open && !busyRef.current) setArchiving(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.detail.archiveTitle}</DialogTitle>
            <DialogDescription>{t.detail.archiveBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setArchiving(false)}>{m.common.cancel}</Button>
            <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => void archive()}>{t.detail.archiveConfirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
