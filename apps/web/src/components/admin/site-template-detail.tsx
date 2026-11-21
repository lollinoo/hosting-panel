"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminSiteTemplateDetailDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

const BASE = "/api/admin/site-templates";

/** A built-in template is part of the product and an archived one is already gone from the catalog. */
export function canArchive(t: AdminSiteTemplateDetailDto): boolean {
  return !t.builtIn && t.archivedAt === null;
}

/** A template that is archived or no longer passes the checks stays so: "try again" would mislead, so these refusals say what is wrong. */
export function templateRefusalText(m: Messages, sent: { code: string; reason?: string }): string {
  if (sent.code === "RESOURCE_LOCKED" && sent.reason === "template_archived") return m.admin.templates.detail.archivedNotice;
  // The upgrade route answers RESOURCE_LOCKED; the enable and make-default PATCH answer VALIDATION_ERROR (field enabled).
  if ((sent.code === "RESOURCE_LOCKED" || sent.code === "VALIDATION_ERROR") && sent.reason === "template_invalid") return m.admin.templates.invalid;
  return errorMessage(m, sent.code);
}

/** One template: whether customers are offered it, its name, its versions (open, duplicate, make default) and archiving. */
export function SiteTemplateDetail({ template, csrfToken }: { template: AdminSiteTemplateDetailDto; csrfToken: string }) {
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const t = m.admin.templates.detail;
  const col = m.admin.templates.col;
  const keys = useRef<Record<string, string>>({});
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? "");
  const [archiving, setArchiving] = useState(false);
  const archived = template.archivedAt !== null;
  const url = `${BASE}/${template.id}`;

  /** One change at a time; the page is read again afterwards so it always shows the server's truth. */
  async function run(action: string, method: string, body: unknown, done: string) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    const sent = await keyedSend(keys.current, csrfToken, action, method, url, body);
    busyRef.current = false;
    setBusy(null);
    if (!sent.ok) {
      setNotice({ ok: false, text: templateRefusalText(m, sent) });
      return false;
    }
    setNotice({ ok: true, text: done });
    router.refresh();
    return true;
  }

  async function saveDetails() {
    if (await run("details", "PATCH", { name: name.trim(), description: description.trim() || null }, t.saved)) setEditing(false);
  }

  async function archive() {
    await run("archive", "DELETE", undefined, t.archived);
    setArchiving(false);
  }

  return (
    <div className="space-y-6">
      {notice && (
        <Alert variant={notice.ok ? "default" : "destructive"} role={notice.ok ? "status" : "alert"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="space-y-4 pt-6">
          {archived && (
            <Alert role="note">
              <AlertDescription>{t.archivedNotice}</AlertDescription>
            </Alert>
          )}
          {template.builtIn && <p className="text-sm text-muted-foreground">{t.builtInNotice}</p>}
          <label htmlFor="template-enabled" className="flex items-start gap-2 text-sm">
            <input
              id="template-enabled"
              type="checkbox"
              role="switch"
              className="mt-0.5"
              checked={template.enabled}
              disabled={archived || busy !== null}
              onChange={(e) => void run(`enabled:${e.target.checked}`, "PATCH", { enabled: e.target.checked }, t.saved)}
            />
            <span>
              <span className="block font-medium">{t.enabledLabel}</span>
              <span className="block text-muted-foreground">{t.enabledHint}</span>
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            {!archived && (
              <>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setName(template.name); setDescription(template.description ?? ""); setEditing(true); }}>
                  {t.editDetails}
                </Button>
                <Button asChild variant="outline">
                  <Link href={`/admin/templates/${template.id}/edit`}>{t.newVersion}</Link>
                </Button>
              </>
            )}
            <Button asChild variant="outline">
              <Link href={`/admin/templates/new?from=${template.id}`}>{t.duplicate}</Link>
            </Button>
            {canArchive(template) && (
              <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => setArchiving(true)}>
                {t.archive}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.versionsTitle}</CardTitle>
          <p className="text-sm text-muted-foreground">{format(t.sitesTotal, { count: template.siteCount })}</p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{col.version}</TableHead>
                <TableHead>{col.created}</TableHead>
                <TableHead>{col.sites}</TableHead>
                <TableHead>{col.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {template.versions.map((v) => {
                const isDefault = v.id === template.defaultVersionId;
                return (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">
                      {format(m.admin.templates.versionLabel, { version: v.versionNumber })}
                      {isDefault && <Badge variant="success" className="ml-2">{t.default}</Badge>}
                    </TableCell>
                    <TableCell>{new Date(v.createdAt).toLocaleString(locale)}</TableCell>
                    <TableCell>{v.siteCount}</TableCell>
                    <TableCell className="space-x-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/templates/${template.id}/edit?version=${v.id}`}>{t.open}</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/templates/new?from=${template.id}&version=${v.id}`}>{t.duplicate}</Link>
                      </Button>
                      {!isDefault && !archived && (
                        <Button type="button" size="sm" variant="outline" disabled={busy !== null}
                          onClick={() => void run(`default:${v.id}`, "PATCH", { defaultVersionId: v.id }, t.saved)}>
                          {t.makeDefault}
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

      <Dialog open={editing} onOpenChange={(open) => { if (!open && !busyRef.current) setEditing(false); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t.editDetails}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="template-name">{t.name}</Label>
              <Input id="template-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="template-description">{t.description}</Label>
              <Textarea id="template-description" rows={3} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setEditing(false)}>{t.cancel}</Button>
            <Button type="button" disabled={busy !== null || name.trim() === ""} onClick={() => void saveDetails()}>{t.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={archiving} onOpenChange={(open) => { if (!open && !busyRef.current) setArchiving(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{format(t.archiveTitle, { name: template.name })}</DialogTitle>
            <DialogDescription>{t.archiveBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setArchiving(false)}>{t.cancel}</Button>
            <Button type="button" variant="destructive" disabled={busy !== null} onClick={() => void archive()}>{t.archiveConfirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
