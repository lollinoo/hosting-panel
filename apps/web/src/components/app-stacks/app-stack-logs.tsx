"use client";

import { useState } from "react";
import type { AppStackComponentLogsDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useLocale, useMessages } from "@/i18n/provider";

export const APP_STACK_LOG_TAIL = 200;
type Lines = AppStackComponentLogsDto["lines"];

/** Recent lines of one component, loaded on request, newest first. */
export function AppStackLogs({ orgId, stackId, componentKeys }: { orgId: string; stackId: string; componentKeys: string[] }) {
  const m = useMessages();
  const t = m.apps.logs;
  const locale = useLocale();
  const [key, setKey] = useState(componentKeys[0] ?? "");
  const [lines, setLines] = useState<Lines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/app-stacks/${stackId}/components/${encodeURIComponent(key)}/logs?tail=${APP_STACK_LOG_TAIL}`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data?.lines)) setLines([...(body.data.lines as Lines)].reverse());
      else setError(res.status === 503 ? t.unavailable : res.status === 404 ? t.notFound : res.status === 429 ? t.busy : t.error);
    } catch {
      setError(t.error);
    } finally {
      setLoading(false);
    }
  }

  function choose(next: string) {
    setKey(next);
    setLines(null);
    setError(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="app-logs-component">{t.component}</Label>
          <select
            id="app-logs-component"
            value={key}
            onChange={(e) => choose(e.target.value)}
            className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {componentKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" onClick={load} disabled={loading || !key}>
          {lines === null ? t.load : t.refresh}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {loading ? t.loading : ""}
      </p>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {lines !== null &&
        (lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ol className="max-h-96 space-y-0.5 overflow-auto rounded-md border p-3 font-mono text-xs">
            {lines.map((l, i) => (
              <li key={i} className="flex gap-2 whitespace-pre-wrap break-all">
                <span>{t.stream[l.stream]}</span>
                {l.at && <time dateTime={l.at}>{date.format(new Date(l.at))}</time>}
                {l.text}
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}
