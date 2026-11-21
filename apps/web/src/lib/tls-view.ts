import {
  certificateExpiryTier,
  TLS_INVENTORY_FILTERS,
  type CertificateExpiryTier,
  type SiteDomainDto,
  type TlsCertificateDto,
  type TlsInventoryFilter,
} from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";

/** How one address gets its certificate: the Let's Encrypt challenge in use, or an imported certificate. */
export function tlsModeOf(d: SiteDomainDto): "http-01" | "dns-01" | "manual" {
  return d.tls.mode === "manual" ? "manual" : d.challenge;
}

/** The certificates the API says cover a domain (`coveredDomains`); names are never matched against SANs here. */
export function certificatesCovering(list: readonly TlsCertificateDto[], domainId: string): TlsCertificateDto[] {
  return list.filter((c) => c.coveredDomains.some((d) => d.domainId === domainId));
}

export type ExpiryBadgeVariant = "success" | "secondary" | "warning" | "destructive";
export type ExpiryIcon = "ok" | "clock" | "alert";
/** The key of `site.domains.tls.expiry` to show: "valid until {date}", "expires in {n} days", 1 day, today, "expired on {date}". */
export type ExpiryTextKey = keyof Messages["site"]["domains"]["tls"]["expiry"];

const EXPIRY: Record<CertificateExpiryTier, { variant: ExpiryBadgeVariant; icon: ExpiryIcon }> = {
  ok: { variant: "success", icon: "ok" },
  notice: { variant: "secondary", icon: "clock" },
  warning: { variant: "warning", icon: "clock" },
  critical: { variant: "destructive", icon: "alert" },
  expired: { variant: "destructive", icon: "alert" },
};

/** Tier, days left and the text key + icon + badge variant to show for it (never colour alone). */
export function expiryView(notAfter: string | Date, now: Date) {
  const { tier, daysLeft } = certificateExpiryTier(notAfter, now);
  const textKey: ExpiryTextKey =
    tier === "ok" ? "valid" : tier === "expired" ? "expired" : daysLeft <= 0 ? "today" : daysLeft === 1 ? "oneDay" : "days";
  return { tier, daysLeft, textKey, ...EXPIRY[tier] };
}

/** The expiry sentence for a certificate end date. */
export function expiryText(m: Messages, notAfter: string | Date, now: Date, locale: string): string {
  const v = expiryView(notAfter, now);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(notAfter));
  return format(m.site.domains.tls.expiry[v.textKey], { date, n: v.daysLeft });
}

/** The text for a CERTIFICATE_* API error, or null for any other code (the caller falls back to its own text). */
export function tlsErrorText(
  m: Messages,
  code: string,
  details: ReadonlyArray<{ field?: string; reason?: string }> = [],
): string | null {
  if (!code.startsWith("CERTIFICATE_")) return null;
  if (code === "CERTIFICATE_INVALID") {
    const t = m.site.domains.tls;
    for (const { reason } of details) {
      if (!reason) continue;
      if (Object.hasOwn(t.pemReason, reason)) return (t.pemReason as Record<string, string>)[reason]!;
      if (Object.hasOwn(t.reason, reason)) return (t.reason as Record<string, string>)[reason]!;
    }
  }
  return errorMessage(m, code);
}

type Param = string | string[] | undefined;
const first = (v: Param): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** The admin inventory query from `searchParams`: unknown filter -> all, q trimmed to 128, first value of an array. */
export function parseInventoryQuery(sp: Record<string, Param>): { filter: TlsInventoryFilter; q: string; site: string | null } {
  const f = first(sp.filter);
  const filter = (TLS_INVENTORY_FILTERS as readonly string[]).includes(f) ? (f as TlsInventoryFilter) : "all";
  const site = first(sp.site).trim();
  return { filter, q: first(sp.q).trim().slice(0, 128), site: ID_SHAPE.test(site) ? site : null };
}
