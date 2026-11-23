import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeDto } from "@hosting-panel/contracts";

// Q1 (ux-customer §10): the customer area with the application flag off and in a support visit. The real customer
// context (`getCustomerContext`) and the real server reads run; only the session, the upstream HTTP call and
// next/navigation are replaced, so what is asserted is the set of paths a page really asks the API for and the
// markup a customer really gets. Every «off» cell is baited: the application routes answer with real-looking data,
// so a stray read shows up as a path AND as a name on the page.

const session = vi.hoisted(() => ({ current: null as unknown }));
const fetchUpstream = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/apps", lang: "en" as "en" | "it" }));

vi.mock("@/lib/server-session", () => ({
  getServerSession: async () => session.current,
  getSessionFromRequest: async () => session.current,
}));
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: async () => nav.lang }));
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
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import AppsLayout from "@/app/apps/layout";
import SitesLayout from "@/app/sites/layout";
import { CustomerLayout } from "@/app/sites/customer-layout";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import AppWizardPage from "@/app/apps/new/[templateId]/page";
import AppStackPage from "@/app/apps/[stackId]/page";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG_A = "org_a1";
const ORG_B = "org_b2";
const SITES = `v1/organizations/${ORG_A}/sites`;
const ADDRESSES = `v1/organizations/${ORG_A}/managed-sites`;
const TYPES = `v1/organizations/${ORG_A}/site-types`;
const STACKS = `v1/organizations/${ORG_A}/app-stacks`;
const CATALOG = `v1/organizations/${ORG_A}/app-templates`;
const BAIT_STACK = "Leaked Notes Stack";
const BAIT_TEMPLATE = "Leaked Notes Template";

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
    platformCapabilities: { applicationStacksAvailable: true, applicationTemplatesAvailable: true },
    ...over,
  }) as unknown as MeDto;

const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const site = { id: "s1", organizationId: ORG_A, hostAllocationId: "al_1", name: "Blog", slug: "blog", status: "ready", phpVersion: "8.3", siteType: "wordpress", createdAt: NOW, updatedAt: NOW };
const stackBait = {
  id: "k1", name: BAIT_STACK, status: "running", templateId: "atpl_notes", templateName: "Notes", templateVersionNumber: 2,
  componentCount: 2, unhealthyCount: 0, primaryHostname: null, updatedAt: NOW,
};
const templateBait = {
  id: "atpl_notes", name: BAIT_TEMPLATE, description: null, category: "content", versionId: "atv_notes_1", versionNumber: 1,
  componentCount: 1, cpuMilli: 500, memoryBytes: String(2 ** 28), volumeCount: 0, hasIngress: true,
};
const wpType = (id: string) => ({ id, name: `Type ${id}`, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [] });

const upstream = (me: MeDto, extra: Record<string, unknown> = {}) => {
  const byPath: Record<string, unknown> = {
    [SITES]: ok([site]),
    [ADDRESSES]: ok([{ ...site, primaryDomain: "blog.example.test" }]),
    [STACKS]: ok([stackBait]),
    [CATALOG]: ok({ templates: [templateBait], categories: ["content"] }),
    [`${CATALOG}/atpl_notes`]: ok({ ...templateBait, versions: [] }),
    [`${STACKS}/k1`]: ok(stackBait),
    ...extra,
  };
  fetchUpstream.mockImplementation(async (path: string) => (path === "v1/me" ? ok(me) : (byPath[path] ?? fail(404, "NOT_FOUND"))));
};
const paths = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const nonMe = () => paths().filter((p) => p !== "v1/me");
const appReads = () => paths().filter((p) => p.includes("app-"));

const html = (node: ReactNode, lang: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: lang, messages: lang === "en" ? en : itMsgs, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const hrefs = (h: string) => [...h.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1]);
/** Every address on the page except the fixed chrome ones: the entry/logo (`/apps`) and the two of the account menu. */
const content = (h: string) => hrefs(h).filter((x) => x !== "/apps" && x !== "/account" && x !== "/account/notifications");
const entry = (h: string, labels = en) => h.match(/<a[^>]*href="\/apps"[^>]*>([^<]*)<\/a>/)?.[1] === labels.apps.nav;
const LOGO = /<a[^>]*href="\/apps"[^>]*><span[^>]*>HP<\/span>/;
const noticeTexts = (m: typeof en | typeof itMsgs) => [m.apps.unavailable.title, m.apps.unavailable.off, m.apps.unavailable.support, m.apps.unavailable.back];

// The flag values of m6-web-qa-tenancy.test.ts (absent, false, "true", 1, {}) plus the other shapes that are not `true`.
const OFF_FLAGS: readonly (readonly [string, Record<string, unknown> | undefined])[] = [
  ["flag absent", { applicationStacksAvailable: undefined }],
  ["flag false", { applicationStacksAvailable: false }],
  ["flag a truthy string", { applicationStacksAvailable: "true" }],
  ["flag 1", { applicationStacksAvailable: 1 }],
  ["no capabilities at all", {}],
  ["flag null", { applicationStacksAvailable: null }],
  ["flag 0", { applicationStacksAvailable: 0 }],
  ["flag an object", { applicationStacksAvailable: {} }],
  ["flag an array", { applicationStacksAvailable: [true] }],
  ["capabilities missing", undefined],
];
const ON_FLAG = ["flag on", { applicationStacksAvailable: true, applicationTemplatesAvailable: true }] as const;

interface Cell {
  name: string;
  /** the gate the application detail pages show in this cell */
  reason: "off" | "support";
  setup: (caps: Record<string, unknown> | undefined) => void;
}
const customer: Cell = {
  name: "customer",
  reason: "off",
  setup: (caps) => {
    session.current = sessionOf();
    upstream(meOf({ platformCapabilities: caps }));
  },
};
const visitOf = (activeConsole: "customer" | "admin"): Cell => ({
  name: `support visit (console cookie «${activeConsole}»)`,
  reason: "support",
  setup: (caps) => {
    session.current = sessionOf({ isServerAdmin: true, activeConsole });
    upstream(meOf({ memberships: [{ organizationId: ORG_B }], supportAccess: visit, platformCapabilities: caps }));
  },
});
const visits = [visitOf("admin"), visitOf("customer")];
/** the matrix: every «off» flag value for the customer, every flag value (the real one too) in a visit */
const matrix: { label: string; cell: Cell; caps: Record<string, unknown> | undefined }[] = [
  ...OFF_FLAGS.map(([label, caps]) => ({ label, cell: customer, caps })),
  ...visits.flatMap((cell) => [...OFF_FLAGS, ON_FLAG].map(([label, caps]) => ({ label, cell, caps }))),
].map((x) => ({ ...x, label: `${x.cell.name}, ${x.label}` }));
const cells = matrix.map((x) => [x.label, x] as const);

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/apps";
  nav.lang = "en";
  session.current = sessionOf();
  upstream(meOf());
});

describe("the harness can see a read (controls: flag on, customer)", () => {
  it("the layout reads the stacks and lists them; /apps shows them; /apps/new reads the catalog", async () => {
    customer.setup(ON_FLAG[1]);
    const layout = html(await CustomerLayout({ children: null }));
    expect(appReads()).toEqual([STACKS]);
    expect(layout).toContain(BAIT_STACK);
    expect(content(layout)).toContain("/apps/k1");

    fetchUpstream.mockClear();
    expect(html(await AppsPage())).toContain(BAIT_STACK);
    expect(appReads()).toEqual([STACKS]);

    fetchUpstream.mockClear();
    upstream(meOf(), { [TYPES]: ok({ siteTypes: [wpType("t1")] }) });
    expect(html(await NewAppPage())).toContain(BAIT_TEMPLATE);
    expect(appReads()).toEqual([CATALOG]);
  });
});

describe.each([
  ["CustomerLayout", (children: ReactNode) => CustomerLayout({ children })],
  ["SitesLayout", (children: ReactNode) => SitesLayout({ children })],
  ["AppsLayout", (children: ReactNode) => AppsLayout({ children })],
])("%s with the flag off or in a support visit", (_name, layout) => {
  it.each(cells)("%s → no application read, no notice, the entry and logo lead to /apps, the switcher lists WordPress only", async (_label, { cell, caps }) => {
    cell.setup(caps);
    nav.pathname = "/apps";
    const child = createElement("p", null, "child-page");
    const h = html(await layout(child));
    const inVisit = cell !== customer;
    const visitWithFlag = inVisit && caps?.applicationStacksAvailable === true;
    expect(appReads(), "no path containing app-").toEqual([]);
    expect(nonMe()).toEqual([SITES]);
    for (const t of noticeTexts(en)) expect(h).not.toContain(t);
    expect(h).not.toContain(BAIT_STACK);
    expect(h).toContain("<p>child-page</p>");
    expect(h).not.toContain(en.shell.loadErrorTitle);
    expect(h).toMatch(LOGO);
    expect(entry(h)).toBe(true);
    expect(h).toMatch(/<a[^>]*href="\/apps"[^>]*aria-current="page"[^>]*>[^<]*<\/a>|<a[^>]*aria-current="page"[^>]*href="\/apps"[^>]*>[^<]*<\/a>/);
    // the switcher: the one WordPress site, then «New application»; no stack link, no other address
    expect(content(h), visitWithFlag ? "a visit never lists stacks, even with the flag on" : "").toEqual(["/sites/s1", "/apps/new"]);
    expect(h).toContain(`aria-label="${en.shell.switchSite}: ${en.shell.yourSites}"`);
    expect(h).toContain(en.shell.newSite);
    if (inVisit) expect(h).toContain("Customer A"); // the support banner still names the visited organisation
  });

  it("the entry is shown and marked on every customer address, flag off", async () => {
    customer.setup({});
    for (const p of ["/apps", "/apps/new", "/apps/k1", "/sites/s1", "/sites/new"]) {
      nav.pathname = p;
      const h = html(await layout(null));
      expect(entry(h), p).toBe(true);
      expect(h, p).toMatch(/aria-current="page"/);
    }
    nav.pathname = "/account";
    expect(html(await layout(null))).not.toMatch(/aria-current="page"/);
  });

  it("a flag-off customer with no site still gets the entry and no switcher, and no read of an application", async () => {
    customer.setup({});
    upstream(meOf({ platformCapabilities: {} }), { [SITES]: ok([]) });
    const h = html(await layout(null));
    expect(entry(h)).toBe(true);
    expect(h).not.toContain(en.shell.switchSite);
    expect(appReads()).toEqual([]);
  });
});

describe("the layout in Italian, flag off and in a visit", () => {
  it.each(cells.filter(([, x]) => x.caps === undefined || x.caps.applicationStacksAvailable !== true))("%s → «Applicazioni», no notice text", async (_label, { cell, caps }) => {
    nav.lang = "it";
    cell.setup(caps);
    const h = html(await CustomerLayout({ children: null }), "it");
    expect(entry(h, itMsgs)).toBe(true);
    for (const t of noticeTexts(itMsgs)) expect(h).not.toContain(t);
    expect(h).toContain(itMsgs.shell.newSite);
    expect(appReads()).toEqual([]);
  });
});

describe("/apps with the flag off or in a support visit", () => {
  it.each(cells)("%s → the WordPress rows only, a way to create, no notice, no application read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    const h = html(await AppsPage());
    expect(appReads(), "no path containing app-").toEqual([]);
    expect(nonMe().sort()).toEqual([ADDRESSES, SITES]);
    for (const t of noticeTexts(en)) expect(h).not.toContain(t);
    expect(h).not.toContain(BAIT_STACK);
    expect(h).not.toContain(en.apps.list.partial);
    expect(h).not.toContain(en.shell.loadErrorTitle);
    expect(h).toContain(`>${en.apps.list.title}</h1>`);
    expect(h).toMatch(new RegExp(`<a[^>]*href="/apps/new"[^>]*>${en.apps.list.create}</a>`));
    expect(content(h)).toEqual(["/apps/new", "/sites/s1"]);
    expect(h).toContain("blog.example.test");
    expect(h).toContain(en.apps.list.wordpress);
  });

  it.each(cells)("%s → with no site the list says so and still offers the way to create (no dead end)", async (_label, { cell, caps }) => {
    cell.setup(caps);
    upstream(meOf({ platformCapabilities: caps, ...(cell === customer ? {} : { memberships: [{ organizationId: ORG_B }], supportAccess: visit }) }), { [SITES]: ok([]), [ADDRESSES]: ok([]) });
    const h = html(await AppsPage());
    expect(h).toContain(en.apps.list.empty);
    expect(h).toContain(en.shell.emptyBody);
    expect(h).toContain('href="/apps/new"');
    for (const t of noticeTexts(en)) expect(h).not.toContain(t);
    expect(appReads()).toEqual([]);
  });

  it("a stack read that would 500 is never attempted, so the list shows no warning", async () => {
    customer.setup({});
    upstream(meOf({ platformCapabilities: {} }), { [STACKS]: fail(500, "INTERNAL_ERROR") });
    const h = html(await AppsPage());
    expect(h).not.toContain(en.apps.list.partial);
    expect(appReads()).toEqual([]);
  });
});

describe("/apps/new with the flag off or in a support visit", () => {
  it.each(cells.filter(([, x]) => x.cell === customer))("%s, site types unreadable → the WordPress form, no application read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(appReads()).toEqual([]);
    for (const p of nonMe()) expect(p === `v1/organizations/${ORG_A}` || p.startsWith(`v1/organizations/${ORG_A}/`), p).toBe(true);
    expect(paths().join("\n")).not.toContain(ORG_B);
  });

  it.each(cells.filter(([, x]) => x.cell === customer))("%s, one site type → the WordPress form, no application read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    upstream(meOf({ platformCapabilities: caps }), { [TYPES]: ok({ siteTypes: [wpType("t1")] }) });
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(appReads()).toEqual([]);
  });

  it.each(cells.filter(([, x]) => x.cell === customer))("%s, no site type → the WordPress form (it shows its own «no type» alert), no application read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    upstream(meOf({ platformCapabilities: caps }), { [TYPES]: ok({ siteTypes: [] }) });
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(appReads()).toEqual([]);
  });

  it.each(cells.filter(([, x]) => x.cell === customer))("%s, two site types → a WordPress-only chooser: no catalog, no wizard link, no notice, no application read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    upstream(meOf({ platformCapabilities: caps }), { [TYPES]: ok({ siteTypes: [wpType("t1"), wpType("t2")] }) });
    const h = html(await NewAppPage());
    expect(appReads(), "no path containing app-").toEqual([]);
    expect(h).toContain(`>${en.apps.catalog.title}</h1>`);
    expect(hrefs(h)).toEqual(["/sites/new?type=t1", "/sites/new?type=t2"]);
    expect(h).not.toContain(BAIT_TEMPLATE);
    expect(h).not.toContain(en.apps.list.partial);
    for (const t of noticeTexts(en)) expect(h).not.toContain(t);
  });

  it.each(cells.filter(([, x]) => x.cell !== customer))("%s → straight to the WordPress form before any read, whatever the site types", async (_label, { cell, caps }) => {
    cell.setup(caps);
    upstream(meOf({ platformCapabilities: caps, memberships: [{ organizationId: ORG_B }], supportAccess: visit }), { [TYPES]: ok({ siteTypes: [wpType("t1"), wpType("t2")] }) });
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(nonMe()).toEqual([]);
  });
});

describe.each([
  ["/apps/[stackId]", () => AppStackPage({ params: Promise.resolve({ stackId: "k1" }) })],
  ["/apps/[stackId] (an id built to escape)", () => AppStackPage({ params: Promise.resolve({ stackId: "..%2F..%2Fsites" }) })],
  ["/apps/new/[templateId]", () => AppWizardPage({ params: Promise.resolve({ templateId: "atpl_notes" }) })],
  ["/apps/new/[templateId] (an id built to escape)", () => AppWizardPage({ params: Promise.resolve({ templateId: "../x?y=1" }) })],
])("%s keeps its gate", (_name, run) => {
  it.each(cells)("%s → the notice for the reason of the cell, a link back to /apps and not to /sites, nothing read", async (_label, { cell, caps }) => {
    cell.setup(caps);
    const h = html(await run());
    const other = cell.reason === "off" ? "support" : "off";
    expect(h).toContain(en.apps.unavailable.title);
    expect(h).toContain(en.apps.unavailable[cell.reason]);
    expect(h).not.toContain(en.apps.unavailable[other]);
    expect(h).toContain('role="status"');
    expect(hrefs(h)).toEqual(["/apps"]);
    expect(h).toContain(`>${en.apps.unavailable.back}</a>`);
    expect(h).not.toContain(BAIT_STACK);
    expect(h).not.toContain(BAIT_TEMPLATE);
    expect(appReads()).toEqual([]);
    expect(nonMe()).toEqual([]);
  });
});

it("the notice's back link of both languages names applications, never sites", () => {
  for (const m of [en, itMsgs]) {
    expect(m.apps.unavailable.back).not.toMatch(/\bsit[oi]\b|\bsites?\b/i);
    expect(m.apps.unavailable.back).toMatch(/applicazion|application/i);
  }
});
