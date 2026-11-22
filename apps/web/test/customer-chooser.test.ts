import * as React from "react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomerAppTemplateSummaryDto, CustomerSiteTypeDto } from "@hosting-panel/contracts";

const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn() }));
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
}));

import { en } from "@/i18n/en";
import { format } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import NewAppPage from "@/app/apps/new/page";
import NewSitePage from "@/app/sites/new/page";
import { NewSite } from "@/components/customer/new-site";
import { SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { SiteTypeCards } from "@/components/customer/site-type-cards";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const ON = { applicationStacksAvailable: true };
const TYPES = `v1/organizations/${ORG}/site-types`;
const CATALOG = `v1/organizations/${ORG}/app-templates`;
const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: ON,
  support: null,
  ...over,
});
const type = (id: string, over: Partial<CustomerSiteTypeDto> = {}): CustomerSiteTypeDto => ({
  id, name: id, description: null, module: "wordpress", phpVersions: ["8.4"], defaultPhpVersion: "8.4", parameters: [], ...over,
});
const NOTES = {
  id: "atpl_notes", name: "Notes", description: null, category: "content", versionId: "atv_notes_1", versionNumber: 1,
  componentCount: 1, cpuMilli: 500, memoryBytes: String(2 ** 28), volumeCount: 0, hasIngress: true,
} satisfies CustomerAppTemplateSummaryDto;

const html = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node }))
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const appReads = () => fetchUpstream.mock.calls.map(([p]) => String(p)).filter((p) => p.includes("app-"));
const catalog = (templates: CustomerAppTemplateSummaryDto[]) => ok({ templates, categories: ["content"] });
const links = (h: string) => [...h.matchAll(/<a[^>]*href="([^"]*)"[^>]*>/g)].map((m) => m[1]);

beforeEach(() => {
  vi.clearAllMocks();
  mockData.getCustomerContext.mockResolvedValue(context());
});

describe("/apps/new — one choice goes straight to the WordPress form", () => {
  it("a support visit offers WordPress only and reads nothing", async () => {
    mockData.getCustomerContext.mockResolvedValue(context({ support: { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW } }));
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each([
    ["no type offered", ok({ siteTypes: [] })],
    ["one type", ok({ siteTypes: [type("stpl_a")] })],
    ["types unreadable", fail(500, "INTERNAL_ERROR")],
  ])("flag off, %s → redirect, no application read", async (_label, types) => {
    for (const capabilities of [{}, null, { applicationStacksAvailable: "true" }]) {
      mockData.getCustomerContext.mockResolvedValue(context({ capabilities }));
      answer({ [TYPES]: types, [CATALOG]: catalog([NOTES]) });
      await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    }
    expect(appReads()).toEqual([]);
  });

  it.each([
    ["an empty catalog", catalog([])],
    ["applications off on the server (422)", fail(422, "NOT_SUPPORTED")],
  ])("flag on, one type and %s → redirect", async (_label, entries) => {
    answer({ [TYPES]: ok({ siteTypes: [type("stpl_a")] }), [CATALOG]: entries });
    await expect(NewAppPage()).rejects.toThrow("REDIRECT /sites/new");
    expect(appReads()).toEqual([CATALOG]);
  });

  it("no organisation or a failed session read is the load error, not a redirect", async () => {
    for (const over of [{ orgId: null }, { loadError: true, orgId: null, capabilities: null }]) {
      mockData.getCustomerContext.mockResolvedValue(context(over));
      expect(html(await NewAppPage())).toContain(en.shell.loadErrorTitle);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("/apps/new — the chooser", () => {
  it("flag off with two types: the title and one card per type, no step strip, no application read", async () => {
    mockData.getCustomerContext.mockResolvedValue(context({ capabilities: {} }));
    answer({ [TYPES]: ok({ siteTypes: [type("stpl_a", { name: "Blog", description: "A blog." }), type("stpl_b/x", { name: "Shop" })] }) });
    const h = html(await NewAppPage());
    expect(h).toMatch(new RegExp(`<h1[^>]*>${en.apps.catalog.title}</h1>`));
    expect(h).toMatch(/<h3[^>]*>Blog<\/h3>/);
    expect(h).toContain("A blog.");
    expect(links(h)).toEqual(["/sites/new?type=stpl_a", "/sites/new?type=stpl_b%2Fx"]);
    expect(h).toContain(`aria-label="${format(en.apps.catalog.chooseNamed, { name: "Shop" })}"`);
    expect(h.split(`>${en.apps.list.wordpress}<`)).toHaveLength(3);
    expect(h).not.toContain(en.apps.wizard.stepsLabel);
    expect(h).not.toContain(en.apps.list.partial);
    expect(appReads()).toEqual([]);
  });

  it("one type and a published entry: the WordPress card first, then the catalog", async () => {
    answer({ [TYPES]: ok({ siteTypes: [type("stpl_a")] }), [CATALOG]: catalog([NOTES]) });
    const h = html(await NewAppPage());
    expect(links(h)).toEqual(["/sites/new?type=stpl_a", "/apps/new/atpl_notes"]);
    expect(h).toContain(`role="group" aria-label="${en.apps.catalog.filterLabel}"`);
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).not.toContain(en.apps.wizard.stepsLabel);
  });

  it("types unreadable: one generic WordPress card to the plain form", async () => {
    answer({ [CATALOG]: catalog([NOTES]) });
    const h = html(await NewAppPage());
    const card = h.match(/<a[^>]*href="\/sites\/new"[^>]*>([^<]*)<\/a>/)!;
    expect(card[1]).toBe(en.apps.catalog.choose);
    expect(card[0]).toContain(`aria-label="${format(en.apps.catalog.chooseNamed, { name: en.apps.list.wordpress })}"`);
    expect(links(h)).toEqual(["/sites/new", "/apps/new/atpl_notes"]);
  });

  it("a failed catalog read warns and still offers WordPress, never the load error", async () => {
    answer({ [TYPES]: ok({ siteTypes: [type("stpl_a")] }), [CATALOG]: fail(500, "INTERNAL_ERROR") });
    const h = html(await NewAppPage());
    expect(h).toContain(en.apps.list.partial);
    expect(h).toContain('role="alert"');
    expect(links(h)).toEqual(["/sites/new?type=stpl_a"]);
    expect(h).not.toContain(en.shell.loadErrorTitle);
  });

  it("shows the usage; at the limit the limit sentence replaces the WordPress cards, the catalog stays", async () => {
    const types = ok({ siteTypes: [type("stpl_a")] });
    answer({ [TYPES]: types, [CATALOG]: catalog([NOTES]), [`v1/organizations/${ORG}`]: ok({ maxSites: 3, siteCount: 1 }) });
    const free = html(await NewAppPage());
    expect(free).toMatch(new RegExp(`<p[^>]*data-site-usage[^>]*>${format(en.site.create.usage, { used: 1, max: 3 })}</p>`));
    expect(links(free)).toContain("/sites/new?type=stpl_a");

    answer({ [TYPES]: types, [CATALOG]: catalog([NOTES]), [`v1/organizations/${ORG}`]: ok({ maxSites: 3, siteCount: 3 }) });
    const full = html(await NewAppPage());
    expect(full).toContain(format(en.site.create.limitReached, { max: 3 }));
    expect(links(full)).toEqual(["/apps/new/atpl_notes"]);
  });
});

describe("SiteTypeCards", () => {
  it("a limit past the maximum is full too; no limit shows no usage line", () => {
    const over = html(createElement(SiteTypeCards, { m: en, types: [type("stpl_a")], limit: { used: 4, max: 2 } }));
    expect(over).toContain(format(en.site.create.limitReached, { max: 2 }));
    expect(links(over)).toEqual([]);
    const none = html(createElement(SiteTypeCards, { m: en, types: [null], limit: null }));
    expect(none).not.toContain("data-site-usage");
    expect(links(none)).toEqual(["/sites/new"]);
  });
});

describe("/sites/new?type= pre-selects a type", () => {
  const initial = async (searchParams?: Promise<{ type?: string | string[] }>) =>
    ((await NewSitePage(searchParams ? { searchParams } : undefined)) as ReactElement<{ initialTypeId: unknown }>).props.initialTypeId;

  it("a single value is passed on; an array or nothing is null", async () => {
    answer({ [TYPES]: ok({ siteTypes: [type("stpl_a"), type("stpl_b")] }) });
    expect(await initial(Promise.resolve({ type: "stpl_b" }))).toBe("stpl_b");
    expect(await initial(Promise.resolve({ type: ["stpl_a", "stpl_b"] }))).toBeNull();
    expect(await initial(Promise.resolve({}))).toBeNull();
    expect(await initial()).toBeNull();
    for (const [p] of fetchUpstream.mock.calls) expect(String(p)).not.toContain("stpl_b");
  });
});

describe("NewSite with a pre-selected type", () => {
  const internals = (React as unknown as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE!;
  const fetchMock = vi.fn();
  const formBody = { name: "a", domain: "a.test", title: "t", adminUser: "u", adminEmail: "u@a.test", adminPassword: "p".repeat(12), includeWww: false } as SiteFormBody;
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { siteId: "s1" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const posted = async (initialTypeId: string | null) => {
    const prev = internals.H;
    internals.H = {
      useState: (v: unknown) => [v, () => {}],
      useRef: (v: unknown) => ({ current: v }),
      useContext: () => ({ locale: "en", messages: en }),
    };
    let tree: ReactNode;
    try {
      tree = NewSite({ orgId: ORG, csrfToken: "csrf", siteTypes: [type("stpl_a"), type("stpl_b")], limit: null, initialTypeId });
    } finally {
      internals.H = prev;
    }
    const find = (node: unknown): ReactElement<{ onSubmit: (b: SiteFormBody) => Promise<void> }> | undefined => {
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      if (!React.isValidElement(node)) return undefined;
      if (node.type === SiteForm) return node as ReactElement<{ onSubmit: (b: SiteFormBody) => Promise<void> }>;
      return find((node.props as { children?: unknown }).children);
    };
    await find(tree)!.props.onSubmit(formBody);
    return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string) as Record<string, unknown>;
  };

  it("posts the pre-selected type; an id not offered falls back to the first", async () => {
    expect(await posted("stpl_b")).toMatchObject({ templateId: "stpl_b" });
    expect(await posted("stpl_gone")).toMatchObject({ templateId: "stpl_a" });
    expect(await posted(null)).toMatchObject({ templateId: "stpl_a" });
  });
});
