import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APP_STACK_REASONS,
  appTemplateState,
  type AdminAppTemplateDetailDto,
  type AdminAppTemplateSummaryDto,
  type AdminAppTemplateUsageDto,
} from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const notFound = vi.fn();
const keyedSend = vi.fn();
const refresh = vi.fn();
let pathname = "/admin/templates";

vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("@/i18n/server", () => ({ getRequestLocale: (...args: unknown[]) => getRequestLocale(...args) }));
vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    notFound();
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: () => refresh() }),
  usePathname: () => pathname,
}));

import AdminTemplatesLayout from "@/app/admin/templates/layout";
import AdminAppTemplatesPage from "@/app/admin/templates/apps/page";
import AdminAppTemplatePage from "@/app/admin/templates/apps/[templateId]/page";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { templatesTab } from "@/components/admin/templates-tabs";
import { AppTemplateList, appTemplateChips } from "@/components/admin/app-template-list";
import { AppTemplateDetail, canArchiveAppTemplate } from "@/components/admin/app-template-detail";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";
import { Button } from "@/components/ui/button";

const NOW = "2026-11-21T10:00:00.000Z";
const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

function summary(over: Partial<AdminAppTemplateSummaryDto> & { id: string }): AdminAppTemplateSummaryDto {
  const base = {
    slug: over.id.replace("atpl_", ""),
    name: "Custom",
    category: "productivity",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: `${over.id.replace("atpl_", "atv_")}_2`,
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

const BUILT_IN = summary({
  id: "atpl_http_cache",
  name: "Http cache",
  category: "web",
  builtIn: true,
  hasVolumes: false,
  installations: 7,
  defaultVersionId: "atv_http_cache_1",
  defaultVersionNumber: 1,
});
const BOARD = summary({ id: "atpl_board", name: "Board", category: "collaboration", description: "A team board" });
const DRAFT = summary({
  id: "atpl_draft",
  name: "Alpha",
  category: "mystery",
  enabled: false,
  defaultVersionId: null,
  defaultVersionNumber: null,
  installations: 0,
  hasIngress: false,
  hasVolumes: false,
});
const ARCHIVED = summary({ id: "atpl_old", name: "Aardvark", enabled: false, archivedAt: NOW, hasIngress: false });

function detail(base: AdminAppTemplateSummaryDto, over: Partial<AdminAppTemplateDetailDto> = {}): AdminAppTemplateDetailDto {
  return {
    ...base,
    createdAt: NOW,
    versions: [
      { id: base.defaultVersionId ?? "atv_head_2", versionNumber: 2, specHash: "a".repeat(64), createdAt: NOW, installations: 2 },
      { id: "atv_prev_1", versionNumber: 1, specHash: "b".repeat(64), createdAt: "2026-11-01T09:30:00.000Z", installations: 1 },
    ],
    ...over,
  };
}

const USAGE: AdminAppTemplateUsageDto = {
  templateId: "atpl_board",
  stacks: [
    { id: "stk_a", name: "team-board", organizationId: "org_acme", organizationName: "Acme Srl", versionNumber: 2, status: "running" },
    { id: "stk_b", name: "old-board", organizationId: "org_beta", organizationName: "Beta Spa", versionNumber: 1, status: "degraded" },
  ],
  truncated: false,
};

const wrap = (m: Messages, node: ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node });
const html = (m: Messages, node: ReactElement) =>
  renderToStaticMarkup(wrap(m, node)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// Calls a client component once with stand-in hooks so its handlers can run without a DOM.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [v, (x: unknown) => void sets.push([k, x])];
    },
    useRef: (v: unknown) => ({ current: v }),
    useEffect: () => {},
    useContext: () => ctx,
  };
  try {
    return { tree: C(props), sets };
  } finally {
    internals.H = prev;
  }
}
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

const envelope = (data: unknown, page?: unknown) => ({ ok: true, status: 200, data: { data, ...(page ? { page } : {}) } });
const failure = (status: number, code?: string) => ({ ok: false, status, data: null, error: code ? { error: { code } } : null });
const route = (over: Record<string, unknown> = {}) => {
  const table: Record<string, unknown> = {
    "v1/me": envelope({ platformCapabilities: { applicationTemplatesAvailable: true } }),
    "v1/admin/app-templates": envelope([BOARD, BUILT_IN, ARCHIVED, DRAFT]),
    "v1/admin/app-templates/atpl_board": envelope(detail(BOARD)),
    "v1/admin/app-templates/atpl_board/usage": envelope(USAGE),
    ...over,
  };
  fetchUpstream.mockImplementation(async (path: string) => table[path] ?? failure(404));
};
const paths = () => fetchUpstream.mock.calls.map((c) => c[0]);

beforeEach(() => {
  fetchUpstream.mockReset();
  getServerSession.mockReset();
  getRequestLocale.mockReset();
  notFound.mockReset();
  keyedSend.mockReset();
  refresh.mockReset();
  getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getRequestLocale.mockResolvedValue("en");
  pathname = "/admin/templates";
  route();
});

describe("templates layout", () => {
  const child = createElement("p", null, "child page");
  const anchors = (out: string) => [...out.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map((a) => ({ attrs: a[1]!, text: a[2]! }));

  it.each([
    ["flag off", envelope({ platformCapabilities: { applicationTemplatesAvailable: false } })],
    ["flag absent", envelope({ platformCapabilities: {} })],
    ["/v1/me failure", failure(500)],
  ])("%s: renders exactly its children and no nav", async (_name, me) => {
    route({ "v1/me": me });
    const out = renderToStaticMarkup(await AdminTemplatesLayout({ children: child }));
    expect(out).toBe(renderToStaticMarkup(child));
    expect(out).not.toContain("<nav");
    expect(paths()).toEqual(["v1/me"]);
  });

  it.each(locales)("flag on: a labelled nav with both links, the current one by path (%s)", async (locale, m) => {
    getRequestLocale.mockResolvedValue(locale);
    const t = m.admin.appTemplates.tabs;
    for (const [path, active, href] of [
      ["/admin/templates/apps/x", t.apps, "/admin/templates/apps"],
      ["/admin/templates", t.sites, "/admin/templates"],
    ] as const) {
      pathname = path;
      const out = renderToStaticMarkup(await AdminTemplatesLayout({ children: child }));
      expect(out).toContain(`<nav aria-label="${t.label}"`);
      expect(out).toContain("child page");
      const links = anchors(out);
      expect(links.map((a) => a.text)).toEqual([t.sites, t.apps]);
      expect(links.map((a) => a.attrs.match(/href="([^"]+)"/)![1])).toEqual(["/admin/templates", "/admin/templates/apps"]);
      const current = links.filter((a) => a.attrs.includes('aria-current="page"'));
      expect(current).toHaveLength(1);
      expect(current[0]!.text).toBe(active);
      expect(current[0]!.attrs).toContain(`href="${href}"`);
    }
  });

  it.each([
    ["/admin/templates", "sites"],
    ["/admin/templates/new", "sites"],
    ["/admin/templates/stpl_wordpress", "sites"],
    ["/admin/templates/stpl_wordpress/edit", "sites"],
    ["/admin/templates/appsx", "sites"],
    ["/admin/templates/apps", "apps"],
    ["/admin/templates/apps/new", "apps"],
    ["/admin/templates/apps/atpl_x", "apps"],
    ["/admin/templates/apps/atpl_x/edit", "apps"],
  ])("templatesTab(%s) = %s", (path, tab) => {
    expect(templatesTab(path)).toBe(tab);
  });

  it("the tab labels differ between Italian and English", () => {
    for (const key of ["label", "sites", "apps"] as const) expect(en.admin.appTemplates.tabs[key]).not.toBe(itMsgs.admin.appTemplates.tabs[key]);
  });
});

describe("appTemplateChips", () => {
  it("offers only HTTP and storage, never ports or Git", () => {
    expect(appTemplateChips({ hasIngress: true, hasVolumes: true })).toEqual(["http", "storage"]);
    expect(appTemplateChips({ hasIngress: true, hasVolumes: false })).toEqual(["http"]);
    expect(appTemplateChips({ hasIngress: false, hasVolumes: true })).toEqual(["storage"]);
    expect(appTemplateChips({ hasIngress: false, hasVolumes: false })).toEqual([]);
  });
});

describe("AppTemplateList", () => {
  const rowsOf = (out: string) => out.split("<tr").filter((r) => r.includes("/admin/templates/apps/"));

  it.each(locales)("one row per template: link, category, version, state word, installations, chips (%s)", (_l, m) => {
    const t = m.admin.appTemplates;
    const out = html(m, createElement(AppTemplateList, { templates: [BOARD, BUILT_IN, ARCHIVED, DRAFT], m }));
    for (const col of Object.values(t.col)) expect(out).toContain(`>${col}<`);
    const rows = rowsOf(out);
    expect(rows).toHaveLength(4);
    const row = (id: string) => rows.find((r) => r.includes(`href="/admin/templates/apps/${id}"`))!;
    for (const tpl of [BOARD, BUILT_IN, ARCHIVED, DRAFT]) expect(row(tpl.id)).toContain(`>${t.state[appTemplateState(tpl)]}<`);
    expect(row("atpl_board")).toContain(`>${t.category.collaboration}<`);
    expect(row("atpl_board")).toContain(">v2<");
    expect(row("atpl_board")).toContain(">3<");
    expect(row("atpl_board")).toContain(`>${t.chip.http}<`);
    expect(row("atpl_board")).toContain(`>${t.chip.storage}<`);
    expect(row("atpl_board")).not.toContain(`>${t.builtIn}<`);
    expect(row("atpl_http_cache")).toContain(`>${t.builtIn}<`);
    expect(row("atpl_http_cache")).toContain(">v1<");
    expect(row("atpl_http_cache")).toContain(">7<");
    expect(row("atpl_http_cache")).not.toContain(`>${t.chip.storage}<`);
    expect(row("atpl_draft")).toContain(">mystery<");
    expect(row("atpl_draft")).toContain(`>${t.noVersion}<`);
    expect(row("atpl_draft")).not.toContain(`>${t.chip.http}<`);
    expect(out).not.toMatch(/\bgit\b|\bports?\b|\bporte\b/i);
  });

  it("sorts by name with archived templates last, and encodes the link", () => {
    const odd = summary({ id: "atpl_a b", name: "Zed" });
    const out = html(en, createElement(AppTemplateList, { templates: [ARCHIVED, odd, BOARD, DRAFT, BUILT_IN], m: en }));
    const order = ["Alpha", "Board", "Http cache", "Zed", "Aardvark"].map((name) => out.indexOf(`>${name}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('href="/admin/templates/apps/atpl_a%20b"');
  });

  it.each(locales)("says there is nothing and draws no table when empty (%s)", (_l, m) => {
    const out = html(m, createElement(AppTemplateList, { templates: [], m }));
    expect(out).toContain(m.admin.appTemplates.empty);
    expect(out).not.toContain("<table");
  });
});

describe("list page", () => {
  it("redirects to /login without a session (list and detail) before any upstream call", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(AdminAppTemplatesPage()).rejects.toThrow("REDIRECT:/login");
    await expect(AdminAppTemplatePage({ params: Promise.resolve({ templateId: "atpl_board" }) })).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each(locales)("reads exactly the template list and renders title, subtitle, the create link and the rows (%s)", async (locale, m) => {
    getRequestLocale.mockResolvedValue(locale);
    const t = m.admin.appTemplates;
    const out = html(m, await AdminAppTemplatesPage());
    expect(fetchUpstream.mock.calls).toEqual([["v1/admin/app-templates", { accessToken: "tok", timeoutMs: 20_000 }]]);
    expect(out).toContain(t.title);
    expect(out).toContain(t.subtitle);
    expect(out).toMatch(new RegExp(`href="/admin/templates/apps/new"[^>]*>${t.create}<`));
    expect(out).toContain('href="/admin/templates/apps/atpl_board"');
    expect(out).not.toContain(t.more);
  });

  it("notes a partial list when the API says there is more", async () => {
    route({ "v1/admin/app-templates": envelope([BOARD], { nextCursor: "c", hasMore: true }) });
    expect(html(en, await AdminAppTemplatesPage())).toContain(en.admin.appTemplates.more);
  });

  it.each(locales)("a 422 NOT_SUPPORTED says the feature is off and offers no create link (%s)", async (locale, m) => {
    getRequestLocale.mockResolvedValue(locale);
    route({ "v1/admin/app-templates": failure(422, "NOT_SUPPORTED") });
    const out = html(m, await AdminAppTemplatesPage());
    expect(out).toMatch(new RegExp(`role="status"[^]*${m.admin.appTemplates.notAvailable.replace(/[()]/g, "\\$&")}`));
    expect(out).not.toContain("/admin/templates/apps/new");
    expect(out).not.toContain("<table");
    expect(out).not.toContain(m.admin.appTemplates.loadError);
  });

  it("any other failure says it could not load", async () => {
    route({ "v1/admin/app-templates": failure(500) });
    const out = html(en, await AdminAppTemplatesPage());
    expect(out).toMatch(new RegExp(`role="alert"[^]*${en.admin.appTemplates.loadError}`));
    expect(out).not.toContain("<table");
    expect(out).not.toContain(en.admin.appTemplates.notAvailable);
  });
});

describe("canArchiveAppTemplate", () => {
  it("is false for a built-in or an archived template, true otherwise", () => {
    expect(canArchiveAppTemplate(BUILT_IN)).toBe(false);
    expect(canArchiveAppTemplate(ARCHIVED)).toBe(false);
    expect(canArchiveAppTemplate({ ...BUILT_IN, archivedAt: NOW })).toBe(false);
    expect(canArchiveAppTemplate(BOARD)).toBe(true);
    expect(canArchiveAppTemplate(DRAFT)).toBe(true);
  });
});

describe("AppTemplateDetail", () => {
  const mount = (template: AdminAppTemplateDetailDto, usage: AdminAppTemplateUsageDto | null = USAGE, m: Messages = en) =>
    html(m, createElement(AppTemplateDetail, { template, usage, csrfToken: "csrf" }));
  const switchTag = (out: string) => out.match(/<input[^>]*role="switch"[^>]*>/)![0];

  it.each(locales)("a labelled, described switch, checked for a published template (%s)", (_l, m) => {
    const t = m.admin.appTemplates.detail;
    const out = mount(detail(BOARD), USAGE, m);
    const tag = switchTag(out);
    expect(tag).toContain('id="app-template-enabled"');
    expect(tag).toContain('type="checkbox"');
    expect(tag).toContain('aria-describedby="app-template-enabled-hint"');
    expect(tag).toContain("checked");
    expect(tag).not.toContain("disabled");
    expect(out).toMatch(new RegExp(`<label[^>]*for="app-template-enabled"[^>]*>${t.enabled}<`));
    expect(out).toMatch(new RegExp(`id="app-template-enabled-hint"[^>]*>${t.enabledHint}<`));
  });

  it("the switch is disabled when archived or without a default version", () => {
    expect(switchTag(mount(detail(ARCHIVED)))).toContain("disabled");
    expect(switchTag(mount(detail(DRAFT)))).toContain("disabled");
    expect(switchTag(mount(detail(DRAFT)))).not.toContain("checked");
  });

  it("lists the versions with the default badge, a <time>, installations, make-default and new-from links", () => {
    const t = en.admin.appTemplates.detail;
    const out = mount(detail(BOARD));
    expect(out).toContain(`>${t.versions}<`);
    expect(out).toContain(`>${t.createdAt}<`);
    expect(out.match(new RegExp(`>${t.isDefault}<`, "g"))).toHaveLength(1);
    expect(out).toContain(`<time dateTime="${NOW}">`);
    expect(out).toContain(
      `<time dateTime="2026-11-01T09:30:00.000Z">${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date("2026-11-01T09:30:00.000Z"))}<`,
    );
    const rows = out.split("<tr");
    const head = rows.find((r) => r.includes("edit?version=atv_board_2"))!;
    const prev = rows.find((r) => r.includes("edit?version=atv_prev_1"))!;
    expect(head).toContain(">v2<");
    expect(head).not.toContain(t.makeDefault);
    expect(prev).toContain(">v1<");
    expect(prev).toContain(`>${t.makeDefault}<`);
    expect(prev).toContain(`href="/admin/templates/apps/atpl_board/edit?version=atv_prev_1"`);
    expect(prev).toContain(`>${t.newFrom}<`);
  });

  it("archive is offered for a custom template and absent for a built-in or archived one", () => {
    const t = en.admin.appTemplates.detail;
    expect(mount(detail(BOARD))).toContain(`>${t.archive}<`);
    expect(mount(detail(BUILT_IN))).not.toContain(`>${t.archive}<`);
    const archived = mount(detail(ARCHIVED));
    expect(archived).not.toContain(`>${t.archive}<`);
    expect(archived).not.toContain(`>${t.makeDefault}<`);
  });

  it.each(locales)("the usage table names each stack, its customer, version and status in words (%s)", (_l, m) => {
    const t = m.admin.appTemplates;
    const out = mount(detail(BOARD), USAGE, m);
    expect(out).toContain(`>${t.detail.usage}<`);
    expect(out).toContain(`>${t.detail.usageCustomer}<`);
    const rows = out.split("<tr");
    const a = rows.find((r) => r.includes(">team-board<"))!;
    expect(a).toContain(">Acme Srl<");
    expect(a).toContain(">v2<");
    expect(a).toContain(`>${t.stackStatus.running}<`);
    const b = rows.find((r) => r.includes(">old-board<"))!;
    expect(b).toContain(">Beta Spa<");
    expect(b).toContain(`>${t.stackStatus.degraded}<`);
    expect(out).not.toContain(t.detail.usageTruncated);
  });

  it("usage: error, empty and truncated states", () => {
    const t = en.admin.appTemplates.detail;
    expect(mount(detail(BOARD), null)).toMatch(new RegExp(`role="alert"[^]*${t.usageError}`));
    const empty = mount(detail(BOARD), { ...USAGE, stacks: [] });
    expect(empty).toContain(t.usageEmpty);
    expect(empty).not.toContain(">team-board<");
    expect(mount(detail(BOARD), { ...USAGE, truncated: true })).toContain(t.usageTruncated);
  });

  describe("actions (callHooks)", () => {
    const props = (template = detail(BOARD)) => ({ template, usage: USAGE, csrfToken: "csrf" });
    const send = (url: string, method: string, body: unknown) => [expect.any(Object), "csrf", expect.any(String), method, url, body];

    it("the switch PATCHes enabled, then refreshes and says so", async () => {
      keyedSend.mockResolvedValue({ ok: true, data: {} });
      const { tree, sets } = callHooks(AppTemplateDetail, props(), en);
      const input = els(tree).find((e) => e.props.id === "app-template-enabled")!;
      await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { checked: false } });
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(keyedSend).toHaveBeenCalledWith(...send("/api/admin/app-templates/atpl_board", "PATCH", { enabled: false }));
      expect(sets).toContainEqual([1, { ok: true, text: en.admin.appTemplates.detail.saved }]);
    });

    it("make default PATCHes the version id", async () => {
      keyedSend.mockResolvedValue({ ok: true, data: {} });
      const { tree } = callHooks(AppTemplateDetail, props(), en);
      const button = els(tree).find((e) => e.type === Button && textOf(e) === en.admin.appTemplates.detail.makeDefault)!;
      await (button.props.onClick as () => Promise<void>)();
      await vi.waitFor(() => expect(keyedSend).toHaveBeenCalledTimes(1));
      expect(keyedSend).toHaveBeenCalledWith(...send("/api/admin/app-templates/atpl_board", "PATCH", { defaultVersionId: "atv_prev_1" }));
    });

    it("archive opens a dialog whose confirm names the action and POSTs {} to the archive route", async () => {
      keyedSend.mockResolvedValue({ ok: true, data: {} });
      const t = en.admin.appTemplates.detail;
      const { tree, sets } = callHooks(AppTemplateDetail, props(), en);
      const all = els(tree);
      const open = all.find((e) => e.type === Button && textOf(e) === t.archive)!;
      expect(open.props.variant).toBe("destructive");
      (open.props.onClick as () => void)();
      expect(sets).toContainEqual([2, true]);
      expect(all.some((e) => textOf(e) === t.archiveBody)).toBe(true);
      const confirm = all.find((e) => e.type === Button && textOf(e) === t.archiveConfirm)!;
      expect(t.archiveConfirm).toContain(t.archive);
      await (confirm.props.onClick as () => Promise<void>)();
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
      expect(keyedSend).toHaveBeenCalledWith(...send("/api/admin/app-templates/atpl_board/archive", "POST", {}));
      expect(sets).toContainEqual([1, { ok: true, text: t.archived }]);
    });

    it.each(locales)("a refusal becomes the reason's sentence in an alert and nothing is refreshed (%s)", async (_l, m) => {
      keyedSend.mockResolvedValue({ ok: false, code: "RESOURCE_LOCKED", reason: "template_archived" });
      const { tree, sets } = callHooks(AppTemplateDetail, props(), m);
      const input = els(tree).find((e) => e.props.id === "app-template-enabled")!;
      await (input.props.onChange as (e: unknown) => Promise<void>)({ target: { checked: false } });
      await vi.waitFor(() => expect(sets).toContainEqual([1, { ok: false, text: m.admin.appTemplates.reasons.template_archived }]));
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});

describe("detail page", () => {
  const page = (templateId = "atpl_board") => AdminAppTemplatePage({ params: Promise.resolve({ templateId }) });

  it.each(locales)("reads the template and its usage, shows back link, name, slug, state and the detail (%s)", async (locale, m) => {
    getRequestLocale.mockResolvedValue(locale);
    const t = m.admin.appTemplates;
    const out = html(m, await page());
    expect(paths()).toEqual(["v1/admin/app-templates/atpl_board", "v1/admin/app-templates/atpl_board/usage"]);
    expect(out).toMatch(/<h1[^>]*>Board</);
    expect(out).toMatch(/class="[^"]*font-mono[^"]*">board</);
    expect(out).toContain(`>${t.state.published}<`);
    expect(out).toContain("A team board");
    expect(out).toMatch(new RegExp(`href="/admin/templates/apps"[^>]*>[^]*?${t.back}<`));
    expect(out).toContain('id="app-template-enabled"');
    expect(out).toContain(">team-board<");
  });

  it("encodes the id it sends upstream", async () => {
    await expect(page("a/b")).rejects.toThrow("NOT_FOUND");
    expect(paths()).toContain("v1/admin/app-templates/a%2Fb");
  });

  it("renders notFound() for a 404", async () => {
    await expect(page("atpl_missing")).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("shows the load error (and not notFound) when the API fails", async () => {
    route({ "v1/admin/app-templates/atpl_board": failure(500) });
    const out = html(en, await page());
    expect(notFound).not.toHaveBeenCalled();
    expect(out).toContain(en.shell.loadErrorTitle);
    expect(out).not.toContain('id="app-template-enabled"');
  });

  it("a 422 NOT_SUPPORTED says the feature is off and offers no controls", async () => {
    route({ "v1/admin/app-templates/atpl_board": failure(422, "NOT_SUPPORTED") });
    const out = html(en, await page());
    expect(out).toContain(en.admin.appTemplates.notAvailable);
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<button");
  });

  it("a failed usage read still renders the template with the usage error", async () => {
    route({ "v1/admin/app-templates/atpl_board/usage": failure(500) });
    const out = html(en, await page());
    expect(out).toContain('id="app-template-enabled"');
    expect(out).toContain(en.admin.appTemplates.detail.usageError);
  });
});

describe("appTemplateRefusalText", () => {
  it.each(locales)("has its own sentence for every APP_STACK_REASONS member (%s)", (_l, m) => {
    const generic = errorMessage(m, "VALIDATION_ERROR");
    for (const reason of APP_STACK_REASONS) {
      const text = appTemplateRefusalText(m, "VALIDATION_ERROR", reason);
      expect(text).toBe(m.admin.appTemplates.reasons[reason]);
      expect(text).not.toBe(generic);
      expect(text).not.toBe("");
    }
  });
});

describe("sidebar", () => {
  it("still has exactly one templates entry, also on an application template page", () => {
    for (const path of ["/admin/templates", "/admin/templates/apps/atpl_board"]) {
      pathname = path;
      for (const m of [en, itMsgs]) {
        const out = renderToStaticMarkup(wrap(m, createElement(SidebarNav)));
        const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
        expect(hrefs.filter((h) => h.startsWith("/admin/templates"))).toEqual(["/admin/templates"]);
        expect(out).not.toContain(m.admin.appTemplates.tabs.apps);
      }
    }
    expect(format(en.admin.appTemplates.versionLabel, { n: 2 })).toBe("v2");
  });
});
