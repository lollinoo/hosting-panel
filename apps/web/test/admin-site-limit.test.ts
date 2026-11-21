import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/sites",
}));

import AdminSitesPage from "@/app/admin/sites/page";
import { CustomerSiteLimits, parseSiteLimit, siteUsageText, type SiteLimitCustomer } from "@/components/admin/customer-site-limits";
import { adminSiteErrorText } from "@/components/admin/change-owner-dialog";

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;

const html = (m: Messages, node: ReactElement, locale: "en" | "it" = "en") =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: m, children: node })).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const customer = (over: Partial<SiteLimitCustomer> & { name: string }): SiteLimitCustomer => ({
  organizationId: `org_${over.name.toLowerCase()}`,
  ownerEmail: `${over.name.toLowerCase()}@example.test`,
  maxSites: 5,
  siteCount: 3,
  ...over,
});

const ACME = customer({ name: "Acme", maxSites: 5, siteCount: 3 });
const FULL = customer({ name: "Fullco", maxSites: 2, siteCount: 2 });
const OVER = customer({ name: "Overco", maxSites: 1, siteCount: 3 });
const NONE = customer({ name: "Zeroco", maxSites: 0, siteCount: 0 });
const FREE = customer({ name: "Freeco", maxSites: null, siteCount: 4 });

describe("parseSiteLimit", () => {
  it("reads a whole number from 0 up", () => {
    expect(parseSiteLimit("5", false)).toBe(5);
    expect(parseSiteLimit("0", false)).toBe(0);
    expect(parseSiteLimit(" 12 ", false)).toBe(12);
    expect(parseSiteLimit("10000", false)).toBe(10_000);
  });

  it("unlimited is null whatever the field holds", () => {
    expect(parseSiteLimit("", true)).toBeNull();
    expect(parseSiteLimit("abc", true)).toBeNull();
  });

  it("anything else is invalid, including what the contract refuses", () => {
    for (const input of ["", "  ", "-1", "1.5", "abc", "1e2", "+3", "0x10", "10001", "99999999999999999999"]) {
      expect(parseSiteLimit(input, false), input).toBe("invalid");
    }
  });
});

describe("siteUsageText", () => {
  it("shows used of max, or used with no limit", () => {
    for (const [, m] of locales) {
      const t = m.admin.sites.customers;
      expect(siteUsageText(t, 3, 5)).toBe(format(t.usage, { used: 3, max: 5 }));
      expect(siteUsageText(t, 4, null)).toBe(format(t.usageUnlimited, { used: 4 }));
      expect(siteUsageText(t, 0, 0)).toBe(format(t.usage, { used: 0, max: 0 }));
    }
    expect(siteUsageText(itMsgs.admin.sites.customers, 3, 5)).toBe("3 di 5");
    expect(siteUsageText(itMsgs.admin.sites.customers, 4, null)).toBe("4 (nessun limite)");
    expect(siteUsageText(en.admin.sites.customers, 3, 5)).toBe("3 of 5");
  });
});

describe("CustomerSiteLimits", () => {
  it("renders nothing without customers", () => {
    for (const [locale, m] of locales) expect(html(m, createElement(CustomerSiteLimits, { customers: [], csrfToken: "csrf" }), locale)).toBe("");
  });

  it("lists every customer with its usage in both languages", () => {
    for (const [locale, m] of locales) {
      const t = m.admin.sites.customers;
      const out = html(m, createElement(CustomerSiteLimits, { customers: [ACME, FREE], csrfToken: "csrf" }), locale);
      expect(out).toContain(t.title);
      expect(out).toContain(t.intro);
      for (const head of [t.colCustomer, t.colSites, t.colActions]) expect(out).toContain(head);
      expect(out).toContain("Acme");
      expect(out).toContain("acme@example.test");
      expect(out).toContain(siteUsageText(t, 3, 5));
      expect(out).toContain(siteUsageText(t, 4, null));
    }
  });

  it("marks only the customers whose count has reached the limit", () => {
    for (const [locale, m] of locales) {
      const full = m.admin.sites.customers.full;
      const count = (customers: SiteLimitCustomer[]) =>
        html(m, createElement(CustomerSiteLimits, { customers, csrfToken: "csrf" }), locale).split(full).length - 1;
      expect(count([ACME, FREE])).toBe(0);
      expect(count([ACME, FULL, FREE])).toBe(1);
      // Lowered below usage, or a limit of zero, is full as well.
      expect(count([OVER, NONE, ACME])).toBe(2);
    }
  });

  it("gives each edit button a label naming the customer", () => {
    for (const [locale, m] of locales) {
      const t = m.admin.sites.customers;
      const out = html(m, createElement(CustomerSiteLimits, { customers: [ACME, FULL], csrfToken: "csrf" }), locale);
      expect(out).toContain(`aria-label="${format(t.editAria, { name: "Acme" })}"`);
      expect(out).toContain(`aria-label="${format(t.editAria, { name: "Fullco" })}"`);
      expect(out.split(`>${t.edit}<`).length - 1).toBe(2);
    }
  });

  it("keeps the edit form closed until a customer is picked", () => {
    const out = html(en, createElement(CustomerSiteLimits, { customers: [ACME], csrfToken: "csrf" }));
    expect(out).not.toContain("site-limit-max");
    expect(out).not.toContain("site-limit-unlimited");
  });
});

describe("/admin/sites page", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    getRequestLocale.mockReset();
    getServerSession.mockResolvedValue({ csrfToken: "csrf", user: { isServerAdmin: true } });
    getRequestLocale.mockResolvedValue("en");
  });

  const list = (customers: SiteLimitCustomer[]) => ({
    ok: true,
    status: 200,
    data: { data: { sites: [], customers, certificateAlerts: [] } },
  });
  const render = async (customers: SiteLimitCustomer[]) => {
    fetchUpstream.mockResolvedValue(list(customers));
    return html(en, (await AdminSitesPage({ searchParams: Promise.resolve({}) })) as ReactElement);
  };

  it("shows the customers card above the sites when there are customers", async () => {
    const out = await render([ACME, FULL]);
    expect(out).toContain(en.admin.sites.customers.title);
    expect(out).toContain(siteUsageText(en.admin.sites.customers, 2, 2));
    expect(out.indexOf(en.admin.sites.customers.title)).toBeLessThan(out.indexOf(en.admin.sites.empty));
  });

  it("shows no card without customers, and none when the list cannot be loaded", async () => {
    expect(await render([])).not.toContain(en.admin.sites.customers.title);
    fetchUpstream.mockResolvedValue({ ok: false, status: 500 });
    const out = html(en, (await AdminSitesPage({ searchParams: Promise.resolve({}) })) as ReactElement);
    expect(out).toContain(en.admin.sites.loadError);
    expect(out).not.toContain(en.admin.sites.customers.title);
  });

  it("an unauthenticated visit goes to the login before anything is read", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(AdminSitesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("REDIRECT:/login");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("adminSiteErrorText", () => {
  it("names the site limit when the API refuses for it", () => {
    for (const [, m] of locales) {
      expect(adminSiteErrorText(m, { code: "QUOTA_EXCEEDED", reason: "site_limit_reached" })).toBe(m.admin.sites.limitReached);
    }
  });

  it("any other refusal keeps its generic text", () => {
    for (const [, m] of locales) {
      // QUOTA_EXCEEDED has no sentence of its own in the shared catalog: without the reason it is the generic one.
      expect(adminSiteErrorText(m, { code: "QUOTA_EXCEEDED" })).toBe(m.errors.generic);
      expect(adminSiteErrorText(m, { code: "QUOTA_EXCEEDED", reason: "other" })).toBe(m.errors.generic);
      expect(adminSiteErrorText(m, { code: "VALIDATION_ERROR", reason: "site_limit_reached" })).toBe(m.errors.VALIDATION_ERROR);
      expect(adminSiteErrorText(m, { code: "NOPE" })).toBe(m.errors.generic);
      expect(adminSiteErrorText(m, { code: "" })).toBe(m.errors.generic);
    }
  });
});

describe("site limit copy", () => {
  it("has the admin sentences in both languages, with the placeholders the code fills", () => {
    for (const [, m] of locales) {
      const t = m.admin.sites.customers;
      expect(m.admin.sites.limitReached.length).toBeGreaterThan(20);
      expect(t.usage).toContain("{used}");
      expect(t.usage).toContain("{max}");
      expect(t.usageUnlimited).toContain("{used}");
      expect(t.editAria).toContain("{name}");
      expect(t.editTitle).toContain("{name}");
      expect(t.belowUsage).toContain("{name}");
      expect(t.belowUsage).toContain("{used}");
      expect(t.belowUsage).toContain("{max}");
      for (const key of ["title", "intro", "colCustomer", "colSites", "colActions", "full", "edit", "maxLabel", "unlimitedLabel", "invalid", "save", "saving", "cancel"] as const) {
        expect(t[key].length, key).toBeGreaterThan(0);
      }
    }
  });
});
