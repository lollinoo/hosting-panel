"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isTerminalOperationStatus, SUPPORTED_PHP_VERSIONS, type SiteStatus } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DeleteSiteDialog } from "@/components/customer/delete-site-dialog";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { renewKeyAfter } from "@/lib/site-setup";

type Sent = { ok: true; operationId: string } | { ok: false; code: string };
type Outcome = { tone: "ok" | "error"; text: string };

export function SiteActions({
  orgId,
  siteId,
  siteName,
  status,
  phpVersion,
  csrfToken,
}: {
  orgId: string;
  siteId: string;
  siteName: string;
  status: SiteStatus;
  phpVersion: string;
  csrfToken: string;
}) {
  const m = useMessages();
  const t = m.site.manage;
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const alive = useRef(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [php, setPhp] = useState(phpVersion);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const base = `/api/bff/orgs/${orgId}/managed-sites/${siteId}`;
  const canStart = status === "stopped";
  const canStopOrRestart = status === "ready" || status === "degraded";

  // The key is kept after a 5xx or a lost reply, so retrying the same thing replays instead of repeating it.
  async function send(name: string, method: string, url: string, body: unknown): Promise<Sent> {
    const key = (keys.current[name] ??= crypto.randomUUID());
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 202 && data?.data?.operationId) {
        delete keys.current[name];
        return { ok: true, operationId: data.data.operationId };
      }
      if (renewKeyAfter(res.status)) delete keys.current[name];
      return { ok: false, code: data?.error?.code ?? "" };
    } catch {
      return { ok: false, code: "" };
    }
  }

  async function finish(operationId: string): Promise<"succeeded" | "failed" | null> {
    for (let i = 0; i < 150 && alive.current; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`/api/bff/orgs/${orgId}/operations/${operationId}`, { cache: "no-store" });
        const op = (await res.json().catch(() => null))?.data;
        if (op && isTerminalOperationStatus(op.status)) return op.status === "succeeded" ? "succeeded" : "failed";
      } catch {
        // keep trying; the page can be reloaded to see the final state
      }
    }
    return null;
  }

  async function run(name: string, method: string, url: string, body: unknown) {
    setBusy(name);
    setOutcome(null);
    const sent = await send(name, method, url, body);
    if (!sent.ok) {
      setOutcome({ tone: "error", text: errorMessage(m, sent.code) });
      setBusy(null);
      return;
    }
    router.refresh();
    const result = await finish(sent.operationId);
    if (!alive.current) return;
    setOutcome(
      result === "succeeded"
        ? { tone: "ok", text: t.done }
        : { tone: "error", text: result === "failed" ? t.failed : t.slow },
    );
    setBusy(null);
    router.refresh();
  }

  async function confirmDelete(confirmName: string): Promise<string | null> {
    const sent = await send(`delete:${confirmName}`, "DELETE", base, { confirmName });
    if (!sent.ok) return errorMessage(m, sent.code);
    router.push("/sites");
    return null;
  }

  const power = (action: "start" | "stop" | "restart", enabled: boolean) => (
    <Button
      type="button"
      variant="outline"
      disabled={!enabled || busy !== null}
      onClick={() => run(action, "POST", `${base}/actions`, { action })}
    >
      {busy === action ? t.working : t[action]}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-2">
          {power("start", canStart)}
          {power("stop", canStopOrRestart)}
          {power("restart", canStopOrRestart)}
        </div>

        <div className="space-y-2">
          <Label htmlFor="site-php-version">{t.phpVersion}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="site-php-version"
              value={php}
              onChange={(e) => setPhp(e.target.value)}
              disabled={busy !== null}
              className="flex h-9 w-28 rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {SUPPORTED_PHP_VERSIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null || php === phpVersion || status === "deploying" || status === "maintenance"}
              onClick={() => run(`php:${php}`, "PATCH", `${base}/runtime`, { phpVersion: php })}
            >
              {busy?.startsWith("php:") ? t.working : t.phpApply}
            </Button>
          </div>
          <CardDescription>{t.phpHint}</CardDescription>
        </div>

        <div aria-live="polite">
          {outcome && (
            <Alert variant={outcome.tone === "error" ? "destructive" : "default"} role={outcome.tone === "error" ? "alert" : "status"}>
              <AlertDescription>{outcome.text}</AlertDescription>
            </Alert>
          )}
        </div>

        <div className="space-y-2 rounded-md border border-destructive/40 p-4">
          <h3 className="text-sm font-medium text-destructive">{t.dangerTitle}</h3>
          <p className="text-sm text-muted-foreground">{t.dangerHint}</p>
          <Button type="button" variant="destructive" onClick={() => setDeleting(true)} disabled={busy !== null}>
            {t.delete}
          </Button>
        </div>
      </CardContent>
      <DeleteSiteDialog siteName={siteName} open={deleting} onOpenChange={setDeleting} onConfirm={confirmDelete} />
    </Card>
  );
}
