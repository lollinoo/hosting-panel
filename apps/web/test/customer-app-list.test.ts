import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStackSummaryDto, ManagedSiteDto, SiteSummaryDto } from "@hosting-panel/contracts";

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
}));

import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import type { Messages } from "@/i18n";
import AppsPage from "@/app/apps/page";
import { AppStackList } from "@/components/app-stacks/app-stack-list";

const NOW = "2026-11-22T10:00:00.000Z";
const ORG = "org_a1";
const STACKS = `v1/organizations/${ORG}/app-stacks`;
const ADDRESSES = `v1/organizations/${ORG}/managed-sites`;
const visit = { organizationId: ORG, organizationName: "Customer A", expiresAt: NOW };
const context = (over: Record<string, unknown> = {}) => ({
  session: { csrfToken: "csrf", user: { name: "Someone" } },
  orgId: ORG,
  loadError: false,
  capabilities: { applicationStacksAvailable: true },
  support: null,
  ...over,
});

const site = (id: string, name: string, over: Partial<SiteSummaryDto> = {}): SiteSummaryDto => ({
  id,
  organizationId: ORG,
  hostAllocationId: "alloc_1",
  name,
  slug: name.toLowerCase(),
  status: "ready",
  phpVersion: "8.3",
  siteType: "wordpress",
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const stack = (id: string, name: string, over: Partial<AppStackSummaryDto> = {}): AppStackSummaryDto => ({
  id,
  name,
  status: "running",
  templateId: "atpl_notes",
  templateName: "Notes",
  templateVersionNumber: 2,
  installed: null,
  componentCount: 2,
  unhealthyCount: 0,
  primaryHostname: "notes.example.test",
  updatedAt: NOW,
  ...over,
});
const managed = (s: SiteSummaryDto, primaryDomain: string | null): ManagedSiteDto => ({ ...s, primaryDomain });

const BLOG = site("site_b", "blog");
const SHOP = site("site_s", "Shop");
const NOTES = stack("stk_n", "Notes board");

const html = (node: ReactNode) => renderToStaticMarkup(node as never).replace(/&#x27;/g, "'");
const list = (props: { stacks?: AppStackSummaryDto[]; sites?: SiteSummaryDto[]; siteAddresses?: Record<string, string> }, m: Messages = en) =>
  html(createElement(AppStackList, { stacks: [], ...props, m, locale: m === en ? "en" : "it" }));
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data } });
const fail = (status: number, code: string) => ({ ok: false, status, error: { error: { code } } });
const answer = (byPath: Record<string, unknown>) =>
  fetchUpstream.mockImplementation(async (path: string) => byPath[path] ?? fail(404, "NOT_FOUND"));
const reads = () => fetchUpstream.mock.calls.map(([p]) => String(p));
const rows = (h: string) => [...h.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].slice(1).map((r) => [...r[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]!));
const page = async () => html(await AppsPage());
const DASH = '<span class="text-muted-foreground">—</span>';

beforeEach(() => {
  vi.clearAllMocks();
  mockData.getSites.mockResolvedValue([SHOP, BLOG]);
  mockData.getCustomerContext.mockResolvedValue(context());
  answer({ [STACKS]: ok([NOTES]), [ADDRESSES]: ok([managed(BLOG, "blog.example.test"), managed(SHOP, null)]) });
});

describe("the list of both kinds", () => {
  it("sorts sites and stacks together by name; a site row links its page, shows its status, «WordPress» and its address", () => {
    const h = list({ sites: [SHOP, BLOG], stacks: [NOTES], siteAddresses: { site_b: "blog.example.test" } });
    const r = rows(h);
    expect(r.map((c) => c[0]!.match(/>([^<]*)<\/a>/)![1])).toEqual(["blog", "Notes board", "Shop"]);
    expect(r[0]![0]).toContain('href="/sites/site_b"');
    expect(r[1]![0]).toContain('href="/apps/stk_n"');
    expect(r[0]![1]).toContain(`>${en.site.status.online}<`);
    expect(r[0]![2]).toBe(en.apps.list.wordpress);
    expect(r[1]![2]).toBe("Notes, version 2");
    expect(r[0]![3]).toBe("blog.example.test");
    expect(r[1]![3]).toBe("notes.example.test");
    expect(r[2]![3]).toBe(DASH);
    expect(r[0]![4]).toBe(`<time dateTime="${NOW}">${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(NOW))}</time>`);
  });

  it("a stack whose last change was not installed shows the version that runs", () => {
    const failed = stack("stk_f", "Notes board", { status: "failed", templateVersionNumber: 3, installed: { revisionNumber: 2, templateVersionNumber: 2 } });
    expect(rows(list({ stacks: [failed] }))[0]![2]).toBe("Notes, version 2");
    expect(rows(list({ stacks: [failed] }, itMsgs))[0]![2]).toBe("Notes, versione 2");
  });

  it("a site of no known kind shows a dash as its kind; ids are encoded in the site's link", () => {
    const r = rows(list({ sites: [site("a/b", "Legacy", { siteType: null, status: "stopped" })] }));
    expect(r[0]![0]).toContain('href="/sites/a%2Fb"');
    expect(r[0]![1]).toContain(`>${en.site.status.stopped}<`);
    expect(r[0]![2]).toBe(DASH);
    expect(r[0]![3]).toBe(DASH);
  });

  it("the third column is «Type» in English and «Tipo» in Italian", () => {
    expect(list({ sites: [BLOG] })).toContain(">Type</th>");
    const it_ = list({ sites: [BLOG] }, itMsgs);
    expect(it_).toContain(">Tipo</th>");
    expect(it_).toContain(`>${itMsgs.site.status.online}<`);
  });

  it("an empty list says so, with the administrator sentence, and has no table", () => {
    const h = list({});
    expect(h).toContain(`${en.apps.list.empty} ${en.shell.emptyBody}`);
    expect(h).not.toContain("<table");
  });
});

describe("/apps — the page", () => {
  it("reads sites, stacks and addresses, and shows both kinds with the site's address", async () => {
    const h = await page();
    expect(reads().sort()).toEqual([STACKS, ADDRESSES]);
    expect(mockData.getSites).toHaveBeenCalledWith(ORG);
    expect(h).toMatch(/<h1[^>]*>Your applications<\/h1>/);
    expect(h).toMatch(new RegExp(`<a[^>]*href="/apps/new"[^>]*>${en.apps.list.create}</a>`));
    const r = rows(h);
    expect(r.map((c) => c[0]!.match(/>([^<]*)<\/a>/)![1])).toEqual(["blog", "Notes board", "Shop"]);
    expect(r[0]![3]).toBe("blog.example.test");
    expect(r[2]![3]).toBe(DASH);
    expect(h).not.toContain(en.apps.list.partial);
  });

  it("a failed address read shows every site with a dash and no warning", async () => {
    answer({ [STACKS]: ok([NOTES]), [ADDRESSES]: fail(500, "INTERNAL_ERROR") });
    const h = await page();
    const r = rows(h);
    expect(r).toHaveLength(3);
    expect(r[0]![3]).toBe(DASH);
    expect(r[2]![3]).toBe(DASH);
    expect(h).not.toContain(en.apps.list.partial);
    expect(h).not.toContain(en.shell.loadErrorTitle);
  });

  it("flag off or a support visit: WordPress rows with their addresses, no notice, no application read", async () => {
    for (const over of [{ capabilities: {} }, { capabilities: null }, { capabilities: { applicationStacksAvailable: "true" } }, { support: visit }]) {
      fetchUpstream.mockClear();
      mockData.getCustomerContext.mockResolvedValue(context(over));
      const h = await page();
      expect(reads(), JSON.stringify(over)).toEqual([ADDRESSES]);
      expect(rows(h).map((c) => c[2])).toEqual([en.apps.list.wordpress, en.apps.list.wordpress]);
      expect(rows(h)[0]![3]).toBe("blog.example.test");
      expect(h).not.toContain(en.apps.unavailable.title);
      expect(h).not.toContain(en.apps.list.partial);
      expect(h).toContain('href="/apps/new"');
    }
  });

  it("stacks answered NOT_SUPPORTED count as the flag off: site rows, no warning", async () => {
    answer({ [STACKS]: fail(422, "NOT_SUPPORTED") });
    const h = await page();
    expect(rows(h)).toHaveLength(2);
    expect(h).not.toContain(en.apps.list.partial);
    expect(h).not.toContain(en.apps.unavailable.title);
  });

  it("one kind failing shows the other with a warning", async () => {
    answer({ [STACKS]: fail(500, "INTERNAL_ERROR") });
    let h = await page();
    expect(h).toMatch(new RegExp(`role="alert"[^>]*>.*${en.apps.list.partial}`));
    expect(rows(h).map((c) => c[2])).toEqual([en.apps.list.wordpress, en.apps.list.wordpress]);

    mockData.getSites.mockResolvedValue(null);
    answer({ [STACKS]: ok([NOTES]) });
    h = await page();
    expect(h).toContain(en.apps.list.partial);
    expect(rows(h).map((c) => c[2])).toEqual(["Notes, version 2"]);
  });

  it("a failure with no row read shows the warning only: no table, never «no applications»", async () => {
    answer({ [STACKS]: fail(500, "INTERNAL_ERROR") });
    mockData.getSites.mockResolvedValue([]);
    const h = await page();
    expect(h).toContain(en.apps.list.partial);
    expect(h).not.toContain("<table");
    expect(h).not.toContain(en.apps.list.empty);
    expect(h).toContain('href="/apps/new"');
  });

  it("both kinds failing, a failed session read or no organisation is the load error", async () => {
    mockData.getSites.mockResolvedValue(null);
    answer({ [STACKS]: fail(500, "INTERNAL_ERROR") });
    expect(await page()).toContain(en.shell.loadErrorTitle);

    mockData.getCustomerContext.mockResolvedValue(context({ capabilities: {} }));
    expect(await page()).toContain(en.shell.loadErrorTitle);

    for (const over of [{ loadError: true, orgId: null, capabilities: null }, { orgId: null }]) {
      fetchUpstream.mockClear();
      mockData.getCustomerContext.mockResolvedValue(context(over));
      const h = await page();
      expect(h).toContain(en.shell.loadErrorTitle);
      expect(reads()).toEqual([]);
    }
  });

  it("an empty account says so and offers a new application", async () => {
    mockData.getSites.mockResolvedValue([]);
    answer({ [STACKS]: ok([]) });
    const h = await page();
    expect(h).toContain(`${en.apps.list.empty} ${en.shell.emptyBody}`);
    expect(h).not.toContain(en.apps.list.partial);
    expect(h).toContain('href="/apps/new"');
  });
});
