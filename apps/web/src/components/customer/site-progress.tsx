"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isTerminalOperationStatus, type OperationDto } from "@hosting-panel/contracts";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";

export const PROVISION_STEPS = ["create_database", "deploy_site", "install_wordpress", "publish_site", "finish"] as const;

type Progress = Pick<OperationDto, "id" | "status" | "steps">;

/** Follows the latest setup of a site. The operation id comes from the server, so a reload resumes it. */
export function SiteProgress({
  orgId,
  siteId,
  csrfToken,
  initial,
}: {
  orgId: string;
  siteId: string;
  csrfToken: string;
  initial: Progress | null;
}) {
  const m = useMessages();
  const router = useRouter();
  const [op, setOp] = useState<Progress | null>(initial);
  const [pollFailed, setPollFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opId = op?.id;
  const done = op ? isTerminalOperationStatus(op.status) : false;
  const failed = op?.status === "failed" || op?.status === "cancelled";
  const refreshed = useRef(false);

  useEffect(() => {
    if (!opId || done) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/bff/orgs/${orgId}/operations/${opId}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (stop) return;
        if (res.ok && body?.data) {
          setOp(body.data);
          setPollFailed(false);
        } else setPollFailed(true);
      } catch {
        if (!stop) setPollFailed(true);
      }
    };
    const timer = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [orgId, opId, done]);

  // Once the setup succeeded the page re-renders as a normal site.
  useEffect(() => {
    if (op?.status === "succeeded" && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [op?.status, router]);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/managed-sites/${siteId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action: "retry" }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 202 && body?.data?.operationId) {
        setOp({ id: body.data.operationId, status: "accepted", steps: [] });
      } else setError(errorMessage(m, body?.error?.code ?? ""));
    } catch {
      setError(m.errors.generic);
    } finally {
      setRetrying(false);
    }
  }

  const stepStatus = (key: string) => op?.steps.find((s) => s.key === key)?.status;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{m.site.progress.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2 text-sm" aria-live="polite">
          {PROVISION_STEPS.map((key) => {
            const s = stepStatus(key);
            const Icon = s === "succeeded" ? CheckCircle2 : s === "failed" ? XCircle : s === "running" ? Loader2 : Circle;
            return (
              <li key={key} className="flex items-center gap-2" aria-current={s === "running" ? "step" : undefined}>
                <Icon
                  aria-hidden
                  className={`h-4 w-4 ${s === "running" ? "animate-spin" : ""} ${s === "failed" ? "text-destructive" : s === "succeeded" ? "text-green-600" : "text-muted-foreground"}`}
                />
                <span className={s ? "" : "text-muted-foreground"}>{m.site.progress[key]}</span>
              </li>
            );
          })}
        </ol>
        {pollFailed && !done && (
          <p role="status" className="text-xs text-muted-foreground">
            {m.site.progress.pollError}
          </p>
        )}
        {failed && (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="space-y-3">
              <p>{m.site.progress.failed}</p>
              {error && <p>{error}</p>}
              <Button type="button" size="sm" onClick={retry} disabled={retrying}>
                {retrying ? m.site.progress.retrying : m.site.progress.retry}
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
