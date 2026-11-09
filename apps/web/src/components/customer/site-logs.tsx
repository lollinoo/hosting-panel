"use client";

import { useCallback, useEffect, useState } from "react";
import type { SiteLogLineDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";

export function SiteLogs({ orgId, siteId }: { orgId: string; siteId: string }) {
  const m = useMessages();
  const t = m.site.logs;
  const locale = useLocale();
  const [lines, setLines] = useState<SiteLogLineDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bff/orgs/${orgId}/managed-sites/${siteId}/logs?tail=200`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data)) setLines(body.data);
      else setError(res.status === 503 ? t.unavailable : errorMessage(m, body?.error?.code ?? ""));
    } catch {
      setError(m.errors.generic);
    } finally {
      setLoading(false);
    }
  }, [orgId, siteId, m, t.unavailable]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  // Newest first.
  const panel = (stream: SiteLogLineDto["stream"], title: string) => {
    const own = (lines ?? []).filter((l) => l.stream === stream).reverse();
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          {own.length === 0 ? (
            <CardDescription>{lines === null ? "" : t.empty}</CardDescription>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {own.map((l, i) => (
                <div key={i}>
                  {l.at && <time dateTime={l.at} className="text-muted-foreground">{when.format(new Date(l.at))} </time>}
                  {l.text}
                </div>
              ))}
            </pre>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? t.loading : t.refresh}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!error && (
        <div className="grid gap-4 lg:grid-cols-2">
          {panel("stdout", t.visits)}
          {panel("stderr", t.errors)}
        </div>
      )}
    </div>
  );
}
