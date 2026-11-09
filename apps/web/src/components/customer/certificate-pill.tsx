import type { SiteDomainDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { domainView } from "@/lib/domain-view";

const VARIANT = { ok: "success", warn: "warning", error: "destructive", muted: "secondary" } as const;

/** HTTPS state of one address; a working certificate shows its end date. */
export function CertificatePill({
  domain,
  primary,
  m,
  locale,
  now,
}: {
  domain: SiteDomainDto;
  primary: SiteDomainDto;
  m: Messages;
  locale: string;
  now: Date;
}) {
  const view = domainView(domain, primary, now);
  const exp = domain.certificate.expiresAt;
  const text =
    view.label === "secure" && exp
      ? format(m.site.domains.pill.validUntil, { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(exp)) })
      : m.site.domains.state[view.label];
  return <Badge variant={VARIANT[view.tone]}>{text}</Badge>;
}
