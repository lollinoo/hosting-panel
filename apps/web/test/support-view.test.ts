import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { PLATFORM_OPS_ORG_ID, type MeDto } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";

const getServerSession = vi.fn();
const fetchServerMe = vi.fn();
const fetchServerOrgSites = vi.fn();
const fetchServerOrgSite = vi.fn();
const fetchServerAdminSites = vi.fn();
const fetchUpstream = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT ${to}`);
});

vi.mock("@/lib/server-session", () => ({
  getServerSession: () => getServerSession(),
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("@/lib/server-api", () => ({
  fetchServerMe: () => fetchServerMe(),
  fetchServerOrgSites: (...a: unknown[]) => fetchServerOrgSites(...a),
  fetchServerOrgSite: (...a: unknown[]) => fetchServerOrgSite(...a),
  fetchServerAdminSites: () => fetchServerAdminSites(),
}));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/sites",
}));

import { getCustomerContext, getSite } from "@/app/sites/data";
import SitesLayout from "@/app/sites/layout";
import AdminSitesPage from "@/app/admin/sites/page";
import { POST as openSupport } from "@/app/api/admin/sites/[siteId]/support-access/route";
import { DELETE as leaveSupport } from "@/app/api/admin/support-access/route";
import { SupportBanner } from "@/components/customer/support-banner";
import { SitesTable } from "@/components/admin/sites-table";
import { I18nProvider } from "@/i18n/provider";

const ORG_A = "org-a";
const ORG_B = "org-b";
const visit = { organizationId: ORG_A, organizationName: "Customer A", expiresAt: "2026-11-16T11:30:00.000Z" };
const session = (over: { isServerAdmin?: boolean; activeConsole?: "admin" | "customer" } = {}) => ({
  accessToken: "tok",
  csrfToken: "csrf",
  activeConsole: over.activeConsole ?? "customer",
  user: { id: "u1", name: "Someone", mustChangePassword: false, isServerAdmin: over.isServerAdmin ?? false },
});
const me = (over: Partial<MeDto> = {}) =>
  ({
    user: { id: "u1", email: "user@example.test", name: "Someone", locale: "en", totpEnabled: false, mustChangePassword: false, isServerAdmin: false },
    globalRoles: [],
    hostingAdminOrgIds: [],
    memberships: [],
    platformCapabilities: {},
    ...over,
  }) as MeDto;
const membership = (organizationId: string) => ({ organizationId }) as MeDto["memberships"][number];

const render = (el: ReactElement, messages = en, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages, children: el }));

const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
  });
const params = (siteId: string) => ({ params: Promise.resolve({ siteId }) });

beforeEach(() => {
  for (const f of [getServerSession, fetchServerMe, fetchServerOrgSites, fetchServerOrgSite, fetchServerAdminSites, fetchUpstream]) f.mockReset();
  redirect.mockClear();
  fetchServerOrgSites.mockResolvedValue([]);
});

describe("getCustomerContext", () => {
  it("sends an administrator without a visit back to the admin sites with the ended note", async () => {
    for (const s of [session({ isServerAdmin: true }), session({ activeConsole: "admin" })]) {
      getServerSession.mockResolvedValue(s);
      fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)] }));
      await expect(getCustomerContext()).rejects.toThrow("REDIRECT /admin/sites?support=ended");
    }
  });

  it("never loads a customer page's data for an administrator without a visit", async () => {
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)] }));
    await expect(SitesLayout({ children: null })).rejects.toThrow("REDIRECT");
    expect(fetchServerOrgSites).not.toHaveBeenCalled();
    expect(fetchServerOrgSite).not.toHaveBeenCalled();
  });

  it("gives an administrator in a visit the visit's organisation, never a membership", async () => {
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)], supportAccess: visit }));
    const ctx = await getCustomerContext();
    expect(ctx.orgId).toBe(ORG_A);
    expect(ctx.support).toEqual(visit);
    await getSite(ctx.orgId, "s1");
    expect(fetchServerOrgSite).toHaveBeenCalledWith(ORG_A, "s1");
  });

  it("gives a customer memberships[0] and never the administrator's branch", async () => {
    getServerSession.mockResolvedValue(session());
    // A who-am-I that (wrongly) carried a visit must not move a customer to another organisation.
    fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)], supportAccess: visit }));
    const ctx = await getCustomerContext();
    expect(ctx.orgId).toBe(ORG_B);
    expect(ctx.support).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("gives a customer with no membership no organisation, no visit and no redirect", async () => {
    getServerSession.mockResolvedValue(session());
    fetchServerMe.mockResolvedValue(me({ supportAccess: visit }));
    const ctx = await getCustomerContext();
    expect(ctx.orgId).toBeNull();
    expect(ctx.support).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("keeps the shipped load error when who-am-I fails", async () => {
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerMe.mockResolvedValue(null);
    const ctx = await getCustomerContext();
    expect(ctx).toMatchObject({ orgId: null, loadError: true, support: null });
  });
});

describe("sites layout", () => {
  it("shows the banner only to an administrator in a visit", async () => {
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerMe.mockResolvedValue(me({ supportAccess: visit }));
    const html = render(await SitesLayout({ children: null }));
    expect(html).toContain("Support view: you are seeing the applications of Customer A until");
    expect(fetchServerOrgSites).toHaveBeenCalledWith(ORG_A);

    getServerSession.mockResolvedValue(session());
    fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)], supportAccess: visit }));
    expect(render(await SitesLayout({ children: null }))).not.toContain("Support view");
  });
});

describe("sites not-found page", () => {
  it("renders inside the sites layout: the banner stays during a visit, and only then", async () => {
    const { default: SitesNotFound } = await import("@/app/sites/not-found");
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerMe.mockResolvedValue(me({ supportAccess: visit }));
    const html = render(await SitesLayout({ children: await SitesNotFound() }));
    expect(html).toContain("Support view: you are seeing the applications of Customer A until");
    expect(html).toContain(en.shell.support.leave);
    expect(html).toContain(en.notFound.title);
    expect([...render(await SitesNotFound()).matchAll(/href="([^"]*)"/g)].map((x) => x[1])).toEqual(["/apps"]);
    expect(html).not.toContain('href="/"');
    expect(html.match(/<main/g)).toHaveLength(1);

    getServerSession.mockResolvedValue(session());
    fetchServerMe.mockResolvedValue(me({ memberships: [membership(ORG_B)] }));
    const plain = render(await SitesLayout({ children: await SitesNotFound() }));
    expect(plain).toContain(en.notFound.title);
    expect(plain).not.toContain("Support view");
  });
});

describe("support banner", () => {
  it("names the organisation, escaped as text, with a leave button", () => {
    for (const [m, locale] of [[en, "en"], [itMsgs, "it"]] as const) {
      const html = render(createElement(SupportBanner, { support: { ...visit, organizationName: "<b>x</b>" }, csrfToken: "csrf" }), m, locale);
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>x</b>");
      expect(html).toContain(m.shell.support.leave);
    }
  });

  it("shows the unassigned text for the holding organisation", () => {
    const html = render(createElement(SupportBanner, { support: { ...visit, organizationId: PLATFORM_OPS_ORG_ID, organizationName: "Ops" }, csrfToken: "csrf" }));
    expect(html).toContain("Support view: you are seeing the applications not assigned to any customer, until");
    expect(html).not.toContain("Ops");
  });
});

describe("support BFF routes", () => {
  it("opens a visit on the site", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: visit } });
    const res = await openSupport(req("POST"), params("s1"));
    expect(res.status).toBe(201);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/sites/s1/support-access", expect.objectContaining({ method: "POST", accessToken: "tok" }));
  });

  it("refuses a bad site id before the upstream", async () => {
    expect((await openSupport(req("POST"), params("../x"))).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("leaves the visit", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 204, data: null });
    expect((await leaveSupport(req("DELETE"))).status).toBe(204);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/support-access", expect.objectContaining({ method: "DELETE", accessToken: "tok" }));
  });

  it("refuses a bad CSRF token or a foreign Origin on both routes without calling the upstream", async () => {
    expect((await openSupport(req("POST", { "X-CSRF-Token": "bad" }), params("s1"))).status).toBe(403);
    expect((await leaveSupport(req("DELETE", { "X-CSRF-Token": "bad" }))).status).toBe(403);
    expect((await openSupport(req("POST", { Origin: "http://evil.example.test" }), params("s1"))).status).toBe(403);
    expect((await leaveSupport(req("DELETE", { Origin: "http://evil.example.test" }))).status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("admin sites", () => {
  it("has the support action on every row, unassigned included", () => {
    const sites = [
      { id: "s1", name: "a", primaryDomain: "wp-a.example.test", owner: { id: ORG_A, name: "Customer A" }, phpVersion: "8.3", status: "ready" },
      { id: "s2", name: "b", primaryDomain: null, owner: null, phpVersion: null, status: "ready" },
    ];
    const html = render(createElement(SitesTable, { sites, customers: [], csrfToken: "csrf" } as never));
    expect(html.split(en.admin.sites.support.open)).toHaveLength(3);
  });

  it("shows the ended note only when asked", async () => {
    getServerSession.mockResolvedValue(session({ isServerAdmin: true }));
    fetchServerAdminSites.mockResolvedValue(null);
    const ended = renderToStaticMarkup(await AdminSitesPage({ searchParams: Promise.resolve({ support: "ended" }) }));
    expect(ended).toContain(en.admin.sites.support.ended);
    const plain = renderToStaticMarkup(await AdminSitesPage({ searchParams: Promise.resolve({}) }));
    expect(plain).not.toContain(en.admin.sites.support.ended);
  });
});
