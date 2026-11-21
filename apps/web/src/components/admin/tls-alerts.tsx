"use client";

import Link from "next/link";
import { AlertTriangle, Clock } from "lucide-react";
import { CERTIFICATE_ALERT_TIERS, type TlsCertificateAlertDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { format } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";

/** Imported certificates close to their end date (warning, critical, expired); the 30-day notice is a row badge only. */
export function TlsAlerts({ alerts }: { alerts: TlsCertificateAlertDto[] | null }) {
  const t = useMessages().admin.certificates.inventory;
  const locale = useLocale();
  const shown = (alerts ?? []).filter((a) => (CERTIFICATE_ALERT_TIERS as readonly string[]).includes(a.tier));
  if (shown.length === 0) return null;
  const date = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  const urgent = shown.some((a) => a.tier !== "warning");
  return (
    <Alert variant={urgent ? "destructive" : "warning"} role={urgent ? "alert" : "status"}>
      <AlertTitle>{t.alerts.title}</AlertTitle>
      <AlertDescription>
        <ul className="space-y-1">
          {shown.map((a) => (
            <li key={`${a.certificateId}:${a.versionId}`} className="flex items-start gap-2">
              {a.tier === "warning" ? <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{format(t.alerts[a.tier], { name: a.certificateName, where: a.siteName ?? t.alerts.noSite, date: date(a.notAfter) })}</span>
            </li>
          ))}
        </ul>
        <Link href="/admin/certificates?filter=expiring" className="mt-2 inline-block underline">
          {t.alerts.showAll}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
