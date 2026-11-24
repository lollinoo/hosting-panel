import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { SiteDomainDto, SiteDomainsDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
  getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  redirect: vi.fn(),
}));
const dnsProvider = vi.fn();
vi.mock("@/lib/server-api", async () => ({
  ...(await vi.importActual<object>("@/lib/server-api")),
  fetchServerAdminSiteDomains: async () => initial,
  fetchServerAdminDnsProvider: () => dnsProvider(),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));

import { PATCH as setChallenge } from "@/app/api/admin/sites/[siteId]/domains/[domainId]/route";
import * as customerDomainRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/route";
import { DomainsPanel } from "@/components/customer/domains-panel";
import { domainView } from "@/lib/domain-view";
import AdminSiteDomainsPage from "@/app/admin/sites/[siteId]/domains/page";

const dp = { params: Promise.resolve({ siteId: "s1", domainId: "d1" }) };
const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const now = new Date("2026-11-09T12:00:00Z");
const dom = (over: {
  hostname?: string;
  challenge?: SiteDomainDto["challenge"];
  dns?: Partial<SiteDomainDto["dns"]>;
  certificate?: Partial<SiteDomainDto["certificate"]>;
}): SiteDomainDto => ({
  id: over.hostname ?? "d1",
  hostname: over.hostname ?? "hotel.it",
  isPrimary: true,
  routed: true,
  challenge: over.challenge ?? "http-01",
  dns: { status: "ok", checkedAt: null, nextCheckAt: "2026-11-09T13:00:00Z", observedA: [], observedAaaa: [], ...over.dns },
  certificate: { status: "none", problem: null, expiresAt: null, retryAt: null, trusted: true, ...over.certificate },
  tls: { mode: "acme", certificateId: null, versionId: null, state: null, problem: null },
});

describe("domain challenge BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("admin domain BFF forwards PATCH with CSRF", async () => {
    expect((await setChallenge(req("PATCH", { "X-CSRF-Token": "bad" }, {}), dp)).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await setChallenge(req("PATCH", {}, { challenge: "dns-01" }), dp);
    expect(fetchUpstream.mock.calls.map(([path, o]) => [path, o.method])).toEqual([["v1/admin/sites/s1/domains/d1", "PATCH"]]);
    expect(fetchUpstream.mock.calls[0]![1].body).toEqual({ challenge: "dns-01" });
  });

  it("customer domain BFF has no PATCH", () => {
    expect((customerDomainRoute as Record<string, unknown>).PATCH).toBeUndefined();
  });
});

describe("domainView with dns-01", () => {
  it("domainView lets dns-01 certificates past the DNS gate", () => {
    const p = dom({});
    const v = (d: SiteDomainDto) => domainView(d, p, now);
    const dns = { status: "not_found" as const };
    expect(v(dom({ challenge: "dns-01", dns, certificate: { status: "requested" } })).label).toBe("securing");
    expect(v(dom({ challenge: "dns-01", dns, certificate: { status: "failed", problem: "dns_provider" } }))).toMatchObject({
      label: "httpsProblem",
      hint: "dns_provider",
    });
    expect(v(dom({ challenge: "dns-01", dns, certificate: { status: "active", expiresAt: "2027-01-01T00:00:00Z" } })).label).toBe("waitingForDns");
    expect(v(dom({ challenge: "http-01", dns, certificate: { status: "requested" } })).label).toBe("waitingForDns");
  });
});

const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });
const un = (h: string) => h.replaceAll("&#x27;", "'");
const initial: SiteDomainsDto = {
  serverIpv4: "203.0.113.10",
  routesPending: false,
  domains: [dom({ hostname: "hotel.it" }), dom({ hostname: "dns.hotel.it", challenge: "dns-01" })],
  mail: { configured: false, fromAddress: null },
};

describe("domain challenge UI", () => {
  it("customer panel shows the method read-only", () => {
    for (const m of [en, itMsgs]) {
      const html = un(renderToStaticMarkup(wrap(m, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial }))));
      expect(html).not.toContain("<select");
      expect(html).toContain(m.site.domains.challenge["http-01"]);
      expect(html).toContain(m.site.domains.challenge["dns-01"]);
      expect(html).not.toContain(`>${m.admin.sites.challenge.label}</label>`);
    }
  });

  it("admin panel offers both methods", () => {
    const render = (dnsAvailable: boolean, domains = initial.domains) =>
      un(renderToStaticMarkup(wrap(en, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: { ...initial, domains }, challenge: { dnsAvailable } }))));
    const on = render(true);
    expect(on).toContain("<select");
    expect(on).toContain(en.admin.sites.challenge.label);
    expect(on).toContain(`<option value="http-01">${en.admin.sites.challenge["http-01"]}</option>`);
    expect(on).toContain(`<option value="dns-01">${en.admin.sites.challenge["dns-01"]}</option>`);
    expect(on).not.toContain(en.admin.sites.challenge.noProvider);
    expect(on).not.toContain(en.site.domains.challenge["http-01"]);

    const off = render(false, [dom({ hostname: "hotel.it" })]);
    expect(off).toContain(`<option value="dns-01" disabled="">${en.admin.sites.challenge["dns-01"]}</option>`);
    expect(off.split(en.admin.sites.challenge.noProvider).length - 1).toBe(1);
  });

  it("customer page never passes challenge", () => {
    const src = readFileSync(resolve(__dirname, "../src/app/sites/[siteId]/domains/page.tsx"), "utf8");
    expect(src).not.toContain("challenge=");
  });
});

describe("admin domains page", () => {
  const page = async (dns: unknown) => {
    dnsProvider.mockResolvedValue(dns);
    return un(renderToStaticMarkup(wrap(en, await AdminSiteDomainsPage({ params: Promise.resolve({ siteId: "s1" }) }))));
  };

  it("a failed provider read shows the load error, not the missing provider", async () => {
    const down = await page(null);
    expect(down).toContain(en.errors.generic);
    expect(down).not.toContain(en.admin.sites.challenge.noProvider);
    expect(down).toContain(`<option value="dns-01">${en.admin.sites.challenge["dns-01"]}</option>`);

    const none = await page({ provider: null, fieldsSet: [], updatedAt: null, ready: null });
    expect(none).toContain(en.admin.sites.challenge.noProvider);
    expect(none).not.toContain(en.errors.generic);
  });
});
