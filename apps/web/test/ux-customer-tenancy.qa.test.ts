import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerSiteTypeDto, MeDto } from "@hosting-panel/contracts";

// Q4 (ux-customer §10): tenancy and address handling of the customer area. The real customer context
// (`getCustomerContext`) and the real server reads run; only the session, the upstream HTTP call, next/headers and
// next/navigation are replaced, so what is asserted is the set of upstream paths a page really asks for and the
// addresses it really renders. Cookies are baited: `cookies()` / `headers()` throw, so any read of one fails loudly.
// The allowed reads on /apps are /v1/me, …/sites and …/managed-sites (ARCHITECTURE-UX L31).

const session = vi.hoisted(() => ({ current: null as unknown }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/apps" }));
const headerReads = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));

vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => session.current,
  getSessionFromRequest: async () => session.current,
}));
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => "en" }));
vi.mock("next/headers", () => ({
  cookies: (...a: unknown[]) => {
    headerReads.cookies(...a);
    throw new Error("a customer page read a cookie");
  },
  headers: (...a: unknown[]) => {
    headerReads.headers(...a);
    throw new Error("a customer page read the request headers");
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => nav.pathname,
}));
// A dropdown is closed in server-rendered HTML: render the menus inline so the switcher can be read.
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
import { I18nProvider } from "@/i18n/provider";
import { CustomerLayout } from "@/app/sites/customer-layout";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import NewSitePage from "@/app/sites/new/page";
import { NewSite } from "@/components/customer/new-site";
import { SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { SiteTypeCards } from "@/components/customer/site-type-cards";
import { getSiteAddresses } from "@/lib/customer-reads";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG_A = "org_a1";
const ORG_B = "org_b2";
const ME = "v1/me";
const SITES = `v1/organizations/${ORG_A}/sites`;
const ADDRESSES = `v1/organizations/${ORG_A}/managed-sites`;
const TYPES = `v1/organizations/${ORG_A}/site-types`;
const ORG = `v1/organizations/${ORG_A}`;
const STACKS = `v1/organizations/${ORG_A}/app-stacks`;
const CATALOG = `v1/organizations/${ORG_A}/app-templates`;
const ON = { applicationStacksAvailable: true, applicationTemplatesAvailable: true };

const sessionOf = (over: { isServerAdmin?: boolean; activeConsole?: "customer" | "admin" } = {}) => ({
  accessToken: "tok",
  csrfToken: "csrf",
  activeConsole: over.activeConsole ?? "customer",
  user: { id: "u1", name: "Someone", email: "someone@example.test", mustChangePassword: false, isServerAdmin: over.isServerAdmin ?? false },
});
const visit = { organizationId: ORG_A, organizationName: "Customer A", expiresAt: NOW };
const meOf = (over: Record<string, unknown> = {}) =>
  ({
    user: { id: "u1", email: "someone@example.test", name: "Someone", locale: "en", totpEnabled: false, mustChangePassword: false, isServerAdmin: false },
    globalRoles: [],
    hostingAdminOrgIds: [],
    memberships: [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    platformCapabilities: ON,
    ...over,
  }) as unknown as MeDto;

const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const site = (id: string, name = "Blog") => ({
  id, organizationId: ORG_A, hostAllocationId: "al_1", name, slug: "blog", status: "ready", phpVersion: "8.3", siteType: "wordpress", createdAt: NOW, updatedAt: NOW,
});
const stack = (id: string, name = "Notes stack") => ({
  id, name, status: "running", templateId: "atpl_notes", templateName: "Notes", templateVersionNumber: 2,
  componentCount: 2, unhealthyCount: 0, primaryHostname: null, updatedAt: NOW,
});
const template = (id: string, name = "Notes template") => ({
  id, name, description: null, category: "content", versionId: "atv_1", versionNumber: 1,
  componentCount: 1, cpuMilli: 500, memoryBytes: String(2 ** 28), volumeCount: 0, hasIngress: true,
});
const type = (id: string, over: Partial<CustomerSiteTypeDto> = {}): CustomerSiteTypeDto => ({
  id, name: `Type ${id}`, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [], ...over,
});

const answers = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  [SITES]: ok([site("s1")]),
  [ADDRESSES]: ok([{ ...site("s1"), primaryDomain: "blog.example.test" }]),
  [STACKS]: ok([stack("k1")]),
  [CATALOG]: ok({ templates: [template("atpl_notes")], categories: ["content"] }),
  [TYPES]: ok({ siteTypes: [type("stpl_a"), type("stpl_b")] }),
  [ORG]: ok({ id: ORG_A, name: "Customer A", maxSites: null, siteCount: 1 }),
  ...extra,
});
const upstream = (me: MeDto, extra: Record<string, unknown> = {}) => {
  const byPath = answers(extra);
  fetchUpstream.mockImplementation(async (path: string) => (path === ME ? ok(me) : (byPath[path] ?? fail(404, "NOT_FOUND"))));
};
const paths = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const nonMe = () => paths().filter((p) => p !== ME);
const sorted = (xs: string[]) => [...xs].sort();

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const hrefs = (h: string) => [...h.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1]!);

const customerSetup = (me: MeDto = meOf(), extra: Record<string, unknown> = {}) => {
  session.current = sessionOf();
  upstream(me, extra);
};
const visitSetup = (activeConsole: "customer" | "admin", extra: Record<string, unknown> = {}) => {
  session.current = sessionOf({ isServerAdmin: true, activeConsole });
  // the visited organisation (A) is NOT the administrator's own membership (B): a wrong source would read B
  upstream(meOf({ memberships: [{ organizationId: ORG_B }], supportAccess: visit }), extra);
};

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/apps";
  customerSetup();
});
afterEach(() => {
  // whatever happened above, no customer page may have touched a cookie or the raw request headers
  expect(headerReads.cookies).not.toHaveBeenCalled();
  expect(headerReads.headers).not.toHaveBeenCalled();
});

// ------------------------------------------------------------------------------------------------ the source

const web = path.resolve(__dirname, "..");
const src = path.join(web, "src");
const code = (rel: string) =>
  fs
    .readFileSync(path.join(src, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const ORG_FROM_URL = /params\b[^\n;]*\b(orgId|organizationId|orgSlug)\b|\b(orgId|organizationId|orgSlug)\b[^\n;]*=\s*await\s+(params|searchParams)/i;
const NEW_FILES = [
  "app/sites/customer-layout.tsx",
  "app/sites/layout.tsx",
  "app/apps/layout.tsx",
  "app/apps/page.tsx",
  "app/apps/new/page.tsx",
  "app/sites/new/page.tsx",
  "lib/customer-reads.ts",
  "components/customer/site-type-cards.tsx",
  "components/customer/top-bar.tsx",
  "components/app-stacks/app-stack-list.tsx",
  "components/app-stacks/app-stack-view.ts",
];

describe("the new and edited customer files take no organisation from the address, a query or a cookie", () => {
  it.each(NEW_FILES)("%s", (rel) => {
    const c = code(rel);
    expect(c).not.toMatch(ORG_FROM_URL);
    expect(c).not.toMatch(/cookies\s*\(|headers\s*\(|next\/headers|document\.cookie|useSearchParams|location\.(pathname|search|href)/);
    // only the one page that offers `?type=` may even mention searchParams
    if (rel !== "app/sites/new/page.tsx") expect(c).not.toMatch(/searchParams/);
    // a file that has an organisation id gets it from the customer context (or from a caller that did), never from `params`
    if (/\borgId\b/.test(c) && rel.startsWith("app/")) expect(c).toMatch(/getCustomerContext\(\)/);
  });

  it("/sites/new reads one query field, `type`, and nothing else from the query", () => {
    const c = code("app/sites/new/page.tsx");
    const fields = [...c.matchAll(/\(await searchParams\)\??\.(\w+)/g)].map((m) => m[1]);
    expect(fields).toEqual(["type"]);
    expect(c).toMatch(/=\s*await getCustomerContext\(\)/);
  });

  it("the three organisation-reading pages build every path from the context's orgId (no literal organisation, no params)", () => {
    for (const rel of ["app/apps/page.tsx", "app/apps/new/page.tsx", "app/sites/new/page.tsx", "app/sites/customer-layout.tsx"]) {
      const c = code(rel);
      expect(c, rel).not.toMatch(/v1\/organizations\//);
      expect(c, rel).not.toMatch(/\bparams\b/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ behaviour: the organisation

const hostileProps = {
  searchParams: Promise.resolve({ orgId: ORG_B, organizationId: ORG_B, org: ORG_B, orgSlug: ORG_B, organization: ORG_B, type: "stpl_b" }),
  params: Promise.resolve({ orgId: ORG_B, organizationId: ORG_B }),
};
type Page = [string, () => Promise<unknown>];
const pagesWithHostileProps: Page[] = [
  ["CustomerLayout", () => CustomerLayout({ children: null, ...hostileProps } as never)],
  ["AppsPage", () => (AppsPage as (p: unknown) => Promise<unknown>)(hostileProps)],
  ["NewAppPage", () => (NewAppPage as (p: unknown) => Promise<unknown>)(hostileProps)],
  ["NewSitePage", () => (NewSitePage as (p: unknown) => Promise<unknown>)(hostileProps)],
];

describe("the organisation is the first membership, whatever the address, the query or the props say", () => {
  it.each(pagesWithHostileProps)("%s reads only organisation A (memberships[0]), never B", async (_name, page) => {
    await page();
    const reads = nonMe();
    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) expect(p, p).toMatch(new RegExp(`^v1/organizations/${ORG_A}(/|$)`));
    for (const p of paths()) expect(p).not.toContain(ORG_B);
  });

  it("with the application flag on, the whole customer area still stays inside organisation A", async () => {
    for (const [, page] of pagesWithHostileProps) await page();
    expect(paths().filter((p) => p !== ME && !p.startsWith(`v1/organizations/${ORG_A}`))).toEqual([]);
    // the control: this run really reached the application routes, so the check above is not vacuous
    expect(paths()).toEqual(expect.arrayContaining([STACKS, CATALOG, ADDRESSES, TYPES]));
  });

  it("a customer whose /v1/me carries a support visit for another organisation still reads memberships[0] and shows no banner", async () => {
    customerSetup(meOf({ supportAccess: { ...visit, organizationId: "org_visit", organizationName: "Visited Customer" } }));
    const h = html(await CustomerLayout({ children: null }));
    await AppsPage();
    expect(h).not.toContain("Visited Customer");
    for (const p of nonMe()) expect(p).toMatch(new RegExp(`^v1/organizations/${ORG_A}/`));
    expect(paths().some((p) => p.includes("org_visit"))).toBe(false);
  });

  it("a customer with no membership reads no organisation route at all: load error, redirect to /apps, children still render", async () => {
    customerSetup(meOf({ memberships: [] }));
    expect(html(await AppsPage() as ReactNode)).toContain(en.shell.loadErrorTitle);
    expect(html(await NewAppPage() as ReactNode)).toContain(en.shell.loadErrorTitle);
    await expect(NewSitePage()).rejects.toThrow("REDIRECT /apps");
    expect(html(await CustomerLayout({ children: createElement("p", null, "child") }))).toContain("<p>child</p>");
    expect(nonMe()).toEqual([]);
  });

  it("a failed /v1/me reads no organisation route either", async () => {
    session.current = sessionOf();
    fetchUpstream.mockImplementation(async () => fail(500, "INTERNAL_ERROR"));
    expect(html(await AppsPage() as ReactNode)).toContain(en.shell.loadErrorTitle);
    expect(html(await NewAppPage() as ReactNode)).toContain(en.shell.loadErrorTitle);
    await expect(NewSitePage()).rejects.toThrow("REDIRECT /apps");
    expect(nonMe()).toEqual([]);
  });

  it.each([
    ["customer cookie", { isServerAdmin: false, activeConsole: "admin" as const }],
    ["server administrator", { isServerAdmin: true, activeConsole: "customer" as const }],
  ])("%s without a support visit goes back to the administrators' list before any organisation read", async (_label, who) => {
    session.current = sessionOf(who);
    upstream(meOf());
    for (const [name, page] of pagesWithHostileProps) {
      fetchUpstream.mockClear();
      await expect(page(), name).rejects.toThrow("REDIRECT /admin/sites?support=ended");
      expect(nonMe(), name).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------------------------------------ behaviour: a support visit

describe.each([["admin" as const], ["customer" as const]])("a support visit (console cookie «%s»), application flag on", (consoleCookie) => {
  beforeEach(() => visitSetup(consoleCookie));

  it("the layout reads /v1/me and …/sites of the visited organisation, nothing else", async () => {
    const h = html(await CustomerLayout({ children: null }));
    expect(nonMe()).toEqual([SITES]);
    expect(h).toContain("Customer A");
    expect(h).not.toContain("Notes stack");
  });

  it("/apps reads nothing but /v1/me, …/sites and …/managed-sites (L31), all of the visited organisation", async () => {
    const h = html((await AppsPage()) as ReactNode);
    expect(sorted(nonMe())).toEqual(sorted([SITES, ADDRESSES]));
    expect(paths().some((p) => p.includes(ORG_B))).toBe(false);
    expect(paths().some((p) => p.includes("app-") || p.includes("site-types") || p.endsWith(ORG))).toBe(false);
    expect(h).toContain("Blog");
    expect(h).toContain("blog.example.test");
    expect(h).not.toContain("Notes stack");
  });

  it("/apps/new reads nothing but /v1/me and sends to the WordPress form", async () => {
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(nonMe()).toEqual([]);
  });

  it("/sites/new in a visit reads nothing but /v1/me, and a `?type=` id is not sent anywhere", async () => {
    const el = (await NewSitePage({ searchParams: Promise.resolve({ type: "stpl_b" }) })) as ReactElement<Record<string, unknown>>;
    expect(nonMe()).toEqual([]);
    expect(el.props.siteTypes).toEqual([]);
    expect(el.props.limit).toBeNull();
    expect(el.props.orgId).toBe(ORG_A);
  });
});

// ------------------------------------------------------------------------------------------------ `/sites/new?type=`

const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
const formBody = { name: "a", domain: "a.test", title: "t", adminUser: "u", adminEmail: "u@a.test", adminPassword: "p".repeat(12), includeWww: false } as SiteFormBody;

/** Render NewSite's element once with the hooks stubbed, submit its form, and return what the browser would POST. */
async function postedBy(props: Record<string, unknown>, fetchMock: ReturnType<typeof vi.fn>) {
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => [v, () => {}],
    useRef: (v: unknown) => ({ current: v }),
    useContext: () => ({ locale: "en", messages: en }),
  };
  let tree: ReactNode;
  try {
    tree = NewSite(props as never);
  } finally {
    internals.H = prev;
  }
  const find = (node: unknown): ReactElement<{ onSubmit: (b: SiteFormBody) => Promise<void> }> | undefined => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!isValidElement(node)) return undefined;
    if (node.type === SiteForm) return node as ReactElement<{ onSubmit: (b: SiteFormBody) => Promise<void> }>;
    return find((node.props as { children?: unknown }).children);
  };
  await find(tree)!.props.onSubmit(formBody);
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), body: JSON.parse(init.body as string) as Record<string, unknown>, raw: init.body as string };
}

describe("/sites/new?type= never reaches an upstream path or a body unless it is an offered id", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { siteId: "s1" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const HOSTILE: [string, string | string[] | undefined, "first" | "chosen" | "none"][] = [
    ["a path climb", "../x", "first"],
    ["a climb through the organisation", `../../${ORG_B}/sites`, "first"],
    ["another organisation's id", "org_other", "first"],
    ["the visited organisation's id", ORG_B, "first"],
    ["an empty value", "", "first"],
    ["an array", ["stpl_a"], "first"],
    ["a two-value array", ["stpl_b", "stpl_a"], "first"],
    ["an absent value", undefined, "first"],
    ["an encoded climb", "%2e%2e", "first"],
    ["a slash", "stpl_a/../..", "first"],
    ["a query smuggle", "stpl_b?x=1", "first"],
    ["a fragment", "stpl_b#x", "first"],
    ["a different case of an offered id", "STPL_B", "first"],
    ["a padded offered id", " stpl_b", "first"],
    ["a script", '"><script>alert(1)</script>', "first"],
    ["the prototype key", "__proto__", "first"],
    ["an offered id", "stpl_b", "chosen"],
  ];

  it.each(HOSTILE)("?type = %s: no upstream path carries it, the form posts an offered id", async (_label, value) => {
    const query = value === undefined ? {} : { type: value };
    const el = (await NewSitePage({ searchParams: Promise.resolve(query) })) as ReactElement<Record<string, unknown>>;
    // the page reads the same three things whatever the query says, and none of them carries the value
    expect(paths()).toEqual(expect.arrayContaining([ME, ORG, TYPES]));
    expect(sorted(nonMe())).toEqual(sorted([ORG, TYPES]));
    for (const v of [value].flat()) if (v) for (const p of paths()) expect(p).not.toContain(v);

    const offered = (el.props.siteTypes as CustomerSiteTypeDto[]).map((t) => t.id);
    expect(offered).toEqual(["stpl_a", "stpl_b"]);
    const { url, body, raw } = await postedBy(el.props, fetchMock);
    expect(url).toBe(`/api/bff/orgs/${ORG_A}/managed-sites`);
    expect(body.templateId).toBe(value === "stpl_b" ? "stpl_b" : "stpl_a");
    for (const v of [value].flat()) if (v && v !== "stpl_b" && v !== "stpl_a") expect(raw).not.toContain(v);
  });

  it("with the types unreadable, an id from the query is dropped: the legacy body carries no templateId and the URL names organisation A", async () => {
    customerSetup(meOf(), { [TYPES]: fail(500, "INTERNAL_ERROR") });
    const el = (await NewSitePage({ searchParams: Promise.resolve({ type: "stpl_b" }) })) as ReactElement<Record<string, unknown>>;
    expect(el.props.siteTypes).toEqual([]);
    const { url, body, raw } = await postedBy(el.props, fetchMock);
    expect(url).toBe(`/api/bff/orgs/${ORG_A}/managed-sites`);
    expect(body).not.toHaveProperty("templateId");
    expect(raw).not.toContain("stpl_b");
  });

  it("with the types read and empty, an id from the query is dropped as well and the form is blocked", async () => {
    customerSetup(meOf(), { [TYPES]: ok({ siteTypes: [] }) });
    const el = (await NewSitePage({ searchParams: Promise.resolve({ type: "stpl_b" }) })) as ReactElement<Record<string, unknown>>;
    expect(el.props.noSiteTypes).toBe(true);
    expect(html(el)).toContain(en.site.create.noSiteTypes);
    expect(html(el)).not.toContain("stpl_b");
  });

  it("`type` never changes the organisation id the form posts to, even when it looks like one", async () => {
    for (const type of [ORG_A, ORG_B, "org_x"]) {
      const el = (await NewSitePage({ searchParams: Promise.resolve({ type }) })) as ReactElement<Record<string, unknown>>;
      expect(el.props.orgId).toBe(ORG_A);
    }
  });
});

// ------------------------------------------------------------------------------------------------ encoded addresses

/** ids that are not one safe path segment as they stand */
const ODD_IDS = ["a/b", "100%", "%2F", "x?y=1", "a#b", "a b", "ä/ü", "a\\b", "x&y=1", "a;b", "a+b"];
const lastSegment = (href: string, prefix: string) => {
  expect(href.startsWith(prefix), href).toBe(true);
  const rest = href.slice(prefix.length);
  // one path segment: nothing that a browser would read as another segment, a query or a fragment
  expect(rest, href).not.toMatch(/[/?#\\]/);
  return decodeURIComponent(rest);
};

describe("ids with / % ? # are encoded in every address the customer area builds", () => {
  it.each(ODD_IDS)("list: site %j and stack %j link to one encoded segment that decodes to the id", async (id) => {
    customerSetup(meOf(), { [SITES]: ok([site(id, "Site row")]), [STACKS]: ok([stack(id, "Stack row")]), [ADDRESSES]: ok([]) });
    const h = html((await AppsPage()) as ReactNode);
    const links = hrefs(h);
    const siteLinks = links.filter((x) => x.startsWith("/sites/"));
    const stackLinks = links.filter((x) => x.startsWith("/apps/") && x !== "/apps/new");
    expect(siteLinks).toHaveLength(1);
    expect(stackLinks).toHaveLength(1);
    expect(lastSegment(siteLinks[0]!, "/sites/")).toBe(id);
    expect(lastSegment(stackLinks[0]!, "/apps/")).toBe(id);
    // nothing else on the page is an address built from the id
    expect(links.filter((x) => ![siteLinks[0], stackLinks[0], "/apps", "/apps/new", "/account"].includes(x))).toEqual([]);
  });

  it.each(ODD_IDS)("switcher: site %j and stack %j link to one encoded segment that decodes to the id", async (id) => {
    customerSetup(meOf(), { [SITES]: ok([site(id, "Site row")]), [STACKS]: ok([stack(id, "Stack row")]) });
    const h = html(await CustomerLayout({ children: null }));
    const links = hrefs(h);
    expect(links.filter((x) => x.startsWith("/sites/")).map((x) => lastSegment(x, "/sites/"))).toEqual([id]);
    expect(links.filter((x) => x.startsWith("/apps/") && x !== "/apps/new").map((x) => lastSegment(x, "/apps/"))).toEqual([id]);
    expect(links).toContain("/apps/new");
    expect(h).toContain("Stack row");
  });

  it.each(ODD_IDS)("chooser: site type %j and application template %j link to one encoded value that decodes to the id", async (id) => {
    customerSetup(meOf(), {
      [TYPES]: ok({ siteTypes: [type(id), type("stpl_b")] }),
      [CATALOG]: ok({ templates: [template(id)], categories: ["content"] }),
    });
    const h = html((await NewAppPage()) as ReactNode);
    const links = hrefs(h);
    const typeLink = links.find((x) => x.startsWith("/sites/new?type=") && decodeURIComponent(x.slice("/sites/new?type=".length)) === id);
    expect(typeLink, "a card for the odd type id").toBeDefined();
    const query = typeLink!.slice("/sites/new".length);
    expect(query).not.toMatch(/[#&\s]|\?.*\?/);
    expect(new URL(typeLink!, "http://panel.test").searchParams.get("type")).toBe(id);
    expect(new URL(typeLink!, "http://panel.test").pathname).toBe("/sites/new");
    const wizard = links.filter((x) => x.startsWith("/apps/new/"));
    expect(wizard.map((x) => lastSegment(x, "/apps/new/"))).toEqual([id]);
  });

  it("SiteTypeCards alone: an unreadable type list is one generic card with no query at all", () => {
    const h = html(createElement(SiteTypeCards, { m: en, types: [null], limit: null }));
    expect(hrefs(h)).toEqual(["/sites/new"]);
  });

  it("names and addresses that carry markup are escaped in the list, the switcher and the chooser", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    customerSetup(meOf(), {
      [SITES]: ok([site("s1", evil)]),
      [STACKS]: ok([stack("k1", evil)]),
      [ADDRESSES]: ok([{ ...site("s1"), primaryDomain: evil }]),
      [TYPES]: ok({ siteTypes: [type("stpl_a", { name: evil }), type("stpl_b")] }),
      [CATALOG]: ok({ templates: [template("atpl_x", evil)], categories: ["content"] }),
    });
    for (const out of [html((await AppsPage()) as ReactNode), html(await CustomerLayout({ children: null })), html((await NewAppPage()) as ReactNode)]) {
      // the markup is text: no element is created from it (the quotes inside a text node are harmless)
      expect(out).not.toContain("<img");
      expect(out).toContain("&lt;img");
    }
  });
});

// ------------------------------------------------------------------------------------------------ the address column

describe("getSiteAddresses and the address column", () => {
  it("asks for …/managed-sites of the organisation it is given, and for nothing else", async () => {
    session.current = sessionOf();
    upstream(meOf());
    await getSiteAddresses("org_given");
    expect(paths()).toEqual(["v1/organizations/org_given/managed-sites"]);
  });

  it("maps site id → primary domain, leaves a site without a domain out, and answers {} when the read fails", async () => {
    session.current = sessionOf();
    upstream(meOf(), {
      [ADDRESSES]: ok([
        { ...site("s1"), primaryDomain: "a.example.test" },
        { ...site("s2"), primaryDomain: null },
        { ...site("s3"), primaryDomain: "c.example.test" },
      ]),
    });
    expect(await getSiteAddresses(ORG_A)).toEqual({ s1: "a.example.test", s3: "c.example.test" });
    for (const failure of [fail(500, "INTERNAL_ERROR"), fail(403, "FORBIDDEN"), fail(404, "NOT_FOUND"), fail(422, "NOT_SUPPORTED")]) {
      upstream(meOf(), { [ADDRESSES]: failure });
      expect(await getSiteAddresses(ORG_A)).toEqual({});
    }
  });

  it("an address read that fails leaves the rows with «—» and no warning; a site missing from the map shows «—» too", async () => {
    customerSetup(meOf(), { [SITES]: ok([site("s1", "Alpha"), site("s2", "Beta")]), [ADDRESSES]: ok([{ ...site("s1"), primaryDomain: "alpha.example.test" }]) });
    const h = html((await AppsPage()) as ReactNode);
    expect(h).toContain("alpha.example.test");
    const beta = h.split("<tr").find((r) => r.includes(">Beta<"))!;
    expect(beta).toContain('<span class="text-muted-foreground">—</span>');
    expect(h.split("<tr").find((r) => r.includes(">Alpha<"))).not.toContain("—");
    customerSetup(meOf(), { [SITES]: ok([site("s1", "Alpha")]), [ADDRESSES]: fail(500, "INTERNAL_ERROR") });
    const failed = html((await AppsPage()) as ReactNode);
    expect(failed).toContain("Alpha");
    expect(failed).not.toContain(en.apps.list.partial);
    expect(failed).not.toContain("alpha.example.test");
  });

  it("an address never moves to another site: the map is keyed by the site's own id", async () => {
    customerSetup(meOf(), {
      [SITES]: ok([site("s1", "Alpha"), site("s2", "Beta")]),
      [ADDRESSES]: ok([{ ...site("s2"), primaryDomain: "beta.example.test" }]),
    });
    const h = html((await AppsPage()) as ReactNode);
    const rows = h.split("<tr").filter((r) => r.includes("/sites/"));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.includes(">Alpha<"))).not.toContain("beta.example.test");
    expect(rows.find((r) => r.includes(">Beta<"))).toContain("beta.example.test");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a site whose id is the object key «%s» and has no address shows «—», not a function", async (id) => {
    customerSetup(meOf(), { [SITES]: ok([site(id, "Odd")]), [ADDRESSES]: ok([]) });
    const h = html((await AppsPage()) as ReactNode);
    const row = h.split("<tr").find((r) => r.includes(">Odd<"))!;
    expect(row).toContain('<span class="text-muted-foreground">—</span>');
  });
});

// ------------------------------------------------------------------------------------------------ no cookie is read

describe("no customer page reads a cookie, with every page and every context", () => {
  it("the four pages, rendered as a customer and as a visit, never call cookies() or headers() (checked in afterEach)", async () => {
    for (const setup of [() => customerSetup(), () => visitSetup("admin"), () => visitSetup("customer")]) {
      setup();
      await CustomerLayout({ children: null });
      await AppsPage();
      await NewAppPage().catch(() => undefined);
      await NewSitePage();
    }
    expect(paths().length).toBeGreaterThan(0);
  });
});
