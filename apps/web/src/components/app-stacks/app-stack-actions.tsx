"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { appStackEnqueueTarget, type AppStackDetailDto, type AppStackPlanDiffDto, type AppStackStatus } from "@hosting-panel/contracts";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appStackRefusalText } from "./app-stack-view";

export type StackAction = "start" | "stop" | "restart" | "deploy";
type QueuedAction = StackAction | "upgrade" | "rollback";
type Sent = Awaited<ReturnType<typeof keyedSend>>;
type PlanTarget = { templateVersionId: string } | { revisionId: string };

export function stackActionEnabled(action: QueuedAction, status: AppStackStatus): boolean {
  return appStackEnqueueTarget(`stack.${action}`, status) !== null;
}

export function AppStackActions({
  orgId,
  stackId,
  csrfToken,
  status,
  upgrade,
  rollback,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  status: AppStackStatus;
  upgrade: AppStackDetailDto["upgrade"];
  rollback: AppStackDetailDto["rollback"];
}) {
  const m = useMessages();
  const t = m.apps.actions;
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<QueuedAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [plan, setPlan] = useState<"upgrade" | "rollback" | null>(null);
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}`;
  const target: PlanTarget | null =
    plan === "upgrade" && upgrade ? { templateVersionId: upgrade.templateVersionId } : plan === "rollback" && rollback ? { revisionId: rollback.revisionId } : null;

  // One change at a time: null when another request is still out.
  async function run(action: QueuedAction, body: object): Promise<Sent | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(action);
    setNotice(null);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, action, "POST", `${base}/${action}`, body);
    busyRef.current = false;
    setBusy(null);
    if (sent.ok && typeof (sent.data as { data?: { operationId?: unknown } } | null)?.data?.operationId === "string") {
      setNotice(t.accepted);
      router.refresh();
    } else if (sent.ok) setError(appStackRefusalText(m, ""));
    else if (sent.reason !== "plan_changed") setError(appStackRefusalText(m, sent.code, sent.reason)); // the plan dialog plans again
    return sent;
  }

  const button = (action: QueuedAction, label: string, onClick: () => unknown) => (
    <Button type="button" variant="outline" disabled={busy !== null || !stackActionEnabled(action, status)} onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {button("start", t.start, () => run("start", {}))}
        {button("stop", t.stop, () => setStopping(true))}
        {button("restart", t.restart, () => run("restart", {}))}
        {button("deploy", status === "draft" ? t.install : t.reinstall, () => run("deploy", {}))}
        {upgrade && button("upgrade", format(m.apps.upgrade.open, { n: upgrade.versionNumber }), () => setPlan("upgrade"))}
        {rollback && button("rollback", format(m.apps.rollback.open, { n: rollback.templateVersionNumber }), () => setPlan("rollback"))}
      </div>
      <div aria-live="polite">
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <Dialog open={stopping} onOpenChange={(o) => !o && !busyRef.current && setStopping(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.stopTitle}</DialogTitle>
            <DialogDescription>{t.stopBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setStopping(false)}>
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy !== null}
              onClick={async () => {
                await run("stop", {});
                setStopping(false);
              }}
            >
              {t.stopConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {plan && target && (
        <PlanDialog
          mode={plan}
          base={base}
          csrfToken={csrfToken}
          target={target}
          busy={busy !== null}
          onSend={(planHash) => run(plan, { ...target, planHash })}
          onClose={() => !busyRef.current && setPlan(null)}
        />
      )}
    </div>
  );
}

/** Upgrade and rollback: the plan is asked on open, the confirm echoes its hash. */
function PlanDialog({
  mode,
  base,
  csrfToken,
  target,
  busy,
  onSend,
  onClose,
}: {
  mode: "upgrade" | "rollback";
  base: string;
  csrfToken: string;
  target: PlanTarget;
  busy: boolean;
  onSend: (planHash: string) => Promise<Sent | null>;
  onClose: () => void;
}) {
  const m = useMessages();
  const [diff, setDiff] = useState<AppStackPlanDiffDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  async function load() {
    setDiff(null);
    setAck(false);
    try {
      const res = await fetch(`${base}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(target),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.data) setDiff(body.data);
      else setError(appStackRefusalText(m, body?.error?.code ?? "", body?.error?.details?.[0]?.reason));
    } catch {
      setError(appStackRefusalText(m, ""));
    }
  }

  // Once per opening: the dialog mounts when it opens.
  useEffect(() => {
    void load();
  }, []);

  async function confirm() {
    if (!diff) return;
    const sent = await onSend(diff.planHash);
    if (sent && !sent.ok && sent.reason === "plan_changed") {
      setError(m.apps.reasons.plan_changed);
      return load();
    }
    if (sent) onClose();
  }

  const t = mode === "upgrade" ? m.apps.upgrade : m.apps.rollback;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          {mode === "rollback" && <DialogDescription>{m.apps.rollback.body}</DialogDescription>}
        </DialogHeader>
        {!diff && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.apps.upgrade.loading}
          </p>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {diff && <PlanDiff diff={diff} m={m} />}
        {diff?.dataRisk && (
          <div className="flex items-center gap-2">
            <input id="app-plan-ack" type="checkbox" required checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={busy} />
            <Label htmlFor="app-plan-ack">{m.apps.rollback.ack}</Label>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {m.apps.actions.cancel}
          </Button>
          <Button type="button" disabled={busy || !diff || (diff.dataRisk && !ack)} onClick={confirm}>
            {t.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanDiff({ diff, m }: { diff: AppStackPlanDiffDto; m: Messages }) {
  const t = m.apps.upgrade;
  const list = (title: string, rows: { key: string; change: keyof typeof t.change; note?: string }[]) =>
    rows.length > 0 && (
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{r.key}</span>
              <Badge variant="outline">{t.change[r.change]}</Badge>
              {r.note && <span className="text-muted-foreground">{r.note}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="space-y-3">
      {list(t.componentsTitle, diff.components.map((c) => ({ key: c.key, change: c.change, note: c.restart ? t.restarts : undefined })))}
      {list(t.dataTitle, diff.volumes)}
      {list(t.settingsTitle, diff.parameters)}
      {list(t.addressesTitle, diff.ingress.map((i) => ({ key: `${i.componentKey}:${i.port}`, change: i.change })))}
      {diff.downtime && (
        <Alert variant="warning" role="status">
          <AlertDescription>{t.downtime}</AlertDescription>
        </Alert>
      )}
      {diff.volumes.some((v) => v.change === "removed") && (
        <Alert variant="destructive" role="status">
          <AlertTriangle aria-hidden className="h-4 w-4" />
          <AlertDescription>{t.dataRemoved}</AlertDescription>
        </Alert>
      )}
      <p className="text-sm text-muted-foreground">{t.dataWarning}</p>
    </div>
  );
}
