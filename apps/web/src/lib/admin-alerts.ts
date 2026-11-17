import { PANEL_CONTAINERS, type AdminAlertDto, type AlertSeverity } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";

/** A date and time with its zone: the server formats it, so the browser's zone may differ. */
export function formatZonedDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

/** The highest severity among the alerts, or null when there are none. */
export const worstSeverity = (alerts: readonly AdminAlertDto[]): AlertSeverity | null =>
  alerts.length === 0 ? null : alerts.some((a) => a.severity === "critical") ? "critical" : "warning";

/** The full sentence of an alert, with its next step; an unknown kind gets a neutral sentence. */
export function alertText(m: Messages, a: AdminAlertDto): string {
  const t = m.admin.health;
  const date = (iso: string | null) => (iso ? formatZonedDate(iso, m.common.dateLocale) : t.unknownDate);
  const problem = (p: string | null) => {
    const names = m.admin.sites.alertsProblem as Record<string, string>;
    return p && Object.hasOwn(names, p) ? names[p]! : names.other!;
  };
  const what = (kind: string, site: string | null) => (site ? format(t.operationOn, { kind, site }) : kind);
  switch (a.kind) {
    case "disk_high":
      return format(t.alerts.disk_high, { paths: a.details.paths.map((p) => t.disks[p]).join(", "), percent: a.details.usedPercent });
    case "certificate_expiring":
      return format(t.alerts.certificate_expiring, { host: a.details.hostname, site: a.details.siteName, date: date(a.details.expiresAt) })
        + (a.details.problem ? format(t.certificateProblem, { problem: problem(a.details.problem) }) : "");
    case "certificate_not_issued":
      return format(t.alerts.certificate_not_issued, { host: a.details.hostname, site: a.details.siteName, problem: problem(a.details.problem) });
    case "panel_certificate_expiring":
      return format(t.alerts.panel_certificate_expiring, { host: a.details.hostname, date: date(a.details.expiresAt) });
    case "backup_failed":
      return format(t.alerts.backup_failed, { site: a.details.siteName, date: date(a.details.failedAt) });
    case "panel_backup_failed":
      return format(t.alerts.panel_backup_failed, { date: date(a.details.failedAt) });
    case "backup_storage_test_failed":
      return format(t.alerts.backup_storage_test_failed, { date: date(a.details.testedAt) });
    case "component_down": {
      const d = a.details;
      return format(t.alerts.component_down, {
        part: t.components[d.component], state: t.states[d.state], reason: d.reason ? t.reasons[d.reason] : t.states.unknown, fix: t.fix[d.component],
      });
    }
    case "site_container_down":
      // R191 1.1: Restart on the site row recreates a missing container.
      return a.details.observed === "missing"
        ? format(t.siteContainerMissing, { site: a.details.siteName })
        : format(t.alerts.site_container_down, { site: a.details.siteName, observed: t.seen[a.details.observed] });
    case "restore_undo_incomplete":
      return format(t.alerts.restore_undo_incomplete, { site: a.details.siteName, date: date(a.details.failedAt) });
    case "restore_stuck":
      return format(t.alerts.restore_stuck, { site: a.details.siteName ?? a.details.operationId, date: date(a.details.startedAt) });
    case "operation_unknown":
    case "operation_stuck":
      return format(t.alerts[a.kind], { id: a.details.operationId, what: what(a.details.kind, a.details.siteName), date: date(a.since) });
    default:
      return t.unknownAlert; // a kind newer than this page
  }
}

export type AlertLink = { href: string; label: "openDomains" | "openBackups" | "openLog" };

/** Where the next step of an alert is done, or null when it is done on the server. */
export function alertLink(a: AdminAlertDto): AlertLink | null {
  switch (a.kind) {
    case "certificate_expiring":
    case "certificate_not_issued":
      return { href: `/admin/sites/${a.details.siteId}/domains`, label: "openDomains" };
    case "panel_certificate_expiring":
      return { href: "/admin/logs?source=ingress_proxy", label: "openLog" };
    case "backup_failed":
    case "panel_backup_failed":
    case "backup_storage_test_failed":
    case "restore_undo_incomplete":
    case "restore_stuck":
      return { href: "/admin/backups", label: "openBackups" };
    case "site_container_down":
      return { href: `/admin/logs?source=site:${a.details.siteId}`, label: "openLog" };
    case "component_down":
      return (PANEL_CONTAINERS as readonly string[]).includes(a.details.component)
        ? { href: `/admin/logs?source=${a.details.component}`, label: "openLog" }
        : null;
    default:
      return null;
  }
}
