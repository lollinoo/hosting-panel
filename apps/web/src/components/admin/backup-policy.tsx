"use client";

import { useRef, useState } from "react";
import { MAX_BACKUP_POLICY_TARGETS, type AdminBackupTargetDto, type BackupPolicyDto } from "@hosting-panel/contracts";
import { formatLocalHour, formatUtcHour } from "@/components/admin/backup-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

const BASE = "/api/admin/backup-policies";

export interface PolicyDraft {
  scheduleHourUtc?: number;
  retentionDays?: number;
  targetIds: string[];
}

export interface PolicyPatch {
  scheduleHourUtc?: number;
  retentionDays?: number;
  targetIds?: string[];
}

/** The PATCH body: only what differs from the saved policy. */
export function policyPatch(saved: BackupPolicyDto, draft: PolicyDraft): PolicyPatch {
  const patch: PolicyPatch = {};
  if (draft.scheduleHourUtc !== undefined && draft.scheduleHourUtc !== saved.scheduleHourUtc) patch.scheduleHourUtc = draft.scheduleHourUtc;
  if (draft.retentionDays !== undefined && draft.retentionDays !== saved.retentionDays) patch.retentionDays = draft.retentionDays;
  const savedIds = saved.targets.map((x) => x.targetId);
  if (draft.targetIds.join() !== savedIds.join()) patch.targetIds = draft.targetIds;
  return patch;
}

/** Ticks or clears a destination; a third one is refused. The order is the order they were ticked. */
export function toggleTarget(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids.filter((x) => x !== id);
  return ids.length >= MAX_BACKUP_POLICY_TARGETS ? ids : [...ids, id];
}

/** Destinations an administrator can pick: live and enabled, plus the ones the policy already uses. */
function choicesFor(targets: AdminBackupTargetDto[], policy: BackupPolicyDto): AdminBackupTargetDto[] {
  const used = new Set(policy.targets.map((x) => x.targetId));
  return targets.filter((x) => !x.archivedAt && (x.enabled || used.has(x.id)));
}

/** One card: optional hour and retention, and up to two destinations. */
function PolicyCard(p: {
  scope: "default" | "panel";
  csrfToken: string;
  policy: BackupPolicyDto;
  targets: AdminBackupTargetDto[];
  /** Hour and days stay read-only on the panel card. */
  editable: boolean;
  utcHour: number;
}) {
  const m = useMessages();
  const locale = useLocale();
  const t = m.admin.backups;
  const c = p.scope === "default" ? t.policy.sites : t.policy.panel;
  const keys = useRef<Record<string, string>>({});
  const [saved, setSaved] = useState(p.policy);
  const [hour, setHour] = useState(p.policy.scheduleHourUtc ?? p.utcHour);
  const [days, setDays] = useState(String(p.policy.retentionDays));
  const [targetIds, setTargetIds] = useState(() => [...p.policy.targets].sort((a, b) => a.priority - b.priority).map((x) => x.targetId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const choices = choicesFor(p.targets, saved);
  const chosenLocal = choices.some((x) => targetIds.includes(x.id) && x.kind === "local");
  const id = `policy-${p.scope}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const retentionDays = Number(days);
    if (p.editable && !(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 365)) {
      return setNotice({ ok: false, text: t.field.retention_days_invalid });
    }
    if (targetIds.length === 0) return setNotice({ ok: false, text: t.policy.targetRequired });
    const patch = policyPatch(saved, {
      ...(p.editable ? { scheduleHourUtc: hour, retentionDays } : {}),
      targetIds,
    });
    if (Object.keys(patch).length === 0) return setNotice({ ok: true, text: t.policy.unchanged });
    setBusy(true);
    setNotice(null);
    const sent = await keyedSend(keys.current, p.csrfToken, id, "PATCH", `${BASE}/${p.scope}`, patch);
    setBusy(false);
    if (!sent.ok) return setNotice({ ok: false, text: sent.code ? errorMessage(m, sent.code) : m.errors.generic });
    const next = (sent.data as { data?: BackupPolicyDto } | null)?.data;
    if (next) setSaved(next);
    setNotice({ ok: true, text: t.policy.saved });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{c.title}</CardTitle>
        <p className="text-sm text-muted-foreground">{c.hint}</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          {p.editable ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-hour`}>{t.policy.sites.hour}</Label>
                <select
                  id={`${id}-hour`}
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {format(t.hourOption, { utc: formatUtcHour(h), local: formatLocalHour(h, locale) })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-days`}>{t.policy.sites.retention}</Label>
                <Input id={`${id}-days`} type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t.retentionHint}</p>
              </div>
            </>
          ) : (
            <p className="text-sm">{format(t.policy.panel.schedule, { utc: formatUtcHour(p.utcHour), days: saved.retentionDays })}</p>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{c.destination}</legend>
            {choices.map((x) => {
              const checked = targetIds.includes(x.id);
              return (
                <label key={x.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`${id}-target`}
                    value={x.id}
                    checked={checked}
                    disabled={!checked && targetIds.length >= MAX_BACKUP_POLICY_TARGETS}
                    onChange={() => setTargetIds((ids) => toggleTarget(ids, x.id))}
                  />
                  <span>{format(t.policy.option, { name: x.name, kind: t.targets.kind[x.kind] })}</span>
                </label>
              );
            })}
            <p className="text-xs text-muted-foreground">{t.policy.destinationsHint}</p>
          </fieldset>
          {chosenLocal && (
            <Alert role="note">
              <AlertDescription>{t.localWarning}</AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert variant={notice.ok ? "default" : "destructive"} role={notice.ok ? "status" : "alert"}>
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? t.policy.saving : t.policy.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** The Policy tab: the sites default (hour, retention, destination) and the panel copy's destination. */
export function BackupPolicyForm({
  csrfToken,
  siteDefault,
  panel,
  targets,
}: {
  csrfToken: string;
  siteDefault: BackupPolicyDto;
  panel: BackupPolicyDto;
  targets: AdminBackupTargetDto[];
}) {
  const t = useMessages().admin.backups;
  if (!targets.some((x) => !x.archivedAt)) {
    return (
      <Alert role="status">
        <AlertDescription>{t.policy.noTargets}</AlertDescription>
      </Alert>
    );
  }
  const utcHour = siteDefault.scheduleHourUtc ?? 0;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">{t.policy.intro}</p>
      <PolicyCard scope="default" csrfToken={csrfToken} policy={siteDefault} targets={targets} editable utcHour={utcHour} />
      <PolicyCard scope="panel" csrfToken={csrfToken} policy={panel} targets={targets} editable={false} utcHour={utcHour} />
    </div>
  );
}
