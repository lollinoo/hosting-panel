import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApiErrorEnvelopeSchema,
  SITE_SFTP_MAX_USERS,
  type SiteDetailDto,
  type SiteSftpDto,
  type SiteSftpUserDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { format, type Messages } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getCustomerContext = vi.fn();
const getSite = vi.fn();
const serverGet = vi.fn();
const getRequestLocale = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
}));
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
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/sites/s1/files",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { GET as listFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/route";
import { GET as getSftp } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/sftp/route";
import { POST as createSftpUser } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/sftp/users/route";
import { DELETE as deleteSftpUser } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/sftp/users/[userId]/route";
import { POST as resetSftpPassword } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/sftp/users/[userId]/reset-password/route";
import SiteFilesPage from "@/app/sites/[siteId]/files/page";
import SiteSftpPage from "@/app/sites/[siteId]/files/sftp/page";
import { TempPasswordBody } from "@/components/admin/create-customer-dialog";
import { FilesPanel } from "@/components/customer/files-panel";
import {
  AddSftpUserForm,
  DeleteSftpUserForm,
  ResetSftpPasswordForm,
  SftpAccess,
  SftpPasswordResult,
  sftpErrorText,
} from "@/components/customer/sftp-access";
import { Dialog } from "@/components/ui/dialog";

const BASE_UPSTREAM = "v1/organizations/org-1/managed-sites/s1";
const SFTP_FORBIDDEN_WORDS =
  /\b(docker|container|image|volume|network|service|job|template|revision)\b/i;

const siteCtx = (orgId = "org-1", siteId = "s1") => ({
  params: Promise.resolve({ orgId, siteId }),
});

const userCtx = (orgId = "org-1", siteId = "s1", userId = "u-1") => ({
  params: Promise.resolve({ orgId, siteId, userId }),
});

function makeReq(
  method: string,
  opts: {
    path?: string;
    headers?: Record<string, string>;
    omitCsrf?: boolean;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const url = `http://localhost:3000/api/bff/orgs/org-1/managed-sites/s1/${opts.path ?? "sftp"}`;
  const headers: Record<string, string> = {
    Host: "localhost:3000",
    Origin: "http://localhost:3000",
    ...(opts.omitCsrf ? {} : { "X-CSRF-Token": "csrf" }),
    ...(opts.headers ?? {}),
  };

  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    if (!("Content-Type" in headers)) {
      headers["Content-Type"] = "application/json";
    }
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  return new Request(url, { method, headers, body });
}

function wrap(m: Messages, node: React.ReactElement) {
  return createElement(I18nProvider, {
    locale: m === en ? "en" : "it",
    messages: m,
    children: node,
  });
}

function renderHtml(m: Messages, node: React.ReactElement): string {
  return renderToStaticMarkup(wrap(m, node)).replaceAll("&#x27;", "'");
}

function makeUser(i: number, overrides: Partial<SiteSftpUserDto> = {}): SiteSftpUserDto {
  return {
    id: `u-${i}`,
    username: `s12345678_user${i}`,
    createdAt: "2026-11-10T10:00:00Z",
    passwordChangedAt: "2026-11-11T12:00:00Z",
    ...overrides,
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

function collectLeaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [[prefix, obj]];
  }
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(...collectLeaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

describe("SFTP BFF path segment, CSRF, Origin, and payload validation", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  it("refuses any userId that is not one plain path segment with 400 before calling upstream", async () => {
    const badSegments = ["../x", "a/b", "a%2Fb", "", "a".repeat(300), "a\u0000b"];

    for (const bad of badSegments) {
      const delRes = await deleteSftpUser(
        makeReq("DELETE", { path: `sftp/users/${bad}` }),
        userCtx("org-1", "s1", bad),
      );
      expect(delRes.status, `DELETE userId=${JSON.stringify(bad)}`).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await delRes.json()).error.code).toBe("VALIDATION_ERROR");

      const resetRes = await resetSftpPassword(
        makeReq("POST", { path: `sftp/users/${bad}/reset-password` }),
        userCtx("org-1", "s1", bad),
      );
      expect(resetRes.status, `reset userId=${JSON.stringify(bad)}`).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await resetRes.json()).error.code).toBe("VALIDATION_ERROR");
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses any orgId or siteId that is not one plain path segment across all SFTP routes", async () => {
    const badSegments = ["../x", "a/b", "a%2Fb", "", "a".repeat(300), "a\u0000b"];

    for (const bad of badSegments) {
      const targets = [
        [bad, "s1"],
        ["org-1", bad],
      ] as const;

      for (const [orgId, siteId] of targets) {
        const responses = await Promise.all([
          getSftp(makeReq("GET"), siteCtx(orgId, siteId)),
          createSftpUser(makeReq("POST", { body: { name: "alice" } }), siteCtx(orgId, siteId)),
          deleteSftpUser(makeReq("DELETE"), userCtx(orgId, siteId, "u-1")),
          resetSftpPassword(makeReq("POST"), userCtx(orgId, siteId, "u-1")),
        ]);

        for (const res of responses) {
          expect(res.status, `orgId=${JSON.stringify(orgId)} siteId=${JSON.stringify(siteId)}`).toBe(400);
          expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
        }
      }
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses missing CSRF, wrong CSRF, and foreign Origin on every non-GET SFTP route", async () => {
    const badAuthOpts: Array<{ headers?: Record<string, string>; omitCsrf?: boolean }> = [
      { omitCsrf: true },
      { headers: { "X-CSRF-Token": "wrong-csrf" } },
      { headers: { Origin: "https://evil.example" } },
    ];

    for (const opts of badAuthOpts) {
      const responses = await Promise.all([
        createSftpUser(makeReq("POST", { ...opts, body: { name: "alice" } }), siteCtx()),
        deleteSftpUser(makeReq("DELETE", opts), userCtx()),
        resetSftpPassword(makeReq("POST", opts), userCtx()),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("PERMISSION_DENIED");
      }
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses non-JSON, extra keys, and wrong name type on POST sftp/users with 400", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 201, data: { data: {} } });

    const nonJsonBodies = ["{not-json", "name=alice", ""];
    for (const rawBody of nonJsonBodies) {
      const res = await createSftpUser(makeReq("POST", { rawBody }), siteCtx());
      expect(res.status, `rawBody=${JSON.stringify(rawBody)}`).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
    }

    const invalidPayloads: unknown[] = [
      { name: "alice", extra: "bad" },
      { username: "alice" },
      { name: 123 },
      { name: null },
      { name: ["alice"] },
      { name: true },
      {},
    ];
    for (const body of invalidPayloads) {
      const res = await createSftpUser(makeReq("POST", { body }), siteCtx());
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses non-JSON payloads on DELETE and reset-password with 400 before calling upstream", async () => {
    const delRes = await deleteSftpUser(makeReq("DELETE", { rawBody: "{bad" }), userCtx());
    expect(delRes.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(await delRes.json()).error.code).toBe("VALIDATION_ERROR");

    const resetRes = await resetSftpPassword(makeReq("POST", { rawBody: "{bad" }), userCtx());
    expect(resetRes.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(await resetRes.json()).error.code).toBe("VALIDATION_ERROR");

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses bodies over the 1 MiB size limit by Content-Length and actual byte size", async () => {
    const oversizedHeaderRes = await createSftpUser(
      makeReq("POST", {
        headers: { "Content-Length": String(1_048_577) },
        body: { name: "alice" },
      }),
      siteCtx(),
    );
    expect(oversizedHeaderRes.status).toBe(413);
    expect(ApiErrorEnvelopeSchema.parse(await oversizedHeaderRes.json()).error.code).toBe("VALIDATION_ERROR");

    const hugeRaw = JSON.stringify({ name: "a".repeat(1_048_600) });
    const oversizedBodyResponses = await Promise.all([
      createSftpUser(makeReq("POST", { rawBody: hugeRaw }), siteCtx()),
      deleteSftpUser(makeReq("DELETE", { rawBody: hugeRaw }), userCtx()),
      resetSftpPassword(makeReq("POST", { rawBody: hugeRaw }), userCtx()),
    ]);

    for (const res of oversizedBodyResponses) {
      expect(res.status).toBe(413);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("SFTP BFF upstream responses, timeouts, no-store, and secret hygiene", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes through an upstream 503 with retryable and its error code", async () => {
    const err503 = {
      error: {
        code: "DOCKER_ENGINE_UNAVAILABLE",
        message: "SFTP service unavailable",
        requestId: "req-503",
        retryable: true,
        details: [],
      },
    };
    fetchUpstream.mockResolvedValue({ ok: false, status: 503, error: err503 });

    const responses = await Promise.all([
      getSftp(makeReq("GET"), siteCtx()),
      createSftpUser(makeReq("POST", { body: { name: "alice" } }), siteCtx()),
      deleteSftpUser(makeReq("DELETE"), userCtx()),
      resetSftpPassword(makeReq("POST"), userCtx()),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const parsed = ApiErrorEnvelopeSchema.parse(await res.json());
      expect(parsed.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(parsed.error.retryable).toBe(true);
    }
  });

  it("gives the exact same answer as the files routes on an upstream timeout", async () => {
    const timeoutReply = {
      status: 504,
      ok: false,
      error: {
        error: {
          code: "INTERNAL_ERROR",
          message: "Timeout di connessione con il servizio di controllo upstream",
          requestId: "err-upstream-call",
          retryable: true,
          details: [],
        },
      },
    };
    fetchUpstream.mockResolvedValue(timeoutReply);

    const filesRes = await listFiles(makeReq("GET", { path: "files?path=" }), siteCtx());
    const filesBody = await filesRes.json();

    const sftpResponses = await Promise.all([
      getSftp(makeReq("GET"), siteCtx()),
      createSftpUser(makeReq("POST", { body: { name: "alice" } }), siteCtx()),
      deleteSftpUser(makeReq("DELETE"), userCtx()),
      resetSftpPassword(makeReq("POST"), userCtx()),
    ]);

    expect(filesRes.status).toBe(504);
    for (const res of sftpResponses) {
      expect(res.status).toBe(filesRes.status);
      expect(await res.json()).toEqual(filesBody);
    }
  });

  it("uses R12 upstream timeouts (20_000 for GET, 130_000 for mutations)", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });

    await getSftp(makeReq("GET"), siteCtx());
    await createSftpUser(makeReq("POST", { body: { name: "alice" } }), siteCtx());
    await deleteSftpUser(makeReq("DELETE"), userCtx("org-1", "s1", "u-1"));
    await resetSftpPassword(makeReq("POST"), userCtx("org-1", "s1", "u-1"));

    expect(fetchUpstream.mock.calls[0]).toEqual([
      `${BASE_UPSTREAM}/sftp`,
      { method: "GET", accessToken: "tok", timeoutMs: 20_000 },
    ]);
    expect(fetchUpstream.mock.calls[1]).toEqual([
      `${BASE_UPSTREAM}/sftp/users`,
      { method: "POST", accessToken: "tok", body: { name: "alice" }, timeoutMs: 130_000 },
    ]);
    expect(fetchUpstream.mock.calls[2]).toEqual([
      `${BASE_UPSTREAM}/sftp/users/u-1`,
      { method: "DELETE", accessToken: "tok", timeoutMs: 130_000 },
    ]);
    expect(fetchUpstream.mock.calls[3]).toEqual([
      `${BASE_UPSTREAM}/sftp/users/u-1/reset-password`,
      { method: "POST", accessToken: "tok", timeoutMs: 130_000 },
    ]);
  });

  it("returns create and reset passwords intact with Cache-Control: no-store and never puts passwords in headers, URLs, or console logs", async () => {
    const createPw = "ShownOnceCreate!Secret123";
    const resetPw = "ShownOnceReset!Secret456";
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];

    fetchUpstream
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        data: {
          data: {
            user: makeUser(1),
            temporaryPassword: createPw,
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: {
            temporaryPassword: resetPw,
          },
        },
      });

    const createRes = await createSftpUser(
      makeReq("POST", { body: { name: "alice" } }),
      siteCtx(),
    );
    expect(createRes.status).toBe(201);
    expect(createRes.headers.get("cache-control")).toContain("no-store");
    for (const [k, v] of createRes.headers.entries()) {
      expect(`${k}:${v}`).not.toContain(createPw);
    }
    expect((await createRes.json()).data.temporaryPassword).toBe(createPw);

    const resetRes = await resetSftpPassword(makeReq("POST"), userCtx("org-1", "s1", "u-1"));
    expect(resetRes.status).toBe(200);
    expect(resetRes.headers.get("cache-control")).toContain("no-store");
    for (const [k, v] of resetRes.headers.entries()) {
      expect(`${k}:${v}`).not.toContain(resetPw);
    }
    expect((await resetRes.json()).data.temporaryPassword).toBe(resetPw);

    for (const call of fetchUpstream.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(createPw);
      expect(serialized).not.toContain(resetPw);
    }
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(createPw);
        expect(serialized).not.toContain(resetPw);
      }
    }
  });
});

describe("SFTP page logic, escaping, limits, and accessible markup", () => {
  beforeEach(() => {
    getCustomerContext.mockReset();
    getSite.mockReset();
    serverGet.mockReset();
    getRequestLocale.mockReset();
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
    getSite.mockResolvedValue({ ok: true, data: { id: "s1", status: "active" } as unknown as SiteDetailDto });
  });

  it("renders no button, form, or input that could create a user when available is false", async () => {
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      getRequestLocale.mockResolvedValue(locale);
      serverGet.mockResolvedValue({
        ok: true,
        data: makeSftp({ available: false, host: null, port: null, hostKeyFingerprint: null, users: [] }),
      });

      const compHtml = renderHtml(
        m,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ available: false, host: null, port: null, hostKeyFingerprint: null, users: [] }),
        }),
      );
      const pageEl = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
      const pageHtml = renderHtml(m, pageEl!);

      for (const html of [compHtml, pageHtml]) {
        expect(html).toContain(m.site.files.sftp.unavailable);
        expect(html).not.toMatch(/<button\b/i);
        expect(html).not.toMatch(/<form\b/i);
        expect(html).not.toMatch(/<input\b/i);
        expect(html).not.toMatch(/role="button"/i);
      }
    }
  });

  it("explains what to do when host or port is null without rendering null, undefined, or :null", () => {
    for (const m of [en, itMsgs]) {
      for (const patch of [{ host: null }, { port: null }, { host: null, port: null }] as const) {
        const html = renderHtml(
          m,
          createElement(SftpAccess, {
            basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
            csrfToken: "csrf",
            initial: makeSftp(patch),
          }),
        );

        expect(html).toContain(m.site.files.sftp.detailsUnavailable);
        expect(m.site.files.sftp.detailsUnavailable).not.toMatch(
          m === en ? /\b(wait|try again)\b/i : /\b(attendi|riprova)\b/i,
        );
        expect(m.site.files.sftp.detailsUnavailable).toMatch(
          m === en ? /\bcontact your hosting provider\b/i : /\bcontatta il tuo fornitore di hosting\b/i,
        );
        const textOnly = html.replace(/<[^>]+>/g, " ");
        expect(textOnly).not.toMatch(/\b(null|undefined)\b|:null/i);
        expect(html).not.toContain(":null");
      }
    }
  });

  it("escapes HTML payloads in hostKeyFingerprint, user names, and temporaryPassword", () => {
    const evilFp = 'SHA256:<script>alert("fp")</script>';
    const evilUser = 's1_<img src=x onerror=alert("u")>';
    const evilPw = '<script>alert("pw")</script>';

    const accessHtml = renderHtml(
      en,
      createElement(SftpAccess, {
        basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
        csrfToken: "csrf",
        initial: makeSftp({
          hostKeyFingerprint: evilFp,
          users: [makeUser(1, { username: evilUser })],
        }),
      }),
    );

    expect(accessHtml).not.toContain("<script>");
    expect(accessHtml).toContain("&lt;script&gt;");
    expect(accessHtml).not.toContain("<img ");
    expect(accessHtml).toContain("&lt;img");

    const dialogHtmls = [
      renderHtml(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(ResetSftpPasswordForm, {
            username: evilUser,
            onConfirm: async () => null,
            onCancel: () => {},
          }),
        ),
      ),
      renderHtml(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(DeleteSftpUserForm, {
            username: evilUser,
            onConfirm: async () => null,
            onCancel: () => {},
          }),
        ),
      ),
      renderHtml(
        en,
        createElement(
          Dialog,
          { open: true },
          createElement(SftpPasswordResult, {
            title: en.site.files.sftp.created.title,
            username: evilUser,
            password: evilPw,
            onDone: () => {},
          }),
        ),
      ),
    ];

    for (const html of dialogHtmls) {
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img ");
      expect(html).toContain("&lt;img");
    }
    expect(dialogHtmls[2]).toContain("&lt;script&gt;");
  });

  it("keeps Add user enabled at 9 users without limit text, and disables Add user with limit text at 10 users", () => {
    const nineUsers = Array.from({ length: SITE_SFTP_MAX_USERS - 1 }, (_, i) => makeUser(i + 1));
    const tenUsers = Array.from({ length: SITE_SFTP_MAX_USERS }, (_, i) => makeUser(i + 1));

    for (const m of [en, itMsgs]) {
      const limitMsg = format(m.site.files.sftp.limit, { max: SITE_SFTP_MAX_USERS });

      const nineHtml = renderHtml(
        m,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ users: nineUsers }),
        }),
      );
      expect(nineHtml).toContain(format(m.site.files.sftp.count, { count: 9, max: SITE_SFTP_MAX_USERS }));
      expect(nineHtml).not.toContain(limitMsg);
      const nineAddBtn = nineHtml.match(
        new RegExp(`<button\\b([^>]*)>(?:(?!</button>).)*${m.site.files.sftp.add}</button>`),
      );
      expect(nineAddBtn).not.toBeNull();
      expect(nineAddBtn![1]).not.toMatch(/(?:^|\s)disabled=""/);

      const tenHtml = renderHtml(
        m,
        createElement(SftpAccess, {
          basePath: "/api/bff/orgs/o1/managed-sites/s1/sftp",
          csrfToken: "csrf",
          initial: makeSftp({ users: tenUsers }),
        }),
      );
      expect(tenHtml).toContain(format(m.site.files.sftp.count, { count: 10, max: SITE_SFTP_MAX_USERS }));
      expect(tenHtml).toContain(limitMsg);
      const tenAddBtn = tenHtml.match(
        new RegExp(`<button\\b([^>]*)>(?:(?!</button>).)*${m.site.files.sftp.add}</button>`),
      );
      expect(tenAddBtn).not.toBeNull();
      expect(tenAddBtn![1]).toMatch(/(?:^|\s)disabled=""/);
    }
  });

  it("states in the shown-once password block that the password will not be shown again", () => {
    for (const m of [en, itMsgs]) {
      const html = renderHtml(
        m,
        createElement(
          Dialog,
          { open: true },
          createElement(SftpPasswordResult, {
            title: m.site.files.sftp.created.title,
            username: "s12345678_alice",
            password: "ShownOnce#Password1",
            onDone: () => {},
          }),
        ),
      );
      expect(html).toContain(m.site.files.sftp.created.tempOnce);
      expect(html).toMatch(m === en ? /only once/i : /una sola volta/i);

      const directBody = renderHtml(
        m,
        createElement(TempPasswordBody, {
          password: "ShownOnce#Password1",
          who: "s12345678_alice",
          t: m.site.files.sftp.created,
        }),
      );
      expect(directBody).toContain(m.site.files.sftp.created.tempOnce);
    }
  });

  it("gives every dialog a visible heading, labels every dialog input, and names the login in the delete dialog", () => {
    const login = "s1a2b3c4d_alice";

    for (const m of [en, itMsgs]) {
      const dialogs = [
        renderHtml(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(AddSftpUserForm, { onSubmit: async () => null, onCancel: () => {} }),
          ),
        ),
        renderHtml(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(ResetSftpPasswordForm, {
              username: login,
              onConfirm: async () => null,
              onCancel: () => {},
            }),
          ),
        ),
        renderHtml(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(DeleteSftpUserForm, {
              username: login,
              onConfirm: async () => null,
              onCancel: () => {},
            }),
          ),
        ),
        renderHtml(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(SftpPasswordResult, {
              title: m.site.files.sftp.created.title,
              username: login,
              password: "ShownOnce#Password1",
              onDone: () => {},
            }),
          ),
        ),
      ];

      for (const html of dialogs) {
        const heading = html.match(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/);
        expect(heading, "visible dialog <h2>").not.toBeNull();
        expect(heading![1]).not.toMatch(/\bsr-only\b/);
        expect(heading![2]!.replace(/<[^>]+>/g, "").trim().length).toBeGreaterThan(0);

        for (const inputMatch of html.matchAll(/<input\b([^>]*)>/g)) {
          const idMatch = /\bid="([^"]+)"/.exec(inputMatch[1]!);
          expect(idMatch, "dialog input id").not.toBeNull();
          expect(html).toMatch(new RegExp(`<label\\b[^>]*for="${idMatch![1]}"`));
        }
      }

      const deleteHtml = dialogs[2]!;
      expect(deleteHtml).toContain(format(m.site.files.sftp.remove.title, { name: login }));
      expect(deleteHtml).toContain(format(m.site.files.sftp.remove.body, { name: login }));
    }
  });
});

describe("SFTP texts, bilingual parity, jargon guard, error mapping, and Files tab link", () => {
  beforeEach(() => {
    getCustomerContext.mockReset();
    getSite.mockReset();
    serverGet.mockReset();
    getRequestLocale.mockReset();
    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
    getSite.mockResolvedValue({ ok: true, data: { id: "s1", status: "active" } as unknown as SiteDetailDto });
  });

  it("has non-empty IT/EN parity under site.files.sftp without duplicated identical sentences", () => {
    const enLeaves = collectLeaves(en.site.files.sftp);
    const itLeaves = collectLeaves(itMsgs.site.files.sftp);

    expect(enLeaves.map(([k]) => k).sort()).toEqual(itLeaves.map(([k]) => k).sort());

    const itByKey = new Map(itLeaves);
    for (const [k, enVal] of enLeaves) {
      const itVal = itByKey.get(k);
      expect(typeof enVal, `en.site.files.sftp.${k}`).toBe("string");
      expect(typeof itVal, `it.site.files.sftp.${k}`).toBe("string");
      expect((enVal as string).trim().length, `empty en.site.files.sftp.${k}`).toBeGreaterThan(0);
      expect((itVal as string).trim().length, `empty it.site.files.sftp.${k}`).toBeGreaterThan(0);

      if (enVal === itVal) {
        // Only short technical labels (e.g., SFTP, host, port) could reasonably match across locales.
        expect(enVal, `untranslated identical copy at site.files.sftp.${k}`).toMatch(/^(SFTP|host|port)$/i);
      }
    }
  });

  it("contains no forbidden infrastructure words in SFTP texts or rendered SFTP page markup", async () => {
    for (const [k, v] of [
      ["en.site.files.sftpLink", en.site.files.sftpLink],
      ["it.site.files.sftpLink", itMsgs.site.files.sftpLink],
      ...collectLeaves(en.site.files.sftp).map(([k, v]) => [`en.site.files.sftp.${k}`, v] as const),
      ...collectLeaves(itMsgs.site.files.sftp).map(([k, v]) => [`it.site.files.sftp.${k}`, v] as const),
    ]) {
      expect(String(v), `jargon in ${k}`).not.toMatch(SFTP_FORBIDDEN_WORDS);
    }

    const dtoVariants: SiteSftpDto[] = [
      makeSftp({ available: false, host: null, port: null, hostKeyFingerprint: null, users: [] }),
      makeSftp({ users: [makeUser(1), makeUser(2)] }),
      makeSftp({ host: null, port: null, hostKeyFingerprint: null, users: [] }),
    ];

    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      getRequestLocale.mockResolvedValue(locale);
      for (const dto of dtoVariants) {
        serverGet.mockResolvedValueOnce({ ok: true, data: dto });
        const pageEl = await SiteSftpPage({ params: Promise.resolve({ siteId: "s1" }) });
        const pageHtml = renderHtml(m, pageEl!);
        expect(pageHtml, `${locale} page markup`).not.toMatch(SFTP_FORBIDDEN_WORDS);
      }
    }
  });

  it("maps every SFTP route error code through sftpErrorText to non-generic copy with a next step", () => {
    const enNextStep = /\b(wait|try again|choose|delete|go back|ask|sign in|manage|use)\b/i;
    const itNextStep =
      /\b(attendi|riprova|scegli|scegline|eliminane|torna|chiedi|accedi|gestire|usa)\b/i;

    const specificCodes = [
      "NOT_SUPPORTED",
      "ALREADY_EXISTS",
      "QUOTA_EXCEEDED",
      "DOCKER_ENGINE_UNAVAILABLE",
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "PERMISSION_DENIED",
      "UNAUTHENTICATED",
    ] as const;

    for (const m of [en, itMsgs]) {
      for (const code of specificCodes) {
        const text = sftpErrorText(m, code);
        expect(text, `sftpErrorText(${m === en ? "en" : "it"}, ${code})`).not.toBe(m.errors.generic);
        expect(text, `next step in ${code}`).toMatch(m === en ? enNextStep : itNextStep);
      }
    }
  });

  it("renders exactly one link to the SFTP page in the Files tab markup (in both EN and IT)", async () => {
    for (const [locale, m] of [["en", en], ["it", itMsgs]] as const) {
      getRequestLocale.mockResolvedValue(locale);

      const panelHtml = renderHtml(
        m,
        createElement(FilesPanel, {
          apiBase: "/api/bff/orgs/o1/managed-sites/s1",
          orgId: "o1",
          siteId: "s1",
          csrfToken: "csrf",
        }),
      );
      const panelLinks = panelHtml.match(/<a\b[^>]*href="\/sites\/s1\/files\/sftp"[^>]*>/g) ?? [];
      expect(panelLinks, `${locale} FilesPanel SFTP links`).toHaveLength(1);
      expect(panelHtml).toContain(m.site.files.sftpLink);

      const pageEl = await SiteFilesPage({ params: Promise.resolve({ siteId: "s1" }) });
      const pageHtml = renderHtml(m, pageEl!);
      const pageLinks = pageHtml.match(/<a\b[^>]*href="\/sites\/s1\/files\/sftp"[^>]*>/g) ?? [];
      expect(pageLinks, `${locale} SiteFilesPage SFTP links`).toHaveLength(1);
    }

    getSite.mockResolvedValueOnce({
      ok: true,
      data: { id: "s1", status: "deploying" } as unknown as SiteDetailDto,
    });
    getRequestLocale.mockResolvedValue("en");
    const deployingEl = await SiteFilesPage({ params: Promise.resolve({ siteId: "s1" }) });
    const deployingHtml = renderHtml(en, deployingEl!);
    expect(deployingHtml).not.toContain("/files/sftp");
  });
});
