import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSiteTemplateDetailDto, AdminSiteTemplateSummaryDto } from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const getRequestLocale = vi.fn();
const notFound = vi.fn();
const keyedSend = vi.fn();

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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/templates/stpl_wordpress",
}));

import AdminTemplatesPage from "@/app/admin/templates/page";
import AdminTemplatePage from "@/app/admin/templates/[templateId]/page";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { groupByModule, templateStatusKeys } from "@/components/admin/site-template-list";
import { SiteTemplateDetail, canArchive } from "@/components/admin/site-template-detail";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";

const NOW = "2026-11-21T10:00:00.000Z";

function summary(over: Partial<AdminSiteTemplateSummaryDto> & { id: string }): AdminSiteTemplateSummaryDto {
  return {
    module: "wordpress",
    name: "Custom",
    description: null,
    builtIn: false,
    enabled: true,
    archivedAt: null,
    defaultVersionId: "stv_custom_2",
    defaultVersionNumber: 2,
    versionCount: 2,
    siteCount: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as AdminSiteTemplateSummaryDto;
}

const BUILT_IN = summary({
  id: "stpl_wordpress",
  name: "WordPress",
  builtIn: true,
  defaultVersionId: "stv_wordpress_1",
  defaultVersionNumber: 1,
  versionCount: 1,
  siteCount: 7,
});
const CUSTOM = summary({ id: "stpl_custom", name: "Blog", description: "A tuned blog", siteCount: 3 });
const DISABLED = summary({ id: "stpl_off", name: "Alpha", enabled: false, versionCount: 1, defaultVersionNumber: 1 });
const ARCHIVED = summary({ id: "stpl_old", name: "Aardvark", archivedAt: NOW, enabled: false });

function detail(base: AdminSiteTemplateSummaryDto, over: Partial<AdminSiteTemplateDetailDto> = {}): AdminSiteTemplateDetailDto {
  return {
    ...base,
    versions: [
      { id: base.defaultVersionId, versionNumber: base.defaultVersionNumber, createdAt: NOW, siteCount: 2, isDefault: true },
      { id: "stv_prev_1", versionNumber: 1, createdAt: "2026-11-01T09:30:00.000Z", siteCount: 1, isDefault: false },
    ],
    ...over,
  };
}

const wrap = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  createElement(I18nProvider, { locale, messages: m, children: node });
const html = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(wrap(m, node, locale)).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("groupByModule", () => {
  it("lists known modules first in SITE_TYPE_KEYS order, then unknown ones alphabetically; empty input gives no groups", () => {
    const odd = (id: string, module: string) => ({ ...CUSTOM, id, module }) as unknown as AdminSiteTemplateSummaryDto;
    const groups = groupByModule([odd("a", "zeta"), CUSTOM, odd("b", "alpha")]);
    expect(groups.map((g) => g.module)).toEqual(["wordpress", "alpha", "zeta"]);
    expect(groupByModule([])).toEqual([]);
  });

  it("puts the built-in first, then live templates by name, and archived ones last", () => {
    const [group] = groupByModule([ARCHIVED, CUSTOM, DISABLED, BUILT_IN]);
    expect(group!.templates.map((t) => t.name)).toEqual(["WordPress", "Alpha", "Blog", "Aardvark"]);
  });
});

describe("templateStatusKeys", () => {
  it("combines built-in and enabled/disabled, and an archived template is only archived", () => {
    expect(templateStatusKeys(BUILT_IN)).toEqual(["builtIn", "enabled"]);
    expect(templateStatusKeys({ ...BUILT_IN, enabled: false })).toEqual(["builtIn", "disabled"]);
    expect(templateStatusKeys(CUSTOM)).toEqual(["enabled"]);
    expect(templateStatusKeys(DISABLED)).toEqual(["disabled"]);
    expect(templateStatusKeys(ARCHIVED)).toEqual(["archived"]);
  });
});

describe("canArchive", () => {
  it("is false for a built-in or an archived template, true otherwise", () => {
    expect(canArchive(detail(BUILT_IN))).toBe(false);
    expect(canArchive(detail(ARCHIVED))).toBe(false);
    expect(canArchive(detail(CUSTOM))).toBe(true);
  });
});

describe("SiteTemplateDetail", () => {
  const mount = (template: AdminSiteTemplateDetailDto, m: Messages = en, locale: "en" | "it" = "en") =>
    html(m, createElement(SiteTemplateDetail, { template, csrfToken: "csrf" }), locale);

  it("shows the switch, the total of sites and the actions of a custom template", () => {
    for (const [m, locale] of [[en, "en"], [itMsgs, "it"]] as const) {
      const t = m.admin.templates.detail;
      const out = mount(detail(CUSTOM), m, locale);
      expect(out).toContain(t.enabledLabel);
      expect(out).toMatch(/role="switch"[^>]*checked/);
      expect(out).not.toMatch(/role="switch"[^>]*disabled/);
      expect(out).toContain(t.enabledHint);
      expect(out).toContain(format(t.sitesTotal, { count: 3 }));
      expect(out).toContain(t.editDetails);
      expect(out).toContain(t.archive);
      expect(out).toContain('href="/admin/templates/stpl_custom/edit"');
      expect(out).toContain('href="/admin/templates/new?from=stpl_custom"');
      expect(out).not.toContain(t.builtInNotice);
      expect(out).not.toContain(t.archivedNotice);
    }
  });

  it("lists the versions with the default badge, a date, the site count and open/duplicate links", () => {
    const t = en.admin.templates.detail;
    const out = mount(detail(CUSTOM));
    expect(out).toContain(t.versionsTitle);
    for (const col of [en.admin.templates.col.version, en.admin.templates.col.created, en.admin.templates.col.sites, en.admin.templates.col.actions])
      expect(out).toContain(`>${col}<`);
    expect(out).toContain(format(en.admin.templates.versionLabel, { version: 2 }));
    expect(out).toContain(format(en.admin.templates.versionLabel, { version: 1 }));
    expect(out).toContain(new Date("2026-11-01T09:30:00.000Z").toLocaleString("en"));
    expect(out.match(new RegExp(`>${t.default}<`, "g"))).toHaveLength(1);
    expect(out).toContain('href="/admin/templates/stpl_custom/edit?version=stv_custom_2"');
    expect(out).toContain('href="/admin/templates/stpl_custom/edit?version=stv_prev_1"');
    expect(out).toContain('href="/admin/templates/new?from=stpl_custom&version=stv_custom_2"');
    expect(out).toContain('href="/admin/templates/new?from=stpl_custom&version=stv_prev_1"');
  });

  it("offers 'make default' only on a non-default version", () => {
    const out = mount(detail(CUSTOM));
    expect(out.match(new RegExp(`>${en.admin.templates.detail.makeDefault}<`, "g"))).toHaveLength(1);
    const prevRow = out.split("<tr").find((r) => r.includes("stv_prev_1")) ?? "";
    const defaultRow = out.split("<tr").find((r) => r.includes("stv_custom_2")) ?? "";
    expect(prevRow).toContain(en.admin.templates.detail.makeDefault);
    expect(defaultRow).not.toContain(en.admin.templates.detail.makeDefault);
  });

  it("a built-in template shows its notice and has no archive button", () => {
    const out = mount(detail(BUILT_IN));
    expect(out).toContain(en.admin.templates.detail.builtInNotice);
    expect(out).not.toContain(`>${en.admin.templates.detail.archive}<`);
  });

  it("an archived template is read-only: notice, disabled switch, no mutation buttons, links to consult remain", () => {
    for (const [m, locale] of [[en, "en"], [itMsgs, "it"]] as const) {
      const t = m.admin.templates.detail;
      const out = mount(detail(ARCHIVED), m, locale);
      expect(out).toContain(t.archivedNotice);
      expect(out).toMatch(/role="switch"[^>]*disabled/);
      for (const label of [t.archive, t.editDetails, t.newVersion, t.makeDefault]) expect(out).not.toContain(`>${label}<`);
      expect(out).not.toContain("<button");
      expect(out).toContain(`>${t.open}<`);
    }
  });

  it("a template that is switched off has an unticked switch", () => {
    expect(mount(detail(DISABLED))).not.toMatch(/role="switch"[^>]*checked/);
  });
});

// Calls a client component once with stand-in hooks so its handlers can run without a DOM.
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

describe("SiteTemplateDetail details dialog", () => {
  // useState order in the component: 0 busy, 1 notice, 2 editing, 3 name, 4 description, 5 archiving.
  const props = () => ({ template: detail(CUSTOM), csrfToken: "csrf" });
  const button = (tree: unknown, text: string) => els(tree).find((e) => e.type === Button && textOf(e) === text)!;
  const detailsDialog = (tree: unknown) =>
    els(tree).find((e) => e.type === DialogContent && els(e.props.children).some((c) => c.props.id === "template-name"))!;
  beforeEach(() => keyedSend.mockReset());

  it.each([
    ["template_archived, en", en, { ok: false, code: "RESOURCE_LOCKED", reason: "template_archived" }, en.admin.templates.detail.archivedNotice],
    ["template_archived, it", itMsgs, { ok: false, code: "RESOURCE_LOCKED", reason: "template_archived" }, itMsgs.admin.templates.detail.archivedNotice],
    ["network failure, en", en, { ok: false, code: "" }, errorMessage(en, "")],
  ] as const)("a refused save (%s) shows its alert inside the dialog, before the footer, and keeps it open", async (_l, m, refusal, text) => {
    keyedSend.mockResolvedValue(refusal);
    const { tree, sets } = callHooks(SiteTemplateDetail, props(), m);
    await (button(tree, m.admin.templates.detail.save).props.onClick as () => Promise<void>)();
    await vi.waitFor(() => expect(sets).toContainEqual([1, { ok: false, text }]));
    expect(sets).not.toContainEqual([2, false]);
    const open = callHooks(SiteTemplateDetail, props(), m, { 1: { ok: false, text }, 2: true });
    const inside = els(detailsDialog(open.tree).props.children);
    const alert = inside.findIndex((e) => e.props.role === "alert" && textOf(e) === text);
    expect(alert).toBeGreaterThanOrEqual(0);
    expect(alert).toBeLessThan(inside.findIndex((e) => e.type === DialogFooter));
  });

  it("no alert in the dialog without a refusal; closing or reopening clears an old one", () => {
    const t = en.admin.templates.detail;
    const ok = callHooks(SiteTemplateDetail, props(), en, { 1: { ok: true, text: t.saved }, 2: true });
    expect(els(detailsDialog(ok.tree).props.children).some((e) => e.props.role === "alert")).toBe(false);
    const refused = { 1: { ok: false, text: "No" }, 2: true };
    const reopen = callHooks(SiteTemplateDetail, props(), en, refused);
    (button(reopen.tree, t.editDetails).props.onClick as () => void)();
    expect(reopen.sets).toEqual(expect.arrayContaining([[1, null], [2, true]]));
    const cancel = callHooks(SiteTemplateDetail, props(), en, refused);
    (button(detailsDialog(cancel.tree), t.cancel).props.onClick as () => void)();
    expect(cancel.sets).toEqual(expect.arrayContaining([[2, false], [1, null]]));
    const outside = callHooks(SiteTemplateDetail, props(), en, refused);
    (els(outside.tree).find((e) => e.type === Dialog && e.props.open === true)!.props.onOpenChange as (o: boolean) => void)(false);
    expect(outside.sets).toEqual(expect.arrayContaining([[2, false], [1, null]]));
  });
});

describe("admin template pages", () => {
  const envelope = (data: unknown) => ({ ok: true, status: 200, data: { data } });
  const route = (over: Record<string, unknown> = {}) => {
    const table: Record<string, unknown> = {
      "v1/admin/site-templates": envelope({ templates: [BUILT_IN, CUSTOM], modules: [{ key: "wordpress", phpVersions: ["8.3"] }] }),
      "v1/admin/site-templates/stpl_custom": envelope(detail(CUSTOM)),
      ...over,
    };
    fetchUpstream.mockImplementation(async (path: string) => table[path] ?? { ok: false, status: 404, data: null, error: null });
  };

  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    notFound.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
    getRequestLocale.mockResolvedValue("en");
    route();
  });

  const render = async (node: Promise<ReactElement>, m: Messages = en) => html(m, await node, m === en ? "en" : "it");

  it("redirects to /login without a session (list and detail) before any upstream call", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(AdminTemplatesPage()).rejects.toThrow("REDIRECT:/login");
    await expect(AdminTemplatePage({ params: Promise.resolve({ templateId: "stpl_custom" }) })).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("list page reads exactly the templates and renders title, subtitle, the 'new' link and the list", async () => {
    const out = await render(AdminTemplatesPage());
    expect([...fetchUpstream.mock.calls.map((c) => c[0])].sort()).toEqual(["v1/admin/site-templates", "v1/me"]);
    expect(out).toContain(en.admin.templates.title);
    expect(out).toContain(en.admin.templates.subtitle);
    expect(out).toMatch(/href="\/admin\/templates\/new"[^>]*>[^<]*New template/);
    expect(out).toContain('href="/admin/templates/stpl_custom"');
    expect(out).toContain(en.admin.templates.modules.wordpress);
  });

  it("list page says it could not load when the API fails", async () => {
    route({ "v1/admin/site-templates": { ok: false, status: 500, data: null, error: null } });
    const out = await render(AdminTemplatesPage());
    expect(out).toContain(en.admin.templates.loadError);
    expect(out).not.toContain("<table");
  });

  it("list page speaks Italian when the locale is Italian", async () => {
    getRequestLocale.mockResolvedValue("it");
    const out = await render(AdminTemplatesPage(), itMsgs);
    expect(out).toContain(itMsgs.admin.templates.title);
    expect(out).toContain(itMsgs.admin.templates.create);
  });

  it("detail page loads the template, shows the back link, the name with its badges, the description and the detail", async () => {
    const out = await render(AdminTemplatePage({ params: Promise.resolve({ templateId: "stpl_custom" }) }));
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual(["v1/admin/site-templates/stpl_custom"]);
    expect(out).toMatch(/<h1[^>]*>[^<]*Blog/);
    expect(out).toContain('href="/admin/templates"');
    expect(out).toContain(en.admin.templates.back);
    expect(out).toContain("A tuned blog");
    expect(out).toContain(en.admin.templates.status.enabled);
    expect(out).toContain(format(en.admin.templates.detail.sitesTotal, { count: 3 }));
  });

  it("detail page encodes the id it sends upstream", async () => {
    await expect(AdminTemplatePage({ params: Promise.resolve({ templateId: "a/b" }) })).rejects.toThrow("NOT_FOUND");
    expect(fetchUpstream.mock.calls.map((c) => c[0])).toEqual(["v1/admin/site-templates/a%2Fb"]);
  });

  it("detail page renders notFound() for a 404", async () => {
    await expect(AdminTemplatePage({ params: Promise.resolve({ templateId: "stpl_missing" }) })).rejects.toThrow("NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("detail page shows the load error (and not notFound) when the API fails", async () => {
    route({ "v1/admin/site-templates/stpl_custom": { ok: false, status: 500, data: null, error: null } });
    const out = await render(AdminTemplatePage({ params: Promise.resolve({ templateId: "stpl_custom" }) }));
    expect(notFound).not.toHaveBeenCalled();
    expect(out).toContain(en.shell.loadErrorTitle);
  });
});

describe("sidebar", () => {
  it("lists the templates entry right after Sites, in both languages", () => {
    for (const m of [en, itMsgs]) {
      const out = renderToStaticMarkup(wrap(m, createElement(SidebarNav)));
      const hrefs = [...out.matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      expect(hrefs).toContain("/admin/templates");
      expect(hrefs.indexOf("/admin/templates")).toBe(hrefs.indexOf("/admin/sites") + 1);
      expect(out).toContain(`>${m.admin.nav.templates}<`);
    }
    expect(en.admin.nav.templates).not.toBe(itMsgs.admin.nav.templates);
  });

  it("marks the templates entry active on a template page", () => {
    const out = renderToStaticMarkup(wrap(en, createElement(SidebarNav)));
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toMatch(/href="\/admin\/templates"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/admin\/templates"/);
  });
});
