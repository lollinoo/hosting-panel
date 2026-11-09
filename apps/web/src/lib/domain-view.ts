import type { SiteDomainDto } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";

type Tone = "ok" | "warn" | "error" | "muted";
export type DomainLabel = keyof Messages["site"]["domains"]["state"];
export type DomainHint = keyof Messages["site"]["domains"]["hint"];

/** What the customer sees for one address; the first matching rule wins. */
export function domainView(
  d: SiteDomainDto,
  _primary: SiteDomainDto,
  now: Date,
): { tone: Tone; label: DomainLabel; hint: DomainHint | null } {
  if (!d.routed) return { tone: "muted", label: "settingUp", hint: null };
  if (d.dns.status !== "ok") {
    return { tone: "warn", label: "waitingForDns", hint: d.dns.status === "unchecked" ? null : d.dns.status };
  }
  const c = d.certificate;
  if (c.status === "requested") return { tone: "muted", label: "securing", hint: null };
  if (c.status === "failed") return { tone: "error", label: "httpsProblem", hint: c.problem ?? "other" };
  if (c.status === "active") {
    if (c.expiresAt !== null && new Date(c.expiresAt) <= now) return { tone: "error", label: "httpsExpired", hint: null };
    if (!c.trusted) return { tone: "warn", label: "testCertificate", hint: null };
    return { tone: "ok", label: "secure", hint: null };
  }
  return { tone: "muted", label: "securing", hint: null };
}
