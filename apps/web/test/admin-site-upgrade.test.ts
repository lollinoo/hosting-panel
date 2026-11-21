import { beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminSiteDto } from "@hosting-panel/contracts";
import { errorMessage, format, type Messages } from "@/i18n";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const keyedSend = vi.fn();
const refresh = vi.fn();
vi.mock("@/lib/keyed-send", () => ({ keyedSend: (...a: unknown[]) => keyedSend(...a) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: () => refresh() }),
  usePathname: () => "/admin/sites",
}));
// Radix renders its content through a portal, which static markup skips: a stand-in that honours `open`.
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  const part = (tag: string) => ({ children }: { children?: React.ReactNode }) => h(tag, null, children);
  return {
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? children : null),
    DialogContent: part("section"),
    DialogHeader: part("header"),
    DialogFooter: part("footer"),
    DialogTitle: part("h2"),
    DialogDescription: part("p"),
  };
});

import { SitesTable, canUpgradeTemplate } from "@/components/admin/sites-table";
import { UpgradeSiteTemplateDialog } from "@/components/admin/upgrade-site-template-dialog";
import { Button } from "@/components/ui/button";

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const ref = (over: Record<string, unknown> = {}) => ({
  templateId: "stpl_wordpress",
  templateName: "WordPress",
  versionId: "stv_wordpress_1",
  versionNumber: 1,
  defaultVersionId: "stv_wordpress_2",
  defaultVersionNumber: 2,
  ...over,
});
const mk = (id: string, status: AdminSiteDto["status"] = "ready", template: unknown = ref()) =>
  ({ id, name: `wp-${id}.example.test`, status, primaryDomain: null, owner: null, phpVersion: "8.4", template }) as unknown as AdminSiteDto;

/** A site from before templates: the `template` key is absent altogether. */
const legacy = (id: string) => {
  const s = mk(id) as unknown as Record<string, unknown>;
  delete s.template;
  return s as unknown as AdminSiteDto;
};

const wrap = (m: Messages, child: ReactElement) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child }));

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
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("canUpgradeTemplate", () => {
  it("is false without a template, tolerating a missing key", () => {
    expect(canUpgradeTemplate(mk("a", "ready", null))).toBe(false);
    expect(canUpgradeTemplate(legacy("a"))).toBe(false);
  });

  it("is false when the site already runs the default version or a newer one", () => {
    expect(canUpgradeTemplate(mk("a", "ready", ref({ versionNumber: 2, versionId: "stv_wordpress_2" })))).toBe(false);
    expect(canUpgradeTemplate(mk("a", "ready", ref({ versionNumber: 3, versionId: "stv_wordpress_3" })))).toBe(false);
  });

  it("is false when the template has no default version", () => {
    expect(canUpgradeTemplate(mk("a", "ready", ref({ defaultVersionId: null, defaultVersionNumber: null })))).toBe(false);
  });

  it("needs a ready or degraded site", () => {
    for (const status of ["ready", "degraded"] as const) expect(canUpgradeTemplate(mk("a", status))).toBe(true);
    for (const status of ["deploying", "stopped", "maintenance"] as const) {
      expect(canUpgradeTemplate(mk("a", status))).toBe(false);
    }
  });
});

describe("SitesTable template column", () => {
  const sites = [
    mk("a", "ready"),
    mk("b", "degraded"),
    mk("c", "deploying"),
    mk("d", "ready", ref({ versionNumber: 2, versionId: "stv_wordpress_2" })),
    mk("e", "ready", null),
    legacy("f"),
  ];

  it.each(locales)("shows the template and version after PHP, and the upgrade button on upgradable rows only (%s)", (_l, m) => {
    const t = m.admin.sites;
    const html = wrap(m, createElement(SitesTable, { sites, customers: [], csrfToken: "csrf" }));
    expect(html.indexOf(t.colPhp)).toBeLessThan(html.indexOf(`>${t.colTemplate}<`));
    expect(html.indexOf(`>${t.colTemplate}<`)).toBeLessThan(html.indexOf(t.colStatus));
    expect(count(html, ">WordPress v1<")).toBe(3); // a, b, c
    expect(count(html, ">WordPress v2<")).toBe(1); // d
    expect(count(html, `>${t.upgrade}<`)).toBe(2); // a, b
  });

  it("renders a dash for sites without a template", () => {
    const html = wrap(en, createElement(SitesTable, { sites: [mk("e", "ready", null), legacy("f")], customers: [], csrfToken: "csrf" }));
    expect(html).not.toContain(">WordPress");
    expect(html).not.toContain(`>${en.admin.sites.upgrade}<`);
  });

  it("opens the dialog through a fifth state slot and refreshes after an accepted upgrade", () => {
    const { tree, sets } = callHooks(SitesTable, { sites, customers: [], csrfToken: "csrf" }, en);
    const buttons = els(tree).filter((e) => e.type === Button && textOf(e) === en.admin.sites.upgrade);
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props.onClick as () => void)();
    expect(sets).toEqual([[4, sites[0]]]);

    const dialog = els(tree).find((e) => e.type === UpgradeSiteTemplateDialog)!;
    expect(dialog.props.csrfToken).toBe("csrf");
    refresh.mockClear();
    (dialog.props.onClose as () => void)();
    (dialog.props.onDone as (text: string) => void)("done");
    expect(sets).toContainEqual([4, null]);
    expect(sets).toContainEqual([3, { error: false, text: "done" }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("UpgradeSiteTemplateDialog", () => {
  const props = (site: AdminSiteDto | null) => ({ site, csrfToken: "csrf", onClose: vi.fn(), onDone: vi.fn() });

  it.each(locales)("names the site, the template and the target version (%s)", (_l, m) => {
    const html = wrap(m, createElement(UpgradeSiteTemplateDialog, props(mk("a"))));
    expect(html).toContain(format(m.admin.sites.upgradeTitle, { site: "wp-a.example.test", name: "WordPress", version: 2 }));
    expect(html).toContain("v2");
    expect(html).toContain(m.admin.sites.upgradeBody);
    expect(html).toContain(m.admin.sites.upgradeConfirm);
    expect(html).not.toContain('role="alert"');
  });

  it("renders nothing without a site, or when there is no newer default version", () => {
    expect(wrap(en, createElement(UpgradeSiteTemplateDialog, props(null)))).toBe("");
    expect(wrap(en, createElement(UpgradeSiteTemplateDialog, props(mk("a", "ready", null))))).toBe("");
    expect(wrap(en, createElement(UpgradeSiteTemplateDialog, props(mk("a", "ready", ref({ defaultVersionId: null, defaultVersionNumber: null })))))).toBe("");
  });

  const submit = async (tree: ReactNode) => {
    const form = els(tree).find((e) => e.type === "form")!;
    await (form.props.onSubmit as (e: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
  };

  beforeEach(() => keyedSend.mockReset());

  it("posts the default version and reports an accepted upgrade", async () => {
    keyedSend.mockResolvedValue({ ok: true, data: {} });
    const p = props(mk("a"));
    const { tree, sets } = callHooks(UpgradeSiteTemplateDialog, p, en);
    await submit(tree);
    expect(keyedSend).toHaveBeenCalledWith(
      expect.any(Object),
      "csrf",
      "upgrade:a:stv_wordpress_2",
      "POST",
      "/api/admin/sites/a/template-version",
      { versionId: "stv_wordpress_2" },
    );
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect(p.onDone).toHaveBeenCalledWith(en.admin.sites.accepted);
    expect(sets.filter(([k]) => k === 0)).toEqual([[0, true], [0, false]]);
  });

  it.each(locales)("keeps the dialog open and shows the refusal (%s)", async (_l, m) => {
    keyedSend.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const p = props(mk("a"));
    const { tree, sets } = callHooks(UpgradeSiteTemplateDialog, p, m);
    await submit(tree);
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onDone).not.toHaveBeenCalled();
    expect(sets.filter(([k]) => k === 1).at(-1)).toEqual([1, errorMessage(m, "NOT_FOUND")]);
  });
});
