import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CreateSiteDatabaseRequestSchema,
  CreateSiteDatabaseUserRequestSchema,
  type SiteDatabasesDto,
} from "@hosting-panel/contracts";
import { errorMessage, format } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { SITE_TABS } from "@/components/customer/site-tabs";
import { formatSize } from "@/lib/file-browser";
import {
  PHPMYADMIN_OPEN_TIMEOUT_MS,
  AddDatabaseNameFormView,
  DatabaseAccessForm,
  DatabasePasswordResult,
  DeleteDatabaseForm,
  DeleteDatabaseUserForm,
  ResetDatabasePasswordForm,
  SiteDatabases,
  databaseErrorText,
  diffDatabaseAccess,
  fetchSiteDatabasesState,
  isValidDatabaseSuffix,
  openPhpMyAdmin,
  postDatabaseName,
  resolveDatabaseFailureText,
  setDatabaseAccess,
  toAddDatabaseNameError,
} from "@/components/customer/site-databases";

const PREFIX = "wp_0123456789ab";
const BASE = "/api/bff/orgs/org-1/managed-sites/site-1";

function decodeHtml(s: string): string {
  return s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function renderEn(node: React.ReactElement) {
  return decodeHtml(
    renderToStaticMarkup(createElement(I18nProvider, { locale: "en", messages: en, children: node }))
  );
}

function renderIt(node: React.ReactElement) {
  return decodeHtml(
    renderToStaticMarkup(createElement(I18nProvider, { locale: "it", messages: itMsgs, children: node }))
  );
}

function collectStrings(o: unknown): string[] {
  if (typeof o === "string") return [o];
  if (typeof o === "object" && o !== null) {
    return Object.values(o).flatMap(collectStrings);
  }
  return [];
}

function makeDto(overrides: Partial<SiteDatabasesDto> = {}): SiteDatabasesDto {
  return {
    prefix: PREFIX,
    databases: [
      { name: PREFIX, sizeBytes: 12_582_912, primary: true },
      { name: `${PREFIX}_shop`, sizeBytes: 1_048_576, primary: false },
    ],
    users: [
      { name: PREFIX, databases: [PREFIX], primary: true },
      { name: `${PREFIX}_reader`, databases: [`${PREFIX}_shop`], primary: false },
    ],
    limits: { databases: 10, users: 10 },
    phpMyAdminAvailable: true,
    ...overrides,
  };
}

describe("site databases UI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("places database tab between files and backups", () => {
    expect(SITE_TABS.map((t) => t.key)).toEqual(["overview", "domains", "files", "database", "backups", "logs"]);
    const dbTab = SITE_TABS.find((t) => t.key === "database");
    expect(dbTab?.href("site-42")).toBe("/sites/site-42/database");
  });

  it("validates database and user name suffixes against the shared pattern", () => {
    expect(isValidDatabaseSuffix("a")).toBe(true);
    expect(isValidDatabaseSuffix("1")).toBe(true);
    expect(isValidDatabaseSuffix("shop_1")).toBe(true);
    expect(isValidDatabaseSuffix("a".repeat(16))).toBe(true);

    expect(isValidDatabaseSuffix("")).toBe(false);
    expect(isValidDatabaseSuffix("_shop")).toBe(false);
    expect(isValidDatabaseSuffix("a-b")).toBe(false);
    expect(isValidDatabaseSuffix("Shop")).toBe(false);
    expect(isValidDatabaseSuffix("a b")).toBe(false);
    expect(isValidDatabaseSuffix("a'b")).toBe(false);
    expect(isValidDatabaseSuffix("a".repeat(17))).toBe(false);
  });

  it("maps every site database error code in both English and Italian", () => {
    const codes = [
      "QUOTA_EXCEEDED",
      "ALREADY_EXISTS",
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "RESOURCE_LOCKED",
      "DOCKER_ENGINE_UNAVAILABLE",
      "OPERATION_AMBIGUOUS",
      "NOT_SUPPORTED",
      "ORGANIZATION_SUSPENDED",
      "UNAUTHENTICATED",
      "popupBlocked",
    ] as const;

    for (const code of codes) {
      const enText = databaseErrorText(en, code);
      const itText = databaseErrorText(itMsgs, code);
      expect(enText.length, `en:${code}`).toBeGreaterThan(0);
      expect(itText.length, `it:${code}`).toBeGreaterThan(0);
      expect(enText, `distinct:${code}`).not.toBe(en.errors.generic);
      expect(itText, `distinct it:${code}`).not.toBe(itMsgs.errors.generic);
      expect(enText).not.toBe(itText);
    }

    expect(databaseErrorText(en, "UNKNOWN_CODE")).toBe(en.errors.generic);
    expect(databaseErrorText(itMsgs, undefined)).toBe(itMsgs.errors.generic);
    expect(toAddDatabaseNameError(en, "database", "ALREADY_EXISTS")).toBe(en.site.database.errors.ALREADY_EXISTS);
  });

  it("posts new database and user suffixes with CSRF header and schema-valid body", async () => {
    const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ""),
        });
        return new Response(
          JSON.stringify({
            data:
              String(input).endsWith("/database-users")
                ? { user: { name: `${PREFIX}_reader`, databases: [], primary: false }, temporaryPassword: "pw1" }
                : { database: { name: `${PREFIX}_shop`, sizeBytes: 0, primary: false } },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const dbRes = await postDatabaseName(BASE, "database", "shop", "csrf-1");
    expect(dbRes.ok).toBe(true);
    if (dbRes.ok) expect(dbRes.data.database.name).toBe(`${PREFIX}_shop`);
    expect(calls[0]!.url).toBe(`${BASE}/databases`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("X-CSRF-Token")).toBe("csrf-1");
    expect(() => CreateSiteDatabaseRequestSchema.parse(JSON.parse(calls[0]!.body))).not.toThrow();

    const userRes = await postDatabaseName(BASE, "user", "reader", "csrf-2");
    expect(userRes.ok).toBe(true);
    if (userRes.ok) {
      expect(userRes.data.user.name).toBe(`${PREFIX}_reader`);
      expect(userRes.data.temporaryPassword).toBe("pw1");
    }
    expect(calls[1]!.url).toBe(`${BASE}/database-users`);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.headers.get("X-CSRF-Token")).toBe("csrf-2");
    expect(() => CreateSiteDatabaseUserRequestSchema.parse(JSON.parse(calls[1]!.body))).not.toThrow();
  });

  it("sends PUT and DELETE on database grant endpoint via setDatabaseAccess", async () => {
    const calls: Array<{ url: string; method: string; csrf: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), method: init?.method ?? "GET", csrf: headers.get("X-CSRF-Token") });
        return new Response(null, { status: 204 });
      })
    );

    const grantRes = await setDatabaseAccess(BASE, `${PREFIX}_reader`, PREFIX, true, "csrf-g");
    expect(grantRes).toEqual({ ok: true, status: 204, data: undefined });
    expect(calls[0]).toEqual({
      url: `${BASE}/database-users/${PREFIX}_reader/grants/${PREFIX}`,
      method: "PUT",
      csrf: "csrf-g",
    });

    const revokeRes = await setDatabaseAccess(BASE, `${PREFIX}_reader`, `${PREFIX}_shop`, false, "csrf-g");
    expect(revokeRes).toEqual({ ok: true, status: 204, data: undefined });
    expect(calls[1]).toEqual({
      url: `${BASE}/database-users/${PREFIX}_reader/grants/${PREFIX}_shop`,
      method: "DELETE",
      csrf: "csrf-g",
    });

    expect(diffDatabaseAccess([PREFIX, `${PREFIX}_a`], [PREFIX, `${PREFIX}_b`])).toEqual({
      toGrant: [`${PREFIX}_b`],
      toRevoke: [`${PREFIX}_a`],
    });
  });

  it("handles openPhpMyAdmin for blocked popup, success, and upstream/network errors with 130s timeout", async () => {
    expect(PHPMYADMIN_OPEN_TIMEOUT_MS).toBe(130_000);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // 1. Blocked popup
    const blocked = await openPhpMyAdmin(BASE, "csrf-pma", null);
    expect(blocked).toEqual({ ok: false, code: "popupBlocked" });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Success clears opener and navigates window
    const closeOk = vi.fn();
    const okWin = { opener: { postMessage: vi.fn() } as unknown, location: { href: "about:blank" }, close: closeOk };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { url: "/phpmyadmin/site-1/?token=abc" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const success = await openPhpMyAdmin(BASE, "csrf-pma", okWin);
    expect(success).toEqual({ ok: true });
    expect(okWin.opener).toBeNull();
    expect(okWin.location.href).toBe("/phpmyadmin/site-1/?token=abc");
    expect(closeOk).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE}/databases/phpmyadmin`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-pma" }),
      })
    );
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === 130_000)).toBe(true);

    // 3. Error closes window and surfaces error code
    const closeErr = vi.fn();
    const errWin = { opener: {} as unknown, location: { href: "about:blank" }, close: closeErr };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "DOCKER_ENGINE_UNAVAILABLE", message: "down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );
    const fail = await openPhpMyAdmin(BASE, "csrf-pma", errWin);
    expect(fail).toEqual({ ok: false, status: 503, code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(closeErr).toHaveBeenCalledTimes(1);
    expect(errWin.location.href).toBe("about:blank");

    // 4. Network rejection closes window
    const closeNet = vi.fn();
    const netWin = { opener: {} as unknown, location: { href: "about:blank" }, close: closeNet };
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    const netFail = await openPhpMyAdmin(BASE, "csrf-pma", netWin);
    expect(netFail.ok).toBe(false);
    expect(closeNet).toHaveBeenCalledTimes(1);

    // 5. 409 RESOURCE_LOCKED explains why and says to wait a minute and try again
    const close409 = vi.fn();
    const lockWin = { opener: {} as unknown, location: { href: "about:blank" }, close: close409 };
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "RESOURCE_LOCKED", message: "locked" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    );
    const lockFail = await openPhpMyAdmin(BASE, "csrf-pma", lockWin);
    expect(lockFail).toEqual({ ok: false, status: 409, code: "RESOURCE_LOCKED" });
    if (!lockFail.ok) {
      const lockText = databaseErrorText(en, lockFail.code);
      expect(lockText).toMatch(/wait a minute and try again/i);
      expect(lockText).not.toMatch(/updating your site|site is being updated/i);
    }
  });

  it("shows DOCKER_ENGINE_UNAVAILABLE instead of list-updated copy when reload fails too after an unclear result", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Both the mutation (502 OPERATION_AMBIGUOUS) and the list reload (503) fail
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "OPERATION_AMBIGUOUS", message: "ambiguous" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "DOCKER_ENGINE_UNAVAILABLE", message: "down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    const failRes = await postDatabaseName(BASE, "database", "shop", "csrf-1");
    expect(failRes.ok).toBe(false);
    if (!failRes.ok) {
      const msg = await resolveDatabaseFailureText(
        en,
        failRes.status,
        failRes.code,
        async () => (await fetchSiteDatabasesState(BASE)) !== null
      );
      expect(msg).toBe(en.site.database.errors.DOCKER_ENGINE_UNAVAILABLE);
      expect(msg).toMatch(/wait a minute and try again/i);
      expect(msg).not.toMatch(/list has been updated/i);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`${BASE}/databases`);

    // When reload succeeds, OPERATION_AMBIGUOUS is preserved
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "OPERATION_AMBIGUOUS", message: "ambiguous" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            prefix: PREFIX,
            databases: [{ name: PREFIX, primary: true, sizeBytes: 100 }],
            users: [{ name: PREFIX, primary: true, databases: [PREFIX] }],
            limits: { databases: 10, users: 10 },
            phpMyAdminAvailable: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const secondRes = await postDatabaseName(BASE, "database", "shop", "csrf-1");
    expect(secondRes.ok).toBe(false);
    if (!secondRes.ok) {
      const msg = await resolveDatabaseFailureText(
        en,
        secondRes.status,
        secondRes.code,
        async () => (await fetchSiteDatabasesState(BASE)) !== null
      );
      expect(msg).toBe(en.site.database.errors.OPERATION_AMBIGUOUS);
    }
  });

  it("keeps the partial prefix when grant saving partially succeeds and reload fails", async () => {
    const partialMsg = await resolveDatabaseFailureText(
      en,
      503,
      "DOCKER_ENGINE_UNAVAILABLE",
      async () => false,
      en.site.database.users.grants.partial
    );
    expect(partialMsg).toBe(
      `${en.site.database.users.grants.partial} ${en.site.database.errors.DOCKER_ENGINE_UNAVAILABLE}`
    );

    const noPrefixMsg = await resolveDatabaseFailureText(
      en,
      503,
      "DOCKER_ENGINE_UNAVAILABLE",
      async () => false
    );
    expect(noPrefixMsg).toBe(en.site.database.errors.DOCKER_ENGINE_UNAVAILABLE);
  });

  it("renders AddDatabaseNameFormView with prefix in front of input and aria-invalid only for name errors", () => {
    const validHtml = renderEn(
      createElement(AddDatabaseNameFormView, {
        kind: "database",
        prefix: PREFIX,
        value: "shop",
        error: null,
        busy: false,
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      })
    );
    expect(validHtml).toContain(`${PREFIX}_`);
    expect(validHtml.indexOf(`${PREFIX}_`)).toBeLessThan(validHtml.indexOf("<input"));
    expect(validHtml).toContain(`${PREFIX}_shop`);
    expect(validHtml).not.toContain('aria-invalid="true"');

    const nonNameErrHtml = renderEn(
      createElement(AddDatabaseNameFormView, {
        kind: "database",
        prefix: PREFIX,
        value: "shop",
        error: en.site.database.errors.DOCKER_ENGINE_UNAVAILABLE,
        busy: false,
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      })
    );
    expect(nonNameErrHtml).toContain(en.site.database.errors.DOCKER_ENGINE_UNAVAILABLE);
    expect(nonNameErrHtml).not.toContain('aria-invalid="true"');

    const validationErrHtml = renderEn(
      createElement(AddDatabaseNameFormView, {
        kind: "user",
        prefix: PREFIX,
        value: "Shop",
        error: en.site.database.errors.VALIDATION_ERROR,
        busy: false,
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      })
    );
    expect(validationErrHtml).toContain('aria-invalid="true"');
    expect(validationErrHtml).toContain(en.site.database.errors.VALIDATION_ERROR);
  });

  it("renders primary rows without action buttons, formats sizes, and disables Add only at 10 extra items", () => {
    const html = renderEn(
      createElement(SiteDatabases, {
        siteId: "site-1",
        orgId: "org-1",
        initial: makeDto(),
        csrfToken: "csrf",
      })
    );

    expect(html).toContain(en.site.database.primaryBadge);
    expect(html).toContain(formatSize(12_582_912, "en"));
    expect(html).toContain(formatSize(1_048_576, "en"));

    const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? "");
    const primaryRows = rowMatches.filter((r) => r.includes(en.site.database.primaryBadge));
    expect(primaryRows.length).toBe(2);
    for (const row of primaryRows) {
      expect(row).not.toContain("<button");
    }

    const customDbRow = rowMatches.find((r) => r.includes(`${PREFIX}_shop`) && r.includes(formatSize(1_048_576, "en")));
    expect(customDbRow).toContain("<button");
    expect(customDbRow).toContain(en.site.database.databases.remove.action);

    // At 9 custom + 1 primary = 10 total rows, Add button is NOT disabled
    const nineCustom = makeDto({
      databases: [
        { name: PREFIX, sizeBytes: 100, primary: true },
        ...Array.from({ length: 9 }, (_, i) => ({ name: `${PREFIX}_d${i}`, sizeBytes: 0, primary: false })),
      ],
    });
    const underLimitHtml = renderEn(
      createElement(SiteDatabases, { siteId: "site-1", orgId: "org-1", initial: nineCustom, csrfToken: "csrf" })
    );
    expect(underLimitHtml).not.toContain(format(en.site.database.databases.limit, { max: 10 }));

    // At 10 custom + 1 primary = 11 total rows, Add button is disabled and shows limit text
    const tenCustom = makeDto({
      databases: [
        { name: PREFIX, sizeBytes: 100, primary: true },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `${PREFIX}_d${i}`, sizeBytes: 0, primary: false })),
      ],
      users: [
        { name: PREFIX, databases: [PREFIX], primary: true },
        ...Array.from({ length: 10 }, (_, i) => ({ name: `${PREFIX}_u${i}`, databases: [], primary: false })),
      ],
    });
    const atLimitHtml = renderEn(
      createElement(SiteDatabases, { siteId: "site-1", orgId: "org-1", initial: tenCustom, csrfToken: "csrf" })
    );
    expect(atLimitHtml).toContain(format(en.site.database.databases.limit, { max: 10 }));
    expect(atLimitHtml).toContain(format(en.site.database.users.limit, { max: 10 }));
    const addDbBtnMatch = atLimitHtml.match(
      new RegExp(`<button[^>]*>${en.site.database.databases.add}<\\/button>`)
    );
    expect(addDbBtnMatch?.[0]).toContain("disabled");
  });

  it("renders phpMyAdmin section according to phpMyAdminAvailable capability", () => {
    const availableHtml = renderEn(
      createElement(SiteDatabases, {
        siteId: "site-1",
        orgId: "org-1",
        initial: makeDto({ phpMyAdminAvailable: true }),
        csrfToken: "csrf",
      })
    );
    expect(availableHtml).toContain(en.site.database.phpmyadmin.heading);
    expect(availableHtml).toContain(en.site.database.phpmyadmin.body);
    expect(availableHtml).toContain(en.site.database.phpmyadmin.warning);
    expect(availableHtml).toContain(en.site.database.phpmyadmin.importNote);
    expect(availableHtml).toContain(en.site.database.phpmyadmin.open);

    const unavailableHtml = renderEn(
      createElement(SiteDatabases, {
        siteId: "site-1",
        orgId: "org-1",
        initial: makeDto({ phpMyAdminAvailable: false }),
        csrfToken: "csrf",
      })
    );
    expect(unavailableHtml).toContain(en.site.database.phpmyadmin.unavailable);
    expect(unavailableHtml).not.toMatch(new RegExp(`<button\\b[^>]*>${en.site.database.phpmyadmin.open}`));
  });

  it("renders destructive confirmations naming consequences, temp password once, and grant fieldset", () => {
    const delDb = renderEn(
      createElement(DeleteDatabaseForm, {
        databaseName: `${PREFIX}_shop`,
        error: null,
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    expect(delDb).toContain(`${PREFIX}_shop`);
    expect(delDb).toContain(format(en.site.database.databases.remove.body, { name: `${PREFIX}_shop` }));

    const delUser = renderEn(
      createElement(DeleteDatabaseUserForm, {
        userName: `${PREFIX}_reader`,
        error: null,
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    expect(delUser).toContain(`${PREFIX}_reader`);
    expect(delUser).toContain(format(en.site.database.users.remove.body, { name: `${PREFIX}_reader` }));

    const resetPw = renderEn(
      createElement(ResetDatabasePasswordForm, {
        userName: `${PREFIX}_reader`,
        error: null,
        busy: false,
        onConfirm: () => {},
        onCancel: () => {},
      })
    );
    expect(resetPw).toContain(en.site.database.users.reset.body);

    const pwResult = renderEn(
      createElement(DatabasePasswordResult, {
        userName: `${PREFIX}_reader`,
        temporaryPassword: "TempPassword#123",
        onDone: () => {},
      })
    );
    expect(pwResult).toContain("TempPassword#123");
    expect(pwResult).toContain(en.site.database.users.created.copy);
    expect(pwResult).toContain(en.site.database.users.created.tempOnce);

    const accessHtml = renderIt(
      createElement(DatabaseAccessForm, {
        userName: `${PREFIX}_reader`,
        databases: [
          { name: PREFIX, sizeBytes: 100, primary: true },
          { name: `${PREFIX}_shop`, sizeBytes: 0, primary: false },
        ],
        selected: [PREFIX],
        error: null,
        busy: false,
        onToggle: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      })
    );
    expect(accessHtml).toContain("<fieldset");
    expect(accessHtml).toContain("<legend");
    expect(accessHtml).toContain('type="checkbox"');
    expect(accessHtml).toContain(itMsgs.site.database.primaryBadge);
  });

  it("handles server page states cleanly and omits internal infrastructure jargon", async () => {
    const serverGetMock = vi.fn();
    const notFoundMock = vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    vi.doMock("@/app/sites/data", () => ({
      getCustomerContext: vi.fn(async () => ({
        session: { csrfToken: "csrf-srv", user: { locale: "en" } },
        orgId: "org-1",
        loadError: false,
      })),
      getSite: vi.fn(async () => ({ ok: true, data: { id: "site-1", name: "My Site" } })),
    }));
    vi.doMock("@/i18n/server", () => ({
      getRequestLocale: vi.fn(async () => "en"),
    }));
    vi.doMock("@/lib/server-api", () => ({
      serverGet: serverGetMock,
    }));
    vi.doMock("next/navigation", () => ({
      notFound: notFoundMock,
    }));

    const { SiteDatabasePage } = await import("@/app/sites/[siteId]/database/page");
    const params = Promise.resolve({ siteId: "site-1" });

    // 200 success calls serverGet with 20s timeout
    serverGetMock.mockResolvedValueOnce({ ok: true, data: makeDto() });
    const page200 = renderEn(await SiteDatabasePage({ params }));
    expect(serverGetMock).toHaveBeenCalledWith("v1/organizations/org-1/managed-sites/site-1/databases", {
      timeoutMs: 20_000,
    });
    expect(page200).toContain(PREFIX);

    // 403 permission denied
    serverGetMock.mockResolvedValueOnce({ ok: false, outcome: "error", status: 403, code: "PERMISSION_DENIED" });
    const page403 = renderEn(await SiteDatabasePage({ params }));
    expect(page403).toContain(errorMessage(en, "PERMISSION_DENIED"));

    // 403 organization suspended
    serverGetMock.mockResolvedValueOnce({
      ok: false,
      outcome: "error",
      status: 403,
      code: "ORGANIZATION_SUSPENDED",
    });
    const pageSusp = renderEn(await SiteDatabasePage({ params }));
    expect(pageSusp).toContain(en.site.database.errors.ORGANIZATION_SUSPENDED);

    // 422 not supported
    serverGetMock.mockResolvedValueOnce({ ok: false, outcome: "error", status: 422, code: "NOT_SUPPORTED" });
    const page422 = renderEn(await SiteDatabasePage({ params }));
    expect(page422).toContain(en.site.database.unavailable);

    // 503 load failed
    serverGetMock.mockResolvedValueOnce({ ok: false, outcome: "error", status: 503, code: "SERVICE_UNAVAILABLE" });
    const page503 = renderEn(await SiteDatabasePage({ params }));
    expect(page503).toContain(en.site.database.loadFailed);

    // 404 notFound
    serverGetMock.mockResolvedValueOnce({ ok: false, outcome: "notFound" });
    await expect(SiteDatabasePage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();

    // Jargon guard across catalog and rendered output
    const jargonRe = /\b(docker|container|image|volume|network|revision)\b/i;
    for (const str of [...collectStrings(en.site.database), ...collectStrings(itMsgs.site.database)]) {
      expect(str).not.toMatch(jargonRe);
    }
    expect(page200).not.toMatch(jargonRe);
  });
});
