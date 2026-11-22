import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { SITE_TEMPLATE_STRING_PARAMETER_MAX, SUPPORTED_PHP_VERSIONS, type CustomerSiteTypeDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getCustomerContext = vi.fn();
const fetchServerOrg = vi.fn();
const fetchServerCustomerSiteTypes = vi.fn();
vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: async () => ({ accessToken: "tok", csrfToken: "csrf" }),
}));
vi.mock("@/app/sites/data", () => ({ getCustomerContext: (...a: unknown[]) => getCustomerContext(...a) }));
vi.mock("@/lib/server-api", () => ({
  fetchServerOrg: (...a: unknown[]) => fetchServerOrg(...a),
  fetchServerCustomerSiteTypes: (...a: unknown[]) => fetchServerCustomerSiteTypes(...a),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { POST as createSite } from "@/app/api/bff/orgs/[orgId]/managed-sites/route";
import { POST as siteAction } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/actions/route";
import { NewSite, createErrorView, isLimitFull } from "@/components/customer/new-site";
import { SiteForm, buildParameterValues } from "@/components/customer/site-form";
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
const page = (m: Messages, locale: "en" | "it", limit: { used: number; max: number } | null, siteTypes: CustomerSiteTypeDto[] = []) =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, messages: m, children: createElement(NewSite, { orgId: "org-1", csrfToken: "csrf", siteTypes, limit }) }),
  ).replace(/&#x27;/g, "'");

const wordpress: CustomerSiteTypeDto = {
  id: "stpl_wordpress",
  name: "WordPress",
  description: null,
  module: "wordpress",
  phpVersions: ["8.3", "8.4", "8.5"],
  defaultPhpVersion: "8.4",
  parameters: [],
};
const shop: CustomerSiteTypeDto = {
  id: "stpl_shop",
  name: "Negozio online",
  description: "Per vendere i tuoi prodotti",
  module: "wordpress",
  phpVersions: ["8.3"],
  defaultPhpVersion: "8.3",
  parameters: [
    { key: "locale", label: "Lingua", type: "enum", options: ["it", "en"], default: "it" },
    { key: "workers", label: "Processi", type: "integer", min: 1, max: 8, default: 2 },
    { key: "cache", label: "Cache", type: "boolean", default: true },
    { key: "tagline", label: "Slogan", type: "string" },
    { key: "upload", label: "Limite di caricamento", type: "size", default: "64M" },
  ],
};
const blog: CustomerSiteTypeDto = { ...wordpress, id: "stpl_blog", name: "Blog", description: "Solo articoli", phpVersions: ["8.4", "8.5"], defaultPhpVersion: "8.5" };
const siteForm = (m: Messages, locale: "en" | "it", siteType?: CustomerSiteTypeDto | null) =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, messages: m, children: createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType }) }),
  ).replace(/&#x27;/g, "'");
const tag = (html: string, id: string) => new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
const optionValues = (html: string) => [...html.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);

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
    expect(page(itMsgs, "it", { used: 2, max: 5 })).toContain("2 di 5 applicazioni WordPress");
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

describe("NewSite when no site type is offered", () => {
  const none = (m: Messages, locale: "en" | "it", limit: { used: number; max: number } | null = null) =>
    renderToStaticMarkup(
      createElement(I18nProvider, {
        locale,
        messages: m,
        children: createElement(NewSite, { orgId: "org-1", csrfToken: "csrf", siteTypes: [], limit, noSiteTypes: true }),
      }),
    ).replace(/&#x27;/g, "'");

  it("shows a notice instead of the form", () => {
    for (const [locale, m] of locales) {
      const out = none(m, locale);
      expect(out).toContain(m.site.create.noSiteTypes);
      expect(out).toContain('role="status"');
      expect(out).toContain(m.site.create.title);
      expect(out).not.toContain("<form");
      expect(out).not.toContain(m.site.create.submit);
    }
  });

  it("the site limit message still comes first; without the flag an empty list keeps the form", () => {
    for (const [locale, m] of locales) {
      const full = none(m, locale, { used: 5, max: 5 });
      expect(full).toContain(format(m.site.create.limitReached, { max: 5 }));
      expect(full).not.toContain(m.site.create.noSiteTypes);
      expect(page(m, locale, null, [])).toContain("<form");
      expect(page(m, locale, null, [])).not.toContain(m.site.create.noSiteTypes);
    }
  });

  it("the copy keeps the customer vocabulary", () => {
    for (const m of [en, itMsgs]) expect(m.site.create.noSiteTypes).not.toMatch(/\b(container|image|docker|volume|network|revision|service|template|job|organization|organizzazione|servizio)\b/i);
  });
});

describe("NewSite and the site type chooser", () => {
  it("shows no chooser with no site type or with one, and the form keeps working", () => {
    for (const [locale, m] of locales) {
      for (const types of [[], [wordpress]]) {
        const out = page(m, locale, null, types);
        expect(out).not.toContain('name="site-type"');
        expect(out).not.toContain(m.site.create.siteTypeLabel);
        expect(out).toContain("<form");
      }
    }
  });

  it("shows one radio per site type with two or more, the first one checked, name and description as given", () => {
    for (const [locale, m] of locales) {
      const out = page(m, locale, null, [wordpress, shop, blog]);
      expect([...out.matchAll(/<input[^>]*name="site-type"[^>]*>/g)]).toHaveLength(3);
      expect(out).toContain(m.site.create.siteTypeLabel);
      expect(out).toContain(m.site.create.siteTypeHint);
      expect(out).toContain("Negozio online");
      expect(out).toContain("Per vendere i tuoi prodotti");
      expect(/<input[^>]*value="stpl_wordpress"[^>]*>/.exec(out)![0]).toContain("checked");
      expect(/<input[^>]*value="stpl_shop"[^>]*>/.exec(out)![0]).not.toContain("checked");
    }
  });

  it("renders the first site type's options and PHP choice, and a full limit hides the chooser with the form", () => {
    for (const [locale, m] of locales) {
      expect(page(m, locale, null, [shop, wordpress])).toContain('id="site-param-locale"');
      const full = page(m, locale, { used: 5, max: 5 }, [wordpress, shop]);
      expect(full).not.toContain('name="site-type"');
      expect(full).not.toContain("<form");
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

  it("an unknown site type refreshes the list and gets its own sentence, but only when a site type was sent", () => {
    for (const [, m] of locales) {
      expect(createErrorView(m, "NOT_FOUND", [], true)).toEqual({ error: m.site.create.siteTypeUnavailable, fieldErrors: {}, refresh: true });
      expect(createErrorView(m, "NOT_FOUND", [], false)).toEqual({ error: m.errors.NOT_FOUND, fieldErrors: {}, refresh: false });
      expect(createErrorView(m, "NOT_FOUND", [])).toEqual({ error: m.errors.NOT_FOUND, fieldErrors: {}, refresh: false });
      expect(createErrorView(m, "PERMISSION_DENIED", [], true).error).toBe(m.errors.PERMISSION_DENIED);
    }
  });

  it("a refused option is shown under its own control, keyed param:<key>", () => {
    for (const [, m] of locales) {
      expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "parameters.locale" }, { field: "phpVersion" }], true, ["locale"])).toEqual({
        error: null,
        fieldErrors: { "param:locale": m.site.create.fieldInvalid, phpVersion: m.site.create.fieldInvalid },
        refresh: false,
      });
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
      expect(view(m, "VALIDATION_ERROR")).toEqual({ error: m.site.create.invalid, fieldErrors: {}, refresh: false });
      expect(view(m, "PERMISSION_DENIED").error).toBe(m.errors.PERMISSION_DENIED);
      expect(view(m, "").error).toBe(m.errors.generic);
    }
  });
});

describe("createErrorView: a refusal always shows something", () => {
  it("a field with no control (array index, unknown option, includeWww) adds the general sentence to the field errors", () => {
    for (const [, m] of locales) {
      for (const field of ["parameters.0.value", "parameters.gone", "includeWww", "templateId"]) {
        const v = createErrorView(m, "VALIDATION_ERROR", [{ field }], true, ["locale"]);
        expect(v.error).toBe(m.site.create.invalid);
        expect(v.refresh).toBe(false);
      }
      // One field that is shown does not excuse another that is not.
      expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "adminEmail" }, { field: "parameters.0.value" }]).error).toBe(m.site.create.invalid);
    }
  });

  it("fields the form renders (its inputs, the PHP select, a declared option) need no general sentence", () => {
    for (const [, m] of locales) {
      const fields = ["name", "domain", "title", "adminUser", "adminEmail", "adminPassword", "phpVersion", "parameters.locale"].map((field) => ({ field }));
      expect(createErrorView(m, "VALIDATION_ERROR", fields, true, ["locale"]).error).toBeNull();
    }
  });

  it("an archived or invalid site type is permanent: its own sentence and a refresh, not 'retry'", () => {
    for (const [, m] of locales) {
      for (const reason of ["template_archived", "template_invalid"]) {
        for (const sent of [true, false]) {
          expect(createErrorView(m, "RESOURCE_LOCKED", [{ reason }], sent)).toEqual({ error: m.site.create.siteTypeUnavailable, fieldErrors: {}, refresh: true });
        }
      }
      expect(createErrorView(m, "RESOURCE_LOCKED", [{ reason: "built_in" }], true)).toEqual({ error: m.errors.RESOURCE_LOCKED, fieldErrors: {}, refresh: false });
      expect(createErrorView(m, "RESOURCE_LOCKED", [])).toEqual({ error: m.errors.RESOURCE_LOCKED, fieldErrors: {}, refresh: false });
    }
  });

  it("a shown option, or the PHP choice, that the server now refuses as unknown, admin-only or not applicable means the options changed under the form: its own sentence and a refresh", () => {
    for (const [, m] of locales) {
      const changed = { error: m.site.create.optionsChanged, fieldErrors: {}, refresh: true };
      for (const reason of ["unknown", "not_customer"]) {
        // "locale" is an option this form shows: it must not be left as a note under a control that can never pass.
        expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "parameters.locale", reason }], true, ["locale"])).toEqual(changed);
      }
      // The type is still offered: its sentence must not say it is unavailable, and must say what to do.
      expect(m.site.create.optionsChanged).not.toBe(m.site.create.siteTypeUnavailable);
      expect(m.site.create.optionsChanged).not.toMatch(/amministratore|administrator|non è disponibile|not available/i);
      // The PHP choice became administrator-only or was removed: a retry can never pass either.
      for (const reason of ["not_customer", "not_applicable"]) {
        expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "phpVersion", reason }], true, ["locale"])).toEqual(changed);
      }
      // A value problem stays a note under its control; the same reasons on another field, or under another code, are not this case.
      expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "parameters.locale", reason: "not_in_options" }], true, ["locale"])).toEqual({
        error: null,
        fieldErrors: { "param:locale": m.site.create.fieldInvalid },
        refresh: false,
      });
      // An unknown or unsupported PHP version stays the note under the select.
      for (const reason of ["not_in_options", "invalid_type", "out_of_range", "unknown"]) {
        expect(createErrorView(m, "VALIDATION_ERROR", [{ field: "phpVersion", reason }], true, ["locale"])).toEqual({
          error: null,
          fieldErrors: { phpVersion: m.site.create.fieldInvalid },
          refresh: false,
        });
      }
      expect(createErrorView(m, "NOT_FOUND", [{ field: "parameters.locale", reason: "unknown" }], false).refresh).toBe(false);
    }
  });

  it("the general sentences never point at highlighted fields that are not there, and never send a single-type customer to a chooser that is not there", () => {
    for (const [, m] of locales) {
      // When nothing is highlighted, the sentence names the form's fields instead.
      expect(m.site.create.invalid).not.toMatch(/evidenzia|highlight/i);
      expect(m.site.create.siteTypeUnavailable).not.toMatch(/scegline|un altro|another|choose/i);
      expect(m.site.create.siteTypeUnavailable).toMatch(/amministratore|administrator/i);
    }
  });

  it("template_unavailable (the built-in is off) gets the site type sentence even when no site type was sent", () => {
    for (const [, m] of locales) {
      expect(createErrorView(m, "NOT_FOUND", [{ field: "templateId", reason: "template_unavailable" }], false)).toEqual({
        error: m.site.create.siteTypeUnavailable,
        fieldErrors: {},
        refresh: true,
      });
      expect(createErrorView(m, "NOT_FOUND", [{ reason: "something_else" }], false).error).toBe(m.errors.NOT_FOUND);
    }
  });
});

describe("SiteForm shows what createErrorView maps", () => {
  const withErrors = (m: Messages, locale: "en" | "it", siteType: CustomerSiteTypeDto, fieldErrors: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(I18nProvider, { locale, messages: m, children: createElement(SiteForm, { onSubmit: () => {}, submitting: false, siteType, fieldErrors }) }),
    ).replace(/&#x27;/g, "'");

  it("a refused PHP version is written under the select, which is opened so the note is visible", () => {
    for (const [locale, m] of locales) {
      const quiet = withErrors(m, locale, blog, {});
      expect(quiet).toMatch(/<p id="site-php-note"[^>]*><\/p>/);
      expect(quiet).not.toMatch(/<details[^>]*\sopen/);
      expect(tag(quiet, "site-php")).not.toContain("aria-invalid");

      const out = withErrors(m, locale, blog, { phpVersion: m.site.create.fieldInvalid });
      expect(out).toMatch(/<details[^>]*\sopen/);
      expect(out).toContain(`<p id="site-php-note" class="text-xs text-destructive">${m.site.create.fieldInvalid}</p>`);
      expect(tag(out, "site-php")).toContain('aria-invalid="true"');
      expect(tag(out, "site-php")).toContain('aria-describedby="site-php-note"');
    }
  });

  it("every mapped field error of a refusal is on the page, or the general sentence is", () => {
    for (const [locale, m] of locales) {
      const keys = shop.parameters.map((p) => p.key);
      for (const field of ["phpVersion", "parameters.tagline", "adminEmail", "parameters.0.value", "parameters.gone"]) {
        const v = createErrorView(m, "VALIDATION_ERROR", [{ field }], true, keys);
        const out = withErrors(m, locale, { ...shop, phpVersions: ["8.3", "8.4"] }, v.fieldErrors);
        const shown = out.includes(`text-destructive">${m.site.create.fieldInvalid}</p>`);
        expect(shown || v.error !== null, field).toBe(true);
        // ... and the general sentence is the one that carries the unshown ones.
        expect(shown && v.error !== null, field).toBe(false);
      }
    }
  });

  it("a text or size option cannot be longer than the API accepts; a number has no length limit", () => {
    for (const [locale, m] of locales) {
      const out = siteForm(m, locale, shop);
      expect(tag(out, "site-param-tagline")).toContain(`maxLength="${SITE_TEMPLATE_STRING_PARAMETER_MAX}"`);
      expect(tag(out, "site-param-upload")).toContain(`maxLength="${SITE_TEMPLATE_STRING_PARAMETER_MAX}"`);
      expect(tag(out, "site-param-workers")).not.toContain("maxLength");
    }
  });
});

describe("SiteForm and the site type options", () => {
  it("without a site type the form is the legacy one: every supported PHP version, the recommended one marked, no options", () => {
    for (const [locale, m] of locales) {
      for (const out of [siteForm(m, locale), siteForm(m, locale, null)]) {
        expect(optionValues(out)).toEqual([...SUPPORTED_PHP_VERSIONS]);
        expect(out).toContain(`8.4 (${m.site.create.recommended})`);
        expect(out).not.toContain(m.site.create.options);
        expect(out).not.toContain("site-param-");
      }
    }
  });

  it("a site type with a PHP choice lists its versions and marks its default", () => {
    for (const [locale, m] of locales) {
      const out = siteForm(m, locale, blog);
      expect(optionValues(out)).toEqual(["8.4", "8.5"]);
      expect(out).toContain(`8.5 (${m.site.create.recommended})`);
      expect(out).not.toContain(`8.4 (${m.site.create.recommended})`);
    }
  });

  it("a site type with a single PHP version offers no PHP choice", () => {
    for (const [locale, m] of locales) {
      const out = siteForm(m, locale, shop);
      expect(out).not.toContain('id="site-php"');
      expect(siteForm(m, locale, { ...shop, parameters: [], phpVersions: [], defaultPhpVersion: null })).not.toContain("<details");
    }
  });

  it("renders one control per option under the options heading, with the label, default and limits", () => {
    for (const [locale, m] of locales) {
      const out = siteForm(m, locale, shop);
      expect(out).toContain(m.site.create.options);
      for (const label of ["Lingua", "Processi", "Cache", "Slogan", "Limite di caricamento"]) expect(out).toContain(label);
      expect(out).toMatch(/<select[^>]*id="site-param-locale"/);
      expect(optionValues(out)).toEqual(["it", "en"]);
      const workers = tag(out, "site-param-workers");
      expect(workers).toContain('type="number"');
      expect(workers).toContain('min="1"');
      expect(workers).toContain('max="8"');
      expect(workers).toContain('step="1"');
      expect(workers).toContain('value="2"');
      const cache = tag(out, "site-param-cache");
      expect(cache).toContain('type="checkbox"');
      expect(cache).toContain("checked");
      expect(tag(out, "site-param-tagline")).toContain('type="text"');
      expect(tag(out, "site-param-upload")).toContain('value="64M"');
      for (const key of ["locale", "workers", "cache", "tagline", "upload"]) expect(out).toContain(`id="site-param-${key}-note"`);
    }
  });
});

describe("buildParameterValues", () => {
  const defs = shop.parameters;

  it("sends the shown value of every option, in order, converted to its type", () => {
    expect(buildParameterValues(defs, { locale: "en", workers: "4", cache: false, tagline: "  Ciao  ", upload: "128M" })).toEqual([
      { key: "locale", value: "en" },
      { key: "workers", value: 4 },
      { key: "cache", value: false },
      { key: "tagline", value: "Ciao" },
      { key: "upload", value: "128M" },
    ]);
  });

  it("falls back to the default of an option nobody touched and omits an option with neither", () => {
    expect(buildParameterValues(defs, {})).toEqual([
      { key: "locale", value: "it" },
      { key: "workers", value: 2 },
      { key: "cache", value: true },
      { key: "upload", value: "64M" },
    ]);
    expect(buildParameterValues(defs, { workers: "", upload: "   " }).map((e) => e.key)).toEqual(["locale", "workers", "cache", "upload"]);
  });

  it("a blank number or text falls back to the default (or is left out), a ticked box is true and an untouched one without default false", () => {
    expect(buildParameterValues([{ key: "n", label: "N", type: "integer" }], { n: "" })).toEqual([]);
    expect(buildParameterValues([{ key: "b", label: "B", type: "boolean" }], {})).toEqual([{ key: "b", value: false }]);
    expect(buildParameterValues([{ key: "b", label: "B", type: "boolean" }], { b: true })).toEqual([{ key: "b", value: true }]);
    expect(buildParameterValues([{ key: "e", label: "E", type: "enum", options: ["x", "y"] }], {})).toEqual([{ key: "e", value: "x" }]);
  });

  it("never sends the PHP version as an option, and has nothing to send without options", () => {
    expect(buildParameterValues([{ key: "php_version", label: "PHP", type: "enum", options: ["8.4"], default: "8.4" }], {})).toEqual([]);
    expect(buildParameterValues([], { locale: "en" })).toEqual([]);
  });
});

describe("new site page", () => {
  beforeEach(() => {
    getCustomerContext.mockReset();
    fetchServerOrg.mockReset();
    fetchServerCustomerSiteTypes.mockReset();
    fetchServerCustomerSiteTypes.mockResolvedValue({ siteTypes: [] });
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
  });
  const limitOf = async () => ((await NewSitePage()) as { props: { limit: unknown } }).props.limit;
  const typesOf = async () => ((await NewSitePage()) as { props: { siteTypes: unknown } }).props.siteTypes;

  it("passes the site types of the organisation to the form", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: null, siteCount: 0 });
    fetchServerCustomerSiteTypes.mockResolvedValue({ siteTypes: [wordpress, shop] });
    expect(await typesOf()).toEqual([wordpress, shop]);
    expect(fetchServerCustomerSiteTypes).toHaveBeenCalledWith("org-1");
  });

  it("site types that cannot be read (null, rejected, missing) leave the form with no chooser, and the limit still arrives", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: 5, siteCount: 3 });
    for (const read of [() => fetchServerCustomerSiteTypes.mockResolvedValue(null), () => fetchServerCustomerSiteTypes.mockRejectedValue(new Error("boom")), () => fetchServerCustomerSiteTypes.mockResolvedValue(undefined)]) {
      read();
      expect(await typesOf()).toEqual([]);
      expect(await limitOf()).toEqual({ used: 3, max: 5 });
    }
  });

  it("tells the form when the list was read and is empty, never when the read failed or something is offered", async () => {
    const flag = async () => ((await NewSitePage()) as { props: { noSiteTypes: unknown } }).props.noSiteTypes;
    fetchServerOrg.mockResolvedValue({ maxSites: null, siteCount: 0 });
    fetchServerCustomerSiteTypes.mockResolvedValue({ siteTypes: [] });
    expect(await flag()).toBe(true);
    fetchServerCustomerSiteTypes.mockResolvedValue({ siteTypes: [wordpress] });
    expect(await flag()).toBe(false);
    for (const read of [() => fetchServerCustomerSiteTypes.mockResolvedValue(null), () => fetchServerCustomerSiteTypes.mockRejectedValue(new Error("boom")), () => fetchServerCustomerSiteTypes.mockResolvedValue(undefined)]) {
      read();
      expect(await flag()).toBe(false);
    }
  });

  it("a rejected organisation read does not hide the site types", async () => {
    fetchServerOrg.mockRejectedValue(new Error("boom"));
    fetchServerCustomerSiteTypes.mockResolvedValue({ siteTypes: [wordpress] });
    expect(await limitOf()).toBeNull();
    expect(await typesOf()).toEqual([wordpress]);
  });

  it("a redirect thrown by the site types read (dead session) is not swallowed", async () => {
    fetchServerOrg.mockResolvedValue({ maxSites: null, siteCount: 0 });
    fetchServerCustomerSiteTypes.mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }));
    await expect(NewSitePage()).rejects.toThrow("NEXT_REDIRECT");
  });

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
    expect(fetchServerCustomerSiteTypes).not.toHaveBeenCalled();
  });

  it("without an organisation it goes back to /apps before reading anything", async () => {
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: null });
    await expect(NewSitePage()).rejects.toThrow("REDIRECT:/apps");
    expect(fetchServerOrg).not.toHaveBeenCalled();
    expect(fetchServerCustomerSiteTypes).not.toHaveBeenCalled();
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

  it("the site type copy has no infrastructure word, in any language", () => {
    const banned = /\b(container|image|docker|volume|network|revision|service|template|mariadb|job|organization|organizzazione|servizio)\b/i;
    for (const [, m] of locales) {
      const c = m.site.create;
      for (const text of [c.siteTypeLabel, c.siteTypeHint, c.options, c.siteTypeUnavailable]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toMatch(banned);
      }
    }
  });
});
