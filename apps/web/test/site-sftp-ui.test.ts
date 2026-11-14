import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CreateSiteSftpUserRequestSchema,
  SITE_SFTP_MAX_USERS,
  type SiteDetailDto,
  type SiteSftpDto,
  type SiteSftpUserDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const getCustomerContext = vi.fn();
const getSite = vi.fn();
const serverGet = vi.fn();
const getRequestLocale = vi.fn();
const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
const redirect = vi.fn();

vi.mock("@/app/sites/data", () => ({
  getCustomerContext: (...args: unknown[]) => getCustomerContext(...args),
  getSite: (...args: unknown[]) => getSite(...args),
}));
vi.mock("@/lib/server-api", () => ({
  serverGet: (...args: unknown[]) => serverGet(...args),
}));
vi.mock("@/i18n/server", () => ({
  getRequestLocale: (...args: unknown[]) => getRequestLocale(...args),
}));
vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));
vi.mock("next/navigation", () => ({
  redirect: (...args: unknown[]) => redirect(...args),
}));

import SiteSftpPage from "@/app/sites/[siteId]/files/sftp/page";
import { TempPasswordBody } from "@/components/admin/create-customer-dialog";
import {
  AddSftpUserForm,
  AddSftpUserFormView,
  DeleteSftpUserForm,
  ResetSftpPasswordForm,
  SftpAccess,
  SftpPasswordResult,
  createSftpUserBody,
  isValidSftpName,
  postSftpUser,
  sftpErrorText,
  toAddSftpUserError,
} from "@/components/customer/sftp-access";
import { Dialog } from "@/components/ui/dialog";

const realServerApi = await vi.importActual<typeof import("@/lib/server-api")>("@/lib/server-api");

function wrap(m: Messages, node: React.ReactElement) {
  return createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: node });
}

function makeUser(i: number): SiteSftpUserDto {
  return {
    id: `u-${i}`,
    username: `site1_user${i}`,
    createdAt: "2026-11-10T10:00:00Z",
    passwordChangedAt: "2026-11-11T12:00:00Z",
  };
}

function makeSftp(overrides: Partial<SiteSftpDto> = {}): SiteSftpDto {
  return {
    available: true,
    host: "sftp.example.com",
    port: 2222,
    hostKeyFingerprint: "SHA256:AbCdEf1234567890",
    users: [],
    ...overrides,
  };
}

describe("SftpAccess rendering and state matrix", () => {
  it("shows unavailable line with no Add user button when available is false", () => {
    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(
        wrap(
          m,
          createElement(SftpAccess, {
            basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
            csrfToken: "csrf",
            initial: makeSftp({
              available: false,
              host: null,
              port: null,
              hostKeyFingerprint: null,
              users: [],
            }),
          }),
        ),
      ).replaceAll("&#x27;", "'");

      expect(html).toContain(m.site.files.sftp.intro);
      expect(html).toContain(m.site.files.sftp.unavailable);
      expect(html).not.toContain(m.site.files.sftp.add);
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<table");
    }
  });

  it("shows host, port, and fingerprint details when available is true", () => {
    const html = renderToStaticMarkup(
      wrap(
        en,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp(),
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(html).toContain("sftp.example.com");
    expect(html).toContain("2222");
    expect(html).toContain("<details");
    expect(html).toContain(en.site.files.sftp.fingerprintTitle);
    expect(html).toContain(en.site.files.sftp.fingerprintBody);
    expect(html).toContain("SHA256:AbCdEf1234567890");
    expect(html).toContain(en.site.files.sftp.empty);
  });

  it("omits fingerprint <details> when hostKeyFingerprint is null", () => {
    const html = renderToStaticMarkup(
      wrap(
        en,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ hostKeyFingerprint: null }),
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(html).toContain("sftp.example.com");
    expect(html).toContain("2222");
    expect(html).not.toContain("<details");
    expect(html).not.toContain(en.site.files.sftp.fingerprintTitle);
  });

  it("shows unavailable details message when host or port is null without promising waiting helps", () => {
    for (const m of [en, itMsgs]) {
      expect(m.site.files.sftp.detailsUnavailable).not.toMatch(
        m === en ? /\b(wait|try again)\b/i : /\b(attendi|riprova)\b/i,
      );
      expect(m.site.files.sftp.detailsUnavailable).toMatch(
        m === en ? /\bcontact your hosting provider\b/i : /\bcontatta il tuo fornitore di hosting\b/i,
      );
    }
    for (const patch of [{ host: null }, { port: null }] as const) {
      const html = renderToStaticMarkup(
        wrap(
          en,
          createElement(SftpAccess, {
            basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
            csrfToken: "csrf",
            initial: makeSftp(patch),
          }),
        ),
      ).replaceAll("&#x27;", "'");

      expect(html).toContain(en.site.files.sftp.detailsUnavailable);
      expect(html).not.toContain("sftp.example.com");
    }
  });

  it("renders users table and disables Add user at the 10-user limit", () => {
    const twoUsers = [makeUser(1), makeUser(2)];
    const tableHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ users: twoUsers }),
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(tableHtml).toContain("site1_user1");
    expect(tableHtml).toContain("site1_user2");
    expect(tableHtml).toContain(en.site.files.sftp.name);
    expect(tableHtml).toContain(en.site.files.sftp.createdAt);
    expect(tableHtml).toContain(en.site.files.sftp.passwordChanged);
    expect(tableHtml).toContain(en.site.files.sftp.actions);
    expect(tableHtml).toContain(en.site.files.sftp.reset.action);
    expect(tableHtml).toContain(en.site.files.sftp.remove.action);
    expect(tableHtml).not.toContain(en.site.files.sftp.empty);

    const tenUsers = Array.from({ length: SITE_SFTP_MAX_USERS }, (_, idx) => makeUser(idx + 1));
    const fullHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ users: tenUsers }),
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(fullHtml).toContain(format(en.site.files.sftp.limit, { max: SITE_SFTP_MAX_USERS }));
    expect(fullHtml).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Add user/);
  });
});

describe("TempPasswordBody with custom SFTP texts", () => {
  it("uses site.files.sftp.created copy when t prop is passed and admin copy by default", () => {
    const siteHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(TempPasswordBody, {
          password: "ShownOnce#Pass1",
          who: "site1_alice",
          t: en.site.files.sftp.created,
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(siteHtml).toContain('data-testid="temp-password"');
    expect(siteHtml).toContain("ShownOnce#Pass1");
    expect(siteHtml).toContain("site1_alice");
    expect(siteHtml).toContain(en.site.files.sftp.created.tempNote);
    expect(siteHtml).toContain(en.site.files.sftp.created.tempOnce);
    expect(siteHtml).not.toContain(en.admin.users.tempNote);

    const adminHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(TempPasswordBody, {
          password: "Admin#Pass1",
          who: "owner@example.com",
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(adminHtml).toContain('data-testid="temp-password"');
    expect(adminHtml).toContain(en.admin.users.tempNote);
    expect(adminHtml).toContain(en.admin.users.tempOnce);
  });
});

describe("SFTP helpers and dialog forms", () => {
  it("maps error codes to SFTP and global catalog messages", () => {
    for (const m of [en, itMsgs]) {
      expect(sftpErrorText(m, "NOT_SUPPORTED")).toBe(m.site.files.sftp.unavailable);
      expect(sftpErrorText(m, "ALREADY_EXISTS")).toBe(m.site.files.sftp.errors.ALREADY_EXISTS);
      expect(sftpErrorText(m, "QUOTA_EXCEEDED")).toBe(m.site.files.sftp.errors.QUOTA_EXCEEDED);
      expect(sftpErrorText(m, "DOCKER_ENGINE_UNAVAILABLE")).toBe(
        m.site.files.sftp.errors.DOCKER_ENGINE_UNAVAILABLE,
      );
      expect(sftpErrorText(m, "ORGANIZATION_SUSPENDED")).toBe(
        m.site.files.sftp.errors.ORGANIZATION_SUSPENDED,
      );
      expect(sftpErrorText(m, "VALIDATION_ERROR")).toBe(m.site.files.sftp.errors.VALIDATION_ERROR);
      expect(sftpErrorText(m, "OPERATION_AMBIGUOUS")).toBe(m.site.files.errors.OPERATION_AMBIGUOUS);
      expect(sftpErrorText(m, "UNAUTHENTICATED")).toBe(m.site.files.errors.UNAUTHENTICATED);
      expect(sftpErrorText(m, "RESOURCE_LOCKED")).toBe(m.errors.RESOURCE_LOCKED);
      expect(sftpErrorText(m, "DOCKER_ENGINE_UNAVAILABLE")).toMatch(
        m === en ? /\btry again\b/i : /\briprova\b/i,
      );
      expect(sftpErrorText(m, "RESOURCE_LOCKED")).toMatch(
        m === en ? /\btry again\b/i : /\briprova\b/i,
      );
      expect(sftpErrorText(m, "INTERNAL_ERROR")).toBe(m.errors.INTERNAL_ERROR);
      expect(sftpErrorText(m, "UNEXPECTED_CODE")).toBe(m.errors.generic);
    }
  });

  it("builds a create request body accepted by CreateSiteSftpUserRequestSchema", () => {
    const body = createSftpUserBody("alice");
    expect(CreateSiteSftpUserRequestSchema.safeParse(body)).toEqual({
      success: true,
      data: { name: "alice" },
    });
  });

  it("postSftpUser sends POST with CSRF header and body accepted by CreateSiteSftpUserRequestSchema", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await postSftpUser("/api/bff/orgs/o1/managed-sites/s1/sftp", "csrf-tok", "alice");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/bff/orgs/o1/managed-sites/s1/sftp/users");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-tok");
    expect(headers.get("content-type")).toBe("application/json");
    expect(CreateSiteSftpUserRequestSchema.safeParse(JSON.parse(String(init.body)))).toEqual({
      success: true,
      data: { name: "alice" },
    });
  });

  it("sets aria-invalid and aria-describedby on the add-user input according to validity and error state", () => {
    const baseProps = {
      name: "",
      busy: false,
      error: null,
      inputId: "sftp-name",
      hintId: "sftp-hint",
      errorId: "sftp-err",
      onNameChange: () => {},
      onSubmit: (e: React.FormEvent) => e.preventDefault(),
      onCancel: () => {},
    };

    const initialHtml = renderToStaticMarkup(
      wrap(en, createElement(Dialog, { open: true }, createElement(AddSftpUserFormView, baseProps))),
    );
    expect(initialHtml).not.toContain("aria-invalid");
    expect(initialHtml).toContain('aria-describedby="sftp-hint"');

    const invalidNameHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(AddSftpUserFormView, { ...baseProps, name: "bad-name" }),
        ),
      ),
    );
    expect(invalidNameHtml).toContain('aria-invalid="true"');
    expect(invalidNameHtml).toContain('aria-describedby="sftp-hint"');

    const withErrorHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(AddSftpUserFormView, {
            ...baseProps,
            name: "alice",
            error: en.site.files.sftp.errors.ALREADY_EXISTS,
            errorInvalid: true,
          }),
        ),
      ),
    );
    expect(withErrorHtml).toContain('aria-invalid="true"');
    expect(withErrorHtml).toContain('aria-describedby="sftp-hint sftp-err"');
    expect(withErrorHtml).toContain('id="sftp-err"');

    const validationErrorHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(AddSftpUserFormView, {
            ...baseProps,
            name: "alice",
            error: en.site.files.sftp.errors.VALIDATION_ERROR,
            errorInvalid: true,
          }),
        ),
      ),
    );
    expect(validationErrorHtml).toContain('aria-invalid="true"');
    expect(validationErrorHtml).toContain('aria-describedby="sftp-hint sftp-err"');

    const nonFieldErrorHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(AddSftpUserFormView, {
            ...baseProps,
            name: "alice",
            error: en.site.files.sftp.errors.DOCKER_ENGINE_UNAVAILABLE,
          }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    expect(nonFieldErrorHtml).not.toContain("aria-invalid");
    expect(nonFieldErrorHtml).toContain('aria-describedby="sftp-hint sftp-err"');
    expect(nonFieldErrorHtml).toContain('id="sftp-err"');
    expect(nonFieldErrorHtml).toContain(en.site.files.sftp.errors.DOCKER_ENGINE_UNAVAILABLE);

    expect(toAddSftpUserError(en, "VALIDATION_ERROR")).toEqual({
      message: en.site.files.sftp.errors.VALIDATION_ERROR,
      fieldInvalid: true,
    });
    expect(toAddSftpUserError(en, "ALREADY_EXISTS")).toEqual({
      message: en.site.files.sftp.errors.ALREADY_EXISTS,
      fieldInvalid: true,
    });
    expect(toAddSftpUserError(en, "DOCKER_ENGINE_UNAVAILABLE")).toEqual({
      message: en.site.files.sftp.errors.DOCKER_ENGINE_UNAVAILABLE,
      fieldInvalid: false,
    });
    expect(toAddSftpUserError(en, "RESOURCE_LOCKED")).toEqual({
      message: en.errors.RESOURCE_LOCKED,
      fieldInvalid: false,
    });
    expect(toAddSftpUserError(en, "QUOTA_EXCEEDED")).toEqual({
      message: en.site.files.sftp.errors.QUOTA_EXCEEDED,
      fieldInvalid: false,
    });
  });

  it("uses accurate R17 copy for create.hint, reset.body, and remove.body in EN and IT", () => {
    for (const m of [en, itMsgs]) {
      expect(m.site.files.sftp.create.hint).not.toMatch(/short name|nome breve/i);
      expect(m.site.files.sftp.create.hint).toMatch(
        m === en ? /short site code/i : /codice breve del sito/i,
      );
      expect(m.site.files.sftp.create.hint).toMatch(
        m === en ? /full login in the list/i : /nell'elenco/i,
      );
      expect(m.site.files.sftp.reset.body).toMatch(
        m === en ? /reconnect/i : /ricollegarsi/i,
      );
      expect(m.site.files.sftp.remove.body).toMatch(
        m === en ? /reconnect/i : /ricollegarsi/i,
      );
    }
  });

  it("validates short SFTP user names", () => {
    expect(isValidSftpName("a")).toBe(true);
    expect(isValidSftpName("alice01")).toBe(true);
    expect(isValidSftpName("a".repeat(16))).toBe(true);

    expect(isValidSftpName("")).toBe(false);
    expect(isValidSftpName("Alice")).toBe(false);
    expect(isValidSftpName("a b")).toBe(false);
    expect(isValidSftpName("a-b")).toBe(false);
    expect(isValidSftpName("a_b")).toBe(false);
    expect(isValidSftpName("a".repeat(17))).toBe(false);
  });

  it("renders accessible dialog form markup", () => {
    const addHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(AddSftpUserForm, { onSubmit: async () => null, onCancel: () => {} }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    const forMatch = addHtml.match(/<label[^>]*for="([^"]+)"/);
    expect(forMatch?.[1]).toBeTruthy();
    expect(addHtml).toContain(`id="${forMatch![1]}"`);
    expect(addHtml).toContain(en.site.files.sftp.create.label);
    expect(addHtml).toContain(en.site.files.sftp.create.hint);

    const resetHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(ResetSftpPasswordForm, {
            username: "site1_alice",
            onConfirm: async () => null,
            onCancel: () => {},
          }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    expect(resetHtml).toContain(format(en.site.files.sftp.reset.title, { name: "site1_alice" }));
    expect(resetHtml).toContain(en.site.files.sftp.reset.body);
    expect(resetHtml).toContain(en.site.files.sftp.reset.confirm);

    const deleteHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(DeleteSftpUserForm, {
            username: "site1_alice",
            onConfirm: async () => null,
            onCancel: () => {},
          }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    expect(deleteHtml).toContain(format(en.site.files.sftp.remove.title, { name: "site1_alice" }));
    expect(deleteHtml).toContain(en.site.files.sftp.remove.confirm);

    const resultHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(SftpPasswordResult, {
            title: en.site.files.sftp.created.title,
            username: "site1_alice",
            password: "OneTime#Password1",
            onDone: () => {},
          }),
        ),
      ),
    ).replaceAll("&#x27;", "'");
    expect(resultHtml).toContain("site1_alice");
    expect(resultHtml).toContain('data-testid="temp-password"');
    expect(resultHtml).toContain("OneTime#Password1");
    expect(resultHtml).toContain(en.site.files.sftp.created.done);
  });
});

describe("SiteSftpPage server component", () => {
  beforeEach(() => {
    getCustomerContext.mockReset();
    getSite.mockReset();
    serverGet.mockReset();
    getRequestLocale.mockReset();
    getRequestLocale.mockResolvedValue("en");
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
    getSite.mockResolvedValue({ ok: true, data: { id: "s1", status: "ready" } as unknown as SiteDetailDto });
  });

  it("renders LoadError when upstream SFTP fetch fails", async () => {
    serverGet.mockResolvedValue({ ok: false, outcome: "error", status: 500 });
    const el = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
    const html = renderToStaticMarkup(wrap(en, el!)).replaceAll("&#x27;", "'");
    expect(html).toContain(en.shell.loadErrorTitle);
    expect(html).toContain(en.shell.loadErrorBody);
  });

  it("renders PERMISSION_DENIED instead of LoadError when upstream SFTP fetch returns 403", async () => {
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      getRequestLocale.mockResolvedValue(locale);
      serverGet.mockResolvedValue({ ok: false, outcome: "error", status: 403, code: "PERMISSION_DENIED" });
      const el = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
      const html = renderToStaticMarkup(wrap(m, el!)).replaceAll("&#x27;", "'");
      expect(html).toContain(m.errors.PERMISSION_DENIED);
      expect(html).toContain('href="/sites/s1/files"');
      expect(html).not.toContain(m.shell.loadErrorTitle);
      expect(html).not.toContain(m.shell.loadErrorBody);
    }
  });

  it("renders SFTP suspension text instead of PERMISSION_DENIED when 403 has code ORGANIZATION_SUSPENDED", async () => {
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      getRequestLocale.mockResolvedValue(locale);
      serverGet.mockResolvedValue({
        ok: false,
        outcome: "error",
        status: 403,
        code: "ORGANIZATION_SUSPENDED",
      });
      const el = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
      const html = renderToStaticMarkup(wrap(m, el!)).replaceAll("&#x27;", "'");
      expect(html).toContain(m.site.files.sftp.errors.ORGANIZATION_SUSPENDED);
      expect(html).not.toContain(m.errors.PERMISSION_DENIED);
      expect(html).not.toMatch(/administrator|amministratore/i);
      expect(html).toContain('href="/sites/s1/files"');
      expect(html).not.toContain(m.shell.loadErrorTitle);
    }
  });

  it("renders back link to files and SftpAccess with R12 20s timeout when upstream SFTP fetch succeeds", async () => {
    serverGet.mockResolvedValue({ ok: true, data: makeSftp() });
    const el = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
    const html = renderToStaticMarkup(wrap(en, el!)).replaceAll("&#x27;", "'");
    expect(serverGet).toHaveBeenCalledWith("v1/organizations/org-1/managed-sites/s1/sftp", {
      timeoutMs: 20_000,
    });
    expect(html).toContain('href="/sites/s1/files"');
    expect(html).toContain(en.site.files.sftp.back);
    expect(html).toContain(en.site.files.sftp.title);
    expect(html).toContain("sftp.example.com");
  });
});

describe("serverGet timeout and 403 status forwarding", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getServerSession.mockReset();
    redirect.mockReset();
    getServerSession.mockResolvedValue({ accessToken: "tok" });
  });

  it("forwards optional timeoutMs to fetchUpstream and exposes HTTP status on errors", async () => {
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: { ok: 1 } } });
    await realServerApi.serverGet("v1/test");
    expect(fetchUpstream).toHaveBeenLastCalledWith("v1/test", { accessToken: "tok" });

    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: { ok: 2 } } });
    await realServerApi.serverGet("v1/organizations/org-1/managed-sites/s1/sftp", {
      timeoutMs: 20_000,
    });
    expect(fetchUpstream).toHaveBeenLastCalledWith("v1/organizations/org-1/managed-sites/s1/sftp", {
      accessToken: "tok",
      timeoutMs: 20_000,
    });

    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 403 });
    const forbidden = await realServerApi.serverGet("v1/organizations/org-1/managed-sites/s1/sftp");
    expect(forbidden).toEqual({ ok: false, outcome: "error", status: 403 });

    fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: { error: { code: "ORGANIZATION_SUSPENDED", message: "Suspended" } },
    });
    const suspended = await realServerApi.serverGet("v1/organizations/org-1/managed-sites/s1/sftp");
    expect(suspended).toEqual({
      ok: false,
      outcome: "error",
      status: 403,
      code: "ORGANIZATION_SUSPENDED",
    });
  });
});
