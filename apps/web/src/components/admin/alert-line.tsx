"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ALERT_SEVERITIES, type AdminAlertDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { worstSeverity } from "@/lib/admin-alerts";

/** An object with a string kind and a known severity; a kind newer than this page stays valid. */
const isAlert = (a: unknown): boolean =>
  typeof a === "object" && a !== null && typeof (a as { kind?: unknown }).kind === "string" &&
  (ALERT_SEVERITIES as readonly unknown[]).includes((a as { severity?: unknown }).severity);

/** The open alerts, or null when they could not be loaded. */
export async function loadAlerts(): Promise<AdminAlertDto[] | null> {
  try {
    const res = await fetch("/api/admin/alerts", { cache: "no-store" });
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    return res.ok && Array.isArray(body?.data) && body.data.every(isAlert) ? (body.data as AdminAlertDto[]) : null;
  } catch {
    return null;
  }
}

/** undefined = loading, [] = none, null = load failed. */
export function AlertLineView({ alerts }: { alerts: readonly AdminAlertDto[] | null | undefined }) {
  const t = useMessages().admin.alertLine;
  if (alerts === null) {
    return (
      <Alert variant="destructive" role="alert" className="mb-6">
        <AlertDescription>{t.failed}</AlertDescription>
      </Alert>
    );
  }
  const worst = alerts ? worstSeverity(alerts) : null;
  return (
    <div role="status">
      {alerts && worst ? (
        // role undefined: the polite status region announces it, not an interrupting alert
        <Alert variant={worst === "critical" ? "destructive" : "warning"} role={undefined} className="mb-6">
          <AlertDescription>
            {format(t.some, { n: alerts.length, severity: t.severity[worst] })}{" "}
            <Link href="/admin/health" className="underline">{t.link}</Link>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** The alert line on every admin page, loaded again on each change of page. */
export function AlertLine() {
  const pathname = usePathname();
  const [alerts, setAlerts] = useState<AdminAlertDto[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadAlerts().then((data) => {
      if (live) setAlerts(data);
    });
    return () => {
      live = false;
    };
  }, [pathname]);
  return <AlertLineView alerts={alerts} />;
}
