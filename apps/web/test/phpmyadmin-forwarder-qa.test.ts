import { createHash } from "node:crypto";
import { EncryptJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  PMA_COOKIE_MAX_AGE_S,
  PMA_COOKIE_NAME,
  createPhpMyAdminForwarder,
  pmaPrefix,
  sealPmaCookie,
  sessionBindingId,
  type ForwarderDeps,
  type PmaCookiePayload,
} from "@/lib/phpmyadmin-forwarder";
import type { SessionData } from "@/lib/session";
import {
  DELETE as routeDelete,
  OPTIONS as routeOptions,
  PATCH as routePatch,
  PUT as routePut,
} from "@/app/phpmyadmin/[siteId]/[[...path]]/route";

const KEY_A = createHash("sha256").update("qa-pma-cookie-key-a-32-chars-minimum!").digest();
const KEY_B = createHash("sha256").update("qa-pma-cookie-key-b-32-chars-minimum!").digest();
const API_BASE = "http://127.0.0.1:4100";
const UPSTREAM_ORIGIN = "http://127.0.0.1:18306";

const SITE_1 = "site_qa_1";
const SITE_2 = "site_qa_2";
const ORG_1 = "org_qa_1";
const ORG_2 = "org_qa_2";

const SECRET_DB_PW = "QaDbPasswordSuperSecret987654321";
const SECRET_DB_USER = "pma_a1b2c3d4e5f6";
const SECRET_ACCESS_TOKEN = "qa-panel-bearer-secret-token";
const SECRET_CSRF_TOKEN = "qa-panel-csrf-secret-token";

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    accessToken: SECRET_ACCESS_TOKEN,
    csrfToken: SECRET_CSRF_TOKEN,
    activeConsole: "customer",
    activeOrgSlug: "qa-org",
    user: {
      id: "user-qa-1",
      email: "qa@example.test",
      name: "QA User",
      globalRoles: [],
      hostingAdminOrgIds: [],
      locale: "en",
      isServerAdmin: false,
      mustChangePassword: false,
    },
    ...overrides,
  };
}

function makeCookiePayload(
  session: SessionData,
  overrides: Partial<PmaCookiePayload> = {},
): PmaCookiePayload {
  return {
    siteId: SITE_1,
    orgId: ORG_1,
    username: SECRET_DB_USER,
    password: SECRET_DB_PW,
    sid: sessionBindingId(session),
    ...overrides,
  };
}

function getSetCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

async function assertNoSecretsLeaked(
  res: Response,
  secrets: readonly string[],
  opts: { clone?: boolean } = {},
): Promise<void> {
  const target = opts.clone ? res.clone() : res;
  const bodyText = await target.text();
  const headerEntries: string[] = [];
  target.headers.forEach((v, k) => {
    headerEntries.push(`${k}: ${v}`);
  });
  for (const sc of getSetCookies(target)) {
    headerEntries.push(`set-cookie: ${sc}`);
  }
  const combined = `${bodyText}\n${headerEntries.join("\n")}`;
  for (const secret of secrets) {
    expect(combined).not.toContain(secret);
  }
}

function createQaHarness(opts: {
  session?: SessionData | null;
  nowMs?: number;
  secureCookies?: boolean;
  locale?: "it" | "en";
  apiHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  pmaHandler?: (url: string, init?: RequestInit) => Promise<Response> | Response;
} = {}) {
  let currentNow = opts.nowMs ?? 1_750_000_000_000;
  const session = opts.session === undefined ? makeSession() : opts.session;
  const apiCalls: Array<{ url: string; headers: Headers }> = [];
  const pmaCalls: Array<{ url: string; method: string; headers: Headers }> = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(API_BASE)) {
      apiCalls.push({ url, headers: new Headers(init?.headers) });
      if (opts.apiHandler) {
        return await opts.apiHandler(url, init);
      }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith(UPSTREAM_ORIGIN)) {
      pmaCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      if (opts.pmaHandler) {
        return await opts.pmaHandler(url, init);
      }
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`Unexpected outbound fetch target: ${url}`);
  };

  const deps: ForwarderDeps = {
    readSession: async () => session,
    cookieKey: KEY_A,
    apiBaseUrl: API_BASE,
    upstreamOrigin: UPSTREAM_ORIGIN,
    secureCookies: opts.secureCookies ?? true,
    locale: () => opts.locale ?? "en",
    fetch: fakeFetch,
    now: () => currentNow,
  };

  return {
    forward: createPhpMyAdminForwarder(deps),
    apiCalls,
    pmaCalls,
    setNow(ms: number) {
      currentNow = ms;
    },
    advanceMs(delta: number) {
      currentNow += delta;
    },
  };
}

function makeSecretsList(payload: PmaCookiePayload, session: SessionData): string[] {
  const basic = Buffer.from(`${payload.username}:${payload.password}`, "utf8").toString("base64");
  return [
    payload.password,
    basic,
    payload.username,
    payload.orgId,
    payload.sid,
    session.accessToken,
    session.csrfToken,
  ];
}

function flipHexOrB64Char(input: string, index: number): string {
  const ch = input[index]!;
  const replacement = ch === "A" ? "B" : "A";
  return `${input.slice(0, index)}${replacement}${input.slice(index + 1)}`;
}

describe("phpMyAdmin forwarder QA security & edge checks", () => {
  it("refuses a cookie for site 1 used on site 2's address with 404 and never calls phpMyAdmin", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session, { siteId: SITE_1 });
    const jwe = await sealPmaCookie(KEY_A, payload);
    const harness = createQaHarness({ session });

    const res = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_2}/index.php`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${jwe}`,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
      SITE_2,
      ["index.php"],
    );

    expect(res.status).toBe(404);
    expect(harness.apiCalls).toHaveLength(0);
    expect(harness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(res, makeSecretsList(payload, session));
  });

  it("refuses a cookie sealed for another panel session (different csrfToken / sid) and clears hp_pma", async () => {
    const otherSession = makeSession({ csrfToken: "other-session-csrf-token" });
    const currentSession = makeSession();
    const payload = makeCookiePayload(otherSession);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const harness = createQaHarness({ session: currentSession });

    const pageRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${jwe}`,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
      SITE_1,
      [],
    );
    expect(pageRes.status).toBe(303);
    expect(pageRes.headers.get("location")).toBe(`/sites/${SITE_1}/database`);
    const cleared = getSetCookies(pageRes).join("\n");
    expect(cleared).toContain(`${PMA_COOKIE_NAME}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain(`Path=${pmaPrefix(SITE_1)}`);
    expect(harness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(pageRes, makeSecretsList(payload, currentSession));

    const xhrRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/index.php`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${jwe}`,
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
      }),
      SITE_1,
      ["index.php"],
    );
    expect(xhrRes.status).toBe(401);
    expect(harness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(xhrRes, makeSecretsList(payload, currentSession));
  });

  it("refuses a cookie for another organisation (invalid orgId shape, foreign org API 404, and isolated cache)", async () => {
    const session = makeSession();
    const invalidOrgPayload = makeCookiePayload(session, { orgId: "../other-org" });
    const invalidOrgJwe = await sealPmaCookie(KEY_A, invalidOrgPayload);
    const harness = createQaHarness({
      session,
      apiHandler: (url) => {
        if (url.includes(`/organizations/${ORG_1}/`)) {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });

    const badOrgRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${invalidOrgJwe}`,
          accept: "text/html",
        },
      }),
      SITE_1,
      [],
    );
    expect([303, 401, 404]).toContain(badOrgRes.status);
    expect(harness.apiCalls).toHaveLength(0);
    expect(harness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(badOrgRes, makeSecretsList(invalidOrgPayload, session));

    // Seed cache for ORG_1 first, then ensure ORG_2 is NOT served from ORG_1's cache.
    const org1Jwe = await sealPmaCookie(KEY_A, makeCookiePayload(session, { orgId: ORG_1 }));
    const okRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${org1Jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(okRes.status).toBe(200);
    expect(harness.pmaCalls).toHaveLength(1);

    const org2Payload = makeCookiePayload(session, { orgId: ORG_2 });
    const org2Jwe = await sealPmaCookie(KEY_A, org2Payload);
    const foreignOrgRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${org2Jwe}`,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
      SITE_1,
      [],
    );
    expect(foreignOrgRes.status).toBe(404);
    expect(harness.apiCalls).toHaveLength(2);
    expect(harness.pmaCalls).toHaveLength(1);
    await assertNoSecretsLeaked(foreignOrgRes, makeSecretsList(org2Payload, session));
  });

  it("refuses a tampered JWE byte, wrong key, and wrong audience without calling phpMyAdmin", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const validJwe = await sealPmaCookie(KEY_A, payload);
    const parts = validJwe.split(".");
    expect(parts).toHaveLength(5);
    const tamperedCipher = `${parts[0]}.${parts[1]}.${parts[2]}.${flipHexOrB64Char(parts[3]!, 2)}.${parts[4]}`;
    const tamperedTag = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}.${flipHexOrB64Char(parts[4]!, 2)}`;
    const wrongKeyJwe = await sealPmaCookie(KEY_B, payload);
    const wrongAudJwe = await new EncryptJWT({
      siteId: payload.siteId,
      orgId: payload.orgId,
      username: payload.username,
      password: payload.password,
      sid: payload.sid,
    })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setAudience("other-service")
      .setIssuedAt()
      .setExpirationTime("4h")
      .encrypt(KEY_A);

    const harness = createQaHarness({ session });

    for (const token of [tamperedCipher, tamperedTag, wrongKeyJwe, wrongAudJwe]) {
      const res = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${token}` },
        }),
        SITE_1,
        [],
      );
      expect(res.status).toBe(401);
      expect(getSetCookies(res).join("\n")).toContain("Max-Age=0");
      await assertNoSecretsLeaked(res, makeSecretsList(payload, session));
    }
    expect(harness.pmaCalls).toHaveLength(0);
  });

  it("refuses an expired hp_pma cookie at and past exp without calling phpMyAdmin", async () => {
    const startMs = 1_750_000_000_000;
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload, startMs);
    const harness = createQaHarness({ session, nowMs: startMs + PMA_COOKIE_MAX_AGE_S * 1000 + 1000 });

    const res = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: {
          cookie: `${PMA_COOKIE_NAME}=${jwe}`,
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
      SITE_1,
      [],
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/sites/${SITE_1}/database`);
    expect(getSetCookies(res).join("\n")).toContain("Max-Age=0");
    expect(harness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(res, makeSecretsList(payload, session));
  });

  it("validates siteId edges (.., encoded slash, 200 chars refused; uppercase allowed only for matching case)", async () => {
    const session = makeSession();
    const harness = createQaHarness({ session });

    const badSiteIds = ["..", "site%2F1", "site%2f1", "a".repeat(200), "a".repeat(129), "bad.dot", ""];
    for (const badId of badSiteIds) {
      const res = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${badId}/`, {
          headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
        }),
        badId,
        [],
      );
      expect(res.status).toBe(404);
    }
    expect(harness.apiCalls).toHaveLength(0);
    expect(harness.pmaCalls).toHaveLength(0);

    // Uppercase siteId matches ^[A-Za-z0-9_-]{1,128}$ and stays case-sensitive against the cookie.
    const upperSite = "Site_QA_Upper-1";
    const upperPayload = makeCookiePayload(session, { siteId: upperSite });
    const upperJwe = await sealPmaCookie(KEY_A, upperPayload);

    const caseMismatchRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${upperSite.toLowerCase()}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${upperJwe}` },
      }),
      upperSite.toLowerCase(),
      [],
    );
    expect(caseMismatchRes.status).toBe(404);
    expect(harness.pmaCalls).toHaveLength(0);

    const upperOkRes = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${upperSite}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${upperJwe}` },
      }),
      upperSite,
      [],
    );
    expect(upperOkRes.status).toBe(200);
    expect(harness.pmaCalls).toHaveLength(1);
    expect(harness.pmaCalls[0]!.headers.get("x-forwarded-prefix")).toBe(`/phpmyadmin/${upperSite}/`);
  });

  it("refuses prefix-escape paths (.., encoded variants, double slash, absolute URL in path) with 404", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const harness = createQaHarness({ session });

    const escapeCases: Array<{ pathname: string; pathSegments: string[] }> = [
      { pathname: `/phpmyadmin/${SITE_1}/../other`, pathSegments: ["..", "other"] },
      { pathname: `/phpmyadmin/${SITE_1}/%2e%2e/other`, pathSegments: ["%2e%2e", "other"] },
      { pathname: `/phpmyadmin/${SITE_1}/%2E%2E/other`, pathSegments: ["%2E%2E", "other"] },
      { pathname: `/phpmyadmin/${SITE_1}/%2e/index.php`, pathSegments: ["%2e", "index.php"] },
      { pathname: `/phpmyadmin/${SITE_1}/foo%2fbar`, pathSegments: ["foo%2fbar"] },
      { pathname: `/phpmyadmin/${SITE_1}/foo%5cbar`, pathSegments: ["foo%5cbar"] },
      { pathname: `/phpmyadmin/${SITE_1}/foo%00bar`, pathSegments: ["foo%00bar"] },
      { pathname: `/phpmyadmin/${SITE_1}/%ZZ`, pathSegments: ["%ZZ"] },
      // Double slash in raw URL even if Next collapsed pathSegments:
      { pathname: `/phpmyadmin/${SITE_1}//index.php`, pathSegments: ["index.php"] },
      { pathname: `/phpmyadmin/${SITE_1}/themes//metro`, pathSegments: ["themes", "metro"] },
      // Absolute URL embedded in path:
      { pathname: `/phpmyadmin/${SITE_1}//evil.test/steal`, pathSegments: ["evil.test", "steal"] },
      { pathname: `/phpmyadmin/${SITE_1}/https://evil.test/steal`, pathSegments: ["https:", "evil.test", "steal"] },
      { pathname: `/phpmyadmin/${SITE_1}/http://127.0.0.1:4000/`, pathSegments: ["http://127.0.0.1:4000"] },
    ];

    for (const c of escapeCases) {
      const res = await harness.forward(
        new Request(`https://panel.test${c.pathname}`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
        }),
        SITE_1,
        c.pathSegments,
      );
      expect(res.status).toBe(404);
      await assertNoSecretsLeaked(res, makeSecretsList(payload, session));
    }

    expect(harness.apiCalls).toHaveLength(0);
    expect(harness.pmaCalls).toHaveLength(0);
  });

  it("refuses POST, PUT and DELETE from another origin, with no Origin, and with Origin: null", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const harness = createQaHarness({ session });

    const origins: Array<{ label: string; headers: Record<string, string> }> = [
      { label: "other origin", headers: { origin: "https://attacker.test" } },
      { label: "no Origin", headers: {} },
      { label: "Origin: null", headers: { origin: "null" } },
      {
        label: "cross-site Sec-Fetch-Site with matching Origin",
        headers: { origin: "https://panel.test", "sec-fetch-site": "cross-site" },
      },
    ];

    for (const method of ["POST", "PUT", "DELETE"] as const) {
      for (const o of origins) {
        const res = await harness.forward(
          new Request(`https://panel.test/phpmyadmin/${SITE_1}/index.php`, {
            method,
            headers: {
              host: "panel.test",
              cookie: `${PMA_COOKIE_NAME}=${jwe}`,
              ...o.headers,
            },
          }),
          SITE_1,
          ["index.php"],
        );
        expect(res.status).toBe(403);
        await assertNoSecretsLeaked(res, makeSecretsList(payload, session));
      }
    }

    // Even with same-origin headers, PUT/DELETE are refused (405) by both the forwarder and Next route.
    for (const method of ["PUT", "DELETE"] as const) {
      const fwdRes = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${SITE_1}/index.php`, {
          method,
          headers: {
            host: "panel.test",
            origin: "https://panel.test",
            "sec-fetch-site": "same-origin",
            cookie: `${PMA_COOKIE_NAME}=${jwe}`,
          },
        }),
        SITE_1,
        ["index.php"],
      );
      expect(fwdRes.status).toBe(405);
    }

    const ctx = { params: Promise.resolve({ siteId: SITE_1, path: ["index.php"] }) };
    expect((await routePut()).status).toBe(405);
    expect((await routeDelete()).status).toBe(405);
    expect((await routePatch()).status).toBe(405);
    expect((await routeOptions()).status).toBe(405);
    expect(ctx).toBeDefined();

    expect(harness.pmaCalls).toHaveLength(0);
  });

  it("strips browser Authorization, X-Forwarded-*, and panel cookies before forwarding to phpMyAdmin", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const harness = createQaHarness({ session, secureCookies: true });

    const res = await harness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/index.php?route=/sql`, {
        headers: {
          authorization: "Basic YnJvd3NlcjpwYXNz",
          "x-forwarded-for": "203.0.113.9",
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "http",
          "x-forwarded-prefix": "/phpmyadmin/other/",
          cookie: [
            "hp_session=panel-session-jwt",
            "hp_csrf=panel-csrf-cookie",
            `${PMA_COOKIE_NAME}=${jwe}`,
            "phpMyAdmin=pma-sess-123",
            "pma_lang=en",
            "__Secure-pma_token_https=abc",
            "unrelated_cookie=secret",
          ].join("; "),
          "accept-encoding": "br, gzip",
        },
      }),
      SITE_1,
      ["index.php"],
    );

    expect(res.status).toBe(200);
    expect(harness.pmaCalls).toHaveLength(1);
    const sent = harness.pmaCalls[0]!.headers;
    const expectedBasic = Buffer.from(`${SECRET_DB_USER}:${SECRET_DB_PW}`, "utf8").toString("base64");

    expect(sent.get("authorization")).toBe(`Basic ${expectedBasic}`);
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("x-forwarded-host")).toBeNull();
    expect(sent.get("x-forwarded-proto")).toBe("https");
    expect(sent.get("x-forwarded-prefix")).toBe(`/phpmyadmin/${SITE_1}/`);
    expect(sent.get("accept-encoding")).toBe("identity");

    const sentCookie = sent.get("cookie") ?? "";
    expect(sentCookie).not.toContain("hp_session");
    expect(sentCookie).not.toContain("hp_csrf");
    expect(sentCookie).not.toContain(PMA_COOKIE_NAME);
    expect(sentCookie).not.toContain("unrelated_cookie");
    expect(sentCookie).toContain("phpMyAdmin=pma-sess-123");
    expect(sentCookie).toContain("pma_lang=en");
    expect(sentCookie).toContain("__Secure-pma_token_https=abc");
  });

  it("drops www-authenticate, constrains Set-Cookie path/domain, and blocks external/escaping Location redirects", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);

    const locations = [
      { raw: "https://evil.example/phish", expected: pmaPrefix(SITE_1) },
      { raw: "//evil.example/phish", expected: pmaPrefix(SITE_1) },
      { raw: "/sites/other", expected: pmaPrefix(SITE_1) },
      { raw: `/phpmyadmin/${SITE_2}/index.php`, expected: pmaPrefix(SITE_1) },
      { raw: "../outside", expected: pmaPrefix(SITE_1) },
      { raw: `/phpmyadmin/${SITE_1}/index.php?route=/sql`, expected: `/phpmyadmin/${SITE_1}/index.php?route=/sql` },
      { raw: "index.php?route=/", expected: "index.php?route=/" },
    ];

    for (const loc of locations) {
      const harness = createQaHarness({
        session,
        pmaHandler: () => {
          const headers = new Headers({
            "www-authenticate": 'Basic realm="phpMyAdmin"',
            "content-encoding": "gzip",
            "content-length": "42",
            connection: "keep-alive, x-leak-hop",
            "x-leak-hop": "should-drop",
            location: loc.raw,
          });
          headers.append("set-cookie", "phpMyAdmin=sess1; Path=/; Domain=evil.test; HttpOnly; SameSite=Lax");
          headers.append("set-cookie", "hp_session=hijack; Path=/; HttpOnly");
          return new Response(null, { status: 302, headers });
        },
      });

      const res = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
        }),
        SITE_1,
        [],
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
      expect(res.headers.get("x-leak-hop")).toBeNull();
      expect(res.headers.get("location")).toBe(loc.expected);

      const cookies = getSetCookies(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toContain("phpMyAdmin=sess1");
      expect(cookies[0]).toContain(`Path=${pmaPrefix(SITE_1)}`);
      expect(cookies[0]!.toLowerCase()).not.toContain("domain=");
      expect(cookies[0]!.toLowerCase()).not.toContain("path=/;");
      expect(cookies[0]).not.toContain("hp_session");
    }
  });

  it("never passes or caches API 403/404/500/timeout and notices revoked access after cache TTL", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const secrets = makeSecretsList(payload, session);

    for (const status of [403, 404, 500] as const) {
      const harness = createQaHarness({
        session,
        apiHandler: () => new Response(null, { status }),
      });

      const r1 = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
        }),
        SITE_1,
        [],
      );
      const r2 = await harness.forward(
        new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
          headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
        }),
        SITE_1,
        [],
      );

      const expectedStatus = status === 500 ? 503 : 404;
      expect(r1.status).toBe(expectedStatus);
      expect(r2.status).toBe(expectedStatus);
      expect(harness.apiCalls).toHaveLength(2);
      expect(harness.pmaCalls).toHaveLength(0);
      await assertNoSecretsLeaked(r1, secrets);
      await assertNoSecretsLeaked(r2, secrets);
    }

    // Timeout / network failure on API rights check:
    const timeoutHarness = createQaHarness({
      session,
      apiHandler: () => Promise.reject(new DOMException("Aborted", "TimeoutError")),
    });
    const t1 = await timeoutHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    const t2 = await timeoutHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(t1.status).toBe(503);
    expect(t2.status).toBe(503);
    expect(timeoutHarness.apiCalls).toHaveLength(2);
    expect(timeoutHarness.pmaCalls).toHaveLength(0);
    await assertNoSecretsLeaked(t1, secrets);

    // Cache hit before 30 s, then revoked right noticed immediately after 30 s:
    let apiStatus = 204;
    const cacheHarness = createQaHarness({
      session,
      nowMs: 1_750_000_000_000,
      apiHandler: () => new Response(null, { status: apiStatus }),
    });

    const first = await cacheHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(first.status).toBe(200);
    expect(cacheHarness.apiCalls).toHaveLength(1);
    expect(cacheHarness.pmaCalls).toHaveLength(1);

    // Revoke right in API while cache is still warm (29 s):
    apiStatus = 403;
    cacheHarness.advanceMs(29_000);
    const stillCached = await cacheHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(stillCached.status).toBe(200);
    expect(cacheHarness.apiCalls).toHaveLength(1);
    expect(cacheHarness.pmaCalls).toHaveLength(2);

    // Advance past 30 s TTL: revocation is now noticed and phpMyAdmin is NOT called.
    cacheHarness.advanceMs(1_500);
    const afterExpiry = await cacheHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(afterExpiry.status).toBe(404);
    expect(cacheHarness.apiCalls).toHaveLength(2);
    expect(cacheHarness.pmaCalls).toHaveLength(2);
    await assertNoSecretsLeaked(afterExpiry, secrets);
  });

  it("never leaks password, Basic header, or cookie claims in upstream 401 or 503 error replies", async () => {
    const session = makeSession();
    const payload = makeCookiePayload(session);
    const jwe = await sealPmaCookie(KEY_A, payload);
    const secrets = makeSecretsList(payload, session);

    const unauthHarness = createQaHarness({
      session,
      pmaHandler: () =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="phpMyAdmin"' },
        }),
    });
    const r401 = await unauthHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(r401.status).toBe(401);
    expect(r401.headers.get("www-authenticate")).toBeNull();
    expect(getSetCookies(r401).join("\n")).toContain("Max-Age=0");
    await assertNoSecretsLeaked(r401, secrets);

    const downHarness = createQaHarness({
      session,
      pmaHandler: () => Promise.reject(new Error(`connect ECONNREFUSED ${payload.password}`)),
    });
    const r503 = await downHarness.forward(
      new Request(`https://panel.test/phpmyadmin/${SITE_1}/`, {
        headers: { cookie: `${PMA_COOKIE_NAME}=${jwe}` },
      }),
      SITE_1,
      [],
    );
    expect(r503.status).toBe(503);
    await assertNoSecretsLeaked(r503, secrets);
  });
});
