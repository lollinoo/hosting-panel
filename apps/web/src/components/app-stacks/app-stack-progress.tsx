"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isTerminalOperationStatus, type OperationDto } from "@hosting-panel/contracts";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useMessages } from "@/i18n/provider";

export const APP_STACK_POLL_MS = 2_000;
export const APP_STACK_POLL_LIMIT = 300; // 10 min (spec §10.2 deploy budget)
export type PollOutcome = "polling" | "done" | "slow" | "signedOut";

/** Follows one operation: the next poll waits for the previous answer, one refresh at the terminal status. */
export function useOperationPoll(orgId: string, operationId: string): { operation: OperationDto | null; outcome: PollOutcome; pollError: boolean } {
  const router = useRouter();
  const [operation, setOperation] = useState<OperationDto | null>(null);
  const [outcome, setOutcome] = useState<PollOutcome>("polling");
  const [pollError, setPollError] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let n = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/bff/orgs/${orgId}/operations/${operationId}`, { cache: "no-store" });
        if (!alive) return;
        if (res.status === 401) return setOutcome("signedOut");
        const body = res.ok ? await res.json().catch(() => null) : null;
        if (!alive) return;
        if (body?.data) {
          setOperation(body.data);
          setPollError(false);
          if (isTerminalOperationStatus(body.data.status)) {
            setOutcome("done");
            router.refresh();
            return;
          }
        } else setPollError(true);
      } catch {
        if (!alive) return;
        setPollError(true);
      }
      if (++n >= APP_STACK_POLL_LIMIT) return setOutcome("slow");
      timer = setTimeout(tick, APP_STACK_POLL_MS);
    };
    setOperation(null);
    setOutcome("polling");
    setPollError(false);
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [orgId, operationId, router]);

  return { operation, outcome, pollError };
}

export function AppStackProgress({ orgId, operationId }: { orgId: string; operationId: string }) {
  const m = useMessages();
  const t = m.apps.progress;
  const { operation, outcome, pollError } = useOperationPoll(orgId, operationId);
  const kind = operation?.kind.slice("stack.".length) ?? "deploy";
  const titles: Record<string, string> = t.title;
  // A backup and a restore have steps of their own beside the ones every stack operation has.
  const steps: Record<string, string> = { ...m.apps.steps, ...m.apps.backups.steps };
  const status = operation?.status;
  // The run of a task (ADR-0042) has one step and its own words.
  const isTask = operation?.kind === "stack.task";
  // They have no entry in the history: the reason of a failure is on the row of the backup.
  const failed = isTask ? t.taskFailed : kind === "backup" ? t.backupFailed : kind === "restore" ? t.restoreFailed : t.failed;
  const long = (kind === "backup" || kind === "restore") && outcome === "polling";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{Object.hasOwn(titles, kind) ? titles[kind] : t.title.deploy}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-2 text-sm" aria-live="polite">
          {operation?.steps.map((s) => {
            const Icon = s.status === "succeeded" ? CheckCircle2 : s.status === "failed" ? XCircle : s.status === "running" ? Loader2 : Circle;
            return (
              <li key={s.id} className="flex items-center gap-2" aria-current={s.status === "running" ? "step" : undefined}>
                <Icon aria-hidden className={`h-4 w-4 ${s.status === "running" ? "animate-spin" : ""}`} />
                <span>{isTask ? m.apps.tasks.step : Object.hasOwn(steps, s.key) ? steps[s.key] : steps.settle}</span>
                <span className="text-muted-foreground">{m.apps.stepStatus[s.status]}</span>
              </li>
            );
          })}
        </ol>
        {status === "succeeded" && (
          <p role="status" className="text-sm">
            {t.succeeded}
          </p>
        )}
        {(status === "failed" || status === "cancelled") && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{failed}</AlertDescription>
          </Alert>
        )}
        {status === "unknown" && (
          <Alert variant="warning" role="status">
            <AlertDescription>{t.unknown}</AlertDescription>
          </Alert>
        )}
        {long && <p className="text-xs text-muted-foreground">{t.longNote}</p>}
        {pollError && outcome === "polling" && (
          <p role="status" className="text-xs text-muted-foreground">
            {t.pollError}
          </p>
        )}
        {outcome === "slow" && (
          <p role="status" className="text-sm">
            {t.slow}
          </p>
        )}
        {outcome === "signedOut" && (
          <p role="status" className="text-sm">
            <Link href="/login" className="underline">
              {t.signedOut}
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
