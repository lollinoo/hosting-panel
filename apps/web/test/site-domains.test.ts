import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

import { GET as listDomains, POST as addDomain } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/route";
import { DELETE as removeDomain } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/route";
import { POST as setPrimary } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/primary/route";
import { POST as checkNow } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/check/route";
import { SITE_TABS } from "@/components/customer/site-tabs";
import { DomainsPanel, domainView } from "@/components/customer/domains-panel";
import { SiteForm } from "@/components/customer/site-form";

const base = "v1/organizations/org-1/managed-sites/s1/domains";
const sp = { params: Promise.resolve({ orgId: "org-1", siteId: "s1" }) };
const dp = { params: Promise.resolve({ orgId: "org-1", siteId: "s1", domainId: "d1" }) };
const req = (method: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const now = new Date("2026-11-09T12:00:00Z");
const dom = (over: {
  hostname?: string;
  isPrimary?: boolean;
  routed?: boolean;
  dns?: Partial<SiteDomainDto["dns"]>;
  certificate?: Partial<SiteDomainDto["certificate"]>;
}): SiteDomainDto => ({
  id: over.hostname ?? "d1",
  hostname: over.hostname ?? "hotel.it",
  isPrimary: over.isPrimary ?? true,
  routed: over.routed ?? true,
  dns: { status: "ok", checkedAt: null, nextCheckAt: "2026-11-09T13:00:00Z", observedA: [], observedAaaa: [], ...over.dns },
  certificate: { status: "none", problem: null, expiresAt: null, retryAt: null, trusted: true, ...over.certificate },
});

describe("domains BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("domains BFF forwards add, remove, primary and check with CSRF", async () => {
    const bad = { "X-CSRF-Token": "bad" };
    expect((await addDomain(req("POST", bad, {}), sp)).status).toBe(403);
    expect((await removeDomain(req("DELETE", bad, {}), dp)).status).toBe(403);
    expect((await setPrimary(req("POST", bad, {}), dp)).status).toBe(403);
    expect((await checkNow(req("POST", bad, {}), dp)).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });
    await listDomains(req("GET"), sp);
    await addDomain(req("POST", {}, { hostname: "hotel.it", includeWww: true }), sp);
    await removeDomain(req("DELETE"), dp);
    await setPrimary(req("POST"), dp);
    await checkNow(req("POST"), dp);
    const calls = fetchUpstream.mock.calls.map(([path, o]) => [path, o.method]);
    expect(calls).toEqual([
      [base, "GET"],
      [base, "POST"],
      [`${base}/d1`, "DELETE"],
      [`${base}/d1/primary`, "POST"],
      [`${base}/d1/check`, "POST"],
    ]);
    expect(fetchUpstream.mock.calls[1]![1].body).toEqual({ hostname: "hotel.it", includeWww: true });
  });
});

describe("domainView", () => {
  it("domainView orders states", () => {
    const p = dom({});
    const v = (d: SiteDomainDto) => domainView(d, p, now);
    expect(v(dom({ routed: false, dns: { status: "not_found" } })).label).toBe("settingUp");
    expect(v(dom({ dns: { status: "not_found" } }))).toMatchObject({ label: "waitingForDns", hint: "not_found", tone: "warn" });
    expect(v(dom({ dns: { status: "points_elsewhere" } })).hint).toBe("points_elsewhere");
    expect(v(dom({ dns: { status: "ipv6_conflict" } })).hint).toBe("ipv6_conflict");
    expect(v(dom({ dns: { status: "lookup_failed" } })).hint).toBe("lookup_failed");
    expect(v(dom({ certificate: { status: "requested" } })).label).toBe("securing");
    expect(v(dom({ certificate: { status: "failed", problem: "port_80_blocked" } }))).toMatchObject({ label: "httpsProblem", hint: "port_80_blocked", tone: "error" });
    expect(v(dom({ certificate: { status: "failed", problem: null } })).hint).toBe("other");
    expect(v(dom({ certificate: { status: "active", expiresAt: "2026-11-01T00:00:00Z" } })).label).toBe("httpsExpired");
    expect(v(dom({ certificate: { status: "active", expiresAt: "2027-01-01T00:00:00Z", trusted: false } })).label).toBe("testCertificate");
    expect(v(dom({ certificate: { status: "active", expiresAt: "2027-01-01T00:00:00Z" } }))).toMatchObject({ label: "secure", tone: "ok", hint: null });
  });
});

const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });

describe("domains UI", () => {
  const initial: SiteDomainsDto = {
    serverIpv4: "203.0.113.10",
    routesPending: false,
    domains: [dom({ hostname: "hotel.it" }), dom({ hostname: "www.hotel.it", isPrimary: false, dns: { status: "not_found" } })],
  };

  it("panel lists the A records with the server IP", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(wrap(m, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial })));
      for (const s of ["hotel.it", "www.hotel.it", "203.0.113.10"]) expect(html).toContain(s);
    }
  });

  it("offers 'Make main address' only for names with working HTTPS, or while no name has", () => {
    const secure = { certificate: { status: "active" as const, expiresAt: "2099-01-01T00:00:00Z" } };
    const html = (domains: SiteDomainDto[]) =>
      renderToStaticMarkup(wrap(en, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: { ...initial, domains } })));
    const count = (s: string) => s.split(en.site.domains.makeMain).length - 1;
    // primary on https: only a secure secondary may become main
    expect(count(html([dom({ ...secure }), dom({ hostname: "www.hotel.it", isPrimary: false })]))).toBe(0);
    expect(count(html([dom({ ...secure }), dom({ hostname: "www.hotel.it", isPrimary: false, ...secure })]))).toBe(1);
    // site still on http: any other name may
    expect(count(html([dom({}), dom({ hostname: "www.hotel.it", isPrimary: false })]))).toBe(1);
  });

  it("every domain hint exists in both languages and names a next step", () => {
    const keys = ["not_found", "points_elsewhere", "ipv6_conflict", "lookup_failed", "rate_limited", "port_80_blocked", "not_pointing", "caa_blocked", "other"];
    for (const m of [en, itMsgs]) expect(Object.keys(m.site.domains.hint).sort()).toEqual([...keys].sort());
    const h = (m: typeof en) => m.site.domains.hint;
    expect(h(en).not_found).toBe("This address doesn't point anywhere yet. At your domain provider, create an A record for {host} with the value {ip}. Changes can take a few hours; we check automatically.");
    expect(h(en).points_elsewhere).toBe("{host} points to {seen}, not to this server. Change its A record at your domain provider to {ip}.");
    expect(h(en).ipv6_conflict).toBe("{host} also has an IPv6 (AAAA) record. Delete it at your domain provider: this server answers on IPv4 only.");
    expect(h(en).lookup_failed).toBe("We couldn't check right now. We'll try again automatically.");
    expect(h(en).rate_limited).toBe("Let's Encrypt asked us to wait before creating another certificate for this address. We'll try again automatically on {time}; you don't need to do anything.");
    expect(h(en).port_80_blocked).toBe("Let's Encrypt couldn't reach your site from the internet. Your server administrator has been alerted. We'll try again on {time}.");
    expect(h(en).not_pointing).toBe("Let's Encrypt reached a different server for {host}. Check that its A record is {ip} and that there is no AAAA record. We'll try again on {time}.");
    expect(h(en).caa_blocked).toBe("A setting at your domain provider (a CAA record) doesn't allow Let's Encrypt. Ask them to allow letsencrypt.org, or delete the CAA record.");
    expect(h(en).other).toBe("The certificate couldn't be created. We'll try again on {time}. If this keeps happening, contact your server administrator.");
    expect(h(itMsgs).not_found).toContain("Crea un record A per {host} con valore {ip}");
    expect(h(itMsgs).points_elsewhere).toContain("{seen}");
    expect(h(itMsgs).ipv6_conflict).toContain("AAAA");
    expect(h(itMsgs).lookup_failed).toContain("automaticamente");
    expect(h(itMsgs).rate_limited).toContain("{time}");
    expect(h(itMsgs).not_pointing).toContain("{ip}");
    expect(h(itMsgs).caa_blocked).toContain("letsencrypt.org");
    expect(h(itMsgs).other).toContain("amministratore");
    for (const m of [en, itMsgs]) for (const t of Object.values(m.site.domains.hint)) expect(t.length).toBeGreaterThan(20);
  });

  it("state labels and pill copy are exact in both languages", () => {
    expect(en.site.domains.state).toEqual({
      settingUp: "Getting ready",
      waitingForDns: "Waiting for DNS",
      securing: "Setting up HTTPS",
      secure: "HTTPS active",
      httpsProblem: "HTTPS not active yet",
      httpsExpired: "HTTPS expired",
      testCertificate: "Test certificate",
    });
    expect(en.site.domains.pill.validUntil).toBe("HTTPS valid until {date}");
    expect(itMsgs.site.domains.state.waitingForDns).toBe("In attesa del DNS");
    expect(itMsgs.site.domains.pill.validUntil).toBe("HTTPS attivo fino al {date}");
    expect(en.site.activity.domains).toBe("Web addresses updated");
    expect(en.site.domains.removeConfirm).toBe("Visitors using {host} will no longer reach your site.");
    expect(en.site.domains.conflict).toMatch(/Remove it from the other site first, or ask your administrator\.$/);
  });

  it("site tabs include domains between overview and logs", () => {
    expect(SITE_TABS.map((t) => t.key)).toEqual(["overview", "domains", "logs"]);
    expect(SITE_TABS[1]!.href("s1")).toBe("/sites/s1/domains");
  });

  it("port 80 hint says the administrator was alerted", () => {
    expect(en.site.domains.hint.port_80_blocked).toContain("administrator");
    expect(itMsgs.site.domains.hint.port_80_blocked).toContain("amministratore");
  });

  it('create form ticks "Also www" for hotel.it and www.hotel.it but not for blog.hotel.it', () => {
    const checked = (d: string) =>
      /<input[^>]*id="site-includeWww"[^>]*>/.exec(
        renderToStaticMarkup(wrap(en, createElement(SiteForm, { onSubmit: () => {}, submitting: false, initialDomain: d }))),
      )![0].includes("checked");
    expect([checked("hotel.it"), checked("www.hotel.it"), checked("blog.hotel.it")]).toEqual([true, true, false]);
  });

  it("hint drops the time sentence when there is no time, and Copy buttons name the host", () => {
    for (const m of [en, itMsgs]) {
      const failed = dom({ certificate: { status: "failed", problem: "other", retryAt: null }, dns: { nextCheckAt: null as unknown as string } });
      const html = renderToStaticMarkup(wrap(m, createElement(DomainsPanel, { basePath: "/b", csrfToken: "c", initial: { ...initial, domains: [failed, dom({ hostname: "www.hotel.it", isPrimary: false })] } })));
      expect(html).not.toMatch(/(on|il) \./);
      expect(html).not.toContain("{time}");
      for (const h of ["hotel.it", "www.hotel.it"]) expect(html).toContain(`aria-label="${m.site.domains.copyFor.replace("{host}", h).replace("'", "&#x27;")}"`);
    }
  });
});
