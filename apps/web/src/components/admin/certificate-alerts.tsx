"use client";

import type { CertificateAlertDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";

export function CertificateAlerts({ alerts }: { alerts: CertificateAlertDto[] }) {
  const t = useMessages().admin.sites;
  const locale = useLocale();
  if (alerts.length === 0) return null;
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso)) : "");
  const line = (a: CertificateAlertDto) => {
    const v = { host: a.hostname, site: a.siteName ?? "", date: date(a.expiresAt), problem: t.alertsProblem[a.problem ?? "other"] };
    return format(a.kind === "expiring" ? t.alertsExpiring : a.kind === "not_issued" ? t.alertsNotIssued : t.alertsPanelExpiring, v);
  };
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{t.alertsTitle}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {alerts.map((a) => (
            <li key={`${a.kind}:${a.hostname}`}>{line(a)}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
