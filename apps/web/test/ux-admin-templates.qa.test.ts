import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APP_TEMPLATE_LIMITS,
  APP_TEMPLATE_STATES,
  appTemplateState,
  type AdminAppTemplateDetailDto,
  type AdminAppTemplateSummaryDto,
  type AdminSiteTemplateSummaryDto,
} from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

// QA-A1 (ux-admin §10): the one «Modelli» list and the details dialog of an application template. Only the session,
// the upstream HTTP call, the keyed sender and next/navigation are replaced; the real server reads and the real
// components run.

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const keyedSend = vi.fn();
const refresh = vi.fn();

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
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: () => refresh() }),
  usePathname: () => "/admin/templates",
}));

import AdminTemplatesPage from "@/app/admin/templates/page";
import AdminAppTemplatesPage from "@/app/admin/templates/apps/page";
import { TemplateCatalog } from "@/components/admin/template-catalog";
import { AppTemplateDetail, appTemplateCategoryOptions } from "@/components/admin/app-template-detail";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

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
    slug: "x",
    name: "Custom",
    category: "productivity",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: "atv_x_2",
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

function detail(base: AdminAppTemplateSummaryDto): AdminAppTemplateDetailDto {
  return {
    ...base,
    createdAt: NOW,
    versions: [
      { id: base.defaultVersionId ?? "atv_head_2", versionNumber: 2, specHash: "a".repeat(64), createdAt: NOW, installations: 2 },
      { id: "atv_prev 1/x", versionNumber: 1, specHash: "b".repeat(64), createdAt: "2026-11-01T09:30:00.000Z", installations: 1 },
    ],
  };
}

const wrap = (m: Messages, node: ReactElement) => createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node });
const raw = (m: Messages, node: ReactElement) => renderToStaticMarkup(wrap(m, node));
const html = (m: Messages, node: ReactElement) => raw(m, node).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

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

// Calls a client component once with stand-in hooks so its handlers can run without a DOM; `init` overrides the
// initial value of the useState call at that index.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, m: Messages, init: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const ctx = { locale: m === en ? "en" : "it", messages: m };
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in init ? init[k] : v, (x: unknown) => void sets.push([k, x])];
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

const envelope = (data: unknown, page?: unknown) => ({ ok: true, status: 200, data: { data, ...(page ? { page } : {}) } });
const failure = (status: number, code?: string) => ({ ok: false, status, data: null, error: code ? { error: { code } } : null });
const meWith = (flag: unknown) => envelope({ platformCapabilities: { applicationTemplatesAvailable: flag } });
const WP = site({ id: "stpl_wordpress", name: "WordPress", builtIn: true });
const BOARD = app({ id: "atpl_board", name: "Board" });
const route = (over: Record<string, unknown> = {}) => {
  const table: Record<string, unknown> = {
    "v1/me": meWith(true),
    "v1/admin/site-templates": envelope({ templates: [WP] }),
    "v1/admin/app-templates": envelope([BOARD]),
    ...over,
  };
  fetchUpstream.mockImplementation(async (path: string) => table[path] ?? failure(404));
};
const paths = () => fetchUpstream.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  fetchUpstream.mockReset();
  getServerSession.mockReset();
  getRequestLocale.mockReset();
  keyedSend.mockReset();
  refresh.mockReset();
  getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  getRequestLocale.mockResolvedValue("en");
  route();
});

describe("/admin/templates: which values of the flag read the application templates", () => {
  it.each([
    ["true", true, true],
    ["false", false, false],
    ["undefined", undefined, false],
    ['the string "true"', "true", false],
    ["the number 1", 1, false],
    ["null", null, false],
  ])("applicationTemplatesAvailable = %s → application read: %s", async (_n, flag, reads) => {
    route({ "v1/me": meWith(flag) });
    const out = html(en, await AdminTemplatesPage());
    expect(paths().includes("v1/admin/app-templates")).toBe(reads);
    expect(out.includes('href="/admin/templates/apps/atpl_board"')).toBe(reads);
    expect(out.includes("Board")).toBe(reads);
    expect(out.includes(en.admin.appTemplates.tabs.label)).toBe(false); // the menu is closed in static HTML; the label is on the content only
    expect(out).toContain('href="/admin/templates/stpl_wordpress"');
    expect(out).not.toContain('role="alert"');
  });

  it("v1/me answering 500: WordPress rows only, no application read, no alert", async () => {
    route({ "v1/me": failure(500) });
    const tree = await AdminTemplatesPage();
    expect(paths().sort()).toEqual(["v1/admin/site-templates", "v1/me"]);
    expect(els(tree).some((e) => e.props["aria-label"] === en.admin.appTemplates.tabs.label)).toBe(false);
    const out = html(en, tree);
    expect(out).toContain('href="/admin/templates/stpl_wordpress"');
    expect(out).not.toContain('role="alert"');
    expect(out).not.toContain("/admin/templates/apps/");
  });

  it.each(locales)("both reads failing: both alerts, no table, the way to create is still there (%s)", async (_l, m) => {
    getRequestLocale.mockResolvedValue(m === en ? "en" : "it");
    route({ "v1/admin/site-templates": failure(500), "v1/admin/app-templates": failure(500) });
    const out = html(m, await AdminTemplatesPage());
    expect(out).toContain(m.admin.templates.loadError);
    expect(out).toContain(m.admin.appTemplates.loadError);
    expect(out).not.toContain("<table");
    expect(out).toContain(m.admin.templates.create);
  });
});

describe("one table for many templates", () => {
  const SITES = Array.from({ length: 100 }, (_, i) => site({ id: `stpl_${i}`, name: `Site ${String(i).padStart(3, "0")}`, siteCount: i }));
  const APPS = Array.from({ length: 100 }, (_, i) => app({ id: `atpl_${i}`, name: `App ${String(i).padStart(3, "0")}`, installations: i }));

  it.each(locales)("100 WordPress + 100 application templates: one table, one header row, 200 rows, sites first (%s)", (_l, m) => {
    const out = raw(m, createElement(TemplateCatalog, { sites: SITES, apps: APPS, m }));
    expect(out.match(/<table/g)).toHaveLength(1);
    expect(out.match(/<thead/g)).toHaveLength(1);
    expect(out.match(/<tbody/g)).toHaveLength(1);
    expect(out.match(/<tr/g)).toHaveLength(201);
    expect(out.match(/<th[ >]/g)).toHaveLength(5);
    const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
    expect(new Set(hrefs).size).toBe(200);
    expect(hrefs.slice(0, 100).every((h) => /^\/admin\/templates\/stpl_\d+$/.test(h))).toBe(true);
    expect(hrefs.slice(100).every((h) => /^\/admin\/templates\/apps\/atpl_\d+$/.test(h))).toBe(true);
    expect(out.split(`>${m.admin.templates.modules.wordpress}<`).length - 1).toBe(100);
    expect(out.split(`>${m.admin.appTemplates.tabs.apps}<`).length - 1).toBe(100);
  });

  it("the page with 100 + 100 templates also draws one table", async () => {
    route({ "v1/admin/site-templates": envelope({ templates: SITES }), "v1/admin/app-templates": envelope(APPS) });
    const out = raw(en, await AdminTemplatesPage());
    expect(out.match(/<table/g)).toHaveLength(1);
    expect(out.match(/<tr/g)).toHaveLength(201);
  });

  it("names of 80 characters and descriptions of 500 do not break the list or the dialog", () => {
    const name = "N".repeat(APP_TEMPLATE_LIMITS.stackName);
    const description = "d".repeat(APP_TEMPLATE_LIMITS.stackDescription);
    expect([name.length, description.length]).toEqual([80, 500]);
    const tpl = app({ id: "atpl_long", name, description });
    const siteLong = site({ id: "stpl_long", name, description });
    const out = raw(en, createElement(TemplateCatalog, { sites: [siteLong], apps: [tpl], m: en }));
    expect(out.split(`>${name}<`).length - 1).toBe(2);
    expect(out.match(/<tr/g)).toHaveLength(3);
    const { tree } = callHooks(AppTemplateDetail, { template: detail(tpl), usage: null, csrfToken: "csrf" }, en);
    const all = els(tree);
    expect(all.find((e) => e.props.id === "app-template-name")!.props.value).toBe(name);
    expect(all.find((e) => e.props.id === "app-template-description")!.props.value).toBe(description);
    expect(all.find((e) => e.props.id === "app-template-name")!.props.maxLength).toBe(80);
    expect(all.find((e) => e.props.id === "app-template-description")!.props.maxLength).toBe(500);
  });

  it("an application template name that looks like markup is text", () => {
    const XSS = "<script>alert(1)</script>";
    const IMG = '"><img src=x onerror=alert(1)>';
    const out = raw(en, createElement(TemplateCatalog, { sites: [], apps: [app({ id: "atpl_x", name: XSS }), app({ id: "atpl_y", name: IMG })], m: en }));
    expect(out).not.toContain("<script>");
    expect(out).not.toMatch(/<img[^>]*onerror/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const detailOut = raw(en, createElement(AppTemplateDetail, { template: detail(app({ id: "atpl_x", name: XSS })), usage: null, csrfToken: "c" }));
    expect(detailOut).not.toContain("<script>");
  });
});

describe("ids that need encoding", () => {
  const ID = "x a/b?c#d%e&f";
  const ENC = encodeURIComponent(ID);

  it.each(locales)("both kinds of row link to the encoded id (%s)", (_l, m) => {
    const out = raw(m, createElement(TemplateCatalog, { sites: [site({ id: `stpl_${ID}` })], apps: [app({ id: `atpl_${ID}` })], m }));
    const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
    expect(hrefs).toEqual([`/admin/templates/stpl_${ENC}`, `/admin/templates/apps/atpl_${ENC}`]);
    expect(out).not.toContain(`stpl_${ID}"`);
  });

  it("the detail's edit links and the save address are encoded too", async () => {
    const tpl = detail(app({ id: `atpl_${ID}` }));
    const out = raw(en, createElement(AppTemplateDetail, { template: tpl, usage: null, csrfToken: "csrf" }));
    expect(out).toContain(`href="/admin/templates/apps/atpl_${ENC}/edit"`);
    expect(out).toContain(`href="/admin/templates/apps/atpl_${ENC}/edit?version=${encodeURIComponent("atv_prev 1/x")}"`);
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    const { tree } = callHooks(AppTemplateDetail, { template: tpl, usage: null, csrfToken: "csrf" }, en);
    const save = els(tree).find((e) => e.type === Button && textOf(e) === en.admin.templates.detail.save)!;
    await (save.props.onClick as () => Promise<void>)();
    expect(keyedSend.mock.calls[0]![4]).toBe(`/api/admin/app-templates/atpl_${ENC}`);
  });
});

describe("every application state × built-in", () => {
  const cases = APP_TEMPLATE_STATES.flatMap((state) =>
    [false, true].map((builtIn) => [state, builtIn] as const),
  );
  const make = (state: (typeof APP_TEMPLATE_STATES)[number], builtIn: boolean) =>
    app({
      id: "atpl_s",
      name: "Subject",
      builtIn,
      enabled: state === "published",
      archivedAt: state === "archived" ? NOW : null,
      defaultVersionId: state === "draft" ? null : "atv_s_1",
      defaultVersionNumber: state === "draft" ? null : 1,
    });

  it.each(cases.flatMap(([s, b]) => locales.map(([l, m]) => [s, b, l, m] as const)))(
    "the row of a %s template, built-in %s (%s)",
    (state, builtIn, _l, m) => {
      const tpl = make(state, builtIn);
      expect(tpl.state).toBe(state);
      const out = raw(m, createElement(TemplateCatalog, { sites: [], apps: [tpl], m }));
      const row = out.split("<tr")[2]!;
      const a = m.admin.appTemplates;
      expect(row).toContain(`>${a.state[state]}<`);
      expect(row.includes(`>${a.builtIn}<`)).toBe(builtIn);
      expect(row.includes("opacity-60")).toBe(state === "archived");
      expect(row).toContain(state === "draft" ? `>${a.noVersion}<` : `>${format(a.versionLabel, { n: 1 })}<`);
      // exactly one state badge: the other two state words are not on the row
      for (const other of APP_TEMPLATE_STATES.filter((s) => s !== state)) {
        if (a.state[other] !== a.state[state]) expect(row).not.toContain(`>${a.state[other]}<`);
      }
    },
  );

  it.each(cases)("the detail of a %s template, built-in %s: switch, entries and archive follow the state", (state, builtIn) => {
    const out = raw(en, createElement(AppTemplateDetail, { template: detail(make(state, builtIn)), usage: null, csrfToken: "csrf" }));
    const t = en.admin.appTemplates.detail;
    const archived = state === "archived";
    expect(out.includes(`>${t.editDetails}<`)).toBe(!archived);
    expect(out.includes(`>${t.editContent}<`)).toBe(!archived);
    expect(out.includes(t.editContentHint)).toBe(!archived);
    expect(out.includes(`>${t.archive}<`)).toBe(!archived && !builtIn);
    expect(out.includes(en.admin.templates.detail.builtInNotice)).toBe(builtIn && !archived);
    expect(out.includes(en.admin.templates.detail.archivedNotice)).toBe(archived);
    const sw = out.match(/<input[^>]*id="app-template-enabled"[^>]*>/)![0];
    expect(/\bdisabled\b/.test(sw)).toBe(archived || state === "draft");
    expect(/\bchecked\b/.test(sw)).toBe(state === "published");
  });
});

describe("the details dialog", () => {
  const props = (template: AdminAppTemplateDetailDto) => ({ template, usage: null, csrfToken: "csrf" });
  const saveButton = (tree: unknown, m: Messages) => els(tree).find((e) => e.type === Button && textOf(e) === m.admin.templates.detail.save)!;
  const cancelButton = (tree: unknown, m: Messages) => els(tree).find((e) => e.type === Button && textOf(e) === m.common.cancel && e.props.variant === "outline")!;
  const dialogs = (tree: unknown) => els(tree).filter((e) => e.type === Dialog);

  it.each(locales)("every label is bound by htmlFor to its own control, and says the right word (%s)", (_l, m) => {
    const { tree } = callHooks(AppTemplateDetail, props(detail(BOARD)), m);
    const all = els(tree);
    const wanted: Array<[string, string, string | ((t: unknown) => boolean)]> = [
      ["app-template-name", m.admin.appTemplates.col.name, "Input"],
      ["app-template-description", m.admin.templates.detail.description, "Textarea"],
      ["app-template-category", m.admin.appTemplates.col.category, "select"],
    ];
    for (const [id, text, kind] of wanted) {
      const labels = all.filter((e) => e.type === Label && e.props.htmlFor === id);
      expect(labels, id).toHaveLength(1);
      expect(textOf(labels[0])).toBe(text);
      expect(text).not.toBe("");
      const controls = all.filter((e) => e.props.id === id);
      expect(controls, id).toHaveLength(1);
      const type = controls[0]!.type as unknown as { displayName?: string; name?: string; render?: { name?: string } } | string;
      const label = typeof type === "string" ? type : (type.displayName ?? type.render?.name ?? type.name);
      expect(label, id).toBe(kind);
    }
    // no other id is shared by two elements in the dialog (a duplicate would hijack a label)
    const ids = all.map((e) => e.props.id).filter((i): i is string => typeof i === "string");
    expect(new Set(ids).size).toBe(ids.length);
    // and the dialog is described by the hint that exists
    const content = all.find((e) => e.props["aria-describedby"] === "app-template-details-hint")!;
    expect(content).toBeDefined();
    expect(all.some((e) => e.props.id === "app-template-details-hint" && textOf(e) === m.admin.appTemplates.detail.detailsHint)).toBe(true);
  });

  it.each([
    ["mystery", 9, "mystery"],
    ["Web", 9, "Web"], // wrong case is not a known key
    ["", 9, ""],
    ["productivity", 8, "productivity"],
    ["web", 8, "web"],
  ])("a stored category %j: %i options, the select shows %j and saving keeps it", async (stored, count, shown) => {
    const tpl = detail(app({ id: "atpl_c", category: stored }));
    const { tree } = callHooks(AppTemplateDetail, props(tpl), en);
    const select = els(tree).find((e) => e.props.id === "app-template-category")!;
    expect(select.props.value).toBe(shown);
    const options = els(select.props.children).filter((e) => e.type === "option");
    expect(options).toHaveLength(count);
    expect(options.map((o) => o.props.value)).toContain(shown);
    expect(options[0]!.props.value).toBe(count === 9 ? stored : Object.keys(en.admin.appTemplates.category)[0]);
    expect(new Set(options.map((o) => o.props.value)).size).toBe(count);
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    await (saveButton(tree, en).props.onClick as () => Promise<void>)();
    expect((keyedSend.mock.calls[0]![5] as { category: string }).category).toBe(stored);
  });

  it.each(locales)("the known options are the dictionary's, in both languages, with no blank label (%s)", (_l, m) => {
    const opts = appTemplateCategoryOptions(m, "web");
    expect(opts.map((o) => o.value)).toEqual(Object.keys(m.admin.appTemplates.category));
    expect(opts.every((o) => o.label.trim() !== "")).toBe(true);
    expect(Object.keys(en.admin.appTemplates.category)).toEqual(Object.keys(itMsgs.admin.appTemplates.category));
  });

  it.each([
    ["  Board  ", "  A team board \n", { name: "Board", description: "A team board" }],
    ["Board", "   ", { name: "Board", description: null }],
    ["Board", "", { name: "Board", description: null }],
  ])("saving %j / %j sends the trimmed values", async (name, description, expected) => {
    const tpl = { ...detail(app({ id: "atpl_t", name: name as string, description: description as string })) };
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    const { tree } = callHooks(AppTemplateDetail, props(tpl), en);
    await (saveButton(tree, en).props.onClick as () => Promise<void>)();
    expect(keyedSend.mock.calls[0]![5]).toEqual({ ...expected, category: "productivity" });
  });

  it("a name of spaces or of nothing cannot be saved", () => {
    for (const name of ["   ", "", "\t\n"]) {
      const { tree } = callHooks(AppTemplateDetail, props(detail(app({ id: "atpl_t", name }))), en);
      expect(saveButton(tree, en).props.disabled, JSON.stringify(name)).toBe(true);
    }
    const ok = callHooks(AppTemplateDetail, props(detail(app({ id: "atpl_t", name: "x" }))), en);
    expect(saveButton(ok.tree, en).props.disabled).toBe(false);
  });

  it.each(locales)("while a save is in flight the buttons are disabled and Cancel / outside click do not close the dialog (%s)", async (_l, m) => {
    let release: (v: unknown) => void = () => {};
    keyedSend.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const { tree, sets } = callHooks(AppTemplateDetail, props(detail(BOARD)), m);
    (saveButton(tree, m).props.onClick as () => void)();
    // closing the dialog from outside (Escape / overlay) is refused while the request runs
    const dialog = dialogs(tree)[0]!;
    (dialog.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).not.toContainEqual([3, false]);
    // a second save while busy sends nothing more
    (saveButton(tree, m).props.onClick as () => void)();
    await Promise.resolve();
    expect(keyedSend).toHaveBeenCalledTimes(1);
    release({ ok: true, data: {} });
    await vi.waitFor(() => expect(sets).toContainEqual([3, false]));
    expect(refresh).toHaveBeenCalledTimes(1);

    // the rendered buttons of a busy component are disabled
    const busy = callHooks(AppTemplateDetail, props(detail(BOARD)), m, { 0: "details" });
    expect(cancelButton(busy.tree, m).props.disabled).toBe(true);
    expect(saveButton(busy.tree, m).props.disabled).toBe(true);
    expect(els(busy.tree).find((e) => e.props.role === "status" && textOf(e) === m.admin.appTemplates.detail.working)).toBeDefined();
  });

  it("Cancel and an outside click close the dialog when nothing is running", () => {
    const { tree, sets } = callHooks(AppTemplateDetail, props(detail(BOARD)), en);
    expect(cancelButton(tree, en).props.disabled).toBe(false);
    (cancelButton(tree, en).props.onClick as () => void)();
    expect(sets).toContainEqual([3, false]);
    sets.length = 0;
    (dialogs(tree)[0]!.props.onOpenChange as (o: boolean) => void)(false);
    expect(sets).toContainEqual([3, false]);
    expect(keyedSend).not.toHaveBeenCalled();
  });

  it("opening the dialog again shows the stored values, not an abandoned draft", () => {
    const tpl = detail(app({ id: "atpl_r", name: "Stored", description: "Desc", category: "web" }));
    const { tree, sets } = callHooks(AppTemplateDetail, props(tpl), en, { 4: "typed but cancelled", 5: "x", 6: "content" });
    const open = els(tree).find((e) => e.type === Button && textOf(e) === en.admin.appTemplates.detail.editDetails)!;
    (open.props.onClick as () => void)();
    expect(sets).toEqual(expect.arrayContaining([[4, "Stored"], [5, "Desc"], [6, "web"], [3, true]]));
  });

  it.each([
    ["VALIDATION_ERROR", undefined],
    ["NOT_FOUND", undefined],
    ["RESOURCE_LOCKED", "template_archived"],
  ])("a refusal %s / %s keeps the dialog open and shows a non-empty sentence", async (code, reason) => {
    keyedSend.mockResolvedValue({ ok: false, code, reason });
    const { tree, sets } = callHooks(AppTemplateDetail, props(detail(BOARD)), en);
    await (saveButton(tree, en).props.onClick as () => Promise<void>)();
    const notice = sets.find(([k]) => k === 1 && (sets[0]![1] as unknown) !== null)!;
    expect(sets).not.toContainEqual([3, false]);
    expect(refresh).not.toHaveBeenCalled();
    const last = [...sets].reverse().find(([k]) => k === 1)![1] as { ok: boolean; text: string };
    expect(notice).toBeDefined();
    expect(last.ok).toBe(false);
    expect(last.text.trim()).not.toBe("");
  });
});

describe("/admin/templates/apps", () => {
  it.each([0, 1, 2])("redirects to the one list, every time (call %i), with or without a session and without any read", async () => {
    expect(() => AdminAppTemplatesPage()).toThrow("REDIRECT:/admin/templates");
    getServerSession.mockResolvedValue(null);
    expect(() => AdminAppTemplatesPage()).toThrow("REDIRECT:/admin/templates");
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(getServerSession).not.toHaveBeenCalled();
  });

  it("the trailing-slash address is the same page: the app does not turn trailingSlash on, and no second route claims it", () => {
    const config = readFileSync(join(process.cwd(), "apps/web/next.config.mjs"), "utf8");
    expect(config).not.toMatch(/trailingSlash\s*:\s*true/);
    const dir = join(process.cwd(), "apps/web/src/app/admin/templates/apps");
    const entries = readdirSync(dir).sort();
    expect(entries).toEqual(["[templateId]", "new", "page.tsx"]);
    expect(readdirSync(join(process.cwd(), "apps/web/src/app/admin/templates")).sort()).not.toContain("layout.tsx");
  });
});

describe("markup safety of this cycle's files", () => {
  it("no source file of the web app uses dangerouslySetInnerHTML", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?|mjs)$/.test(name) && readFileSync(p, "utf8").includes("dangerouslySetInnerHTML")) hits.push(p);
      }
    };
    walk(join(process.cwd(), "apps/web/src"));
    expect(hits).toEqual([]);
  });
});
