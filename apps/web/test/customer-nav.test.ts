import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStackSummaryDto, OrganizationDetailDto, SiteSummaryDto } from "@hosting-panel/contracts";

const nav = vi.hoisted(() => ({ pathname: "/apps", params: {} as Record<string, string> }));
const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSites: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({
  accessToken: "tok",
  csrfToken: "csrf",
  activeConsole: "customer",
  user: { name: "Someone", isServerAdmin: false, mustChangePassword: false },
}));

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => session }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => nav.params,
  usePathname: () => nav.pathname,
}));
// The menu's items render only when it is open: render them inline to read the switcher.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createElement: h, Fragment } = await import("react");
  const pass = ({ children }: { children?: ReactNode }) => h(Fragment, null, children);
  return {
    DropdownMenu: pass,
    DropdownMenuTrigger: pass,
    DropdownMenuContent: ({ children }: { children?: ReactNode }) => h("div", { "data-menu": "" }, children),
    DropdownMenuItem: pass,
    DropdownMenuLabel: pass,
    DropdownMenuSeparator: () => null,
  };
});

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import AccountPage from "@/app/account/page";
import AppsLayout from "@/app/apps/layout";
import SitesLayout from "@/app/sites/layout";
import { CustomerLayout } from "@/app/sites/customer-layout";
import { CustomerTopBar } from "@/components/customer/top-bar";
import { appEntries, appHref, appKindLabel, appLinks, type AppLink } from "@/components/app-stacks/app-stack-view";
import { getSiteAddresses, optional, siteLimitOf } from "@/lib/customer-reads";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const STACKS = `v1/organizations/${ORG}/app-stacks`;
const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: { applicationStacksAvailable: true },
  support: null,
  ...over,
});
const site = (id: string, name: string, siteType: "wordpress" | null = "wordpress") =>
  ({ id, organizationId: ORG, hostAllocationId: "al_1", name, slug: id, status: "ready", phpVersion: "8.3", siteType, createdAt: NOW, updatedAt: NOW }) as SiteSummaryDto;
const stack = (id: string, name: string) =>
  ({
    id,
    name,
    status: "running",
    templateId: "atpl_notes",
    templateName: "Notes",
    templateVersionNumber: 2,
    componentCount: 2,
    unhealthyCount: 0,
    primaryHostname: null,
    updatedAt: NOW,
  }) as AppStackSummaryDto;

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node })).replace(/&#x27;/g, "'");
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const reads = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const anchor = (h: string, href: string) => h.match(new RegExp(`<a[^>]*href="${href.replace(/[/?]/g, "\\$&")}"[^>]*>`))?.[0];
const entry = (h: string) => h.match(/<a[^>]*href="\/apps"[^>]*>([^<]*)<\/a>/);
const LOGO = /<a[^>]*href="\/apps"[^>]*><span[^>]*>HP<\/span>/;
const bar = (apps?: readonly AppLink[]) => html(createElement(CustomerTopBar, { apps, userName: "Someone", csrfToken: "csrf" }));

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/apps";
  nav.params = {};
  mockData.getSites.mockResolvedValue([site("s1", "Blog")]);
  mockData.getCustomerContext.mockResolvedValue(context());
  answer({ [STACKS]: ok([stack("k1", "Notes board")]) });
});

describe("app-stack-view helpers", () => {
  it("appEntries: by name whatever the case or accent, a site before a stack on a tie, then by id, in both languages", () => {
    const sites = [site("s2", "beta"), site("s1", "Alpha"), site("s0", "alpha"), site("s3", "Zeta")];
    const stacks = [stack("k1", "alpha"), stack("k0", "Beta"), stack("k2", "Émile")];
    for (const locale of ["en", "it"] as const) {
      expect(appEntries(sites, stacks, locale).map((e) => `${e.kind}:${e.id}`), locale).toEqual([
        "site:s0",
        "site:s1",
        "stack:k1",
        "site:s2",
        "stack:k0",
        "stack:k2",
        "site:s3",
      ]);
    }
    expect(appEntries([], [], "en")).toEqual([]);
  });

  it("appHref names each kind's page and encodes the id", () => {
    expect(appHref("site", "s1")).toBe("/sites/s1");
    expect(appHref("stack", "k1")).toBe("/apps/k1");
    expect(appHref("site", "a/b")).toBe("/sites/a%2Fb");
    expect(appHref("stack", "a/b?c")).toBe("/apps/a%2Fb%3Fc");
  });

  it("appKindLabel: WordPress for a WordPress site, nothing for a site of no known type, the catalog name for a stack", () => {
    const [wp, other, notes] = appEntries([site("s1", "a"), site("s2", "b", null)], [stack("k1", "c")], "en");
    expect(appKindLabel(en, wp!)).toBe(en.apps.list.wordpress);
    expect(appKindLabel(itMsgs, wp!)).toBe(itMsgs.apps.list.wordpress);
    expect(appKindLabel(en, other!)).toBeNull();
    expect(appKindLabel(en, notes!)).toBe("Notes");
    expect(appLinks(en, [wp!, other!, notes!])).toEqual([
      { kind: "site", id: "s1", name: "a", label: "WordPress" },
      { kind: "site", id: "s2", name: "b", label: null },
      { kind: "stack", id: "k1", name: "c", label: "Notes" },
    ]);
  });
});

describe("customer reads", () => {
  it("getSiteAddresses maps a site to its main address, leaves out a site without one, and gives {} when the read fails", async () => {
    answer({
      [`v1/organizations/${ORG}/managed-sites`]: ok([
        { ...site("s1", "Blog"), primaryDomain: "blog.example.test" },
        { ...site("s2", "Shop"), primaryDomain: null },
        { ...site("s3", "Docs"), primaryDomain: "docs.example.test" },
      ]),
    });
    expect(await getSiteAddresses(ORG)).toEqual({ s1: "blog.example.test", s3: "docs.example.test" });
    expect(reads()).toEqual([`v1/organizations/${ORG}/managed-sites`]);

    answer({ [`v1/organizations/${ORG}/managed-sites`]: fail(500, "INTERNAL") });
    expect(await getSiteAddresses(ORG)).toEqual({});
    answer({});
    expect(await getSiteAddresses(ORG)).toEqual({});
  });

  it("optional and siteLimitOf keep the create form's rules", async () => {
    expect(await optional(Promise.resolve(1))).toBe(1);
    expect(await optional(Promise.reject(new Error("down")))).toBeNull();
    const redirected = Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;replace;/login" });
    await expect(optional(Promise.reject(redirected))).rejects.toBe(redirected);
    expect(siteLimitOf(null)).toBeNull();
    expect(siteLimitOf({ maxSites: null, siteCount: 2 } as OrganizationDetailDto)).toBeNull();
    expect(siteLimitOf({ maxSites: 5, siteCount: 2 } as OrganizationDetailDto)).toEqual({ used: 2, max: 5 });
  });
});

describe("top bar", () => {
  it("logo and «Applications» lead to /apps; the entry is there even with no application", () => {
    const h = bar();
    expect(h).toMatch(LOGO);
    expect(entry(h)?.[1]).toBe(en.apps.nav);
    expect(h).not.toContain(en.shell.switchSite);
    expect(h).not.toContain('href="/sites');
  });

  it("marks the entry on every page of either kind, and nowhere else", () => {
    for (const p of ["/apps", "/apps/new", "/apps/k1", "/sites/s1", "/sites/new"]) {
      nav.pathname = p;
      expect(entry(bar())?.[0], p).toContain('aria-current="page"');
    }
    nav.pathname = "/account";
    expect(entry(bar())?.[0]).not.toContain("aria-current");
  });

  it("the switcher lists both kinds with their kind word and ends with «New application» → /apps/new", () => {
    const apps: AppLink[] = [
      { kind: "site", id: "s1", name: "Blog", label: "WordPress" },
      { kind: "stack", id: "k1", name: "Notes board", label: "Notes" },
      { kind: "site", id: "s2", name: "Legacy", label: null },
    ];
    const h = bar(apps);
    expect(h).toContain(`aria-label="${en.shell.switchSite}: ${en.shell.yourSites}"`);
    const menu = h.slice(h.indexOf("data-menu"), h.lastIndexOf("data-menu")); // the switcher's menu, before the account menu
    expect(menu).toMatch(/href="\/sites\/s1"[^>]*><span[^>]*>Blog<\/span><span[^>]*>WordPress<\/span><\/a>/);
    expect(menu).toMatch(/href="\/apps\/k1"[^>]*><span[^>]*>Notes board<\/span><span[^>]*>Notes<\/span><\/a>/);
    expect(menu).toMatch(/href="\/sites\/s2"[^>]*><span[^>]*>Legacy<\/span><\/a>/);
    expect(menu).not.toContain('aria-current="page"');
    const links = [...menu.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
    expect(links).toEqual(["/sites/s1", "/apps/k1", "/sites/s2", "/apps/new"]);
    expect(menu).toMatch(new RegExp(`href="/apps/new"[^>]*>(<svg.*?</svg>)?${en.shell.newSite}</a>`));
  });

  it("marks the current site and the current stack", () => {
    const apps: AppLink[] = [
      { kind: "site", id: "x1", name: "Blog", label: "WordPress" },
      { kind: "stack", id: "x1", name: "Notes board", label: "Notes" },
    ];
    nav.params = { siteId: "x1" };
    let h = bar(apps);
    expect(h).toContain(`aria-label="${en.shell.switchSite}: Blog"`);
    expect(anchor(h, "/sites/x1")).toContain('aria-current="page"');
    expect(anchor(h, "/apps/x1")).not.toContain("aria-current");

    nav.params = { stackId: "x1" };
    h = bar(apps);
    expect(h).toContain(`aria-label="${en.shell.switchSite}: Notes board"`);
    expect(anchor(h, "/apps/x1")).toContain('aria-current="page"');
    expect(anchor(h, "/sites/x1")).not.toContain("aria-current");
  });

  it("hides the switcher when there is no application", () => {
    const h = bar([]);
    expect(h).not.toContain(en.shell.switchSite);
    expect(h.match(/data-menu/g)).toHaveLength(1); // the account menu only
  });
});

describe("customer layout", () => {
  const child = createElement("p", null, "child");

  it("with the flag on reads the stacks once and lists both kinds", async () => {
    const h = html(await CustomerLayout({ children: child }));
    expect(reads()).toEqual([STACKS]);
    expect(mockData.getSites).toHaveBeenCalledWith(ORG);
    expect(anchor(h, "/sites/s1")).toBeDefined();
    expect(anchor(h, "/apps/k1")).toBeDefined();
    expect(h).toContain("<p>child</p>");
  });

  it("with the flag off or in a support visit reads no stack and lists the sites only", async () => {
    for (const over of [{ capabilities: {} }, { capabilities: null }, { capabilities: { applicationStacksAvailable: "true" } }, { support: { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW } }]) {
      fetchUpstream.mockClear();
      mockData.getCustomerContext.mockResolvedValue(context(over));
      const h = html(await CustomerLayout({ children: child }));
      expect(reads(), JSON.stringify(over)).toEqual([]);
      expect(anchor(h, "/sites/s1"), JSON.stringify(over)).toBeDefined();
      expect(h).not.toMatch(/href="\/apps\/k/);
      expect(h).toContain("<p>child</p>");
    }
  });

  it("a failed read of either kind leaves that kind out and still renders the page", async () => {
    answer({ [STACKS]: fail(500, "INTERNAL") });
    let h = html(await CustomerLayout({ children: child }));
    expect(anchor(h, "/sites/s1")).toBeDefined();
    expect(h).not.toMatch(/href="\/apps\/k/);
    expect(h).toContain("<p>child</p>");
    expect(h).not.toContain(en.shell.loadErrorTitle);

    answer({ [STACKS]: ok([stack("k1", "Notes board")]) });
    mockData.getSites.mockResolvedValue(null);
    h = html(await CustomerLayout({ children: child }));
    expect(anchor(h, "/apps/k1")).toBeDefined();
    expect(h).not.toContain('href="/sites/');
    expect(h).toContain("<p>child</p>");
    expect(h).not.toContain(en.shell.loadErrorTitle);
  });

  it("who-am-I failing shows the load error, reads nothing more, and keeps the top bar", async () => {
    mockData.getCustomerContext.mockResolvedValue(context({ orgId: null, loadError: true, capabilities: null }));
    const h = html(await CustomerLayout({ children: child }));
    expect(h).toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain("<p>child</p>");
    expect(h).toMatch(LOGO);
    expect(entry(h)?.[1]).toBe(en.apps.nav);
    expect(mockData.getSites).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the sites and the apps layouts are this one layout, after the customer guards", async () => {
    const one = html(await CustomerLayout({ children: child }));
    for (const layout of [SitesLayout, AppsLayout]) {
      mockData.getCustomerContext.mockClear();
      expect(html(await layout({ children: child }))).toBe(one);
      expect(mockData.getCustomerContext).toHaveBeenCalled();
    }
    mockData.getCustomerContext.mockRejectedValue(new Error("REDIRECT /login"));
    await expect(SitesLayout({ children: child })).rejects.toThrow("REDIRECT /login");
    await expect(AppsLayout({ children: child })).rejects.toThrow("REDIRECT /login");
  });
});

describe("account page", () => {
  it("shows the «Applications» entry without a switcher and reads no site", async () => {
    answer({
      "v1/me": ok({ user: { name: "Someone", totpEnabled: false }, memberships: [{ organizationId: ORG }], platformCapabilities: {} }),
    });
    const h = html(await AccountPage());
    expect(h).toMatch(LOGO);
    expect(entry(h)?.[1]).toBe(en.apps.nav);
    expect(h).not.toContain(en.shell.switchSite);
    expect(reads()).toEqual(["v1/me"]);
  });
});
