import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Link from "next/link";
import { appTemplateState, type AdminAppTemplateSummaryDto, type AdminSiteTemplateSummaryDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/templates",
}));

import AdminTemplatesPage from "@/app/admin/templates/page";
import { TemplateCatalog, templateCatalogRows } from "@/components/admin/template-catalog";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";

const NOW = "2026-11-22T10:00:00.000Z";
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

function site(over: Partial<AdminSiteTemplateSummaryDto> & { id: string }): AdminSiteTemplateSummaryDto {
  return {
    module: "wordpress",
    name: "Custom",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: `${over.id}_v2`,
    defaultVersionNumber: 2,
    versionCount: 2,
    siteCount: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as AdminSiteTemplateSummaryDto;
}

function app(over: Partial<AdminAppTemplateSummaryDto> & { id: string }): AdminAppTemplateSummaryDto {
  const base = {
    slug: over.id.replace("atpl_", ""),
    name: "Custom",
    category: "productivity",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: `${over.id}_v2`,
    defaultVersionNumber: 2,
    installations: 3,
    componentCount: 2,
    hasIngress: true,
    hasVolumes: true,
    updatedAt: NOW,
    ...over,
  };
  return { ...base, state: appTemplateState(base) } as AdminAppTemplateSummaryDto;
}

const WP = site({ id: "stpl_wordpress", name: "WordPress", builtIn: true, defaultVersionNumber: 1, siteCount: 7 });
const BLOG = site({ id: "stpl_custom", name: "Blog", siteCount: 4 });
const OFF = site({ id: "stpl_off", name: "Alpha", enabled: false, defaultVersionNumber: 1, siteCount: 0 });
const OLD_SITE = site({ id: "stpl_old", name: "Aardvark", archivedAt: NOW, enabled: false });
const SITES = [OLD_SITE, BLOG, OFF, WP];

const BOARD = app({ id: "atpl_board", name: "Board", installations: 5 });
const CACHE = app({ id: "atpl_http_cache", name: "Http cache", builtIn: true, defaultVersionNumber: 1, installations: 9 });
const DRAFT = app({ id: "atpl_draft", name: "Alpine", enabled: false, defaultVersionId: null, defaultVersionNumber: null, installations: 0 });
const OLD_APP = app({ id: "atpl_old", name: "Abacus", enabled: false, archivedAt: NOW });
const ODD = app({ id: "atpl_a b", name: "Zed" });
const APPS = [OLD_APP, ODD, BOARD, DRAFT, CACHE];

const html = (m: Messages, node: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
type El = ReactElement<Record<string, unknown>>;
const els = (node: unknown): El[] => {
  if (Array.isArray(node)) return node.flatMap(els);
  if (!isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};
const textOf = (node: unknown): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : isValidElement(node)
        ? textOf((node.props as Record<string, unknown>).children)
        : "";
const hrefs = (tree: unknown) => els(tree).map((e) => e.props.href).filter((h) => h !== undefined);

const envelope = (data: unknown, page?: unknown) => ({ ok: true, status: 200, data: { data, ...(page ? { page } : {}) } });
const failure = (status: number, code?: string) => ({ ok: false, status, data: null, error: code ? { error: { code } } : null });
const ON = envelope({ platformCapabilities: { applicationTemplatesAvailable: true } });
const route = (over: Record<string, unknown> = {}) => {
  const table: Record<string, unknown> = {
    "v1/me": ON,
    "v1/admin/site-templates": envelope({ templates: [WP, BLOG] }),
    "v1/admin/app-templates": envelope([BOARD, CACHE]),
    ...over,
  };
  fetchUpstream.mockImplementation(async (path: string) => table[path] ?? failure(404));
};
const paths = () => fetchUpstream.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  fetchUpstream.mockReset();
  getServerSession.mockReset();
  getRequestLocale.mockReset();
  getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getRequestLocale.mockResolvedValue("en");
  route();
});

describe("templateCatalogRows", () => {
  it("lists WordPress templates first (built-in, live by name, archived), then application templates by name with archived ones last", () => {
    const rows = templateCatalogRows(SITES, APPS);
    expect(rows.map((r) => [r.kind, r.template.name])).toEqual([
      ["site", "WordPress"],
      ["site", "Alpha"],
      ["site", "Blog"],
      ["site", "Aardvark"],
      ["app", "Alpine"],
      ["app", "Board"],
      ["app", "Http cache"],
      ["app", "Zed"],
      ["app", "Abacus"],
    ]);
    expect(templateCatalogRows([], [])).toEqual([]);
  });
});

describe("TemplateCatalog", () => {
  const rowsOf = (out: string) => out.split("<tr").slice(2);
  const rowOf = (out: string, href: string) => rowsOf(out).find((r) => r.includes(`href="${href}"`))!;

  it.each(locales)("one table, five columns, one row per template of either kind (%s)", (_l, m) => {
    const t = m.admin.templates;
    const a = m.admin.appTemplates;
    const out = html(m, createElement(TemplateCatalog, { sites: SITES, apps: APPS, m }));
    expect(out.match(/<table/g)).toHaveLength(1);
    const heads = [...out.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((h) => h[1]);
    expect(heads).toEqual([t.col.name, t.col.kind, t.col.status, t.col.defaultVersion, t.col.sites]);
    expect(rowsOf(out)).toHaveLength(SITES.length + APPS.length);

    const wp = rowOf(out, "/admin/templates/stpl_wordpress");
    expect(wp).toContain(`>${t.modules.wordpress}<`);
    expect(wp).toContain(`>${t.status.builtIn}<`);
    expect(wp).toContain(`>${t.status.enabled}<`);
    expect(wp).toContain(`>${format(t.versionLabel, { version: 1 })}<`);
    expect(wp).toContain(">7<");
    expect(rowOf(out, "/admin/templates/stpl_custom")).toContain(">4<");
    expect(rowOf(out, "/admin/templates/stpl_off")).toContain(`>${t.status.disabled}<`);
    const oldSite = rowOf(out, "/admin/templates/stpl_old");
    expect(oldSite).toContain(`>${t.status.archived}<`);
    expect(rowsOf(out).filter((r) => r.includes("opacity-60"))).toEqual([oldSite, rowOf(out, "/admin/templates/apps/atpl_old")]);

    for (const tpl of APPS) {
      const row = rowOf(out, `/admin/templates/apps/${encodeURIComponent(tpl.id)}`);
      expect(row).toContain(`>${a.tabs.apps}<`);
      expect(row).toContain(`>${a.state[tpl.state]}<`);
      expect(row).toContain(`>${tpl.installations}<`);
    }
    expect(out).toContain('href="/admin/templates/apps/atpl_a%20b"');
    expect(rowOf(out, "/admin/templates/apps/atpl_http_cache")).toContain(`>${a.builtIn}<`);
    expect(rowOf(out, "/admin/templates/apps/atpl_http_cache")).toContain(`>${format(a.versionLabel, { n: 1 })}<`);
    expect(rowOf(out, "/admin/templates/apps/atpl_board")).not.toContain(`>${a.builtIn}<`);
    expect(rowOf(out, "/admin/templates/apps/atpl_draft")).toContain(`>${a.noVersion}<`);
    expect(out).not.toMatch(/\bgit\b|\bports?\b/i);
  });

  it("keeps the order of templateCatalogRows on screen", () => {
    const out = html(en, createElement(TemplateCatalog, { sites: SITES, apps: APPS, m: en }));
    const order = ["WordPress", "Alpha", "Blog", "Aardvark", "Alpine", "Board", "Http cache", "Zed", "Abacus"].map((n) => out.indexOf(`>${n}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("shows an unknown module by its key", () => {
    const odd = { ...BLOG, module: "mystery" } as unknown as AdminSiteTemplateSummaryDto;
    expect(rowOf(html(en, createElement(TemplateCatalog, { sites: [odd], apps: [], m: en })), "/admin/templates/stpl_custom")).toContain(">mystery<");
  });

  it("escapes a site template's name and an unknown module key", () => {
    const XSS = "<script>alert(1)</script>";
    const IMG = '"><img src=x onerror=alert(1)>';
    const sites = [site({ id: "stpl_x", name: XSS }), site({ id: "stpl_y", module: IMG as never })];
    const out = renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: createElement(TemplateCatalog, { sites, apps: [], m: en }) }));
    expect(out).not.toContain("<script>");
    expect(out).not.toMatch(/<img[^>]*onerror/);
    expect(out).not.toContain('"><img');
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it.each(locales)("says there is nothing and draws no table when both lists are empty (%s)", (_l, m) => {
    const out = html(m, createElement(TemplateCatalog, { sites: [], apps: [], m }));
    expect(out).toContain(m.admin.templates.empty);
    expect(out).not.toContain("<table");
  });
});

describe("/admin/templates", () => {
  const menuOf = (tree: unknown) => els(tree).find((e) => e.type === DropdownMenuContent);

  it("redirects to /login without a session before any read", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(AdminTemplatesPage()).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each([
    ["/v1/me fails", failure(404)],
    ["flag false", envelope({ platformCapabilities: { applicationTemplatesAvailable: false } })],
    ["flag absent", envelope({ platformCapabilities: {} })],
  ])("%s: WordPress rows only, a plain «new» link, no multi-service read and no notice", async (_name, me) => {
    route({ "v1/me": me });
    const tree = await AdminTemplatesPage();
    expect([...paths()].sort()).toEqual(["v1/admin/site-templates", "v1/me"]);
    expect(menuOf(tree)).toBeUndefined();
    expect(hrefs(tree)).toEqual(["/admin/templates/new"]);
    const out = html(en, tree);
    expect(out).toMatch(new RegExp(`href="/admin/templates/new"[^>]*>${en.admin.templates.create}<`));
    expect(out).toContain('href="/admin/templates/stpl_custom"');
    expect(out).not.toContain("/admin/templates/apps/");
    expect(out).not.toContain(en.admin.appTemplates.notAvailable);
    expect(out).not.toContain('role="alert"');
  });

  it.each(locales)("flag on: reads the multi-service templates and asks the kind in one «new» menu (%s)", async (locale, m) => {
    getRequestLocale.mockResolvedValue(locale);
    const tabs = m.admin.appTemplates.tabs;
    const tree = await AdminTemplatesPage();
    expect(fetchUpstream).toHaveBeenCalledWith("v1/admin/app-templates", { accessToken: "tok", timeoutMs: 20_000 });
    const menu = menuOf(tree)!;
    expect(menu.props["aria-label"]).toBe(tabs.label);
    const links = els(menu).filter((e) => e.type === Link);
    expect(links.map((l) => [l.props.href, textOf(l)])).toEqual([
      ["/admin/templates/new", tabs.sites],
      ["/admin/templates/apps/new", tabs.apps],
    ]);
    const out = html(m, tree);
    expect(out).toContain(m.admin.templates.title);
    expect(out).toContain(m.admin.templates.subtitle);
    expect(out).toContain(`>${m.admin.templates.create}`);
    expect(out).toContain('href="/admin/templates/stpl_wordpress"');
    expect(out).toContain('href="/admin/templates/apps/atpl_board"');
    expect(out).not.toContain(m.admin.appTemplates.more);
    expect(out).not.toContain('role="alert"');
  });

  it("a 422 while the flag says on is treated as off: plain link, no notice, WordPress rows", async () => {
    route({ "v1/admin/app-templates": failure(422, "NOT_SUPPORTED") });
    const tree = await AdminTemplatesPage();
    expect(menuOf(tree)).toBeUndefined();
    expect(hrefs(tree)).toEqual(["/admin/templates/new"]);
    const out = html(en, tree);
    expect(out).toContain('href="/admin/templates/stpl_wordpress"');
    expect(out).not.toContain(en.admin.appTemplates.notAvailable);
    expect(out).not.toContain('role="alert"');
  });

  it("a failed multi-service read says so and keeps the WordPress rows", async () => {
    route({ "v1/admin/app-templates": failure(500) });
    const out = html(en, await AdminTemplatesPage());
    expect(out).toMatch(new RegExp(`role="alert"[^]*${en.admin.appTemplates.loadError}`));
    expect(out).not.toContain(en.admin.templates.loadError);
    expect(out).toContain('href="/admin/templates/stpl_wordpress"');
    expect(out).not.toContain(en.admin.appTemplates.notAvailable);
  });

  it("a failed WordPress read says so and keeps the application rows", async () => {
    route({ "v1/admin/site-templates": failure(500) });
    const out = html(en, await AdminTemplatesPage());
    expect(out).toMatch(new RegExp(`role="alert"[^]*${en.admin.templates.loadError}`));
    expect(out).not.toContain(en.admin.appTemplates.loadError);
    expect(out).toContain('href="/admin/templates/apps/atpl_board"');
    expect(out).not.toContain("/admin/templates/stpl_");
  });

  it("both reads empty: the empty text", async () => {
    route({ "v1/admin/site-templates": envelope({ templates: [] }), "v1/admin/app-templates": envelope([]) });
    const out = html(en, await AdminTemplatesPage());
    expect(out).toContain(en.admin.templates.empty);
    expect(out).not.toContain("<table");
  });

  it("notes a partial list when the API says there are more multi-service templates", async () => {
    route({ "v1/admin/app-templates": envelope([BOARD], { nextCursor: "c", hasMore: true }) });
    expect(html(en, await AdminTemplatesPage())).toContain(en.admin.appTemplates.more);
  });
});
