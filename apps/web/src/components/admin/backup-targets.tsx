"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminBackupTargetDto, BackupTargetsDto } from "@hosting-panel/contracts";
import { backupProblemText, formatDateTime } from "@/components/admin/backup-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { formatSize } from "@/lib/file-browser";
import { keyedSend } from "@/lib/keyed-send";

const BASE = "/api/admin/backup-targets";
/** The same floor the health alert uses (apps/api admin-health.service): under 1 GiB or a tenth of the disk. */
const LOW_SPACE_FLOOR_BYTES = 1024 ** 3;

type LastTest = AdminBackupTargetDto["lastTest"];

/** A row can be deleted only when nothing references it and it is not the original settings. */
export function canDeleteTarget(target: AdminBackupTargetDto): boolean {
  return !target.legacy && target.usage.copies === 0;
}

export function isLowSpace(test: LastTest): boolean {
  if (!test || test.availableBytes === null || test.totalBytes === null) return false;
  return test.availableBytes < Math.max(LOW_SPACE_FLOOR_BYTES, test.totalBytes / 10);
}

/** The state of a row in words: archived, enabled or disabled, and the last test with its problem. */
export function targetStateText(m: Messages, target: AdminBackupTargetDto, locale: string): string {
  const s = m.admin.backups.targets.state;
  if (target.archivedAt) return s.archived;
  const base = target.enabled ? s.enabled : s.disabled;
  const test = target.lastTest;
  if (!test) return `${base} · ${s.neverTested}`;
  const when = formatDateTime(test.at, locale);
  return test.outcome === "ok"
    ? `${base} · ${format(s.testOk, { when })}`
    : `${base} · ${format(s.testFailed, { when })} ${backupProblemText(m.admin.backups, test.problem)}`;
}

export function targetErrorText(m: Messages, code: string): string {
  if (code === "BACKUP_TARGET_IN_USE") return m.admin.backups.targets.inUse;
  return code ? errorMessage(m, code) : m.admin.backups.targets.saveFailed;
}

type Pending = { kind: "archive" | "delete" | "initialise"; target: AdminBackupTargetDto };

/** All backup destinations, with the switches, archive, delete and the local-destination card. */
export function BackupTargets({
  csrfToken,
  initial,
  localAvailable,
}: {
  csrfToken: string;
  initial: BackupTargetsDto;
  localAvailable: boolean;
}) {
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const t = m.admin.backups.targets;
  const keys = useRef<Record<string, string>>({});
  const busyRef = useRef(false);
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState(t.local.defaultName);

  async function reload() {
    try {
      const res = await fetch(BASE, { headers: { Accept: "application/json" } });
      const body = (await res.json().catch(() => null)) as { data?: BackupTargetsDto } | null;
      if (res.ok && body?.data) return setData(body.data);
    } catch {
      /* fall through to a server refresh */
    }
    router.refresh();
  }

  /** One mutation at a time; the list is read again afterwards so the rows always show the server's truth. */
  async function run(action: string, method: string, url: string, body: unknown, done: string | null) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    const sent = await keyedSend(keys.current, csrfToken, action, method, url, body);
    busyRef.current = false;
    setBusy(null);
    if (!sent.ok) {
      setNotice({ ok: false, text: action.startsWith("test:") && sent.code === "" ? t.test.ambiguous : targetErrorText(m, sent.code) });
      return false;
    }
    setNotice(done === null ? null : { ok: true, text: done });
    await reload();
    return true;
  }

  const patch = (target: AdminBackupTargetDto, body: Record<string, unknown>, done = t.saved) =>
    run(`patch:${target.id}`, "PATCH", `${BASE}/${target.id}`, body, done);

  async function confirm() {
    if (!pending) return;
    const { kind, target } = pending;
    // A refusal keeps its sentence on the page; the dialog closes either way.
    if (kind === "archive") await patch(target, { archived: true }, t.archive.done);
    else if (kind === "delete") await run(`delete:${target.id}`, "DELETE", `${BASE}/${target.id}`, undefined, t.delete.done);
    else await run(`init:${target.id}`, "POST", `${BASE}/${target.id}/initialize`, {}, t.local.initialiseDone);
    setPending(null);
  }

  const live = data.targets.filter((x) => !x.archivedAt);
  const local = live.find((x) => x.kind === "local") ?? null;
  const dialog = pending && {
    archive: { title: format(t.archive.title, { name: pending.target.name }), body: t.archive.body, confirm: t.archive.confirm, cancel: t.archive.cancel },
    delete: { title: format(t.delete.title, { name: pending.target.name }), body: t.delete.body, confirm: t.delete.confirm, cancel: t.delete.cancel },
    initialise: { title: t.local.initialiseTitle, body: t.local.initialiseBody, confirm: t.local.initialiseConfirm, cancel: t.local.initialiseCancel },
  }[pending.kind];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.title}</CardTitle>
          <p className="text-sm text-muted-foreground">{t.intro}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice && (
            <Alert variant={notice.ok ? "default" : "destructive"} role={notice.ok ? "status" : "alert"}>
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}
          {data.targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.name}</TableHead>
                  <TableHead>{t.columns.kind}</TableHead>
                  <TableHead>{t.columns.state}</TableHead>
                  <TableHead>{t.columns.backups}</TableHead>
                  <TableHead>{t.columns.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.targets.map((x) => {
                  const archived = x.archivedAt !== null;
                  const rowBusy = busy !== null;
                  return (
                    <TableRow key={x.id}>
                      <TableCell className="font-medium">
                        {x.name}
                        {x.legacy && <Badge variant="secondary" className="ml-2">{t.legacy}</Badge>}
                      </TableCell>
                      <TableCell>{t.kind[x.kind]}</TableCell>
                      <TableCell className="space-y-2">
                        <p className="text-sm">{targetStateText(m, x, locale)}</p>
                        <div className="flex flex-col gap-1 text-sm">
                          <SwitchField id={`enabled-${x.id}`} label={t.switches.enabled} hint={t.switches.enabledHint}
                            name={x.name} checked={x.enabled} disabled={archived || rowBusy}
                            onChange={(v) => void patch(x, { enabled: v })} />
                          <SwitchField id={`selectable-${x.id}`} label={t.switches.customerSelectable} hint={t.switches.customerSelectableHint}
                            name={x.name} checked={x.customerSelectable} disabled={archived || rowBusy}
                            onChange={(v) => void patch(x, { customerSelectable: v })} />
                        </div>
                      </TableCell>
                      <TableCell>{format(t.copiesCount, { count: x.usage.copies })}</TableCell>
                      <TableCell className="space-x-2">
                        {!archived && (
                          <Button type="button" size="sm" variant="outline" disabled={rowBusy} onClick={() => setPending({ kind: "archive", target: x })}>
                            {t.archive.button}
                          </Button>
                        )}
                        {canDeleteTarget(x) && (
                          <Button type="button" size="sm" variant="destructive" disabled={rowBusy} onClick={() => setPending({ kind: "delete", target: x })}>
                            {t.delete.button}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {localAvailable && (
        <Card>
          <CardHeader>
            <CardTitle>{t.local.title}</CardTitle>
            <p className="text-sm text-muted-foreground">{t.local.intro}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert role="note">
              <AlertDescription>{m.admin.backups.localWarning}</AlertDescription>
            </Alert>
            {local ? (
              <LocalDetails target={local} busy={busy} onInitialise={() => setPending({ kind: "initialise", target: local })}
                onTest={() => void run(`test:${local.id}`, "POST", `${BASE}/${local.id}/test`, {}, null)} />
            ) : (
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("create", "POST", BASE, { kind: "local", name: name.trim() }, t.saved);
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="local-target-name">{t.local.name}</Label>
                  <Input id="local-target-name" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} />
                </div>
                <Button type="submit" disabled={busy !== null || !data.localRootConfigured || name.trim() === ""}>
                  {busy === "create" ? t.local.adding : t.local.add}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setPending(null); }}>
        <DialogContent>
          {dialog && (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
                <DialogDescription>{dialog.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setPending(null)}>{dialog.cancel}</Button>
                <Button type="button" variant={pending.kind === "delete" ? "destructive" : "default"} disabled={busy !== null} onClick={() => void confirm()}>
                  {dialog.confirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SwitchField(p: { id: string; label: string; hint: string; name: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const t = useMessages().admin.backups.targets;
  return (
    <label htmlFor={p.id} className="flex items-center gap-2" title={p.hint}>
      <input id={p.id} type="checkbox" role="switch" checked={p.checked} disabled={p.disabled}
        aria-label={`${p.label} — ${format(t.switches.label, { name: p.name })}`}
        onChange={(e) => p.onChange(e.target.checked)} />
      <span>{p.label}</span>
    </label>
  );
}

function LocalDetails({ target, busy, onInitialise, onTest }: { target: AdminBackupTargetDto; busy: string | null; onInitialise: () => void; onTest: () => void }) {
  const m = useMessages();
  const locale = useLocale();
  const t = m.admin.backups.targets;
  const test = target.lastTest;
  const available = test?.availableBytes ?? null;
  const total = test?.totalBytes ?? null;
  const testing = busy === `test:${target.id}`;
  const initialising = busy === `init:${target.id}`;
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{target.name}</p>
      <div>
        <p className="text-muted-foreground">{t.local.root}</p>
        <code className="block rounded bg-muted px-2 py-1">{target.local?.root ?? "—"}</code>
        <p className="text-xs text-muted-foreground">{t.local.rootHint}</p>
      </div>
      <p>
        {target.local?.initializedAt
          ? format(t.local.initialised, { when: formatDateTime(target.local.initializedAt, locale) })
          : t.local.notInitialised}
      </p>
      <p>{targetStateText(m, target, locale)}</p>
      <p>
        {available !== null && total !== null
          ? format(t.capacity, { free: formatSize(available, locale), total: formatSize(total, locale) })
          : t.capacityUnknown}
      </p>
      {isLowSpace(test) && available !== null && total !== null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {format(t.lowSpace, { free: formatSize(available, locale), total: formatSize(total, locale) })}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" disabled={busy !== null} onClick={onInitialise}>
          {initialising ? t.local.initialising : t.local.initialise}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={onTest}>
          {testing ? t.test.testing : t.test.button}
        </Button>
      </div>
    </div>
  );
}
