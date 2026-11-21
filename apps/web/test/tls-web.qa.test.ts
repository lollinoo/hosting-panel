// QA (independent) for the manual TLS web surface: HTML hygiene, sources, copy, a11y, BFF refusals, i18n.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Children, cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CERTIFICATE_PROBLEM_REASONS, ERROR_CODES } from "@hosting-panel/contracts";
import type { SiteDomainDto, SiteDomainsDto, TlsCertificateDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const h = vi.hoisted(() => ({ locale: "en" as "en" | "it" }));
const fetchUpstream = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf", user: {} }),
  getSessionFromRequest: (...a: unknown[]) => getSession(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => h.locale }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/app/sites/data", () => ({
  getCustomerContext: async () => ({ orgId: "o1", session: { csrfToken: "csrf" }, capabilities: { manualTlsCertificatesAvailable: true } }),
  getSite: async () => ({ ok: true, data: { id: "s1" } }),
}));

import SiteDomainsPage from "@/app/sites/[siteId]/domains/page";
import AdminSiteDomainsPage from "@/app/admin/sites/[siteId]/domains/page";
import AdminCertificatesPage from "@/app/admin/certificates/page";
import { CertificatePill } from "@/components/customer/certificate-pill";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { ImportFormStep, ReviewStep, reviewDomains, reviewRows, TlsImportDialog, EMPTY_PEM } from "@/components/customer/tls-import-dialog";
import { TlsAlerts } from "@/components/admin/tls-alerts";
import { domainView } from "@/lib/domain-view";
import { tlsErrorText } from "@/lib/tls-view";
import * as importRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/route";
import * as versionsRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import * as activateRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/versions/[versionId]/activate/route";
import * as domainTlsRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/tls/route";
import * as adminImportRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/route";
import * as adminVersionsRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import * as adminActivateRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/versions/[versionId]/activate/route";
import * as adminDomainTlsRoute from "@/app/api/admin/sites/[siteId]/domains/[domainId]/tls/route";

const NOW = Date.now();
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW + d * DAY).toISOString();
const CANARY = "QA-CANARY-9f3b7c";
const KEYCANARY = `-----BEGIN PRIVATE KEY-----\n${CANARY}\n-----END PRIVATE KEY-----\n`;
const VID = `ctv_${"a".repeat(32)}`;
const CERTIFICATE_ERROR_CODES_FOR_QA = ERROR_CODES.filter((c) => c.startsWith("CERTIFICATE_"));
const leaks = /QA-CANARY|-----BEGIN|PRIVATE KEY|SECRETSECRET/;

// Extra properties a misbehaving upstream could add: they must never reach the markup.
const poison = { leafPem: KEYCANARY, chainPem: KEYCANARY, privateKeyPem: KEYCANARY, pem: KEYCANARY, key: KEYCANARY, password: CANARY };

const dom = (over: Partial<SiteDomainDto> = {}): SiteDomainDto => ({
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
const domainsDto = (...d: SiteDomainDto[]): SiteDomainsDto => ({ domains: d, serverIpv4: "203.0.113.5", routesPending: false, mail: { configured: false, fromAddress: null } });
const version = (over: Record<string, unknown> = {}) => ({
  id: VID,
  versionNumber: 1,
  status: "active",
  subject: "CN=shop.example.com",
  issuer: "CN=CA",
  sanDns: ["shop.example.com"],
  wildcard: false,
  notBefore: at(-10),
  notAfter: at(90),
  serialNumber: "01",
  fingerprintSha256: "a".repeat(64),
  keyType: "ec",
  keyBits: 256,
  createdAt: at(-10),
  activatedAt: at(-10),
  problem: null,
  ...poison,
  ...over,
});
const cert = (over: Record<string, unknown> = {}): TlsCertificateDto =>
  ({
    id: "cti_1",
    name: "Shop wildcard",
    source: "manual",
    createdForSiteId: null,
    activeVersionId: VID,
    versions: [version(), version({ id: `ctv_${"b".repeat(32)}`, versionNumber: 2, status: "pending" })],
    coveredDomains: [{ domainId: "d1", hostname: "shop.example.com", assigned: true, versionId: VID, ...poison }],
    assignedDomains: [],
    expiry: { tier: "ok", daysLeft: 90 },
    warnings: [],
    updatedAt: at(-10),
    ...poison,
    ...over,
  }) as unknown as TlsCertificateDto;

const wrap = (locale: "en" | "it", node: ReactNode) =>
  createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: node });
const html = (locale: "en" | "it", node: ReactNode) => renderToStaticMarkup(wrap(locale, node));

// The admin page nests one async server component, which the static renderer cannot await.
const expand = async (node: ReactNode): Promise<ReactNode> => {
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return expand(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  }
  if (el.props.children === undefined || typeof el.type === "function") return el;
  return cloneElement(el, undefined, ...(await Promise.all(Children.toArray(el.props.children).map(expand))));
};

function mockUpstream() {
  fetchUpstream.mockReset();
  fetchUpstream.mockImplementation(async (p: string) => {
    const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
    if (p.includes("/alerts"))
      return ok([{ certificateId: "cti_1", certificateName: "Shop wildcard", versionId: VID, organizationId: "o1", siteId: "s1", siteName: "Shop", hostnames: ["shop.example.com"], notAfter: at(3), tier: "critical", daysLeft: 3, ...poison }]);
    if (p.startsWith("v1/admin/tls-certificates"))
      return ok([{ source: "manual", certificateId: "cti_1", name: "Shop wildcard", organizationId: "o1", organizationName: "Acme", siteId: "s1", siteName: "Shop", hostnames: ["shop.example.com"], issuer: "CA", wildcard: false, notAfter: at(3), status: "active", tier: "critical", ...poison }]);
    if (p === "v1/admin/dns-provider") return ok({ provider: null, fieldsSet: [], updatedAt: null, applied: true, ready: false });
    if (p === "v1/admin/sites") return ok({ sites: [{ id: "s1", name: "Shop", owner: { organizationId: "o1", name: "Acme" } }], customers: [], certificateAlerts: [] });
    if (p === "v1/me") return ok({ platformCapabilities: { manualTlsCertificatesAvailable: true } });
    if (p.endsWith("/tls-certificates")) return ok([cert()]);
    if (p.endsWith("/domains")) return ok(domainsDto(dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "active", problem: null } })));
    return { ok: false, status: 404 };
  });
}

describe("server-rendered pages carry no PEM or key material", () => {
  beforeEach(mockUpstream);

  for (const locale of ["en", "it"] as const) {
    it(`customer domains, admin domains and admin certificates pages (${locale}) never print the canary or a PEM marker`, async () => {
      h.locale = locale;
      const pages = [
        await SiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) }),
        await AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) }),
        await AdminCertificatesPage({ searchParams: Promise.resolve({ site: "s1" }) }),
      ];
      for (const page of pages) {
        const out = html(locale, (await expand(page)) as ReactElement);
        expect(out.length).toBeGreaterThan(500); // a real render, not an empty shell
        expect(out).toContain("Shop wildcard"); // the poisoned certificate was rendered, only its safe fields
        expect(out).not.toMatch(leaks);
        expect(out).not.toMatch(/<textarea[^>]*>[^<]+<\/textarea>/);
        expect(out).not.toMatch(/\svalue="-----/);
      }
      h.locale = "en";
    });
  }

  it("the page really loaded the poisoned certificates (the canary guard is not vacuous)", async () => {
    h.locale = "en";
    await expand(await AdminCertificatesPage({ searchParams: Promise.resolve({ site: "s1" }) }));
    const paths = fetchUpstream.mock.calls.map(([p]) => p);
    expect(paths).toContain("v1/admin/sites/s1/tls-certificates");
    expect(paths).toContain("v1/admin/tls-certificates/alerts");
  });

  it.each(["en", "it"] as const)("wizard steps and the open dialog (%s) render no PEM from a poisoned certificate", (locale) => {
    const c = cert();
    const v = c.versions[1]!;
    const rows = reviewRows(v, (locale === "en" ? en : itMsgs) as never, locale);
    const review = html(locale, createElement(ReviewStep, { rows, domains: reviewDomains(c, [dom()], "d1"), busy: null, error: null, onToggle: () => {}, onConfirm: () => {}, onKeep: () => {}, onCancel: () => {} }));
    expect(review).not.toMatch(leaks);
    const form = html(locale, createElement(ImportFormStep, { isNew: true, pem: EMPTY_PEM, issues: {}, fileErrors: {}, busy: false, error: null, onName: () => {}, onPem: () => {}, onFile: () => {}, onSubmit: () => {}, onCancel: () => {} }));
    expect(form).not.toMatch(/-----BEGIN [A-Z ]+-----\s*[A-Za-z0-9+/=]{4}/);
    const dialog = html(locale, createElement(TlsImportDialog, { basePath: "/api/bff/orgs/o1/managed-sites/s1", csrfToken: "csrf", domains: [dom()], onDone: () => {}, onClose: () => {} }));
    expect(dialog).not.toMatch(/QA-CANARY|PRIVATE KEY-----\s*[A-Za-z0-9+/=]{4}/);
  });
});

describe("sources of the TLS web surface", () => {
  const root = path.resolve(__dirname, "../src");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const f = path.join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
    });
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tlsFiles = [...walk(root)].filter((f) => /tls|certificate/i.test(path.relative(root, f)));
  const extra = ["components/customer/domains-panel.tsx", "lib/domain-view.ts", "lib/bff-idempotent.ts", "lib/server-api.ts"].map((p) => path.join(root, p));

  it("finds the TLS files (guards the scan itself)", () => {
    const rel = tlsFiles.map((f) => path.relative(root, f));
    for (const f of ["components/customer/tls-import-dialog.tsx", "components/admin/certificate-inventory.tsx", "components/admin/tls-alerts.tsx", "lib/tls-view.ts", "components/customer/certificate-pill.tsx"]) {
      expect(rel).toContain(f);
    }
    expect(rel.filter((f) => f.endsWith("route.ts")).length).toBeGreaterThanOrEqual(11);
  });

  it("none uses web storage, IndexedDB, cookies from script, console, raw HTML injection, a password input or a PFX field", () => {
    for (const f of [...tlsFiles, ...extra]) {
      const code = strip(readFileSync(f, "utf8"));
      const rel = path.relative(root, f);
      expect(code, rel).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|dangerouslySetInnerHTML|BroadcastChannel|caches\.open/);
      expect(code, rel).not.toMatch(/type=["']password["']|\bpfx\b|\bp12\b|pkcs12/i);
    }
  });

  it("the PEM never goes into a URL, a log or a cookie in the dialog", () => {
    const code = strip(readFileSync(path.join(root, "components/customer/tls-import-dialog.tsx"), "utf8"));
    expect(code).not.toMatch(/router\.(push|replace)|history\.|location\.|searchParams|URLSearchParams|document\./);
  });
});

describe("a pending certificate is never presented as active", () => {
  const claim = /\b(attiv\w*|active|activated|enabled|abilitat\w*|installat\w*|installed|live|online)\b/i;
  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: no review, progress or done text of the wizard claims it", (_n, m) => {
    const w = m.site.domains.tls.wizard as Record<string, string>;
    const keys = ["stepReview", "stepDone", "reviewTitle", "reviewIntro", "warningNoActiveYet", "confirm", "confirming", "keepForLater", "doneTitle", "done", "doneKept", "submitting"];
    for (const k of keys) {
      expect(w[k], k).toBeTruthy();
      expect(w[k], k).not.toMatch(claim);
    }
    // "in use" is allowed only in the negative ("not in use yet")
    for (const k of ["reviewIntro", "doneKept", "reviewNoDomains"]) expect(w[k], k).toMatch(/non|not|nothing|niente|nessun|No /i);
  });

  it("the ReviewStep markup (both languages, with and without an error/progress) has no claim", () => {
    for (const locale of ["en", "it"] as const) {
      const m = (locale === "en" ? en : itMsgs) as never;
      const rows = reviewRows(cert().versions[1]!, m, locale);
      for (const busy of [null, "confirm"] as const) {
        const out = html(locale, createElement(ReviewStep, { rows, domains: reviewDomains(cert(), [dom()], "d1"), busy, error: null, onToggle: () => {}, onConfirm: () => {}, onKeep: () => {}, onCancel: () => {} }));
        expect(out.replace(/<[^>]*>/g, " ")).not.toMatch(claim);
      }
    }
  });
});

describe("applying and failed are announced and written, not only coloured", () => {
  const manual = (state: "applying" | "failed", problem: string | null = null) =>
    dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state, problem } });
  const panel = (d: SiteDomainDto) =>
    createElement(DomainsPanel, { basePath: "/api/bff/orgs/o1/managed-sites/s1/domains", csrfToken: "csrf", initial: domainsDto(d), tls: { certificates: [cert()], manualAvailable: true } });

  it.each(["en", "it"] as const)("%s: applying is a polite status with text and failed is an alert with text and a next step", (locale) => {
    const m = locale === "en" ? en : itMsgs;
    const applying = html(locale, panel(manual("applying")));
    expect(applying).toMatch(/<p[^>]*role="status"[^>]*>[^<]*\S[^<]*<\/p>/);
    expect(applying).toContain(m.site.domains.state.applyingCertificate.replace("'", "&#x27;"));
    const failed = html(locale, panel(manual("failed", "sni_mismatch")));
    const alert = failed.match(/<div[^>]*role="alert"[^>]*>([\s\S]*?)<\/div><\/div>|<div[^>]*role="alert"[^>]*>([\s\S]*?)<\/div>/);
    expect(alert, "role=alert present").not.toBeNull();
    const text = (alert![1] ?? alert![2] ?? "").replace(/<[^>]*>/g, "").trim();
    expect(text.length).toBeGreaterThan(20);
    expect(text.replace(/&#x27;/g, "'")).toContain(m.site.domains.tls.problem.sni_mismatch.slice(0, 20));
    // the row badge also names the state in words
    expect(failed).toContain(m.site.domains.state.httpsProblem.replace("'", "&#x27;"));
  });

  it("a failed problem key that is not a known text falls back to a sentence, never to the raw key", () => {
    const out = html("en", panel(manual("failed", "weird_new_reason")));
    expect(out).not.toContain("weird_new_reason");
    expect(out).toContain(en.site.domains.tls.problem.other);
  });

  it("admin alerts: alert only when urgent (status for a warning), tier text, decorative icon", () => {
    for (const locale of ["en", "it"] as const) {
      const alerts = (["warning", "critical", "expired"] as const).map((tier) => ({ certificateId: "c", certificateName: "Shop", versionId: tier, organizationId: "o", siteId: null, siteName: null, hostnames: [], notAfter: at(2), tier, daysLeft: 2 }));
      for (const a of alerts) {
        const out = html(locale, createElement(TlsAlerts, { alerts: [a] }));
        expect(out).toContain(a.tier === "warning" ? 'role="status"' : 'role="alert"');
        expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
        expect(out.replace(/<[^>]*>/g, " ")).toContain("Shop");
        expect(out).not.toMatch(/\{(name|where|date)\}/);
      }
    }
  });
});

describe("the header pill and 'secure' during a certificate change", () => {
  const acmeApplying = dom({ tls: { mode: "acme", certificateId: null, versionId: null, state: "applying", problem: null } });

  it("a manual address still applying is not secure (header pill included)", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "applying", problem: null } });
    expect(domainView(d, d, new Date()).label).not.toBe("secure");
    expect(html("en", createElement(CertificatePill, { domain: d, primary: d, m: en, locale: "en", now: new Date() }))).not.toMatch(/Valid until|Imported/i);
  });

  // An address going back to Let's Encrypt (mode "acme", state "applying") is not "secure" in the site header either.
  it("an address going back to automatic certificates is not 'secure' while the change applies", () => {
    expect(domainView(acmeApplying, acmeApplying, new Date()).label).not.toBe("secure");
    expect(html("en", createElement(CertificatePill, { domain: acmeApplying, primary: acmeApplying, m: en, locale: "en", now: new Date() }))).not.toMatch(/Valid until/);
  });
});

// ------------------------------------------------------------------------------------------------------ BFF
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const PEMOK = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const KEYOK = "-----BEGIN PRIVATE KEY-----\nSECRETSECRET\n-----END PRIVATE KEY-----\n";
const pemBody = { format: "pem", leafPem: PEMOK, chainPem: "", privateKeyPem: KEYOK };
const C = { orgId: "o1", siteId: "s1" };

const POSTS: Array<{ name: string; handler: Handler; params: Record<string, string>; body: unknown; pem: boolean; admin: boolean }> = [
  { name: "customer import", handler: importRoute.POST as unknown as Handler, params: C, body: { name: "shop", ...pemBody }, pem: true, admin: false },
  { name: "customer version", handler: versionsRoute.POST as unknown as Handler, params: { ...C, certificateId: "c1" }, body: pemBody, pem: true, admin: false },
  { name: "admin import", handler: adminImportRoute.POST as unknown as Handler, params: { siteId: "s1" }, body: { name: "shop", ...pemBody }, pem: true, admin: true },
  { name: "admin version", handler: adminVersionsRoute.POST as unknown as Handler, params: { siteId: "s1", certificateId: "c1" }, body: pemBody, pem: true, admin: true },
  { name: "customer activate", handler: activateRoute.POST as unknown as Handler, params: { ...C, certificateId: "c1", versionId: VID }, body: { domainIds: ["d1"] }, pem: false, admin: false },
  { name: "customer domain tls", handler: domainTlsRoute.POST as unknown as Handler, params: { ...C, domainId: "d1" }, body: { mode: "manual", versionId: VID }, pem: false, admin: false },
  { name: "admin activate", handler: adminActivateRoute.POST as unknown as Handler, params: { siteId: "s1", certificateId: "c1", versionId: VID }, body: { domainIds: ["d1"] }, pem: false, admin: true },
  { name: "admin domain tls", handler: adminDomainTlsRoute.POST as unknown as Handler, params: { siteId: "s1", domainId: "d1" }, body: { mode: "acme" }, pem: false, admin: true },
];

const mkReq = (raw: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/x", {
    method: "POST",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", "Idempotency-Key": "k1", ...headers },
    body: raw,
    ...(typeof raw === "string" ? {} : { duplex: "half" }),
  } as RequestInit);
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

describe("BFF refusals happen before any upstream call", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSession.mockReset().mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  for (const c of POSTS) {
    it(`${c.name}: a body over 1 MiB is a 413 (declared length, and streamed without one) and is never echoed`, async () => {
      const big = JSON.stringify({ ...(c.body as object), padding: "x".repeat(1024 * 1024 + 10) });
      const declared = await c.handler(mkReq(big), ctx(c.params));
      expect(declared.status).toBe(413);
      const streamed = await c.handler(
        mkReq(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(big)); ctl.close(); } }), { "Content-Length": "5" }),
        ctx(c.params),
      );
      expect(streamed.status).toBe(413);
      expect(await streamed.text()).not.toMatch(/xxxxxxxx|SECRETSECRET/);
      expect(fetchUpstream).not.toHaveBeenCalled();
    });

    it(`${c.name}: arrays, null, scalars and prototype keys are refused (400) and never forwarded`, async () => {
      // {} is a valid activate body (domainIds is optional: "every domain already on the certificate")
      const shapes = ["[]", "null", '"str"', "42", "true", `{"__proto__":{"x":1}}`, JSON.stringify([c.body]), ...(c.name.includes("activate") ? [] : ["{}"])];
      for (const raw of shapes) {
        const res = await c.handler(mkReq(raw), ctx(c.params));
        expect([400, 413], raw).toContain(res.status);
      }
      expect(fetchUpstream).not.toHaveBeenCalled();
    });
  }

  for (const c of POSTS.filter((p) => p.pem)) {
    it(`${c.name}: PFX, password and unknown-key variants (case, nesting, escapes, wrong format) never reach the API`, async () => {
      const base = c.body as Record<string, unknown>;
      const bad: unknown[] = [
        { ...base, pfx: "AAAA" },
        { ...base, PFX: "AAAA" },
        { ...base, p12: "AAAA", pkcs12Base64: "AAAA" },
        { ...base, passphrase: "x" },
        { ...base, Password: "x" },
        { ...base, keyPassword: "x" },
        { ...base, nested: { pfx: "AAAA", password: "x" } },
        { ...base, format: "pfx" },
        { ...base, format: "PEM" },
        { ...base, format: ["pem"] },
        { ...base, format: undefined },
        { ...base, privateKeyPem: ["a"] },
        { ...base, privateKeyPem: 7 },
        { ...base, privateKeyPem: "" },
        { ...base, leafPem: "" },
        { ...base, chainPem: null },
      ];
      for (const b of bad) {
        const res = await c.handler(mkReq(JSON.stringify(b)), ctx(c.params));
        expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
        expect(await res.text()).not.toMatch(/SECRETSECRET|BEGIN/);
      }
      // an escaped key name is the same key after JSON.parse
      const escaped = JSON.stringify(base).replace(/^\{/, '{"pass\\u0077ord":"x",');
      expect((await c.handler(mkReq(escaped), ctx(c.params))).status).toBe(400);
      // a duplicate key keeps the last value: a valid body whose last duplicate is bad is refused
      const dup = JSON.stringify(base).replace(/\}$/, ',"format":"pfx"}');
      expect((await c.handler(mkReq(dup), ctx(c.params))).status).toBe(400);
      expect(fetchUpstream).not.toHaveBeenCalled();
    });

    it(`${c.name}: a body just under 1 MiB whose fields are individually within the PEM cap is not a BFF 413`, async () => {
      fetchUpstream.mockResolvedValue({ status: 201, ok: true, data: { data: {} } });
      const body = { ...(c.body as object), chainPem: "A".repeat(500 * 1024) };
      const res = await c.handler(mkReq(JSON.stringify(body)), ctx(c.params));
      expect(res.status).toBe(201);
    });
  }

  it("a missing or foreign-origin request is refused before the body is parsed or the API called", async () => {
    for (const c of POSTS) {
      const noKey = await c.handler(mkReq(JSON.stringify(c.body), { "X-CSRF-Token": "" }), ctx(c.params));
      expect(noKey.status, c.name).toBe(403);
      const foreign = await c.handler(mkReq(JSON.stringify(c.body), { Origin: "http://evil.test" }), ctx(c.params));
      expect(foreign.status, c.name).toBe(403);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------ copy and i18n
const leavesOf = (o: unknown, prefix = ""): Array<[string, string]> =>
  typeof o === "string" ? [[prefix, o]] : Object.entries(o as object).flatMap(([k, v]) => leavesOf(v, prefix ? `${prefix}.${k}` : k));
const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("customer copy of the TLS feature", () => {
  const jargon = /\b(traefik|sni|acme|executor|outbox|resolver|handshake|manifest|ipc|idempotenc\w*|x\.?509|docker|container|contenitor\w*|stack|endpoint|payload|checksum|hp_ingress|acme\.json|organization|organizzazion\w*|service|servizio|volume|network|rete|image|immagine|template|revision\w*|http\s?[45]\d\d)\b|\/(etc|var|opt|srv)\/|HCP-SPEC|ADR-/i;
  const customer = (m: typeof en) => [
    ...leavesOf(m.site.domains.tls),
    ...leavesOf(m.site.domains.state),
    ...leavesOf(m.site.domains.hint),
    ...leavesOf(m.site.domains.pill),
    ...Object.entries(m.errors).filter(([k]) => k.startsWith("CERTIFICATE_")).map(([k, v]) => [`errors.${k}`, v] as [string, string]),
  ];

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: passes the jargon bans (no proxy/ACME/SNI/internal vocabulary, no paths, no status codes)", (_n, m) => {
    const all = customer(m);
    expect(all.length).toBeGreaterThan(80);
    for (const [k, v] of all) {
      // "Let's Encrypt" is the product name the customer already knows; the bare word ACME is not
      expect(v.replace(/Let[’']s Encrypt/g, ""), k).not.toMatch(jargon);
    }
  });

  it("the jargon regex catches a planted word (guards the guard)", () => {
    for (const w of ["Traefik reloaded", "SNI mismatch", "see /etc/hosting-panel", "organizzazione", "HTTP 502"]) expect(w).toMatch(jargon);
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: every CERTIFICATE_* API code maps to its own sentence, not the generic one", (_n, m) => {
    expect(CERTIFICATE_ERROR_CODES_FOR_QA.length).toBe(11);
    const seen = new Set<string>();
    for (const code of CERTIFICATE_ERROR_CODES_FOR_QA) {
      const text = tlsErrorText(m, code, []);
      expect(text, code).toBeTruthy();
      expect(text, code).not.toBe(m.errors.generic);
      expect(seen.has(text!), `${code} duplicates another text`).toBe(false);
      seen.add(text!);
    }
    expect(tlsErrorText(m, "SOMETHING_ELSE", [])).toBeNull();
    expect(tlsErrorText(m, "CERTIFICATE_INVALID", [{ reason: "__proto__" }])).toBe(m.errors.CERTIFICATE_INVALID);
  });

  it.each([
    ["en", en],
    ["it", itMsgs],
  ] as const)("%s: every certificate problem a domain or version can report has a specific text (not the 'other' fallback)", (_n, m) => {
    const problem = m.site.domains.tls.problem as Record<string, string>;
    const missing = CERTIFICATE_PROBLEM_REASONS.filter((r) => !Object.hasOwn(problem, r) && !Object.hasOwn(m.site.domains.tls.reason, r) && !Object.hasOwn(m.site.domains.tls.pemReason, r));
    expect(missing).toEqual([]);
  });
});

describe("IT and EN are complete", () => {
  const groups: Array<[string, (m: typeof en) => unknown]> = [
    ["site.domains", (m) => m.site.domains],
    ["admin.certificates", (m) => m.admin.certificates],
    ["errors", (m) => m.errors],
    ["admin.health.alerts", (m) => (m.admin as unknown as { health: { alerts: unknown } }).health.alerts],
  ];
  it.each(groups)("%s: same keys, no empty text, same placeholders in both languages", (_n, pick) => {
    const e = new Map(leavesOf(pick(en)));
    const i = new Map(leavesOf(pick(itMsgs)));
    expect([...i.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of e) {
      expect(v.trim(), `en ${k}`).not.toBe("");
      expect(i.get(k)!.trim(), `it ${k}`).not.toBe("");
      expect(tokens(i.get(k)!), `placeholders ${k}`).toEqual(tokens(v));
    }
  });

  it("the TLS-specific groups are translated, not copied", () => {
    const same = (pick: (m: typeof en) => unknown, allow: RegExp) => {
      const e = new Map(leavesOf(pick(en)));
      const i = new Map(leavesOf(pick(itMsgs)));
      return [...e].filter(([k, v]) => v === i.get(k) && !allow.test(v)).map(([k]) => k);
    };
    const short = /^(PEM|SHA-256|RSA|EC|N\/A|—|-|\{\w+\})$/;
    expect(same((m) => m.site.domains.tls, short)).toEqual([]);
    expect(same((m) => m.admin.certificates.inventory, short)).toEqual([]);
    const certErrors = (m: typeof en) => Object.fromEntries(Object.entries(m.errors).filter(([k]) => k.startsWith("CERTIFICATE_")));
    expect(same(certErrors, short)).toEqual([]);
  });

  it("Italian TLS copy has no leftover English sentences", () => {
    const english = /\b(the|your|please|certificate|private key|expires|valid until|this address|choose|replace|upload)\b/i;
    for (const [k, v] of leavesOf(itMsgs.site.domains.tls)) {
      // Italian "certificato" legitimately contains neither "certificate" nor the whole English word
      expect(v.replace(/-----BEGIN [A-Z ]+-----/g, ""), k).not.toMatch(english);
    }
  });
});
