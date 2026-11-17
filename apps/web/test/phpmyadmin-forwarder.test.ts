import { createHash } from "node:crypto";
import { EncryptJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import type { SessionData } from "@/lib/session";
import {
  PMA_COOKIE_MAX_AGE_S,
  PMA_COOKIE_NAME,
  PMA_COOKIE_RE,
  createPhpMyAdminForwarder,
  openPmaCookie,
  pmaPrefix,
  sealPmaCookie,
  sessionBindingId,
  type ForwarderDeps,
  type PmaCookiePayload,
} from "@/lib/phpmyadmin-forwarder";
import {
  DELETE as routeDelete,
  GET as routeGet,
  HEAD as routeHead,
  OPTIONS as routeOptions,
  PATCH as routePatch,
  POST as routePost,
  PUT as routePut,
  dynamic as routeDynamic,
  runtime as routeRuntime,
} from "@/app/phpmyadmin/[siteId]/[[...path]]/route";

const TEST_KEY = createHash("sha256").update("test-pma-secret-key-32-chars-minimum!").digest();
const OTHER_KEY = createHash("sha256").update("other-pma-secret-key-32-chars-minimum!").digest();
const SITE_ID = "site-1";
const ORG_ID = "org-1";
const API_BASE = "http://127.0.0.1:4000";
const PMA_ORIGIN = "http://127.0.0.1:8306";
const FORBIDDEN_WORDS =
  /\b(docker|container|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim)\b/i;

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    accessToken: "panel-access-token-1",
    csrfToken: "csrf-token-1",
    activeConsole: "customer",
    activeOrgSlug: "org-slug",
    user: {
      id: "user-1",
      email: "owner@example.test",
      name: "Owner",
      globalRoles: [],
      hostingAdminOrgIds: [],
      locale: "en",
      isServerAdmin: false,
      mustChangePassword: false,
    },
    ...overrides,
  };
}

function makePayload(
  session: SessionData,
  overrides: Partial<PmaCookiePayload> = {},
): PmaCookiePayload {
  return {
    siteId: SITE_ID,
    orgId: ORG_ID,
    username: "pma_0123456789ab",
    password: "SuperSecretPmaPassword1234",
    sid: sessionBindingId(session),
    ...overrides,
  };
}

function splitSetCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function createHarness(opts: {
  session?: SessionData | null;
  locale?: "it" | "en";
  secureCookies?: boolean;
  startMs?: number;
  apiHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  pmaHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
} = {}) {
  let currentNow = opts.startMs ?? 1_700_000_000_000;
  const session = opts.session === undefined ? makeSession() : opts.session;
  const apiCalls: Array<{ url: string; init?: RequestInit }> = [];
  const pmaCalls: Array<{ url: string; init?: RequestInit }> = [];

  const apiHandler =
    opts.apiHandler ??
    (() => new Response(null, { status: 204 }));
  const pmaHandler =
    opts.pmaHandler ??
    (() =>
      new Response("<html><body>phpMyAdmin OK</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }));

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(API_BASE)) {
      apiCalls.push({ url, init });
      return await apiHandler(url, init);
    }
    if (url.startsWith(PMA_ORIGIN)) {
      pmaCalls.push({ url, init });
      return await pmaHandler(url, init);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const deps: ForwarderDeps = {
    readSession: async () => session,
    cookieKey: TEST_KEY,
    apiBaseUrl: API_BASE,
    upstreamOrigin: PMA_ORIGIN,
    secureCookies: opts.secureCookies ?? false,
    locale: () => opts.locale ?? "en",
    fetch: fakeFetch,
    now: () => currentNow,
  };

  return {
    forward: createPhpMyAdminForwarder(deps),
    apiCalls,
    pmaCalls,
    advanceMs: (delta: number) => {
      currentNow += delta;
    },
    setNow: (value: number) => {
      currentNow = value;
    },
    session,
  };
}

function makeForwardReq(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    duplex?: "half";
    signal?: AbortSignal;
  } = {},
): Request {
  const reqInit: RequestInit & { duplex?: "half" } = {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    ...(init.duplex ? { duplex: init.duplex } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  };
  return new Request(url, reqInit);
}

describe("phpmyadmin-forwarder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("cookie sealing and opening", () => {
    it("round-trips a sealed hp_pma payload", async () => {
      const session = makeSession();
      const payload = makePayload(session);
      const token = await sealPmaCookie(TEST_KEY, payload);
      const opened = await openPmaCookie(TEST_KEY, token);
      expect(opened).toEqual(payload);
    });

    it("refuses cookies sealed with another key, tampered, wrong audience, bad shape, or expired", async () => {
      const session = makeSession();
      const payload = makePayload(session);
      const valid = await sealPmaCookie(TEST_KEY, payload);

      expect(await openPmaCookie(OTHER_KEY, valid)).toBeNull();
      expect(await openPmaCookie(TEST_KEY, `${valid.slice(0, -4)}AAAA`)).toBeNull();
      expect(await openPmaCookie(TEST_KEY, "not-a-jwe")).toBeNull();

      const wrongAud = await new EncryptJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setAudience("wrong-audience")
        .setIssuedAt()
        .setExpirationTime("4h")
        .encrypt(TEST_KEY);
      expect(await openPmaCookie(TEST_KEY, wrongAud)).toBeNull();

      const badShape = await new EncryptJWT({ siteId: "s1", orgId: "o1" })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setAudience("hp-phpmyadmin")
        .setIssuedAt()
        .setExpirationTime("4h")
        .encrypt(TEST_KEY);
      expect(await openPmaCookie(TEST_KEY, badShape)).toBeNull();

      const expired = await new EncryptJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setAudience("hp-phpmyadmin")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 20_000)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
        .encrypt(TEST_KEY);
      expect(await openPmaCookie(TEST_KEY, expired)).toBeNull();
    });

    it("computes deterministic 32-hex sessionBindingId from csrfToken", () => {
      const s = makeSession({ csrfToken: "abc-123" });
      expect(sessionBindingId(s)).toMatch(/^[0-9a-f]{32}$/);
      expect(sessionBindingId(s)).toBe(sessionBindingId(makeSession({ csrfToken: "abc-123" })));
      expect(sessionBindingId(s)).not.toBe(sessionBindingId(makeSession({ csrfToken: "other" })));
    });
  });

  describe("refusals before contacting phpMyAdmin", () => {
    it("returns 404 for invalid siteId shapes without calling API or phpMyAdmin", async () => {
      const h = createHarness();
      for (const badId of ["", "../etc", "a/b", "site.1", "site!1", "a".repeat(129)]) {
        const res = await h.forward(makeForwardReq(`http://localhost/phpmyadmin/bad/`), badId, []);
        expect(res.status).toBe(404);
      }
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("redirects /phpmyadmin/<siteId> without trailing slash via 308 keeping query", async () => {
      const h = createHarness();
      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}?route=/sql&db=test`),
        SITE_ID,
        [],
      );
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/?route=/sql&db=test`);
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("returns 404 on unsafe path segments (., .., %2e%2e, %5c, NUL, slash, bad percent)", async () => {
      const h = createHarness();
      const badPaths: Array<[string, string[]]> = [
        [`http://localhost/phpmyadmin/${SITE_ID}/..`, [".."]],
        [`http://localhost/phpmyadmin/${SITE_ID}/.`, ["."]],
        [`http://localhost/phpmyadmin/${SITE_ID}/%2e%2e/etc`, ["%2e%2e", "etc"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/%2e/x`, ["%2e", "x"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/a%5cb`, ["a%5cb"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/a\\b`, ["a\\b"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/a%2fb`, ["a%2fb"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/a%00b`, ["a%00b"]],
        [`http://localhost/phpmyadmin/${SITE_ID}/%ZZ`, ["%ZZ"]],
        [`http://localhost/phpmyadmin/${SITE_ID}//foo`, ["foo"]],
      ];
      for (const [url, segments] of badPaths) {
        const res = await h.forward(makeForwardReq(url), SITE_ID, segments);
        expect(res.status, url).toBe(404);
      }
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("without session: redirects page loads to /login (303) and returns 401 for non-page loads", async () => {
      const h = createHarness({ session: null });

      const navRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { "sec-fetch-mode": "navigate" },
        }),
        SITE_ID,
        [],
      );
      expect(navRes.status).toBe(303);
      expect(navRes.headers.get("location")).toBe("/login");

      const htmlRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { accept: "text/html,application/xhtml+xml" },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(htmlRes.status).toBe(303);
      expect(htmlRes.headers.get("location")).toBe("/login");

      const xhrRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: {
            accept: "application/json",
            "x-requested-with": "XMLHttpRequest",
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(xhrRes.status).toBe(401);
      expect(xhrRes.headers.get("www-authenticate")).toBeNull();

      const corsHtmlRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: {
            "sec-fetch-mode": "cors",
            accept: "text/html",
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(corsHtmlRes.status).toBe(401);

      const postRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "POST",
          headers: { accept: "text/html", origin: "http://localhost" },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(postRes.status).toBe(401);
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("enforces same-origin on every method except GET and HEAD (403)", async () => {
      const h = createHarness();
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const crossSite = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "POST",
          headers: {
            host: "localhost",
            origin: "http://localhost",
            "sec-fetch-site": "cross-site",
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(crossSite.status).toBe(403);

      const wrongOrigin = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "POST",
          headers: {
            host: "panel.example.test",
            origin: "https://evil.example.test",
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(wrongOrigin.status).toBe(403);

      const missingBoth = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "POST",
          headers: {
            host: "panel.example.test",
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(missingBoth.status).toBe(403);

      const putCrossOrigin = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "PUT",
          headers: {
            host: "panel.example.test",
            origin: "https://evil.example.test",
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(putCrossOrigin.status).toBe(403);

      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("accepts same-origin POST with Sec-Fetch-Site: same-origin or matching X-Forwarded-Host", async () => {
      const h = createHarness();
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const res = await h.forward(
        makeForwardReq(`http://127.0.0.1:3000/phpmyadmin/${SITE_ID}/index.php`, {
          method: "POST",
          headers: {
            host: "127.0.0.1:3000",
            "x-forwarded-host": "panel.example.test",
            origin: "https://panel.example.test",
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
          },
          body: "a=1",
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(res.status).toBe(200);
      expect(h.pmaCalls).toHaveLength(1);
    });

    it("refuses missing hp_pma cookie (303 tab on page load, 401 otherwise) without calling upstream", async () => {
      const h = createHarness();

      const nav = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { "sec-fetch-mode": "navigate" },
        }),
        SITE_ID,
        [],
      );
      expect(nav.status).toBe(303);
      expect(nav.headers.get("location")).toBe(`/sites/${SITE_ID}/database`);

      const xhr = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`),
        SITE_ID,
        ["index.php"],
      );
      expect(xhr.status).toBe(401);
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("clears hp_pma and refuses when cookie cannot be opened, is expired, or belongs to another session", async () => {
      const startMs = 1_700_000_000_000;
      const h = createHarness({ startMs });
      const validCookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!), startMs);
      const wrongKeyCookie = await sealPmaCookie(OTHER_KEY, makePayload(h.session!), startMs);
      const otherSessionCookie = await sealPmaCookie(
        TEST_KEY,
        makePayload(makeSession({ csrfToken: "different-csrf" })),
        startMs,
      );

      for (const badCookie of ["tampered.jwe.token", wrongKeyCookie, otherSessionCookie]) {
        const res = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
            headers: {
              "sec-fetch-mode": "navigate",
              cookie: `${PMA_COOKIE_NAME}=${badCookie}`,
            },
          }),
          SITE_ID,
          [],
        );
        expect(res.status).toBe(303);
        expect(res.headers.get("location")).toBe(`/sites/${SITE_ID}/database`);
        const setCookies = splitSetCookies(res);
        expect(setCookies.some((c) => c.startsWith(`${PMA_COOKIE_NAME}=;`) && c.includes("Max-Age=0") && c.includes(`Path=${pmaPrefix(SITE_ID)}`))).toBe(true);
      }

      // Advance forwarder clock past 4h expiry
      h.advanceMs((PMA_COOKIE_MAX_AGE_S + 5) * 1000);
      const expiredRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${validCookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(expiredRes.status).toBe(401);
      expect(
        splitSetCookies(expiredRes).some(
          (c) => c.startsWith(`${PMA_COOKIE_NAME}=;`) && c.includes("Max-Age=0"),
        ),
      ).toBe(true);

      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("returns 404 when hp_pma cookie names a different siteId", async () => {
      const h = createHarness();
      const siteACookie = await sealPmaCookie(
        TEST_KEY,
        makePayload(h.session!, { siteId: "site-A" }),
      );

      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-B/`, {
          headers: {
            "sec-fetch-mode": "navigate",
            cookie: `${PMA_COOKIE_NAME}=${siteACookie}`,
          },
        }),
        "site-B",
        [],
      );
      expect(res.status).toBe(404);
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("refuses a cookie for another organisation (API 404 or bad orgId shape) without calling phpMyAdmin", async () => {
      const h = createHarness({
        apiHandler: (url) =>
          url.includes("/organizations/org-2/")
            ? new Response(null, { status: 404 })
            : new Response(null, { status: 204 }),
      });

      const otherOrgCookie = await sealPmaCookie(
        TEST_KEY,
        makePayload(h.session!, { orgId: "org-2" }),
      );
      const resOtherOrg = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${otherOrgCookie}` },
        }),
        SITE_ID,
        [],
      );
      expect(resOtherOrg.status).toBe(404);
      expect(h.apiCalls).toHaveLength(1);
      expect(h.apiCalls[0]?.url).toContain("/organizations/org-2/");
      expect(h.pmaCalls).toHaveLength(0);

      const badOrgCookie = await sealPmaCookie(
        TEST_KEY,
        makePayload(h.session!, { orgId: "org/../bad" }),
      );
      const resBadOrg = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${badOrgCookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(resBadOrg.status).toBe(401);
      expect(
        splitSetCookies(resBadOrg).some(
          (c) => c.startsWith(`${PMA_COOKIE_NAME}=;`) && c.includes("Max-Age=0"),
        ),
      ).toBe(true);
      expect(h.apiCalls).toHaveLength(1);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("returns 405 on unused methods even with valid session, origin, and cookie", async () => {
      const h = createHarness();
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          method: "PUT",
          headers: {
            host: "localhost",
            origin: "http://localhost",
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
          },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
      expect(h.apiCalls).toHaveLength(0);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("returns 503 localized page when API rights check throws or returns 5xx", async () => {
      const h = createHarness({
        locale: "it",
        apiHandler: () => {
          throw new Error("API connection refused");
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        [],
      );
      expect(res.status).toBe(503);
      const html = await res.text();
      expect(html).toContain(itMsgs.site.database.phpmyadmin.downTitle);
      expect(html).toContain(itMsgs.site.database.phpmyadmin.downBody);
      expect(html).toContain(itMsgs.site.database.phpmyadmin.backToDatabases);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("maps API rights answers: 403/404 -> 404, 401 -> login/401, 5xx/error -> 503", async () => {
      let apiStatus = 403;
      const h = createHarness({
        apiHandler: () => new Response(null, { status: apiStatus }),
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const baseHeaders = { cookie: `${PMA_COOKIE_NAME}=${cookie}` };

      apiStatus = 403;
      const r403 = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { ...baseHeaders, "sec-fetch-mode": "navigate" },
        }),
        SITE_ID,
        [],
      );
      expect(r403.status).toBe(404);

      apiStatus = 404;
      const r404 = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, { headers: baseHeaders }),
        SITE_ID,
        [],
      );
      expect(r404.status).toBe(404);

      apiStatus = 401;
      const r401Nav = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { ...baseHeaders, "sec-fetch-mode": "navigate" },
        }),
        SITE_ID,
        [],
      );
      expect(r401Nav.status).toBe(303);
      expect(r401Nav.headers.get("location")).toBe("/login");

      const r401Xhr = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, { headers: baseHeaders }),
        SITE_ID,
        ["index.php"],
      );
      expect(r401Xhr.status).toBe(401);

      apiStatus = 500;
      const r500 = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, { headers: baseHeaders }),
        SITE_ID,
        [],
      );
      expect(r500.status).toBe(503);
      expect(h.pmaCalls).toHaveLength(0);
    });

    it("on API 403/404 page load: returns 404 panel HTML in en and it with back link, and keeps 404 empty body for XHR", async () => {
      for (const [locale, expectedBody, backLabel] of [
        [
          "en",
          "You no longer have access to this site's databases.",
          en.site.database.phpmyadmin.backToDatabases,
        ],
        [
          "it",
          "Non hai più accesso ai database di questo sito.",
          itMsgs.site.database.phpmyadmin.backToDatabases,
        ],
      ] as const) {
        const h = createHarness({
          locale,
          apiHandler: () => new Response(null, { status: 403 }),
        });
        const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

        const navRes = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
            headers: {
              cookie: `${PMA_COOKIE_NAME}=${cookie}`,
              "sec-fetch-mode": "navigate",
            },
          }),
          SITE_ID,
          [],
        );
        expect(navRes.status).toBe(404);
        expect(navRes.headers.get("content-type")).toContain("text/html");
        const html = await navRes.text();
        expect(html).toContain(expectedBody);
        expect(html).toContain(`/sites/${SITE_ID}/database`);
        expect(html).toContain(backLabel);
        expect(html).not.toMatch(FORBIDDEN_WORDS);

        const xhrRes = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
            headers: {
              cookie: `${PMA_COOKIE_NAME}=${cookie}`,
              "x-requested-with": "XMLHttpRequest",
            },
          }),
          SITE_ID,
          ["index.php"],
        );
        expect(xhrRes.status).toBe(404);
        expect(await xhrRes.text()).toBe("");
      }
    });
  });

  describe("rights cache", () => {
    it("caches API 204 for 30 s per session and site, expires after 30 s, and never caches refusals", async () => {
      let apiStatus = 204;
      const h = createHarness({
        startMs: 1_700_000_000_000,
        apiHandler: () => new Response(null, { status: apiStatus }),
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const req = () =>
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        });

      expect((await h.forward(req(), SITE_ID, ["index.php"])).status).toBe(200);
      expect(h.apiCalls).toHaveLength(1);
      expect(h.apiCalls[0]?.url).toBe(
        `${API_BASE}/v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/databases/phpmyadmin`,
      );
      const authHeaders = new Headers(h.apiCalls[0]?.init?.headers);
      expect(authHeaders.get("authorization")).toBe(`Bearer ${h.session!.accessToken}`);

      // Within 30 s -> cached
      h.advanceMs(29_999);
      expect((await h.forward(req(), SITE_ID, ["index.php"])).status).toBe(200);
      expect(h.apiCalls).toHaveLength(1);
      expect(h.pmaCalls).toHaveLength(2);

      // Past 30 s -> re-checks API
      h.advanceMs(1);
      expect((await h.forward(req(), SITE_ID, ["index.php"])).status).toBe(200);
      expect(h.apiCalls).toHaveLength(2);

      // Next expiry gets 403 -> refused AND never cached
      h.advanceMs(30_001);
      apiStatus = 403;
      expect((await h.forward(req(), SITE_ID, ["index.php"])).status).toBe(404);
      expect(h.apiCalls).toHaveLength(3);

      apiStatus = 204;
      expect((await h.forward(req(), SITE_ID, ["index.php"])).status).toBe(200);
      expect(h.apiCalls).toHaveLength(4);
    });

    it("caps rights cache at 1000 entries, evicting the oldest while keeping the newest", async () => {
      const h = createHarness({ startMs: 1_700_000_000_000 });
      const cookies: Array<{ siteId: string; cookie: string }> = [];
      for (let i = 0; i <= 1000; i += 1) {
        const siteId = `site-${i}`;
        cookies.push({
          siteId,
          cookie: await sealPmaCookie(TEST_KEY, makePayload(h.session!, { siteId })),
        });
      }

      for (let i = 0; i < 1000; i += 1) {
        const entry = cookies[i]!;
        const res = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${entry.siteId}/index.php`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${entry.cookie}` },
          }),
          entry.siteId,
          ["index.php"],
        );
        expect(res.status).toBe(200);
      }
      expect(h.apiCalls).toHaveLength(1000);

      // First and last cached entries still hit cache before overflow
      await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-0/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[0]!.cookie}` },
        }),
        "site-0",
        ["index.php"],
      );
      await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-999/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[999]!.cookie}` },
        }),
        "site-999",
        ["index.php"],
      );
      expect(h.apiCalls).toHaveLength(1000);

      // 1001st distinct entry evicts site-0 (oldest) while leaving site-999 (newest prior) cached
      const overflowRes = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-1000/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[1000]!.cookie}` },
        }),
        "site-1000",
        ["index.php"],
      );
      expect(overflowRes.status).toBe(200);
      expect(h.apiCalls).toHaveLength(1001);

      await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-999/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[999]!.cookie}` },
        }),
        "site-999",
        ["index.php"],
      );
      await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-1000/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[1000]!.cookie}` },
        }),
        "site-1000",
        ["index.php"],
      );
      expect(h.apiCalls).toHaveLength(1001);

      await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/site-0/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookies[0]!.cookie}` },
        }),
        "site-0",
        ["index.php"],
      );
      expect(h.apiCalls).toHaveLength(1002);
    });
  });

  describe("outbound request forwarding and streaming", () => {
    it("sets Basic auth, X-Forwarded-Prefix, X-Forwarded-Proto, filters cookies and headers", async () => {
      const h = createHarness({ secureCookies: true });
      const payload = makePayload(h.session!, {
        username: "pma_abcdef012345",
        password: "PasswordValue987654321012",
      });
      const pmaJwe = await sealPmaCookie(TEST_KEY, payload);

      const res = await h.forward(
        makeForwardReq(
          `http://panel.example.test/phpmyadmin/${SITE_ID}/index.php?route=/database/structure&db=wp_1`,
          {
            method: "POST",
            headers: {
              host: "panel.example.test",
              origin: "https://panel.example.test",
              "sec-fetch-site": "same-origin",
              authorization: "Bearer client-secret-should-drop",
              "x-forwarded-for": "1.2.3.4",
              "x-forwarded-prefix": "/evil/",
              "x-forwarded-proto": "http",
              "x-csrf-token": "secret-csrf",
              accept: "application/json",
              "accept-language": "it-IT",
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "VitestClient/1.0",
              "x-requested-with": "XMLHttpRequest",
              cookie: [
                "hp_session=panel-session-secret",
                `${PMA_COOKIE_NAME}=${pmaJwe}`,
                "hp_csrf=csrf-cookie",
                "phpMyAdmin=pma-sid-123",
                "pma_lang=it",
                "__Secure-phpMyAdmin_https=pma-sec-456",
              ].join("; "),
            },
            body: "token=abc",
          },
        ),
        SITE_ID,
        ["index.php"],
      );

      expect(res.status).toBe(200);
      expect(h.pmaCalls).toHaveLength(1);
      const call = h.pmaCalls[0]!;
      expect(call.url).toBe(`${PMA_ORIGIN}/index.php?route=/database/structure&db=wp_1`);
      expect(call.init?.redirect).toBe("manual");

      const sentHeaders = new Headers(call.init?.headers);
      expect(sentHeaders.get("authorization")).toBe(
        `Basic ${Buffer.from(`${payload.username}:${payload.password}`, "utf8").toString("base64")}`,
      );
      expect(sentHeaders.get("x-forwarded-prefix")).toBe(`/phpmyadmin/${SITE_ID}/`);
      expect(sentHeaders.get("x-forwarded-proto")).toBe("https");
      expect(sentHeaders.get("accept-encoding")).toBe("identity");
      expect(sentHeaders.get("accept")).toBe("application/json");
      expect(sentHeaders.get("accept-language")).toBe("it-IT");
      expect(sentHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(sentHeaders.get("user-agent")).toBe("VitestClient/1.0");
      expect(sentHeaders.get("x-requested-with")).toBe("XMLHttpRequest");
      expect(sentHeaders.get("x-forwarded-for")).toBeNull();
      expect(sentHeaders.get("x-csrf-token")).toBeNull();
      expect(sentHeaders.get("origin")).toBeNull();

      const cookieSent = sentHeaders.get("cookie") ?? "";
      expect(cookieSent).toContain("phpMyAdmin=pma-sid-123");
      expect(cookieSent).toContain("pma_lang=it");
      expect(cookieSent).toContain("__Secure-phpMyAdmin_https=pma-sec-456");
      expect(cookieSent).not.toContain("hp_session");
      expect(cookieSent).not.toContain("hp_pma");
      expect(cookieSent).not.toContain("hp_csrf");
    });

    it("streams upload body whole without buffering", async () => {
      const captured: { bytes: Uint8Array | null } = { bytes: null };
      let sawDuplex: string | undefined;
      let sawStreamBody = false;

      const h = createHarness({
        pmaHandler: async (_url, init) => {
          sawDuplex = (init as RequestInit & { duplex?: string } | undefined)?.duplex;
          sawStreamBody = init?.body instanceof ReadableStream;
          const ab = await new Response(init?.body).arrayBuffer();
          captured.bytes = new Uint8Array(ab);
          return new Response("imported", { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const chunk1 = new Uint8Array(32_768).fill(0x41);
      const chunk2 = new Uint8Array(32_768).fill(0x42);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });

      const req = makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?route=/import`, {
        method: "POST",
        headers: {
          host: "localhost",
          origin: "http://localhost",
          "sec-fetch-site": "same-origin",
          "content-type": "multipart/form-data; boundary=xyz",
          cookie: `${PMA_COOKIE_NAME}=${cookie}`,
        },
        body: stream,
        duplex: "half",
      });

      const res = await h.forward(req, SITE_ID, ["index.php"]);
      expect(res.status).toBe(200);
      expect(sawDuplex).toBe("half");
      expect(sawStreamBody).toBe(true);
      expect(captured.bytes?.byteLength).toBe(65_536);
      expect(captured.bytes?.[0]).toBe(0x41);
      expect(captured.bytes?.[65_535]).toBe(0x42);
    });
  });

  describe("response shaping and errors", () => {
    it("drops hop-by-hop, content-encoding, content-length, www-authenticate and rewrites Set-Cookie and Location", async () => {
      const h = createHarness({
        pmaHandler: () => {
          const headers = new Headers();
          headers.set("content-type", "text/html; charset=utf-8");
          headers.set("content-encoding", "gzip");
          headers.set("content-length", "999");
          headers.set("www-authenticate", 'Basic realm="phpMyAdmin"');
          headers.set("connection", "keep-alive, x-hop-extra");
          headers.set("keep-alive", "timeout=5");
          headers.set("transfer-encoding", "chunked");
          headers.set("x-hop-extra", "secret");
          headers.set("location", "https://evil.example.test/steal");
          headers.append("set-cookie", "phpMyAdmin=sess1; path=/; HttpOnly; SameSite=Strict");
          headers.append("set-cookie", "pma_lang=en; Max-Age=2592000; path=/foo; Domain=evil.test; HttpOnly");
          headers.append("set-cookie", "hp_session=hijack; path=/; HttpOnly");
          headers.append("set-cookie", "other=bad; path=/");
          return new Response("redirecting", { status: 302, headers });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(res.headers.get("connection")).toBeNull();
      expect(res.headers.get("keep-alive")).toBeNull();
      expect(res.headers.get("transfer-encoding")).toBeNull();
      expect(res.headers.get("x-hop-extra")).toBeNull();
      expect(res.headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/`);

      const outCookies = splitSetCookies(res);
      expect(outCookies).toHaveLength(2);
      expect(outCookies[0]).toContain("phpMyAdmin=sess1");
      expect(outCookies[0]).toContain(`Path=/phpmyadmin/${SITE_ID}/`);
      expect(outCookies[1]).toContain("pma_lang=en");
      expect(outCookies[1]).toContain(`Path=/phpmyadmin/${SITE_ID}/`);
      expect(outCookies[1]).not.toMatch(/domain=/i);
      expect(outCookies.join("\n")).not.toContain("hp_session");
      expect(outCookies.join("\n")).not.toContain("other=bad");
    });

    it("strips Set-Cookie Path and Domain attributes when whitespace surrounds =", async () => {
      const h = createHarness({
        pmaHandler: () => {
          const headers = new Headers();
          headers.append("set-cookie", "phpMyAdmin=sess2; Path = /; Domain = x; HttpOnly; SameSite=Strict");
          return new Response("ok", { status: 200, headers });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      const outCookies = splitSetCookies(res);
      expect(outCookies).toHaveLength(1);
      expect(outCookies[0]).toContain("phpMyAdmin=sess2");
      expect(outCookies[0]).toContain(`Path=/phpmyadmin/${SITE_ID}/`);
      expect(outCookies[0]).toContain("HttpOnly");
      expect(outCookies[0]).not.toMatch(/path\s*=\s*\/(?=[;\s]|$)/i);
      expect(outCookies[0]).not.toMatch(/domain\s*=/i);
    });

    it("ensures X-Frame-Options: SAMEORIGIN when upstream omits it, keeps upstream X-Frame-Options, and leaves upstream CSP untouched", async () => {
      let nextHeaders: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
      const h = createHarness({
        pmaHandler: () => new Response("ok", { status: 200, headers: nextHeaders }),
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const send = () =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );

      const withoutUpstream = await send();
      expect(withoutUpstream.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(withoutUpstream.headers.get("content-security-policy")).toBeNull();

      nextHeaders = {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'",
      };
      const withUpstream = await send();
      expect(withUpstream.headers.get("x-frame-options")).toBe("DENY");
      expect(withUpstream.headers.get("content-security-policy")).toBe(
        "default-src 'self'; script-src 'self' 'unsafe-inline'",
      );
    });

    it("keeps safe Location (under prefix or relative) and replaces foreign paths", async () => {
      let nextLocation = `/phpmyadmin/${SITE_ID}/index.php?route=/&reload=1`;
      const h = createHarness({
        pmaHandler: () =>
          new Response(null, { status: 302, headers: { location: nextLocation } }),
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
      const send = () =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );

      expect((await send()).headers.get("location")).toBe(
        `/phpmyadmin/${SITE_ID}/index.php?route=/&reload=1`,
      );

      nextLocation = "index.php?route=/sql";
      expect((await send()).headers.get("location")).toBe("index.php?route=/sql");

      nextLocation = "/index.php?route=/";
      expect((await send()).headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/`);

      nextLocation = `/phpmyadmin/other-site/index.php`;
      expect((await send()).headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/`);

      nextLocation = `/phpmyadmin/${SITE_ID}/../other/index.php`;
      expect((await send()).headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/`);

      nextLocation = "//evil.test/x";
      expect((await send()).headers.get("location")).toBe(`/phpmyadmin/${SITE_ID}/`);
    });

    it("handles 304 and 206 responses cleanly", async () => {
      let nextStatus = 304;
      const h = createHarness({
        pmaHandler: () =>
          nextStatus === 304
            ? new Response(null, { status: 304, headers: { etag: '"abc"' } })
            : new Response("part", {
                status: 206,
                headers: { "content-range": "bytes 0-3/10" },
              }),
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const r304 = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/js/main.js`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["js", "main.js"],
      );
      expect(r304.status).toBe(304);
      expect(r304.headers.get("etag")).toBe('"abc"');

      nextStatus = 206;
      const r206 = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/js/main.js`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}`, range: "bytes=0-3" },
        }),
        SITE_ID,
        ["js", "main.js"],
      );
      expect(r206.status).toBe(206);
      expect(await r206.text()).toBe("part");
    });

    it("on upstream 401: clears hp_pma, strips www-authenticate, returns panel short page with back link and no secrets", async () => {
      const h = createHarness({
        secureCookies: true,
        locale: "en",
        pmaHandler: () =>
          new Response("Access denied! secret-upstream-byte", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="phpMyAdmin"' },
          }),
      });
      const payload = makePayload(h.session!, {
        username: "pma_secretuser01",
        password: "VerySecretPassword999999",
      });
      const cookie = await sealPmaCookie(TEST_KEY, payload);

      const res = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        [],
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
      const setCookies = splitSetCookies(res);
      expect(
        setCookies.some(
          (c) =>
            c.startsWith(`${PMA_COOKIE_NAME}=;`) &&
            c.includes("Max-Age=0") &&
            c.includes(`Path=/phpmyadmin/${SITE_ID}/`) &&
            c.includes("Secure") &&
            c.includes("HttpOnly") &&
            c.includes("SameSite=Strict"),
        ),
      ).toBe(true);

      const html = await res.text();
      expect(html).toContain(`/sites/${SITE_ID}/database`);
      expect(html).toContain(en.site.database.phpmyadmin.backToDatabases);
      expect(html).not.toContain("Access denied");
      expect(html).not.toContain("secret-upstream-byte");
      expect(html).not.toContain(payload.username);
      expect(html).not.toContain(payload.password);
      expect(html).not.toContain(
        Buffer.from(`${payload.username}:${payload.password}`, "utf8").toString("base64"),
      );
      expect(html).not.toMatch(FORBIDDEN_WORDS);
    });

    it("on upstream 401: mentions another session may have opened phpMyAdmin in both en and it", async () => {
      for (const [locale, expectedSentence, backLabel] of [
        [
          "en",
          "Someone else may have opened phpMyAdmin for this site.",
          en.site.database.phpmyadmin.backToDatabases,
        ],
        [
          "it",
          "Qualcun altro potrebbe aver aperto phpMyAdmin per questo sito.",
          itMsgs.site.database.phpmyadmin.backToDatabases,
        ],
      ] as const) {
        const h = createHarness({
          locale,
          pmaHandler: () => new Response("Access denied", { status: 401 }),
        });
        const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));
        const res = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          [],
        );
        expect(res.status).toBe(401);
        const html = await res.text();
        expect(html).toContain(expectedSentence);
        expect(html).toContain(backLabel);
        expect(html).toContain(`/sites/${SITE_ID}/database`);
        expect(html).not.toMatch(FORBIDDEN_WORDS);
      }
    });

    it("on upstream error: returns 503 panel page in en and it with catalog keys and zero forbidden words", async () => {
      const enTexts = en.site.database.phpmyadmin;
      const itTexts = itMsgs.site.database.phpmyadmin;

      for (const [locale, texts] of [
        ["en", enTexts],
        ["it", itTexts],
      ] as const) {
        const h = createHarness({
          locale,
          pmaHandler: () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:8306");
          },
        });
        const payload = makePayload(h.session!);
        const cookie = await sealPmaCookie(TEST_KEY, payload);

        const res = await h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          [],
        );

        expect(res.status).toBe(503);
        expect(res.headers.get("content-type")).toContain("text/html");
        const html = await res.text();
        expect(html).toContain(texts.downTitle);
        expect(html).toContain(texts.downBody);
        expect(html).toContain(texts.backToDatabases);
        expect(html).toContain(`/sites/${SITE_ID}/database`);
        expect(html).not.toContain("ECONNREFUSED");
        expect(html).not.toContain(payload.username);
        expect(html).not.toContain(payload.password);
        expect(html).not.toMatch(FORBIDDEN_WORDS);
      }
    });
  });

  describe("per-site worker concurrency", () => {
    const realSetImmediate = globalThis.setImmediate;
    const realSetTimeout = globalThis.setTimeout;
    const realHrtimeNs = process.hrtime.bigint;

    afterEach(() => {
      vi.useRealTimers();
    });

    interface Deferred<T> {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason?: unknown) => void;
    }

    function createDeferred<T>(): Deferred<T> {
      let resolve!: (value: T) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    function createControllableStream() {
      const encoder = new TextEncoder();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          controller = ctrl;
        },
        cancel() {
          canceled = true;
        },
      });
      return {
        stream,
        push: (text: string) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        error: (err: unknown) => controller.error(err),
        get canceled() {
          return canceled;
        },
      };
    }

    async function flushWork(turns = 6): Promise<void> {
      for (let i = 0; i < turns; i += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
    }

    async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
      const deadlineNs = realHrtimeNs() + BigInt(timeoutMs) * 1_000_000n;
      let step = 0;
      while (!predicate()) {
        if (realHrtimeNs() > deadlineNs) {
          throw new Error("Timed out waiting for test condition");
        }
        if (step < 10) {
          await new Promise<void>((resolve) => realSetImmediate(resolve));
        } else {
          await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
        }
        step += 1;
      }
    }

    function trackQueueWaits(): () => number {
      const spy = vi.spyOn(globalThis, "setTimeout");
      return () => spy.mock.calls.filter(([, delay]) => delay === 30_000).length;
    }

    it("caps one site at 2 in-flight requests and dispatches waiting requests in FIFO order", async () => {
      const queueWaits = trackQueueWaits();
      const upstreams = new Map<string, Deferred<Response>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: (url) => {
          const reqTag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(reqTag);
          const deferred = createDeferred<Response>();
          upstreams.set(reqTag, deferred);
          return deferred.promise;
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const sendReq = (tag: string) =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=${tag}`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );

      const p1 = sendReq("1");
      await waitUntil(() => sentOrder.length >= 1);
      const p2 = sendReq("2");
      await waitUntil(() => sentOrder.length >= 2);
      const p3 = sendReq("3");
      await waitUntil(() => queueWaits() >= 1);
      const p4 = sendReq("4");
      await waitUntil(() => queueWaits() >= 2);

      expect(sentOrder).toEqual(["1", "2"]);
      expect(upstreams.has("3")).toBe(false);
      expect(upstreams.has("4")).toBe(false);

      // Finish request 2 first -> request 3 must start next (FIFO), not request 4.
      upstreams.get("2")!.resolve(new Response("body-2", { status: 200 }));
      const r2 = await p2;
      expect(await r2.text()).toBe("body-2");
      await waitUntil(() => sentOrder.length >= 3);

      expect(sentOrder).toEqual(["1", "2", "3"]);
      expect(upstreams.has("4")).toBe(false);

      // Finish request 1 -> request 4 starts.
      upstreams.get("1")!.resolve(new Response("body-1", { status: 200 }));
      const r1 = await p1;
      expect(await r1.text()).toBe("body-1");
      await waitUntil(() => sentOrder.length >= 4);

      expect(sentOrder).toEqual(["1", "2", "3", "4"]);

      upstreams.get("3")!.resolve(new Response("body-3", { status: 200 }));
      upstreams.get("4")!.resolve(new Response("body-4", { status: 200 }));
      const [r3, r4] = await Promise.all([p3, p4]);
      expect(await r3.text()).toBe("body-3");
      expect(await r4.text()).toBe("body-4");
    });

    it("releases only after full body read for streamed responses, and immediately for HEAD, 204, 304, and redirects", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: (url, init) => {
          const parsed = new URL(url);
          const tag = parsed.searchParams.get("req") ?? "";
          sentOrder.push(tag);
          if (tag === "head") {
            expect(init?.method).toBe("HEAD");
            return new Response(null, { status: 200 });
          }
          if (tag === "204") {
            return new Response(null, { status: 204 });
          }
          if (tag === "304") {
            return new Response(null, { status: 304 });
          }
          if (tag === "302") {
            // Even if upstream attached a body, a redirect gives the slot back at once.
            const s = createControllableStream();
            streams.set(tag, s);
            return new Response(s.stream, {
              status: 302,
              headers: { location: `/phpmyadmin/${SITE_ID}/index.php` },
            });
          }
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const send = (tag: string, method = "GET") =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=${tag}`, {
            method,
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );

      const p1 = send("stream-1");
      await waitUntil(() => sentOrder.length >= 1);
      const p2 = send("stream-2");
      await waitUntil(() => sentOrder.length >= 2);
      const pWait = send("queued");
      await waitUntil(() => queueWaits() >= 1);
      await flushWork();

      const r1 = await p1;
      await p2;
      const reader1 = r1.body!.getReader();
      streams.get("stream-1")!.push("chunk-1");
      const firstRead = await reader1.read();
      expect(new TextDecoder().decode(firstRead.value)).toBe("chunk-1");
      await flushWork();
      expect(sentOrder).toEqual(["stream-1", "stream-2"]);

      streams.get("stream-1")!.close();
      expect((await reader1.read()).done).toBe(true);
      await waitUntil(() => sentOrder.length >= 3);
      expect(sentOrder).toEqual(["stream-1", "stream-2", "queued"]);

      // Keep "stream-2" open (holding 1 slot), finish "queued".
      streams.get("queued")!.close();
      await (await pWait).text();
      await flushWork();

      // Now verify HEAD, 204, 304, and 302 each release their slot before body consumption.
      const resHead = await send("head", "HEAD");
      expect(resHead.status).toBe(200);
      const res204 = await send("204");
      expect(res204.status).toBe(204);
      const res304 = await send("304");
      expect(res304.status).toBe(304);
      const res302 = await send("302");
      expect(res302.status).toBe(302);

      // Slot 2 must still be completely free right now while stream-2 occupies slot 1.
      const pAfter = send("after-redirects");
      await waitUntil(() => sentOrder.includes("after-redirects"));
      expect(sentOrder).toContain("after-redirects");

      streams.get("stream-2")!.close();
      streams.get("after-redirects")!.close();
      streams.get("302")?.close();
      await (await pAfter).text();
    });

    it("does not abort upstream or free the slot when the client cancels reading the response body", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];
      const seenSignals: Array<AbortSignal | null | undefined> = [];

      const h = createHarness({
        pmaHandler: (url, init) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          seenSignals.push(init?.signal);
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const p1 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=1`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 1);
      const p2 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=2`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 2);
      const p3 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=3`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => queueWaits() >= 1);
      await flushWork();

      expect(sentOrder).toEqual(["1", "2"]);
      expect(seenSignals[0]).toBeUndefined();
      expect(seenSignals[1]).toBeUndefined();

      const res1 = await p1;
      await p2;
      const reader1 = res1.body!.getReader();
      streams.get("1")!.push("part-a");
      expect(new TextDecoder().decode((await reader1.read()).value)).toBe("part-a");

      // Client navigates away mid-stream.
      await reader1.cancel("browser closed");
      await flushWork();

      expect(streams.get("1")!.canceled).toBe(false);
      expect(sentOrder).toEqual(["1", "2"]);

      // Only once upstream finishes pushing and closes the body does request 3 advance.
      streams.get("1")!.push("part-b");
      streams.get("1")!.close();
      await waitUntil(() => sentOrder.length >= 3);
      expect(sentOrder).toEqual(["1", "2", "3"]);

      streams.get("2")!.close();
      streams.get("3")!.close();
      await (await p3).text();
    });

    it("keeps upstream running and holds its slot when UPSTREAM_HEADERS_TIMEOUT_MS expires", async () => {
      vi.useFakeTimers();
      const upstreams = new Map<string, Deferred<Response>>();
      const sentOrder: string[] = [];
      const seenSignals: Array<AbortSignal | null | undefined> = [];

      const h = createHarness({
        locale: "en",
        pmaHandler: (url, init) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          seenSignals.push(init?.signal);
          const deferred = createDeferred<Response>();
          upstreams.set(tag, deferred);
          return deferred.promise;
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const send = (tag: string, page = false, signal?: AbortSignal) =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=${tag}`, {
            headers: {
              cookie: `${PMA_COOKIE_NAME}=${cookie}`,
              ...(page ? { "sec-fetch-mode": "navigate" } : {}),
            },
            ...(signal ? { signal } : {}),
          }),
          SITE_ID,
          ["index.php"],
        );

      const p1 = send("slow-headers", true);
      await waitUntil(() => sentOrder.length >= 1);
      expect(sentOrder).toEqual(["slow-headers"]);
      expect(seenSignals[0]).toBeUndefined();

      // Exceed 310s UPSTREAM_HEADERS_TIMEOUT_MS -> browser gets 503 still-working page.
      await vi.advanceTimersByTimeAsync(310_000);
      const r1 = await p1;
      expect(r1.status).toBe(503);
      expect(seenSignals[0]).toBeUndefined();

      // slow-headers still holds slot 1: req 2 fills slot 2 and req 3 waits.
      const abortInFlight2 = new AbortController();
      const p2 = send("in-flight-2", false, abortInFlight2.signal);
      await waitUntil(() => sentOrder.length >= 2);
      const p3 = send("waiting-3");
      await waitUntil(() => vi.getTimerCount() >= 2);
      await flushWork();
      expect(sentOrder).toEqual(["slow-headers", "in-flight-2"]);

      await vi.advanceTimersByTimeAsync(5_000);
      await flushWork();
      expect(sentOrder).toEqual(["slow-headers", "in-flight-2"]);

      // Browser disconnecting on req 2 while headers are still pending also keeps slot 2 held until req 2 ends.
      abortInFlight2.abort(new Error("client closed tab while waiting headers"));
      const r2 = await p2;
      expect(r2.status).toBe(503);
      expect(seenSignals[1]).toBeUndefined();

      // Upstream finally sends headers for slow-headers with a stream -> slot stays held until body ends.
      const lateStream = createControllableStream();
      upstreams.get("slow-headers")!.resolve(new Response(lateStream.stream, { status: 200 }));
      lateStream.push("ignored-late-chunk");
      await flushWork();
      expect(sentOrder).toEqual(["slow-headers", "in-flight-2"]);

      lateStream.close();
      await waitUntil(() => sentOrder.length >= 3);
      expect(sentOrder).toEqual(["slow-headers", "in-flight-2", "waiting-3"]);

      // Finish detached in-flight-2 + waiting-3 cleanly.
      upstreams.get("in-flight-2")!.resolve(new Response("ok2", { status: 200 }));
      upstreams.get("waiting-3")!.resolve(new Response("ok3", { status: 200 }));
      await (await p3).text();
    });

    it("uses upstreamFetch for phpMyAdmin, serves localized 'still working' page after 310s, and holds the slot until upstream finishes", async () => {
      vi.useFakeTimers();

      for (const locale of ["en", "it"] as const) {
        const queueWaits = trackQueueWaits();
        const apiCalls: string[] = [];
        const upstreamSent: string[] = [];
        const upstreams = new Map<string, Deferred<Response>>();
        const session = makeSession();
        const cookie = await sealPmaCookie(TEST_KEY, makePayload(session));

        const apiOnlyFetch: typeof fetch = async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          if (!url.startsWith(API_BASE)) {
            throw new Error(`deps.fetch should not be called for upstream: ${url}`);
          }
          apiCalls.push(url);
          return new Response(null, { status: 204 });
        };

        const upstreamFetch: typeof fetch = (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
          const tag = new URL(url).searchParams.get("req") ?? "";
          upstreamSent.push(tag);
          const d = createDeferred<Response>();
          upstreams.set(tag, d);
          return d.promise;
        };

        const forward = createPhpMyAdminForwarder({
          readSession: async () => session,
          cookieKey: TEST_KEY,
          apiBaseUrl: API_BASE,
          upstreamOrigin: PMA_ORIGIN,
          secureCookies: false,
          locale: () => locale,
          fetch: apiOnlyFetch,
          upstreamFetch,
        });

        const send = (tag: string, page: boolean) =>
          forward(
            makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=${tag}`, {
              headers: {
                cookie: `${PMA_COOKIE_NAME}=${cookie}`,
                ...(page ? { "sec-fetch-mode": "navigate" } : { accept: "application/json" }),
              },
            }),
            SITE_ID,
            ["index.php"],
          );

        const p1 = send("slow-page", true);
        await waitUntil(() => upstreamSent.length >= 1);
        const p2 = send("slow-xhr", false);
        await waitUntil(() => upstreamSent.length >= 2);
        expect(upstreamSent).toEqual(["slow-page", "slow-xhr"]);
        expect(apiCalls.length).toBeGreaterThanOrEqual(1);

        // Advance past 310s UPSTREAM_HEADERS_TIMEOUT_MS: both slots detach.
        await vi.advanceTimersByTimeAsync(310_000);
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.status).toBe(503);
        const html = await r1.text();
        expect(html).not.toMatch(FORBIDDEN_WORDS);
        expect(html).toContain(`/sites/${SITE_ID}/database`);
        if (locale === "en") {
          expect(html).toContain("phpMyAdmin is still working");
          expect(html).toContain(
            "Your last request is taking more than 5 minutes and is still running. Don't send it again. Wait for it to finish, or open phpMyAdmin again from the Database tab to stop it.",
          );
        } else {
          expect(html).toContain("phpMyAdmin sta ancora lavorando");
          expect(html).toContain(
            "La tua ultima richiesta richiede più di 5 minuti ed è ancora in corso. Non inviarla di nuovo. Attendi che finisca oppure riapri phpMyAdmin dalla scheda Database per interromperla.",
          );
        }
        expect(r2.status).toBe(503);
        expect(await r2.text()).toBe("");

        // A third request for the same site waits and is NOT dispatched to upstreamFetch.
        const p3 = send("third", false);
        await waitUntil(() => queueWaits() >= 1);
        await flushWork();
        expect(upstreamSent).toEqual(["slow-page", "slow-xhr"]);

        // Resolving headers alone keeps slot 1 held while the body stream is still open.
        const lateStream = createControllableStream();
        upstreams.get("slow-page")!.resolve(new Response(lateStream.stream, { status: 200 }));
        lateStream.push("chunk");
        await flushWork();
        expect(upstreamSent).toEqual(["slow-page", "slow-xhr"]);

        // Reading the pending call's body to EOF releases slot 1 and lets req 3 through.
        lateStream.close();
        await waitUntil(() => upstreamSent.length >= 3);
        expect(upstreamSent).toEqual(["slow-page", "slow-xhr", "third"]);

        upstreams.get("third")!.resolve(new Response("third-ok", { status: 200 }));
        const r3 = await p3;
        expect(r3.status).toBe(200);
        expect(await r3.text()).toBe("third-ok");

        upstreams.get("slow-xhr")!.resolve(new Response("xhr-done", { status: 200 }));
        await flushWork();
      }
    });

    it("releases the slot on upstream fetch rejection, body stream error, and upload abort failure", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: async (url, init) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          if (tag === "fetch-reject") {
            throw new Error("ECONNRESET");
          }
          if (tag === "upload-fail") {
            const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
            while (true) {
              const { done } = await reader.read();
              if (done) break;
            }
            return new Response("uploaded", { status: 200 });
          }
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const pHold = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=hold`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.includes("hold"));

      // 1) Fetch rejects immediately.
      const resReject = await h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=fetch-reject`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(resReject.status).toBe(503);

      // 2) Upstream body stream errors mid-stream -> releases slot.
      const pStreamErr = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=stream-err`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.includes("stream-err"));
      const resStreamErr = await pStreamErr;
      const errReadPromise = resStreamErr.text().catch((err: unknown) => err);
      streams.get("stream-err")!.error(new Error("premature upstream close"));
      await expect(errReadPromise).resolves.toBeInstanceOf(Error);
      await flushWork();

      // 3) Upload stream errors when browser drops -> fetch rejects -> releases slot.
      let uploadCtrl!: ReadableStreamDefaultController<Uint8Array>;
      const uploadBody = new ReadableStream<Uint8Array>({
        start(ctrl) {
          uploadCtrl = ctrl;
        },
      });
      const pUpload = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=upload-fail`, {
          method: "POST",
          headers: {
            cookie: `${PMA_COOKIE_NAME}=${cookie}`,
            origin: "http://localhost",
          },
          body: uploadBody,
          duplex: "half",
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.includes("upload-fail"));

      const pAfter = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=after-failures`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => queueWaits() >= 1);
      await flushWork();
      expect(sentOrder).not.toContain("after-failures");

      uploadCtrl.error(new Error("client upload aborted"));
      const resUpload = await pUpload;
      expect(resUpload.status).toBe(503);
      await waitUntil(() => sentOrder.includes("after-failures"));

      expect(sentOrder).toContain("after-failures");

      streams.get("hold")!.close();
      streams.get("after-failures")!.close();
      await (await pHold).text();
      await (await pAfter).text();
    });

    it("never double-releases a slot when a finished body is later cancelled", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: (url) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const send = (tag: string) =>
        h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=${tag}`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );

      const p1 = send("1");
      await waitUntil(() => sentOrder.length >= 1);
      const p2 = send("2");
      await waitUntil(() => sentOrder.length >= 2);
      const p3 = send("3");
      await waitUntil(() => queueWaits() >= 1);
      const p4 = send("4");
      await waitUntil(() => queueWaits() >= 2);
      await flushWork();

      const r1 = await p1;
      const reader1 = r1.body!.getReader();
      streams.get("1")!.push("eof-payload");
      streams.get("1")!.close();
      expect(new TextDecoder().decode((await reader1.read()).value)).toBe("eof-payload");
      expect((await reader1.read()).done).toBe(true);
      reader1.releaseLock();
      await waitUntil(() => sentOrder.length >= 3);

      // Only req 3 started; req 4 still waits because req 2 and req 3 occupy both slots.
      expect(sentOrder).toEqual(["1", "2", "3"]);

      // Cancelling the already-ended response stream must NOT release a second slot.
      await r1.body!.cancel("late cancel after eof");
      await flushWork();
      expect(sentOrder).toEqual(["1", "2", "3"]);

      streams.get("2")!.close();
      streams.get("3")!.close();
      await (await p2).text();
      await (await p3).text();
      await waitUntil(() => sentOrder.length >= 4);
      expect(sentOrder).toEqual(["1", "2", "3", "4"]);

      streams.get("4")!.close();
      await (await p4).text();
    });

    it("returns 503 after 30s queue wait (busy page in EN/IT for page loads, plain 503 otherwise) and leaves the queue", async () => {
      vi.useFakeTimers();

      for (const locale of ["en", "it"] as const) {
        const streams = new Map<string, ReturnType<typeof createControllableStream>>();
        const sentOrder: string[] = [];

        const h = createHarness({
          locale,
          pmaHandler: (url) => {
            const tag = new URL(url).searchParams.get("req") ?? "";
            sentOrder.push(tag);
            const s = createControllableStream();
            streams.set(tag, s);
            return new Response(s.stream, { status: 200 });
          },
        });
        const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

        const p1 = h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=1`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );
        await waitUntil(() => sentOrder.length >= 1);
        const p2 = h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=2`, {
            headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          }),
          SITE_ID,
          ["index.php"],
        );
        await waitUntil(() => sentOrder.length >= 2);
        expect(sentOrder).toEqual(["1", "2"]);

        const pPageWaiter = h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=page-timeout`, {
            headers: {
              cookie: `${PMA_COOKIE_NAME}=${cookie}`,
              "sec-fetch-mode": "navigate",
            },
          }),
          SITE_ID,
          ["index.php"],
        );
        const pApiWaiter = h.forward(
          makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=xhr-timeout`, {
            headers: {
              cookie: `${PMA_COOKIE_NAME}=${cookie}`,
              accept: "application/json",
            },
          }),
          SITE_ID,
          ["index.php"],
        );
        await waitUntil(() => vi.getTimerCount() >= 2);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(sentOrder).toEqual(["1", "2"]);

        await vi.advanceTimersByTimeAsync(1);
        const [pageRes, apiRes] = await Promise.all([pPageWaiter, pApiWaiter]);

        expect(pageRes.status).toBe(503);
        expect(pageRes.headers.get("cache-control")).toContain("no-store");
        expect(pageRes.headers.get("content-type")).toContain("text/html");
        const html = await pageRes.text();
        expect(html).not.toMatch(FORBIDDEN_WORDS);
        expect(html).toContain(`/sites/${SITE_ID}/database`);
        if (locale === "en") {
          expect(html).toContain("busy");
          expect(html).toContain("Database");
          expect(html).toContain(en.site.database.phpmyadmin.backToDatabases);
        } else {
          expect(html).toContain("occupato");
          expect(html).toContain("Database");
          expect(html).toContain(itMsgs.site.database.phpmyadmin.backToDatabases);
        }

        expect(apiRes.status).toBe(503);
        expect(apiRes.headers.get("cache-control")).toContain("no-store");
        expect(apiRes.headers.get("content-type")).toBeNull();
        expect(await apiRes.text()).toBe("");

        // Free both active slots: timed-out waiters must never be sent to phpMyAdmin.
        streams.get("1")!.close();
        streams.get("2")!.close();
        await (await p1).text();
        await (await p2).text();
        await flushWork();
        expect(sentOrder).toEqual(["1", "2"]);
      }
    });

    it("removes a queued request from the line if req.signal aborts while waiting", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: (url) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookie = await sealPmaCookie(TEST_KEY, makePayload(h.session!));

      const p1 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=1`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 1);
      const p2 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=2`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 2);

      const abortCtrl = new AbortController();
      const pAborted = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=aborted-waiter`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
          signal: abortCtrl.signal,
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => queueWaits() >= 1);
      const p4 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=4`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookie}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => queueWaits() >= 2);
      await flushWork();

      abortCtrl.abort(new Error("tab closed while queued"));
      const resAborted = await pAborted;
      expect(resAborted.status).toBe(503);

      streams.get("1")!.close();
      await (await p1).text();
      await waitUntil(() => sentOrder.length >= 3);

      expect(sentOrder).toEqual(["1", "2", "4"]);
      expect(sentOrder).not.toContain("aborted-waiter");

      streams.get("2")!.close();
      streams.get("4")!.close();
      await (await p2).text();
      await (await p4).text();
    });

    it("does not hold back site B when site A has 2 requests in flight and more waiting", async () => {
      const queueWaits = trackQueueWaits();
      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];

      const h = createHarness({
        pmaHandler: (url) => {
          const tag = new URL(url).searchParams.get("req") ?? "";
          sentOrder.push(tag);
          const s = createControllableStream();
          streams.set(tag, s);
          return new Response(s.stream, { status: 200 });
        },
      });
      const cookieA = await sealPmaCookie(TEST_KEY, makePayload(h.session!, { siteId: SITE_ID }));
      const cookieB = await sealPmaCookie(TEST_KEY, makePayload(h.session!, { siteId: "site-2" }));

      const pA1 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=a1`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookieA}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 1);
      const pA2 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=a2`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookieA}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 2);
      const pA3 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=a3`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookieA}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => queueWaits() >= 1);
      await flushWork();
      expect(sentOrder).toEqual(["a1", "a2"]);

      const pB1 = h.forward(
        makeForwardReq("http://localhost/phpmyadmin/site-2/index.php?req=b1", {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cookieB}` },
        }),
        "site-2",
        ["index.php"],
      );
      await waitUntil(() => sentOrder.includes("b1"));
      expect(sentOrder).toEqual(["a1", "a2", "b1"]);

      streams.get("b1")!.close();
      expect((await pB1).status).toBe(200);

      streams.get("a1")!.close();
      streams.get("a2")!.close();
      await (await pA1).text();
      await (await pA2).text();
      await waitUntil(() => sentOrder.includes("a3"));
      expect(sentOrder).toEqual(["a1", "a2", "b1", "a3"]);

      streams.get("a3")!.close();
      await (await pA3).text();
    });

    it("cleans up idle per-site entries, isolates forwarder instances, and never takes a slot for refused requests", async () => {
      const OriginalMap = globalThis.Map;
      const createdMaps: Array<Map<unknown, unknown>> = [];
      class TrackedMap<K, V> extends OriginalMap<K, V> {
        constructor() {
          super();
          createdMaps.push(this as unknown as Map<unknown, unknown>);
        }
      }

      const streams = new Map<string, ReturnType<typeof createControllableStream>>();
      const sentOrder: string[] = [];
      let h!: ReturnType<typeof createHarness>;
      globalThis.Map = TrackedMap as unknown as MapConstructor;
      try {
        h = createHarness({
          pmaHandler: (url) => {
            const tag = new URL(url).searchParams.get("req") ?? "";
            sentOrder.push(tag);
            if (tag === "err") {
              throw new Error("boom");
            }
            const s = createControllableStream();
            streams.set(tag, s);
            return new Response(s.stream, { status: 200 });
          },
        });
      } finally {
        globalThis.Map = OriginalMap;
      }

      const cA = await sealPmaCookie(TEST_KEY, makePayload(h.session!, { siteId: "site-clean-a" }));
      const cB = await sealPmaCookie(TEST_KEY, makePayload(h.session!, { siteId: "site-clean-b" }));

      const pA1 = h.forward(
        makeForwardReq("http://localhost/phpmyadmin/site-clean-a/index.php?req=ca1", {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cA}` },
        }),
        "site-clean-a",
        ["index.php"],
      );
      const pA2 = h.forward(
        makeForwardReq("http://localhost/phpmyadmin/site-clean-a/index.php?req=ca2", {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cA}` },
        }),
        "site-clean-a",
        ["index.php"],
      );
      await waitUntil(() => sentOrder.length >= 2);

      const concurrencyMap = createdMaps.find((m) => m.has("site-clean-a"));
      expect(concurrencyMap).toBeDefined();

      // Refused request (missing cookie) returns at once without queuing behind the 2 active requests.
      const refusedRes = await h.forward(
        makeForwardReq("http://localhost/phpmyadmin/site-clean-a/index.php?req=refused"),
        "site-clean-a",
        ["index.php"],
      );
      expect(refusedRes.status).toBe(401);

      const pErr = h.forward(
        makeForwardReq("http://localhost/phpmyadmin/site-clean-b/index.php?req=err", {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cB}` },
        }),
        "site-clean-b",
        ["index.php"],
      );
      expect((await pErr).status).toBe(503);

      streams.get("ca1")!.close();
      streams.get("ca2")!.close();
      await (await pA1).text();
      await (await pA2).text();
      await waitUntil(() => concurrencyMap!.size === 0);

      expect(concurrencyMap!.size).toBe(0);

      // Independent forwarder instances do not share per-site counters.
      const hOther = createHarness({
        pmaHandler: () => new Response("other-instance", { status: 200 }),
      });
      const cOther = await sealPmaCookie(TEST_KEY, makePayload(hOther.session!));
      const pKeepOpen = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=inst1-a`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${await sealPmaCookie(TEST_KEY, makePayload(h.session!))}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      const pKeepOpen2 = h.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=inst1-b`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${await sealPmaCookie(TEST_KEY, makePayload(h.session!))}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      await waitUntil(() => sentOrder.includes("inst1-a") && sentOrder.includes("inst1-b"));

      const resOther = await hOther.forward(
        makeForwardReq(`http://localhost/phpmyadmin/${SITE_ID}/index.php?req=inst2`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${cOther}` },
        }),
        SITE_ID,
        ["index.php"],
      );
      expect(resOther.status).toBe(200);

      streams.get("inst1-a")!.close();
      streams.get("inst1-b")!.close();
      await (await pKeepOpen).text();
      await (await pKeepOpen2).text();
    });
  });

  describe("Next route handler wiring", () => {
    it("exports nodejs runtime, force-dynamic, and answers 405 to unused methods", async () => {
      expect(routeRuntime).toBe("nodejs");
      expect(routeDynamic).toBe("force-dynamic");
      expect(typeof routeGet).toBe("function");
      expect(typeof routeHead).toBe("function");
      expect(typeof routePost).toBe("function");

      for (const fn of [routePut, routePatch, routeDelete, routeOptions]) {
        const res = await fn();
        expect(res.status).toBe(405);
        expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
      }

      const r404 = await routeGet(
        makeForwardReq("http://localhost/phpmyadmin/bad!id/"),
        { params: Promise.resolve({ siteId: "bad!id" }) },
      );
      expect(r404.status).toBe(404);

      const r308 = await routeGet(
        makeForwardReq("http://localhost/phpmyadmin/site-1"),
        { params: Promise.resolve({ siteId: "site-1" }) },
      );
      expect(r308.status).toBe(308);
      expect(r308.headers.get("location")).toBe("/phpmyadmin/site-1/");

      const r303 = await routeGet(
        makeForwardReq("http://localhost/phpmyadmin/site-1/", {
          headers: { "sec-fetch-mode": "navigate" },
        }),
        { params: Promise.resolve({ siteId: "site-1" }) },
      );
      expect(r303.status).toBe(303);
      expect(r303.headers.get("location")).toBe("/login");
    });

    it("refuses reserved port 2222 for HP_PHPMYADMIN_PORT", async () => {
      vi.resetModules();
      vi.stubEnv("HP_PHPMYADMIN_PORT", "2222");
      try {
        const mod = await import("@/app/phpmyadmin/[siteId]/[[...path]]/route");
        await expect(
          mod.GET(makeForwardReq("http://localhost/phpmyadmin/site-1/"), {
            params: Promise.resolve({ siteId: "site-1" }),
          }),
        ).rejects.toThrow("HP_PHPMYADMIN_PORT is invalid or uses a reserved port");
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it("exports PMA_COOKIE_RE matching phpMyAdmin cookies only", () => {
      expect(PMA_COOKIE_RE.test("phpMyAdmin")).toBe(true);
      expect(PMA_COOKIE_RE.test("pma_lang")).toBe(true);
      expect(PMA_COOKIE_RE.test("__Secure-phpMyAdmin_https")).toBe(true);
      expect(PMA_COOKIE_RE.test("__Secure-pma_lang_https")).toBe(true);
      expect(PMA_COOKIE_RE.test("hp_session")).toBe(false);
      expect(PMA_COOKIE_RE.test("hp_pma")).toBe(false);
    });
  });
});
