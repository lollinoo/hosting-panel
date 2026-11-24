import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteDetailDto } from "@hosting-panel/contracts";

const mockData = vi.hoisted(() => ({ getCustomerContext: vi.fn(), getSite: vi.fn() }));
const mockApi = vi.hoisted(() => ({ serverGet: vi.fn(), fetchServerSiteDomains: vi.fn(), fetchServerOrgOperations: vi.fn() }));

vi.mock("@/lib/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/app/sites/data", () => mockData);
vi.mock("@/lib/server-api", () => mockApi);
vi.mock("@/i18n/server", () => ({ getRequestLocale: vi.fn(async () => "en") }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sites/site_t1",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

import { en } from "@/i18n/en";
import { I18nProvider } from "@/i18n/provider";
import SiteLayout from "@/app/sites/[siteId]/layout";
import SiteOverviewPage from "@/app/sites/[siteId]/page";
import { SiteProgress } from "@/components/customer/site-progress";
import { WEB_SITE_TYPES, findWebSiteType } from "@/site-types";

const render = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: element }));

const SITE = {
  id: "site_t1",
  organizationId: "org_t1",
  hostAllocationId: "alloc_t1",
  name: "Type Site",
  slug: "type-site",
  status: "ready",
  phpVersion: "8.4",
  siteType: "wordpress",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  services: [],
  domains: [{ id: "dom_t1", hostname: "wp-a.example.test", isPrimary: true, status: "active" }],
  driftSummary: { totalServices: 0, inSyncCount: 0, driftedCount: 0, unknownCount: 0, overallDriftStatus: "in_sync" },
} as unknown as SiteDetailDto;
const params = Promise.resolve({ siteId: "site_t1" });

async function layoutOf(site: SiteDetailDto, tools: boolean) {
  mockData.getCustomerContext.mockResolvedValue({
    orgId: "org_t1",
    session: { csrfToken: "csrf-t1" },
    loadError: false,
    capabilities: { wordpressToolsAvailable: tools },
  });
  mockData.getSite.mockResolvedValue({ ok: true, data: site });
  mockApi.fetchServerSiteDomains.mockResolvedValue(null);
  const html = render((await SiteLayout({ children: null, params })) as ReactElement);
  return { html, tabs: [...html.matchAll(/href="(\/sites\/[^"]+)"/g)].map((m) => m[1]) };
}

const GENERAL = ["/sites/site_t1/domains", "/sites/site_t1/files", "/sites/site_t1/database", "/sites/site_t1/backups", "/sites/site_t1/logs"];

describe("the site pages ask the site type", () => {
  afterEach(() => vi.clearAllMocks());

  it("a WordPress site with the tools has today's tabs in today's order and the WP Admin button", async () => {
    const { html, tabs } = await layoutOf(SITE, true);
    expect(tabs).toEqual(["/sites/site_t1", "/sites/site_t1/wordpress", ...GENERAL]);
    expect(html).toContain('href="http://wp-a.example.test/wp-admin/"');
    expect(html).toContain(en.site.wpAdmin);
  });

  it("without the tools there is no WordPress tab, and the button stays", async () => {
    const { html, tabs } = await layoutOf(SITE, false);
    expect(tabs).toEqual(["/sites/site_t1", ...GENERAL]);
    expect(html).toContain('href="http://wp-a.example.test/wp-admin/"');
  });

  it("a site without a type gets only the overview tab and no header button, and keeps its visit link (L49)", async () => {
    // The managed-site routes behind the other tabs answer 404 for it (ADR 0029 §2).
    const { html, tabs } = await layoutOf({ ...SITE, siteType: null }, true);
    expect(tabs).toEqual(["/sites/site_t1"]);
    expect(html).not.toContain("/wp-admin/");
    expect(html).not.toContain(en.site.wpAdmin);
    expect(html).toContain('href="http://wp-a.example.test"');
  });

  it("a site without a type gets no type card and no type request on the overview", async () => {
    mockData.getCustomerContext.mockResolvedValue({ orgId: "org_t1", session: { csrfToken: "csrf-t1" }, capabilities: { wordpressToolsAvailable: true } });
    mockData.getSite.mockResolvedValue({ ok: true, data: { ...SITE, siteType: null } });
    mockApi.fetchServerOrgOperations.mockResolvedValue([]);
    const html = render((await SiteOverviewPage({ params })) as ReactElement);
    expect(mockApi.serverGet).not.toHaveBeenCalled();
    expect(html).not.toContain(en.site.overview.wordpressTitle);
  });

  it("the progress steps of a WordPress site are today's", () => {
    const steps = WEB_SITE_TYPES.wordpress.progressSteps;
    expect(steps).toEqual(["create_database", "deploy_site", "install_wordpress", "publish_site", "finish"]);
    const html = render(createElement(SiteProgress, { orgId: "org_t1", siteId: "site_t1", csrfToken: "c", initial: null, steps }));
    const shown = [...html.matchAll(/<li[^>]*>[\s\S]*?<span[^>]*>([^<]*)<\/span><\/li>/g)].map((m) => m[1]);
    expect(shown).toEqual(steps.map((k) => en.site.progress[k]));
  });

  it("finds a type only by a known key", () => {
    expect(findWebSiteType("wordpress")).toBe(WEB_SITE_TYPES.wordpress);
    expect(findWebSiteType(null)).toBeNull();
    expect(findWebSiteType("unknown")).toBeNull();
  });
});
