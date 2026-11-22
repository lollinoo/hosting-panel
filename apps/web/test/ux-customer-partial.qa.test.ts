// QA slice Q2 (ux-customer §10): the customer list, the switcher and the chooser when one read fails.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStackSummaryDto, CustomerAppTemplateSummaryDto, CustomerSiteTypeDto, ManagedSiteDto, SiteSummaryDto } from "@hosting-panel/contracts";

const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSites: vi.fn() }));
const fetchUpstream = vi.hoisted(() => vi.fn());

vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-session", () => ({ getServerSession: async () => ({ accessToken: "tok", csrfToken: "csrf" }) }));
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => "/apps",
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
import { format } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import { CustomerLayout } from "@/app/sites/customer-layout";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const ON = { applicationStacksAvailable: true };
const STACKS = `v1/organizations/${ORG}/app-stacks`;
const ADDRESSES = `v1/organizations/${ORG}/managed-sites`;
const TYPES = `v1/organizations/${ORG}/site-types`;
const CATALOG = `v1/organizations/${ORG}/app-templates`;
const ORG_PATH = `v1/organizations/${ORG}`;

const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: ON,
  support: null,
  ...over,
});
const site = (id: string, name: string): SiteSummaryDto => ({
  id, organizationId: ORG, hostAllocationId: "al_1", name, slug: id, status: "ready", phpVersion: "8.3", siteType: "wordpress", createdAt: NOW, updatedAt: NOW,
});
const stack = (id: string, name: string): AppStackSummaryDto => ({
  id, name, status: "running", templateId: "atpl_notes", templateName: "Notes", templateVersionNumber: 2, componentCount: 2, unhealthyCount: 0, primaryHostname: null, updatedAt: NOW,
});
const wpType = (id: string): CustomerSiteTypeDto => ({
  id, name: id, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [],
});
const NOTES = {
  id: "atpl_notes", name: "Notes", description: null, category: "content", versionId: "atv_notes_1", versionNumber: 1,
  componentCount: 1, cpuMilli: 500, memoryBytes: String(2 ** 28), volumeCount: 0, hasIngress: true,
} satisfies CustomerAppTemplateSummaryDto;

const BLOG = site("s1", "Blog");
const BOARD = stack("k1", "Notes board");

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const reads = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const hrefs = (h: string) => [...h.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1]!);
const rowLinks = (h: string) => hrefs(h).filter((x) => x.startsWith("/sites/") || /^\/apps\/(?!new)/.test(x));

beforeEach(() => {
  vi.clearAllMocks();
  mockData.getCustomerContext.mockResolvedValue(context());
  mockData.getSites.mockResolvedValue([BLOG]);
  answer({});
});

// ---- the stack read, as the four states the matrix names ------------------------------------------------------
type StackRead = "ok" | "empty" | "500" | "422" | "off";
const STACK_READS: StackRead[] = ["ok", "empty", "500", "422", "off"];
const stackAnswer = (s: StackRead): Record<string, unknown> =>
  s === "ok" ? { [STACKS]: ok([BOARD]) }
  : s === "empty" ? { [STACKS]: ok([]) }
  : s === "500" ? { [STACKS]: fail(500, "INTERNAL_ERROR") }
  : s === "422" ? { [STACKS]: fail(422, "NOT_SUPPORTED") }
  : { [STACKS]: ok([BOARD]) }; // flag off: the answer must never be read
const arrange = (s: StackRead) => {
  mockData.getCustomerContext.mockResolvedValue(context(s === "off" ? { capabilities: {} } : {}));
  return stackAnswer(s);
};

type SiteRead = "ok" | "empty" | "null";
const SITE_READS: SiteRead[] = ["ok", "empty", "null"];
const sitesOf = (s: SiteRead) => (s === "ok" ? [BLOG] : s === "empty" ? [] : null);

describe("/apps — every combination of the site read and the stack read", () => {
  const matrix = SITE_READS.flatMap((s) => STACK_READS.map((k) => [s, k] as const));

  it.each(matrix)("sites %s × stacks %s", async (s, k) => {
    mockData.getSites.mockResolvedValue(sitesOf(s));
    answer({ ...arrange(k), [ADDRESSES]: ok([{ ...BLOG, primaryDomain: "blog.example.test" } satisfies ManagedSiteDto]) });
    const h = html(await AppsPage());

    const stacksRows = k === "ok" ? 1 : 0;
    const siteRows = s === "ok" ? 1 : 0;
    const nothingRead = s === "null" && k !== "ok" && k !== "empty";
    expect(h.includes(en.shell.loadErrorTitle), "load error only when nothing could be read").toBe(nothingRead);
    // no "applications are not available" notice, whatever the flag or the server says
    expect(h).not.toContain(en.apps.unavailable.title);
    // the flag decides the stack read; the 422 of a server with applications off is not a warning
    expect(reads().includes(STACKS)).toBe(k !== "off");
    if (nothingRead) {
      expect(h).not.toContain(en.apps.list.title);
      return;
    }

    const partial = s === "null" || k === "500";
    expect(h.includes(en.apps.list.partial), "warning").toBe(partial);
    expect(h.includes('role="alert"')).toBe(partial);
    // header and the create button are there in every state
    expect(h).toMatch(new RegExp(`<h1[^>]*>${en.apps.list.title}</h1>`));
    expect(hrefs(h)).toContain("/apps/new");
    // what was read is listed; one failing read never hides the other kind
    expect(rowLinks(h)).toEqual([...(siteRows ? ["/sites/s1"] : []), ...(stacksRows ? ["/apps/k1"] : [])]);
    if (siteRows) expect(h).toContain("blog.example.test");
    // «no applications yet» is said only when both reads really answered empty
    const noRows = siteRows + stacksRows === 0;
    expect(h.includes(en.apps.list.empty), "empty sentence").toBe(noRows && !partial);
    if (noRows && partial) expect(h).not.toContain("<table");
  });

  it("a failed address read never changes the list or adds a warning", async () => {
    answer({ [STACKS]: ok([BOARD]), [ADDRESSES]: fail(500, "INTERNAL_ERROR") });
    const h = html(await AppsPage());
    expect(rowLinks(h)).toEqual(["/sites/s1", "/apps/k1"]);
    expect(h).not.toContain(en.apps.list.partial);
  });

  it("no organisation or a failed who-am-I is the load error with no read at all", async () => {
    for (const over of [{ orgId: null }, { loadError: true, orgId: null, capabilities: null }]) {
      mockData.getCustomerContext.mockResolvedValue(context(over));
      expect(html(await AppsPage())).toContain(en.shell.loadErrorTitle);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(mockData.getSites).not.toHaveBeenCalled();
  });

  it("a support visit reads no stack whatever the server says, and still lists the sites", async () => {
    for (const k of ["ok", "500", "422"] as const) {
      fetchUpstream.mockClear();
      mockData.getCustomerContext.mockResolvedValue(context({ support: { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW } }));
      answer(stackAnswer(k));
      const h = html(await AppsPage());
      expect(reads()).not.toContain(STACKS);
      expect(rowLinks(h)).toEqual(["/sites/s1"]);
      expect(h).not.toContain(en.apps.list.partial);
    }
  });
});

describe("the switcher — every combination of the site read and the stack read", () => {
  const child = createElement("p", null, "child");
  const matrix = SITE_READS.flatMap((s) => STACK_READS.map((k) => [s, k] as const));

  it.each(matrix)("sites %s × stacks %s", async (s, k) => {
    mockData.getSites.mockResolvedValue(sitesOf(s));
    answer(arrange(k));
    const h = html(await CustomerLayout({ children: child }));

    // the page is never replaced by the load error because of a list read; the child and the entry stay
    expect(h).not.toContain(en.shell.loadErrorTitle);
    expect(h).toContain("<p>child</p>");
    expect(h).toContain(`>${en.apps.nav}</a>`);
    expect(reads().includes(STACKS)).toBe(k !== "off");

    const expected = [...(s === "ok" ? ["/sites/s1"] : []), ...(k === "ok" ? ["/apps/k1"] : [])];
    if (expected.length === 0) {
      expect(h).not.toContain(en.shell.switchSite); // nothing to switch between
      expect(h.match(/data-menu/g)).toHaveLength(1); // the account menu only
      return;
    }
    const menu = h.slice(h.indexOf("data-menu"), h.lastIndexOf("data-menu"));
    expect([...menu.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual([...expected, "/apps/new"]);
  });

  it("an unreadable site list leaves the page and the other kind alone", async () => {
    mockData.getSites.mockResolvedValue(null);
    answer({ [STACKS]: ok([BOARD, stack("k2", "Alpha")]) });
    const h = html(await CustomerLayout({ children: child }));
    const menu = h.slice(h.indexOf("data-menu"), h.lastIndexOf("data-menu"));
    expect([...menu.matchAll(/href="([^"]+)"/g)].map((x) => x[1])).toEqual(["/apps/k2", "/apps/k1", "/apps/new"]);
  });
});

// ---- /apps/new ------------------------------------------------------------------------------------------------
type Types = "null" | "none" | "one" | "two";
type Catalog = "empty" | "one" | "500" | "422" | "off";
type Limit = "none" | "free" | "full";
const TYPE_STATES: Types[] = ["null", "none", "one", "two"];
const CATALOG_STATES: Catalog[] = ["empty", "one", "500", "422", "off"];
const LIMITS: Limit[] = ["none", "free", "full"];
const typesAnswer = (t: Types) =>
  t === "null" ? fail(500, "INTERNAL_ERROR")
  : t === "none" ? ok({ siteTypes: [] })
  : t === "one" ? ok({ siteTypes: [wpType("stpl_a")] })
  : ok({ siteTypes: [wpType("stpl_a"), wpType("stpl_b")] });
const catalogAnswer = (c: Catalog) =>
  c === "one" ? ok({ templates: [NOTES], categories: ["content"] })
  : c === "500" ? fail(500, "INTERNAL_ERROR")
  : c === "422" ? fail(422, "NOT_SUPPORTED")
  : ok({ templates: [], categories: [] }); // "empty", and "off" (never read)
const limitAnswer = (l: Limit) => ok({ maxSites: l === "none" ? null : 3, siteCount: l === "full" ? 3 : 1 });
const wordpressLinks = (t: Types) => (t === "null" ? ["/sites/new"] : t === "none" ? [] : t === "one" ? ["/sites/new?type=stpl_a"] : ["/sites/new?type=stpl_a", "/sites/new?type=stpl_b"]);

describe("/apps/new — types × catalog × limit (§5.1)", () => {
  const matrix = TYPE_STATES.flatMap((t) => CATALOG_STATES.flatMap((c) => LIMITS.map((l) => [t, c, l] as const)));

  it.each(matrix)("types %s × catalog %s × limit %s", async (t, c, l) => {
    mockData.getCustomerContext.mockResolvedValue(context(c === "off" ? { capabilities: {} } : {}));
    answer({ [TYPES]: typesAnswer(t), [CATALOG]: catalogAnswer(c), [ORG_PATH]: limitAnswer(l) });

    const choices = (t === "null" ? 1 : t === "none" ? 0 : t === "one" ? 1 : 2);
    const templates = c === "one" ? 1 : 0;
    const catalogFailed = c === "500"; // a 422 or an unread catalog is «no applications», not a failure

    if (templates === 0 && !catalogFailed && choices <= 1) {
      // one possible choice (or none): the WordPress form says it all, limit or not
      await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
      expect(reads().includes(CATALOG)).toBe(c !== "off");
      return;
    }

    const h = html(await NewAppPage());
    expect(reads().includes(CATALOG)).toBe(c !== "off");
    expect(h).not.toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain(en.apps.wizard.stepsLabel);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toMatch(new RegExp(`<h1[^>]*>${en.apps.catalog.title}</h1>`));
    expect(h.includes(en.apps.list.partial), "partial warning").toBe(catalogFailed);
    expect(h.includes('role="alert"')).toBe(catalogFailed);

    const full = l === "full";
    const shown = choices > 0 && !full ? wordpressLinks(t) : [];
    // the catalog cards are never hidden by a full limit, and always come after the WordPress cards
    expect(hrefs(h).filter((x) => x.startsWith("/sites/new") || x.startsWith("/apps/new/"))).toEqual([
      ...shown,
      ...(templates ? ["/apps/new/atpl_notes"] : []),
    ]);
    expect(h.includes("data-site-usage"), "usage line").toBe(choices > 0 && l !== "none");
    expect(h.includes(format(en.site.create.limitReached, { max: 3 })), "limit sentence").toBe(choices > 0 && full);
    if (l === "free" && choices > 0) expect(h).toContain(format(en.site.create.usage, { used: 1, max: 3 }));
  });

  it("a full limit with a catalog entry keeps the card and says why the WordPress cards are gone", async () => {
    answer({ [TYPES]: typesAnswer("two"), [CATALOG]: catalogAnswer("one"), [ORG_PATH]: limitAnswer("full") });
    const h = html(await NewAppPage());
    expect(h).toContain(format(en.site.create.limitReached, { max: 3 }));
    expect(h).toContain("Notes");
    expect(hrefs(h)).toContain("/apps/new/atpl_notes");
    expect(hrefs(h).some((x) => x.startsWith("/sites/new"))).toBe(false);
  });

  it("an unreadable organisation reads as no limit; the cards stay", async () => {
    answer({ [TYPES]: typesAnswer("two"), [CATALOG]: catalogAnswer("one"), [ORG_PATH]: fail(500, "INTERNAL_ERROR") });
    const h = html(await NewAppPage());
    expect(h).not.toContain("data-site-usage");
    expect(hrefs(h).filter((x) => x.startsWith("/sites/new"))).toEqual(wordpressLinks("two"));
  });

  it("types that fail with a limit that is full still leave one generic card out, replaced by the limit sentence", async () => {
    answer({ [TYPES]: typesAnswer("null"), [CATALOG]: catalogAnswer("500"), [ORG_PATH]: limitAnswer("full") });
    const h = html(await NewAppPage());
    expect(h).toContain(en.apps.list.partial);
    expect(h).toContain(format(en.site.create.limitReached, { max: 3 }));
    expect(hrefs(h)).not.toContain("/sites/new");
  });

  it("a malformed types body or a thrown read counts as unreadable: one generic WordPress choice, never a crash", async () => {
    // the catalog's body answered on the types path: no `siteTypes` list in it
    answer({ [TYPES]: ok({ templates: [NOTES], categories: [] }), [CATALOG]: catalogAnswer("one") });
    expect(hrefs(html(await NewAppPage())).filter((x) => x.startsWith("/sites/new"))).toEqual(["/sites/new"]);

    fetchUpstream.mockImplementation(async (path: string) => {
      if (path === TYPES) throw new Error("socket hang up");
      return path === CATALOG ? catalogAnswer("one") : fail(404, "NOT_FOUND");
    });
    expect(hrefs(html(await NewAppPage())).filter((x) => x.startsWith("/sites/new"))).toEqual(["/sites/new"]);
  });

  it("a support visit redirects to the WordPress form for every combination, with no read", async () => {
    mockData.getCustomerContext.mockResolvedValue(context({ support: { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW } }));
    for (const t of TYPE_STATES) {
      answer({ [TYPES]: typesAnswer(t), [CATALOG]: catalogAnswer("one"), [ORG_PATH]: limitAnswer("full") });
      await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});
