import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SiteDomainDto, SiteDomainsDto, TlsCertificateDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchCerts = vi.fn();
const fetchAdminCerts = vi.fn();
const fetchMe = vi.fn();
const fetchDomains = vi.fn();
const fetchAdminDomains = vi.fn();
const getContext = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/", redirect: vi.fn() }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ csrfToken: "csrf", user: {} }) }));
vi.mock("@/lib/server-api", async () => ({
  ...(await vi.importActual<object>("@/lib/server-api")),
  fetchServerSiteDomains: (...a: unknown[]) => fetchDomains(...a),
  fetchServerSiteTlsCertificates: (...a: unknown[]) => fetchCerts(...a),
  fetchServerAdminSiteDomains: (...a: unknown[]) => fetchAdminDomains(...a),
  fetchServerAdminSiteTlsCertificates: (...a: unknown[]) => fetchAdminCerts(...a),
  fetchServerAdminDnsProvider: async () => ({ provider: null }),
  fetchServerMe: () => fetchMe(),
}));
vi.mock("@/app/sites/data", () => ({
  getCustomerContext: () => getContext(),
  getSite: async () => ({ ok: true, data: { id: "s1" } }),
}));

import { DomainsPanel, evictionOffer, needsPoll, postTlsSwitch, tlsSwitchBody } from "@/components/customer/domains-panel";
import SiteDomainsPage from "@/app/sites/[siteId]/domains/page";
import AdminSiteDomainsPage from "@/app/admin/sites/[siteId]/domains/page";

const NOW = Date.now();
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const VID = `ctv_${"a".repeat(32)}`;

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
const data = (...domains: SiteDomainDto[]): SiteDomainsDto => ({
  domains,
  serverIpv4: "203.0.113.5",
  routesPending: false,
  mail: { configured: false, fromAddress: null },
});
const cert = (over: Partial<TlsCertificateDto> = {}): TlsCertificateDto => ({
  id: "cti_1",
  name: "Shop wildcard",
  source: "manual",
  createdForSiteId: null,
  activeVersionId: VID,
  versions: [
    {
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
    },
  ],
  coveredDomains: [{ domainId: "d1", hostname: "shop.example.com", assigned: false, versionId: null }],
  assignedDomains: [],
  expiry: { tier: "ok", daysLeft: 90 },
  warnings: [],
  updatedAt: at(-10),
  ...over,
});
const other = cert({
  id: "cti_2",
  name: "Unrelated",
  coveredDomains: [{ domainId: "d9", hostname: "else.example.com", assigned: false, versionId: null }],
});

const render = (node: ReactNode, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: locale === "en" ? en : itMsgs, children: node }));
const panel = (initial: SiteDomainsDto, tls?: { certificates: TlsCertificateDto[] | null; manualAvailable: boolean }, challenge?: { dnsAvailable: boolean }) =>
  createElement(DomainsPanel, { basePath: "/api/bff/orgs/o1/managed-sites/s1/domains", csrfToken: "csrf", initial, tls, challenge });

describe("DomainsPanel without the manual feature", () => {
  it("is identical with no tls prop, manualAvailable false, or a null certificate list", () => {
    const d = data(dom());
    const base = render(panel(d));
    expect(render(panel(d, { certificates: [cert()], manualAvailable: false }))).toBe(base);
    expect(render(panel(d, { certificates: null, manualAvailable: false }))).toBe(base);
    expect(base).not.toContain("tls-mode-");
    expect(base).not.toContain("<fieldset");
  });

  it("keeps the admin challenge select and the customer read-only text", () => {
    const d = data(dom());
    const admin = render(panel(d, { certificates: [cert()], manualAvailable: false }, { dnsAvailable: true }));
    expect(admin).toContain('<select id="challenge-d1"');
    expect(admin).toContain(en.admin.sites.challenge["dns-01"]);
    expect(render(panel(d))).toContain(en.site.domains.challenge["http-01"]);
  });
});

describe("DomainsPanel with manual certificates", () => {
  const tls = { certificates: [cert(), other], manualAvailable: true };

  it("renders a fieldset with two radios per row", () => {
    const html = render(panel(data(dom()), tls));
    expect(html).toContain("<fieldset");
    expect(html).toContain(`<legend`);
    expect(html).toContain(en.site.domains.tls.sourceLegend);
    expect(html).toContain(en.site.domains.tls.acme.replace("'", "&#x27;"));
    expect(html).toContain(en.site.domains.tls.manual);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/id="tls-mode-d1-acme"[^>]*checked/);
    expect(html).not.toContain(`id="tls-cert-d1"`); // the certificate select waits for the manual choice
  });

  it("shows only the covering certificates with the expiry on a manual row", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "active", problem: null } });
    const html = render(panel(data(d), tls));
    expect(html).toMatch(/id="tls-mode-d1-manual"[^>]*checked/);
    expect(html).toContain('id="tls-cert-d1"');
    expect(html).toContain("Shop wildcard");
    expect(html).not.toContain("Unrelated");
    expect(html).toMatch(/Shop wildcard — expires /);
    expect(html).toContain(en.site.domains.tls.importNew);
    expect(html).toContain(en.site.domains.tls.replace);
  });

  it("says so when no certificate covers the address", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "active", problem: null } });
    const html = render(panel(data(d), { certificates: [other], manualAvailable: true }));
    expect(html).toContain(en.site.domains.tls.noCovering);
  });

  it("renders in Italian", () => {
    expect(render(panel(data(dom()), tls), "it")).toContain(itMsgs.site.domains.tls.sourceLegend);
  });

  it("hides the challenge control of an imported row but keeps it on an automatic one", () => {
    const d1 = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "active", problem: null } });
    const d2 = dom({ id: "d2", hostname: "www.example.com", isPrimary: false });
    const html = render(panel(data(d1, d2), tls, { dnsAvailable: true }));
    expect(html).not.toContain('id="challenge-d1"');
    expect(html).toContain('id="challenge-d2"');
  });

  it("applying shows a status and never the secure label", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "applying", problem: null } });
    const html = render(panel(data(d), tls));
    expect(html).toContain('role="status"');
    expect(html).toContain(en.site.domains.tls.applying);
    expect(html).toContain(en.site.domains.state.applyingCertificate);
    expect(html).not.toContain(`>${en.site.domains.state.secure}<`);
  });

  it("an automatic row going back to Let's Encrypt is not secure while applying either", () => {
    const d = dom({ tls: { mode: "acme", certificateId: null, versionId: null, state: "applying", problem: null } });
    const html = render(panel(data(d), tls));
    expect(html).toContain(en.site.domains.tls.applying);
    expect(html).not.toContain(`>${en.site.domains.state.secure}<`);
  });

  it("failed shows an alert with the problem text and the previous certificate", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "failed", problem: "sni_mismatch" } });
    const html = render(panel(data(d), tls));
    expect(html).toContain('role="alert"');
    expect(html).toContain(en.site.domains.tls.failed);
    expect(html).toContain(en.site.domains.tls.problem.sni_mismatch);
  });

  it("an unknown failure problem falls back to the generic text", () => {
    const d = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "failed", problem: "something_new" } });
    expect(render(panel(data(d), tls))).toContain(en.site.domains.tls.problem.other);
  });
});

describe("needsPoll", () => {
  it("polls while a TLS change is applying, and not when it is settled", () => {
    const applying = dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "applying", problem: null } });
    expect(needsPoll(data(applying), [])).toBe(true);
    expect(needsPoll(data(dom()), [])).toBe(false);
    expect(needsPoll(data(dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: "failed", problem: null } })), [])).toBe(false);
    expect(needsPoll({ ...data(dom()), routesPending: true }, [])).toBe(true);
    expect(needsPoll(data(dom()), ["securing"])).toBe(true);
  });
});

describe("tlsSwitchBody", () => {
  it("acme and manual bodies carry exactly the contract keys, never a challenge", () => {
    expect(tlsSwitchBody("acme")).toEqual({ mode: "acme" });
    expect(tlsSwitchBody("manual", VID)).toEqual({ mode: "manual", versionId: VID });
  });
});

describe("administrator eviction of the automatic certificate", () => {
  const stuck = cert({
    activeVersionId: null,
    versions: [{ ...cert().versions[0]!, status: "failed", problem: "acme_eviction_required" }],
  });
  const tls = { certificates: [stuck], manualAvailable: true };

  it("tlsSwitchBody adds evictAcme and confirmHostname together, only when a hostname is given", () => {
    expect(tlsSwitchBody("manual", VID, "shop.example.com")).toEqual({ mode: "manual", versionId: VID, evictAcme: true, confirmHostname: "shop.example.com" });
    expect(tlsSwitchBody("manual", VID)).toEqual({ mode: "manual", versionId: VID });
  });

  it("evictionOffer finds the refused version of an automatic address, and nothing otherwise", () => {
    expect(evictionOffer(dom(), [stuck])).toMatchObject({ versionId: VID });
    expect(evictionOffer(dom({ id: "d2" }), [stuck])).toBeNull();
    expect(evictionOffer(dom(), [cert()])).toBeNull();
    expect(evictionOffer(dom({ tls: { mode: "manual", certificateId: "cti_1", versionId: VID, state: null, problem: null } }), [stuck])).toBeNull();
  });

  it.each(["en", "it"] as const)("%s: only the administrator panel offers the cleanup, with the brief proxy restart said in the dialog text", (locale) => {
    const d = data(dom());
    const adminOut = render(panel(d, tls, { dnsAvailable: true }), locale);
    const m = locale === "en" ? en : itMsgs;
    expect(adminOut).toContain(m.admin.sites.tlsEvict.open);
    expect(render(panel(d, tls), locale)).not.toContain(m.admin.sites.tlsEvict.open);
    expect(m.admin.sites.tlsEvict.body).toMatch(/\{host\}/);
    expect(m.admin.sites.tlsEvict.body.length).toBeGreaterThan(80);
  });

  it("the confirmed request keeps its own Idempotency-Key and sends both fields", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ data: data(dom()) }) });
    vi.stubGlobal("fetch", f);
    const keys: Record<string, string> = {};
    await postTlsSwitch(keys, "csrf", "/api/admin/sites/s1/domains", "d1", tlsSwitchBody("manual", VID, "shop.example.com"));
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ mode: "manual", versionId: VID, evictAcme: true, confirmHostname: "shop.example.com" });
    vi.unstubAllGlobals();
  });
});

describe("postTlsSwitch", () => {
  const ok = (body: unknown) => ({ ok: true, status: 202, json: async () => ({ data: body }) });
  beforeEach(() => vi.unstubAllGlobals());

  it("POSTs the manual body to <basePath>/<id>/tls with CSRF and an Idempotency-Key", async () => {
    const f = vi.fn().mockResolvedValue(ok(data(dom())));
    vi.stubGlobal("fetch", f);
    const keys: Record<string, string> = {};
    const res = await postTlsSwitch(keys, "csrf", "/api/bff/orgs/o1/managed-sites/s1/domains", "d1", tlsSwitchBody("manual", VID));
    expect(res.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/bff/orgs/o1/managed-sites/s1/domains/d1/tls");
    expect(init.method).toBe("POST");
    expect(init.headers["X-CSRF-Token"]).toBe("csrf");
    expect(init.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body)).toEqual({ mode: "manual", versionId: VID });
  });

  it("acme body is {mode:'acme'} only, and a lost reply replays the same key", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(ok(data(dom())));
    vi.stubGlobal("fetch", f);
    const keys: Record<string, string> = {};
    const base = "/api/admin/sites/s1/domains";
    expect((await postTlsSwitch(keys, "csrf", base, "d1", tlsSwitchBody("acme"))).ok).toBe(false);
    expect((await postTlsSwitch(keys, "csrf", base, "d1", tlsSwitchBody("acme"))).ok).toBe(true);
    expect(JSON.parse(f.mock.calls[0]![1].body)).toEqual({ mode: "acme" });
    expect(f.mock.calls[1]![1].headers["Idempotency-Key"]).toBe(f.mock.calls[0]![1].headers["Idempotency-Key"]);
  });

  it("source scan: no browser storage or console in the panel", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/components/customer/domains-panel.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./);
  });
});

describe("domains pages pass tls", () => {
  beforeEach(() => {
    fetchCerts.mockReset();
    fetchAdminCerts.mockReset();
    fetchMe.mockReset();
    fetchDomains.mockReset().mockResolvedValue(data(dom()));
    fetchAdminDomains.mockReset().mockResolvedValue(data(dom()));
    getContext.mockReset().mockResolvedValue({ orgId: "o1", session: { csrfToken: "csrf" }, capabilities: { manualTlsCertificatesAvailable: true } });
  });
  const props = (el: unknown) => (el as { props: { tls?: { certificates: unknown; manualAvailable: boolean }; basePath: string } }).props;
  const find = (el: unknown): { tls?: { certificates: unknown; manualAvailable: boolean } } | undefined => {
    const e = el as { type?: unknown; props?: { children?: unknown } };
    if (e?.type === DomainsPanel) return props(e);
    const kids = ([] as unknown[]).concat(e?.props?.children ?? []);
    for (const k of kids) {
      const hit = k && typeof k === "object" ? find(k) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };

  it("customer page: capability true loads the list and enables", async () => {
    fetchCerts.mockResolvedValue([cert()]);
    const el = await SiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(fetchCerts).toHaveBeenCalledWith("o1", "s1");
    expect(props(el).tls).toEqual({ certificates: [cert()], manualAvailable: true });
  });

  it("customer page: capability missing or false disables; a failed load is false and null", async () => {
    getContext.mockResolvedValue({ orgId: "o1", session: { csrfToken: "csrf" }, capabilities: null });
    fetchCerts.mockResolvedValue(null);
    const el = await SiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(props(el).tls).toEqual({ certificates: null, manualAvailable: false });
  });

  it("customer page: the certificate list failing disables the feature even when the flag is on", async () => {
    fetchCerts.mockResolvedValue(null);
    const el = await SiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(props(el).tls).toEqual({ certificates: null, manualAvailable: false });
  });

  it("admin page: uses the admin fetchers and the capability from /v1/me", async () => {
    fetchAdminCerts.mockResolvedValue([cert()]);
    fetchMe.mockResolvedValue({ platformCapabilities: { manualTlsCertificatesAvailable: true } });
    const el = await AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(fetchAdminCerts).toHaveBeenCalledWith("s1");
    expect(find(el)?.tls).toEqual({ certificates: [cert()], manualAvailable: true });
  });

  it("admin page: /v1/me failing is false", async () => {
    fetchAdminCerts.mockResolvedValue([cert()]);
    fetchMe.mockResolvedValue(null);
    const el = await AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) });
    expect(find(el)?.tls?.manualAvailable).toBe(false);
  });
});
