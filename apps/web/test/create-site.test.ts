import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getCustomerContext = vi.fn();
const fetchServerOrg = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("@/app/sites/data", () => ({ getCustomerContext: (...a: unknown[]) => getCustomerContext(...a) }));
vi.mock("@/lib/server-api", () => ({ fetchServerOrg: (...a: unknown[]) => fetchServerOrg(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { POST as createSite } from "@/app/api/bff/orgs/[orgId]/managed-sites/route";
import { POST as siteAction } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/actions/route";
import { EmptySites } from "@/components/customer/empty-sites";
import { NewSite, createErrorView, isLimitFull } from "@/components/customer/new-site";
import NewSitePage from "@/app/sites/new/page";

const request = (url: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", ...headers },
    body: JSON.stringify({ name: "Hotel" }),
  });

describe("managed-sites BFF", () => {
  beforeEach(() => fetchUpstream.mockReset());

  it("requires an idempotency key and forwards to the API", async () => {
    const params = { params: Promise.resolve({ orgId: "org-1" }) };
    expect((await createSite(request("/api/bff/orgs/org-1/managed-sites"), params)).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();

    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: { data: { siteId: "s1", operationId: "o1" } } });
    const res = await createSite(request("/api/bff/orgs/org-1/managed-sites", { "Idempotency-Key": "k1" }), params);
    expect(res.status).toBe(202);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites",
      expect.objectContaining({ method: "POST", idempotencyKey: "k1", accessToken: "tok" }),
    );
  });

  it("forwards site actions with the same key", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: {} });
    const params = { params: Promise.resolve({ orgId: "org-1", siteId: "s1" }) };
    await siteAction(request("/x", { "Idempotency-Key": "k2" }), params);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites/s1/actions",
      expect.objectContaining({ idempotencyKey: "k2" }),
    );
  });
});

describe("create-site UI", () => {
  it("empty state links to /sites/new", () => {
    for (const m of [en, itMsgs]) {
      expect(renderToStaticMarkup(createElement(EmptySites, { m }))).toContain('href="/sites/new"');
    }
  });

  it("new customer copy has no infrastructure vocabulary", () => {
    const banned = /\b(container|image|docker|volume|network|revision|service|template|mariadb|job|organization|organizzazione|servizio)\b/i;
    for (const m of [en, itMsgs]) {
      const copy = JSON.stringify([m.site.create, m.site.progress, m.site.wpAdmin, m.shell.emptyTitle, m.shell.emptyBody, m.shell.emptyCta, m.shell.newSite]);
      expect(copy).not.toMatch(banned);
    }
  });
});

const locales = [
  ["en", en],
  ["it", itMsgs],
] as const;
const page = (m: Messages, locale: "en" | "it", limit: { used: number; max: number } | null) =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, messages: m, children: createElement(NewSite, { orgId: "org-1", csrfToken: "csrf", limit }) }),
  ).replace(/&#x27;/g, "'");

describe("isLimitFull", () => {
  it("is true at the limit, past it (lowered below usage) and for a limit of 0", () => {
    expect(isLimitFull(null)).toBe(false);
    expect(isLimitFull({ used: 2, max: 5 })).toBe(false);
    expect(isLimitFull({ used: 4, max: 5 })).toBe(false);
    expect(isLimitFull({ used: 5, max: 5 })).toBe(true);
    expect(isLimitFull({ used: 7, max: 5 })).toBe(true);
    expect(isLimitFull({ used: 0, max: 0 })).toBe(true);
  });
});

describe("NewSite and the site limit", () => {
  it("shows the form and no usage line without a limit", () => {
    for (const [locale, m] of locales) {
      const out = page(m, locale, null);
      expect(out).toContain("<form");
      expect(out).not.toContain("data-site-usage");
      expect(out).not.toContain(format(m.site.create.usage, { used: 0, max: 0 }));
    }
  });

  it("shows how many sites are used while there is room, and keeps the form", () => {
    for (const [locale, m] of locales) {
      const out = page(m, locale, { used: 2, max: 5 });
      expect(out).toContain("data-site-usage");
      expect(out).toContain(format(m.site.create.usage, { used: 2, max: 5 }));
      expect(out).toContain("<form");
      expect(out).not.toContain(format(m.site.create.limitReached, { max: 5 }));
    }
    expect(page(itMsgs, "it", { used: 2, max: 5 })).toContain("2 di 5 siti");
  });

  it("at the limit it explains why and shows no form", () => {
    for (const [locale, m] of locales) {
      for (const limit of [{ used: 5, max: 5 }, { used: 7, max: 5 }, { used: 0, max: 0 }]) {
        const out = page(m, locale, limit);
        expect(out).toContain(format(m.site.create.limitReached, { max: limit.max }));
        expect(out).toContain(format(m.site.create.usage, limit));
        expect(out).toContain('role="status"');
        expect(out).not.toContain("<form");
        expect(out).not.toContain(m.site.create.submit);
        expect(out).toContain(m.site.create.title);
      }
    }
  });
});

describe("createErrorView", () => {
  const view = (m: Messages, code: string, details: { field?: string; reason?: string }[] = []) => createErrorView(m, code, details);

  it("the site limit gets its own sentence and refreshes the page so the full state appears", () => {
    for (const [, m] of locales) {
      expect(view(m, "QUOTA_EXCEEDED", [{ field: "sites", reason: "site_limit_reached" }])).toEqual({
        error: m.site.create.limitReachedSubmit,
        fieldErrors: {},
        refresh: true,
      });
    }
  });

  it("another quota refusal, or the reason under another code, is the generic text and no refresh", () => {
    for (const [, m] of locales) {
      for (const [code, details] of [
        ["QUOTA_EXCEEDED", [{ reason: "something_else" }]],
        ["QUOTA_EXCEEDED", []],
        ["VALIDATION_ERROR", [{ reason: "site_limit_reached" }]],
      ] as const) {
        const v = view(m, code, [...details]);
        expect(v.refresh).toBe(false);
        expect(v.error).not.toBe(m.site.create.limitReachedSubmit);
      }
      expect(view(m, "QUOTA_EXCEEDED").error).toBe(m.errors.generic);
    }
  });

  it("keeps the existing mapping: domain conflict, invalid fields by their last path part, anything else", () => {
    for (const [, m] of locales) {
      expect(view(m, "DOMAIN_CONFLICT")).toEqual({ error: null, fieldErrors: { domain: m.site.create.domainConflict }, refresh: false });
      expect(view(m, "VALIDATION_ERROR", [{ field: "body.adminEmail" }, { field: "phpVersion" }, {}])).toEqual({
        error: null,
        fieldErrors: { adminEmail: m.site.create.fieldInvalid, phpVersion: m.site.create.fieldInvalid },
        refresh: false,
      });
      expect(view(m, "VALIDATION_ERROR")).toEqual({ error: m.errors.VALIDATION_ERROR, fieldErrors: {}, refresh: false });
      expect(view(m, "PERMISSION_DENIED").error).toBe(m.errors.PERMISSION_DENIED);
      expect(view(m, "").error).toBe(m.errors.generic);
    }
  });
});

describe("new site page", () => {
  beforeEach(() => {
    getCustomerContext.mockReset();
    fetchServerOrg.mockReset();
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
  });
  const limitOf = async () => ((await NewSitePage()) as { props: { limit: unknown } }).props.limit;

  it("passes the organisation's usage and limit to the form", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: 5, siteCount: 3 });
    expect(await limitOf()).toEqual({ used: 3, max: 5 });
    expect(fetchServerOrg).toHaveBeenCalledWith("org-1");
  });

  it("a limit of 0 and a count past the limit are passed as they are", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: 0, siteCount: 0 });
    expect(await limitOf()).toEqual({ used: 0, max: 0 });
    fetchServerOrg.mockResolvedValue({ maxSites: 2, siteCount: 4 });
    expect(await limitOf()).toEqual({ used: 4, max: 2 });
  });

  it("no limit, an unreadable organisation or a failing read never blocks creating a site", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: null, siteCount: 3 });
    expect(await limitOf()).toBeNull();
    // An API that does not know the field yet (older release) is unlimited as well.
    fetchServerOrg.mockResolvedValue({ siteCount: 3 });
    expect(await limitOf()).toBeNull();
    fetchServerOrg.mockResolvedValue(null);
    expect(await limitOf()).toBeNull();
    fetchServerOrg.mockRejectedValue(new Error("boom"));
    expect(await limitOf()).toBeNull();
  });

  it("a redirect thrown by the read (dead session) is not swallowed", async () => {
    fetchServerOrg.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }));
    await expect(NewSitePage()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("a support visit has no organization.read permission, so the page does not read the organisation", async () => {
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1", support: { organizationId: "org-1" } });
    fetchServerOrg.mockResolvedValue({ maxSites: 5, siteCount: 3 });
    expect(await limitOf()).toBeNull();
    expect(fetchServerOrg).not.toHaveBeenCalled();
  });

  it("without an organisation it goes back to /sites before reading anything", async () => {
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: null });
    await expect(NewSitePage()).rejects.toThrow("REDIRECT:/sites");
    expect(fetchServerOrg).not.toHaveBeenCalled();
  });
});

describe("site limit customer copy", () => {
  it("never uses the infrastructure words, and carries the placeholders the code fills", () => {
    const banned = /\b(container|image|docker|volume|network|revision|service|template|mariadb|job|organization|organizzazione|servizio)\b/i;
    for (const [, m] of locales) {
      const c = m.site.create;
      expect(JSON.stringify([c.usage, c.limitReached, c.limitReachedSubmit])).not.toMatch(banned);
      expect(c.usage).toContain("{used}");
      expect(c.usage).toContain("{max}");
      expect(c.limitReached).toContain("{max}");
      expect(c.limitReachedSubmit).not.toContain("{");
    }
  });
});
