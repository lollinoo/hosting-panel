import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_STACK_COMPONENT_HEALTH, APP_STACK_STATUSES, type AppStackSummaryDto, type CustomerAppTemplateSummaryDto } from "@hosting-panel/contracts";

const nav = vi.hoisted(() => ({ pathname: "/apps" }));
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
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => nav.pathname,
}));

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import type { Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import AppsLayout from "@/app/apps/layout";
import AppsNotFound from "@/app/apps/not-found";
import AppsPage from "@/app/apps/page";
import NewAppPage from "@/app/apps/new/page";
import SitesLayout from "@/app/sites/layout";
import { AppsUnavailable, appsGate } from "@/components/app-stacks/apps-unavailable";
import { AppCatalog, categoryLabel, filterCatalog } from "@/components/app-stacks/app-catalog";
import { HealthBadge, StackStatusBadge } from "@/components/app-stacks/app-stack-status";
import { WIZARD_STEPS, WizardSteps } from "@/components/app-stacks/wizard-steps";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const ON = { applicationStacksAvailable: true };
const visit = { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW };
const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: ON,
  support: null,
  ...over,
});

const NOTES: CustomerAppTemplateSummaryDto = {
  id: "atpl_notes",
  name: "Notes",
  description: "Shared notes for the team.",
  category: "content",
  versionId: "atv_notes_2",
  versionNumber: 2,
  componentCount: 2,
  cpuMilli: 500,
  memoryBytes: String(256 * 2 ** 20),
  volumeCount: 1,
  hasIngress: true,
};
const WORKER: CustomerAppTemplateSummaryDto = {
  ...NOTES,
  id: "atpl_worker",
  name: "Worker",
  description: null,
  category: "odd-kind",
  versionId: "atv_worker_1",
  versionNumber: 1,
  componentCount: 1,
  cpuMilli: 2000,
  memoryBytes: String(1.5 * 2 ** 30),
  volumeCount: 0,
  hasIngress: false,
};
const STACK: AppStackSummaryDto = {
  id: "stk_a1",
  name: "team-notes",
  status: "running",
  templateId: "atpl_notes",
  templateName: "Notes",
  templateVersionNumber: 2,
  componentCount: 2,
  unhealthyCount: 0,
  primaryHostname: "notes.example.test",
  updatedAt: NOW,
};

const html = (node: ReactNode, m: Messages = en) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const appReads = () => fetchUpstream.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("app-"));
const render = async (page: () => Promise<ReactNode>) => html(await page());

// Calls a client component once with stand-in hooks; `state` presets useState slots by index.
const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
function callHooks<P>(C: (p: P) => ReactNode, props: P, state: Record<number, unknown> = {}) {
  let s = 0;
  const sets: Array<[number, unknown]> = [];
  const prev = internals.H;
  internals.H = {
    useState: (v: unknown) => {
      const k = s++;
      return [k in state ? state[k] : v, (x: unknown) => void sets.push([k, x])];
    },
    useContext: () => ({ locale: "en", messages: en }),
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
  if (!React.isValidElement(node)) return [];
  return [node as El, ...els((node.props as Record<string, unknown>).children)];
};

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = "/apps";
  mockData.getSites.mockResolvedValue([]);
  mockData.getCustomerContext.mockResolvedValue(context());
});

describe("navigation entry", () => {
  const appsLink = (h: string) => h.match(/<a[^>]*href="\/apps"[^>]*>([^<]*)<\/a>/);

  it("the apps layout shows «Applications» only with the flag on and outside a support visit", async () => {
    const on = html(await AppsLayout({ children: createElement("p", null, "child") }));
    expect(appsLink(on)?.[1]).toBe(en.apps.nav);
    expect(appsLink(on)?.[0]).toContain('aria-current="page"');
    expect(on).toContain("<p>child</p>");

    for (const over of [{ capabilities: {} }, { capabilities: null }, { capabilities: { applicationStacksAvailable: "true" } }, { support: visit }]) {
      mockData.getCustomerContext.mockResolvedValue(context(over));
      expect(appsLink(html(await AppsLayout({ children: null }))), JSON.stringify(over)).toBeNull();
    }
  });

  it("the sites layout passes the same flag; without it the top bar is unchanged", async () => {
    nav.pathname = "/sites";
    const on = html(await SitesLayout({ children: null }));
    expect(appsLink(on)?.[1]).toBe(en.apps.nav);
    expect(appsLink(on)?.[0]).not.toContain("aria-current");

    mockData.getCustomerContext.mockResolvedValue(context({ capabilities: {} }));
    const off = html(await SitesLayout({ children: null }));
    expect(off).not.toContain('href="/apps"');
    expect(off).not.toContain(en.apps.nav);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("gate", () => {
  it("appsGate: a support visit first, then the strict flag", () => {
    expect(appsGate({ capabilities: ON as never, support: visit })).toBe("support");
    expect(appsGate({ capabilities: null, support: null })).toBe("off");
    expect(appsGate({ capabilities: { applicationStacksAvailable: false } as never, support: null })).toBe("off");
    expect(appsGate({ capabilities: ON as never, support: null })).toBeNull();
  });

  it.each([
    ["/apps", AppsPage],
    ["/apps/new", NewAppPage],
  ])("%s with the flag off or in a support visit shows the notice and reads no application", async (_path, Page) => {
    for (const [over, reason] of [
      [{ capabilities: {} }, "off"],
      [{ capabilities: null }, "off"],
      [{ support: visit }, "support"],
    ] as const) {
      mockData.getCustomerContext.mockResolvedValue(context(over));
      const h = await render(Page);
      expect(h).toContain(en.apps.unavailable.title);
      expect(h).toContain(en.apps.unavailable[reason]);
      expect(h).toContain('role="status"');
      expect(h).toContain('href="/sites"');
    }
    expect(appReads()).toEqual([]);
  });

  it.each([
    ["/apps", AppsPage],
    ["/apps/new", NewAppPage],
  ])("%s: no organisation → load error; 422 NOT_SUPPORTED → notice; 500 → load error", async (_path, Page) => {
    mockData.getCustomerContext.mockResolvedValue(context({ orgId: null }));
    expect(await render(Page)).toContain(en.shell.loadErrorTitle);
    expect(appReads()).toEqual([]);

    mockData.getCustomerContext.mockResolvedValue(context());
    fetchUpstream.mockResolvedValue(fail(422, "NOT_SUPPORTED"));
    expect(await render(Page)).toContain(en.apps.unavailable.off);
    fetchUpstream.mockResolvedValue(fail(500, "INTERNAL_ERROR"));
    const broken = await render(Page);
    expect(broken).toContain(en.shell.loadErrorTitle);
    expect(broken).not.toContain(en.apps.unavailable.title);
  });

  it.each([
    ["/apps", AppsPage],
    ["/apps/new", NewAppPage],
  ])("%s: a failed session read is the load error, not the «off» notice, and reads nothing", async (_path, Page) => {
    mockData.getCustomerContext.mockResolvedValue(context({ loadError: true, orgId: null, capabilities: null }));
    const h = await render(Page);
    expect(h).toContain(en.shell.loadErrorTitle);
    expect(h).not.toContain(en.apps.unavailable.title);
    expect(appReads()).toEqual([]);
  });

  it("the notice reads in Italian too", () => {
    const h = html(createElement(AppsUnavailable, { m: itMsgs, reason: "support" }), itMsgs);
    expect(h).toContain(itMsgs.apps.unavailable.title);
    expect(h).toContain(itMsgs.apps.unavailable.support);
    expect(h).toContain(itMsgs.apps.unavailable.back);
  });
});

describe("/apps — my applications", () => {
  it("lists each application with its status, version, address and update time", async () => {
    const sick = { ...STACK, id: "stk_b/2", name: "<b>sick</b>", status: "degraded", unhealthyCount: 1, primaryHostname: null } as const;
    answer({ [`v1/organizations/${ORG}/app-stacks`]: ok([STACK, sick]) });
    const h = await render(AppsPage);
    expect(fetchUpstream).toHaveBeenCalledWith(`v1/organizations/${ORG}/app-stacks`, expect.anything());
    expect(h).toContain(`<h1`);
    expect(h).toContain(en.apps.list.title);
    expect(h).toMatch(new RegExp(`<a[^>]*href="/apps/new"[^>]*>${en.apps.list.create}</a>`));
    for (const col of Object.values(en.apps.list.col)) expect(h).toContain(`>${col}</th>`);
    expect(h).toContain('href="/apps/stk_a1"');
    expect(h).toContain('href="/apps/stk_b%2F2"');
    expect(h).toContain("&lt;b&gt;sick&lt;/b&gt;");
    expect(h).toContain(`>${en.apps.status.running}<`);
    expect(h).toContain(`>${en.apps.status.degraded}<`);
    expect(h).toContain("Notes, version 2");
    expect(h).toContain("notes.example.test");
    expect(h).toContain(en.apps.list.noAddress);
    expect(h.match(/components need attention/g)).toEqual(["components need attention"]);
    expect(h).toContain("1 components need attention");
    expect(h).toContain(`<time dateTime="${NOW}">`);
    expect(h).not.toContain(en.apps.list.empty);
  });

  it("an empty list says so and still offers a new application", async () => {
    answer({ [`v1/organizations/${ORG}/app-stacks`]: ok([]) });
    const h = await render(AppsPage);
    expect(h).toContain(en.apps.list.empty);
    expect(h).toContain('href="/apps/new"');
    expect(h).not.toContain("<table");
  });
});

describe("/apps/new — the catalog", () => {
  const CATALOG = { templates: [NOTES, WORKER], categories: ["content", "odd-kind"] };

  it("shows the steps, the filter and one card per entry with resources, data, web and isolation", async () => {
    answer({ [`v1/organizations/${ORG}/app-templates`]: ok(CATALOG) });
    const h = await render(NewAppPage);
    expect(fetchUpstream).toHaveBeenCalledWith(`v1/organizations/${ORG}/app-templates`, expect.anything());
    expect(h).toContain(`aria-label="${en.apps.wizard.stepsLabel}"`);
    expect(h).toMatch(new RegExp(`<li[^>]*aria-current="step"[^>]*>${en.apps.wizard.step.choose}`));
    expect(h).toContain(en.apps.catalog.title);
    expect(h).toContain(`role="group" aria-label="${en.apps.catalog.filterLabel}"`);
    expect(h).toMatch(new RegExp(`aria-pressed="true"[^>]*>${en.apps.catalog.all}<`));
    expect(h).toMatch(new RegExp(`aria-pressed="false"[^>]*>${en.apps.category.content}<`));
    expect(h).toMatch(/aria-pressed="false"[^>]*>odd-kind</);

    expect(h).toMatch(/<h3[^>]*>Notes<\/h3>/);
    expect(h).toMatch(/<h3[^>]*>Worker<\/h3>/);
    expect(h).toContain("Shared notes for the team.");
    expect(h).toContain("2 components");
    expect(h).toContain("CPU 0.5 vCPU · Memory 256 MiB");
    expect(h).toContain("CPU 2 vCPU · Memory 1.5 GiB");
    expect(h).toContain(en.apps.catalog.keepsData);
    expect(h).toContain(en.apps.catalog.noData);
    expect(h).toContain(en.apps.catalog.web);
    expect(h).toContain(en.apps.catalog.noWeb);
    expect(h.split(en.apps.catalog.isolation)).toHaveLength(3);
    expect(h).toContain("Version 2");
    const choose = h.match(/<a[^>]*href="\/apps\/new\/atpl_notes"[^>]*>([^<]*)<\/a>/)!;
    expect(choose[1]).toBe(en.apps.catalog.choose);
    expect(choose[0]).toContain('aria-label="Choose Notes"');
    expect(h).toContain('href="/apps/new/atpl_worker"');
  });

  it("an empty catalog says so", async () => {
    answer({ [`v1/organizations/${ORG}/app-templates`]: ok({ templates: [], categories: [] }) });
    const h = await render(NewAppPage);
    expect(h).toContain(en.apps.catalog.empty);
    expect(h).toContain(en.apps.wizard.step.choose);
  });

  it("filterCatalog keeps one category, or all of them on null", () => {
    expect(filterCatalog([NOTES, WORKER], null)).toEqual([NOTES, WORKER]);
    expect(filterCatalog([NOTES, WORKER], "content")).toEqual([NOTES]);
    expect(filterCatalog([NOTES, WORKER], "games")).toEqual([]);
  });

  it("categoryLabel names a known category and shows any other as given", () => {
    expect(categoryLabel(en, "game-servers")).toBe(en.apps.category["game-servers"]);
    expect(categoryLabel(itMsgs, "content")).toBe(itMsgs.apps.category.content);
    expect(categoryLabel(en, "odd-kind")).toBe("odd-kind");
    expect(categoryLabel(en, "toString")).toBe("toString");
  });

  it("a filter button presses its category; the chosen one is pressed and filters the cards", () => {
    const props = { entries: [NOTES, WORKER], categories: CATALOG.categories };
    const { tree, sets } = callHooks(AppCatalog, props);
    const content = els(tree).find((e) => e.props["aria-pressed"] === false && e.props.children === en.apps.category.content)!;
    (content.props.onClick as () => void)();
    expect(sets).toEqual([[0, "content"]]);

    const chosen = html(callHooks(AppCatalog, props, { 0: "content" }).tree);
    expect(chosen).toMatch(new RegExp(`aria-pressed="true"[^>]*>${en.apps.category.content}<`));
    expect(chosen).toMatch(new RegExp(`aria-pressed="false"[^>]*>${en.apps.catalog.all}<`));
    expect(chosen).toContain(">Notes<");
    expect(chosen).not.toContain(">Worker<");

    expect(html(callHooks(AppCatalog, props, { 0: "games" }).tree)).toContain(en.apps.catalog.noMatch);
  });
});

describe("shared pieces", () => {
  it("WizardSteps marks the done steps with ✓ and words, and the current one with aria-current", () => {
    expect(WIZARD_STEPS).toEqual(["choose", "configure", "domains", "review", "install"]);
    for (const m of [en, itMsgs]) {
      const h = html(createElement(WizardSteps, { current: "domains" }), m);
      const items = [...h.matchAll(/<li([^>]*)>(.*?)<\/li>/g)];
      expect(h).toContain(`<ol aria-label="${m.apps.wizard.stepsLabel}"`);
      expect(items.map((i) => i[2]!.includes(m.apps.wizard.step[WIZARD_STEPS[items.indexOf(i)]!]))).toEqual([true, true, true, true, true]);
      expect(items.map((i) => i[1]!.includes('aria-current="step"'))).toEqual([false, false, true, false, false]);
      expect(items.map((i) => i[2]!.includes("✓") && i[2]!.includes(`<span class="sr-only">${m.apps.wizard.done}</span>`))).toEqual([true, true, false, false, false]);
    }
  });

  it("status and health badges are words from the catalog", () => {
    for (const status of APP_STACK_STATUSES) expect(html(createElement(StackStatusBadge, { status, m: en }))).toContain(`>${en.apps.status[status]}<`);
    for (const health of APP_STACK_COMPONENT_HEALTH) expect(html(createElement(HealthBadge, { health, m: itMsgs }), itMsgs)).toContain(`>${itMsgs.apps.health[health]}<`);
  });

  it("the not-found page links back to the applications", async () => {
    const h = html(await AppsNotFound());
    expect(h).toContain(en.apps.notFound.title);
    expect(h).toContain(en.apps.notFound.body);
    expect(h).toMatch(new RegExp(`<a[^>]*href="/apps"[^>]*>${en.apps.notFound.back}</a>`));
  });
});
