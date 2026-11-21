import { describe, expect, it } from "vitest";
import {
  CERTIFICATE_PROBLEM_REASONS,
  ERROR_CODES,
  PEM_SHAPE_REASONS,
  TLS_INVENTORY_FILTERS,
  type SiteDomainDto,
  type TlsCertificateDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { domainView } from "@/lib/domain-view";
import { certificatesCovering, expiryText, expiryView, parseInventoryQuery, tlsErrorText, tlsModeOf } from "@/lib/tls-view";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

const domain = (over: Partial<SiteDomainDto> = {}): SiteDomainDto => ({
  id: "d1",
  hostname: "shop.example.com",
  isPrimary: true,
  routed: true,
  challenge: "http-01",
  dns: { status: "ok", checkedAt: null, nextCheckAt: at(1), observedA: [], observedAaaa: [] },
  certificate: { status: "active", problem: null, expiresAt: at(60), retryAt: null, trusted: true },
  tls: { mode: "acme", certificateId: null, versionId: null, state: null, problem: null },
  ...over,
});
const manual = (state: "applying" | "active" | "failed" | null, over: Partial<SiteDomainDto> = {}) =>
  domain({ tls: { mode: "manual", certificateId: "cti_1", versionId: "ctv_1", state, problem: null }, ...over });

describe("expiryView", () => {
  it.each([
    [31, "ok", "success", "ok", "valid"],
    [30, "notice", "secondary", "clock", "days"],
    [14, "warning", "warning", "clock", "days"],
    [7, "critical", "destructive", "alert", "days"],
    [1, "critical", "destructive", "alert", "oneDay"],
    [0, "expired", "destructive", "alert", "expired"],
    [-1, "expired", "destructive", "alert", "expired"],
  ] as const)("%i days left -> %s", (days, tier, variant, icon, textKey) => {
    const v = expiryView(at(days), NOW);
    expect(v).toMatchObject({ tier, variant, icon, textKey });
    expect(v.daysLeft).toBe(days);
  });

  it("a certificate ending later today says today", () => {
    expect(expiryView(new Date(NOW.getTime() + 3_600_000), NOW)).toMatchObject({ tier: "critical", daysLeft: 0, textKey: "today" });
  });

  it("expiryText fills the sentence in both locales", () => {
    expect(expiryText(en, at(60), NOW, "en")).toMatch(/^Valid until /);
    expect(expiryText(itMsgs, at(60), NOW, "it")).not.toBe(expiryText(en, at(60), NOW, "en"));
    expect(expiryText(en, at(10), NOW, "en")).toBe("Expires in 10 days");
    expect(expiryText(en, at(1), NOW, "en")).toBe("Expires in 1 day");
    expect(expiryText(en, at(-3), NOW, "en")).toMatch(/^Expired on /);
  });

  it("fails closed on an unparsable date", () => {
    expect(expiryView("not a date", NOW).tier).toBe("expired");
  });
});

describe("tlsModeOf / certificatesCovering", () => {
  it("manual wins over the challenge; otherwise the challenge", () => {
    expect(tlsModeOf(manual("active", { challenge: "dns-01" }))).toBe("manual");
    expect(tlsModeOf(domain())).toBe("http-01");
    expect(tlsModeOf(domain({ challenge: "dns-01" }))).toBe("dns-01");
  });

  it("uses coveredDomains only, never the SAN list", () => {
    const cert = (id: string, covered: string[], sanDns: string[]) =>
      ({
        id,
        coveredDomains: covered.map((domainId) => ({ domainId, hostname: "x", assigned: false, versionId: null })),
        versions: [{ sanDns }],
      }) as unknown as TlsCertificateDto;
    const list = [cert("a", ["d1"], []), cert("b", [], ["shop.example.com"]), cert("c", ["d2", "d1"], [])];
    expect(certificatesCovering(list, "d1").map((c) => c.id)).toEqual(["a", "c"]);
    expect(certificatesCovering(list, "dX")).toEqual([]);
  });
});

describe("tlsErrorText", () => {
  const catalogs = { it: itMsgs, en } as const;
  const certCodes = ERROR_CODES.filter((c) => c.startsWith("CERTIFICATE_"));

  it("maps every PEM shape reason and every certificate problem reason of CERTIFICATE_INVALID to its own text", () => {
    for (const m of [itMsgs, en]) {
      const generic = tlsErrorText(m, "CERTIFICATE_INVALID", [])!;
      for (const reason of CERTIFICATE_PROBLEM_REASONS) {
        const text = tlsErrorText(m, "CERTIFICATE_INVALID", [{ field: "leafPem", reason }]);
        expect(text, reason).toBeTruthy();
        expect(text, reason).not.toBe(generic);
        expect(text, reason).not.toBe(m.errors.generic);
      }
    }
  });

  it("every PEM shape reason reads differently in Italian and English", () => {
    for (const reason of PEM_SHAPE_REASONS) {
      const d = [{ reason }];
      expect(tlsErrorText(itMsgs, "CERTIFICATE_INVALID", d), reason).not.toBe(tlsErrorText(en, "CERTIFICATE_INVALID", d));
    }
  });

  it("every CERTIFICATE_* code has its own text in both locales", () => {
    expect(certCodes.length).toBeGreaterThan(0);
    for (const [name, m] of Object.entries(catalogs)) {
      for (const code of certCodes) {
        const text = tlsErrorText(m, code, []);
        expect(text, `${name} ${code}`).toBeTruthy();
        expect(text, `${name} ${code}`).not.toBe(m.errors.generic);
      }
    }
    for (const code of certCodes) expect(tlsErrorText(itMsgs, code, []), code).not.toBe(tlsErrorText(en, code, []));
  });

  it("an unknown reason falls back to the code's text; other codes are not handled", () => {
    expect(tlsErrorText(en, "CERTIFICATE_INVALID", [{ reason: "toString" }])).toBe(en.errors.CERTIFICATE_INVALID);
    expect(tlsErrorText(en, "CERTIFICATE_KEY_MISMATCH", [{ reason: "required" }])).toBe(en.errors.CERTIFICATE_KEY_MISMATCH);
    expect(tlsErrorText(en, "VALIDATION_ERROR", [])).toBeNull();
  });
});

describe("parseInventoryQuery", () => {
  it("keeps a known filter, otherwise all", () => {
    for (const f of TLS_INVENTORY_FILTERS) expect(parseInventoryQuery({ filter: f }).filter).toBe(f);
    expect(parseInventoryQuery({ filter: "bogus" }).filter).toBe("all");
    expect(parseInventoryQuery({ filter: "constructor" }).filter).toBe("all");
    expect(parseInventoryQuery({}).filter).toBe("all");
  });

  it("takes the first array value, trims q and bounds it to 128", () => {
    expect(parseInventoryQuery({ filter: ["expired", "manual"], q: ["  shop  ", "x"] })).toEqual({ filter: "expired", q: "shop", site: null });
    expect(parseInventoryQuery({ q: "a".repeat(300) }).q).toHaveLength(128);
    expect(parseInventoryQuery({ q: ["", "x"] }).q).toBe("");
  });

  it("accepts a plain site id and drops anything else", () => {
    expect(parseInventoryQuery({ site: "site_1" }).site).toBe("site_1");
    expect(parseInventoryQuery({ site: "../x" }).site).toBeNull();
    expect(parseInventoryQuery({ site: "a".repeat(129) }).site).toBeNull();
  });
});

describe("domainView manual branch", () => {
  const view = (d: SiteDomainDto) => domainView(d, d, NOW);

  it("applying: muted, applying text, never secure", () => {
    expect(view(manual("applying"))).toEqual({ tone: "muted", label: "applyingCertificate", hint: null });
  });

  it("failed: error with the manual hint", () => {
    expect(view(manual("failed"))).toEqual({ tone: "error", label: "httpsProblem", hint: "manualApplyFailed" });
  });

  it("active: secure, or expired once the end date has passed", () => {
    expect(view(manual("active")).label).toBe("secure");
    const expired = manual("active", { certificate: { status: "active", problem: null, expiresAt: at(-1), retryAt: null, trusted: true } });
    expect(view(expired)).toEqual({ tone: "error", label: "httpsExpired", hint: null });
  });

  it("keeps the DNS gate for a manual domain, without the dns-01 exception", () => {
    const pending: SiteDomainDto["certificate"] = { status: "requested", problem: null, expiresAt: null, retryAt: null, trusted: false };
    const dns: SiteDomainDto["dns"] = { status: "not_found", checkedAt: null, nextCheckAt: at(1), observedA: [], observedAaaa: [] };
    expect(view(manual("active", { dns, certificate: pending, challenge: "dns-01" })).label).toBe("waitingForDns");
    expect(view(domain({ dns, certificate: pending, challenge: "dns-01" })).label).toBe("securing");
  });

  it("an unrouted manual domain is still being set up; an acme domain is unchanged", () => {
    expect(view(manual("applying", { routed: false })).label).toBe("settingUp");
    expect(view(domain()).label).toBe("secure");
  });
});
