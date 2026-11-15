import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSession, SESSION_COOKIE_NAME, type SessionData } from "../src/lib/session";
import { GET as getWordpress } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/route";
import { POST as postRefresh } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/refresh/route";
import { POST as postUpdates } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/updates/route";
import { POST as postReset } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/administrators/[userId]/password-reset/route";

const ORG = "org-1";
const SITE = "site-1";
const CSRF = "csrf-wp-test-token";
const BASE = `/api/bff/orgs/${ORG}/managed-sites/${SITE}/wordpress`;
const UPSTREAM = `/v1/organizations/${ORG}/managed-sites/${SITE}/wordpress`;
// Test-only value shaped like the contract; not a real password.
const FAKE_TEMP = "TestOnlyNotARealPassword0";

async function makeSessionCookie(): Promise<string> {
  const session: SessionData = {
    accessToken: "upstream-jwt-token-secret",
    csrfToken: CSRF,
    activeConsole: "customer",
    activeOrgSlug: null,
    user: {
      id: "usr-1",
      email: "owner@example.com",
      name: "Owner",
      locale: "en",
      mustChangePassword: false,
      isServerAdmin: false,
      globalRoles: [],
      hostingAdminOrgIds: [],
    },
  };
  return `${SESSION_COOKIE_NAME}=${await encryptSession(session)}`;
}

function makeReq(
  path: string,
  opts: { method?: string; cookie?: string | null; csrf?: string | null; origin?: string; body?: string; key?: string } = {},
): Request {
  const headers: Record<string, string> = { Host: "localhost:3000", Origin: opts.origin ?? "http://localhost:3000" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://localhost:3000${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

const siteCtx = () => ({ params: Promise.resolve({ orgId: ORG, siteId: SITE }) });
const userCtx = (userId: string) => ({ params: Promise.resolve({ orgId: ORG, siteId: SITE, userId }) });

function installFetchStub(status = 200, payload: unknown = { data: {} }) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | undefined }> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

describe("WordPress BFF routes", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await makeSessionCookie();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GET forwards to the API and answers without a session with 401 and no upstream call", async () => {
    const { calls } = installFetchStub(200, { data: { backupsConfigured: true } });
    const res = await getWordpress(makeReq(BASE, { cookie }), siteCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { backupsConfigured: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain(UPSTREAM);

    const { stub } = installFetchStub();
    const anon = await getWordpress(makeReq(BASE), siteCtx());
    expect(anon.status).toBe(401);
    expect(stub).not.toHaveBeenCalled();
  });

  it("POSTs without the CSRF token or from a foreign Origin are refused before any upstream call", async () => {
    const { stub } = installFetchStub();
    const bad = [{ csrf: null }, { csrf: CSRF, origin: "https://evil.example" }];
    for (const opts of bad) {
      const refresh = await postRefresh(makeReq(`${BASE}/refresh`, { method: "POST", cookie, body: "{}", ...opts }), siteCtx());
      const update = await postUpdates(
        makeReq(`${BASE}/updates`, { method: "POST", cookie, body: JSON.stringify({ scope: "all" }), ...opts }),
        siteCtx(),
      );
      const reset = await postReset(
        makeReq(`${BASE}/administrators/7/password-reset`, { method: "POST", cookie, body: "{}", ...opts }),
        userCtx("7"),
      );
      expect([refresh.status, update.status, reset.status]).toEqual([403, 403, 403]);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("refresh forwards {} with the caller's Idempotency-Key and refuses another body", async () => {
    const { calls } = installFetchStub(202, { data: { siteId: SITE, operationId: "op-1" } });
    const res = await postRefresh(
      makeReq(`${BASE}/refresh`, { method: "POST", cookie, csrf: CSRF, body: "{}", key: "key-refresh-1" }),
      siteCtx(),
    );
    expect(res.status).toBe(202);
    expect(calls[0]!.url).toContain(`${UPSTREAM}/refresh`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("key-refresh-1");
    expect(JSON.parse(calls[0]!.body ?? "null")).toEqual({});

    const { stub } = installFetchStub();
    const extra = await postRefresh(
      makeReq(`${BASE}/refresh`, { method: "POST", cookie, csrf: CSRF, body: JSON.stringify({ force: true }) }),
      siteCtx(),
    );
    expect(extra.status).toBe(400);
    expect(stub).not.toHaveBeenCalled();
  });

  it("updates forwards a valid target with a generated Idempotency-Key", async () => {
    const { calls } = installFetchStub(202, { data: { siteId: SITE, operationId: "op-2" } });
    const target = { scope: "plugin", name: "akismet" };
    const res = await postUpdates(
      makeReq(`${BASE}/updates`, { method: "POST", cookie, csrf: CSRF, body: JSON.stringify(target) }),
      siteCtx(),
    );
    expect(res.status).toBe(202);
    expect(calls[0]!.url).toContain(`${UPSTREAM}/updates`);
    expect(JSON.parse(calls[0]!.body ?? "null")).toEqual(target);
    expect(calls[0]!.headers.get("idempotency-key")).toMatch(/\S+/);
  });

  it("updates refuses a bad body, malformed JSON and an oversized body before any upstream call", async () => {
    const { stub } = installFetchStub();
    const bodies = [
      JSON.stringify({ scope: "plugin" }),
      JSON.stringify({ scope: "all", extra: 1 }),
      JSON.stringify({ scope: "plugin", name: "../evil" }),
      JSON.stringify({ scope: "everything" }),
      "{not json",
    ];
    for (const body of bodies) {
      const res = await postUpdates(makeReq(`${BASE}/updates`, { method: "POST", cookie, csrf: CSRF, body }), siteCtx());
      expect(res.status, body).toBe(400);
    }
    const huge = JSON.stringify({ scope: "all", pad: "x".repeat(1_048_577) });
    const tooBig = await postUpdates(makeReq(`${BASE}/updates`, { method: "POST", cookie, csrf: CSRF, body: huge }), siteCtx());
    expect(tooBig.status).toBe(413);
    expect(stub).not.toHaveBeenCalled();
  });

  it("password reset refuses a bad user id before any upstream call", async () => {
    const { stub } = installFetchStub();
    for (const userId of ["0", "abc", "1/../2", "12345678901", "-1", "07"]) {
      const res = await postReset(
        makeReq(`${BASE}/administrators/x/password-reset`, { method: "POST", cookie, csrf: CSRF, body: "{}" }),
        userCtx(userId),
      );
      expect(res.status, userId).toBe(400);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("password reset forwards without an Idempotency-Key and keeps temporaryPassword in a no-store answer", async () => {
    const { calls } = installFetchStub(200, { data: { temporaryPassword: FAKE_TEMP } });
    const res = await postReset(
      makeReq(`${BASE}/administrators/7/password-reset`, { method: "POST", cookie, csrf: CSRF, body: "{}" }),
      userCtx("7"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ data: { temporaryPassword: FAKE_TEMP } });
    expect(calls[0]!.url).toContain(`${UPSTREAM}/administrators/7/password-reset`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("idempotency-key")).toBeNull();
  });

  it("passes upstream refusals through unchanged", async () => {
    const envelope = { error: { code: "DOCKER_ENGINE_UNAVAILABLE", message: "x", details: [{ reason: "database_unreachable" }] } };
    installFetchStub(503, envelope);
    const res = await postReset(
      makeReq(`${BASE}/administrators/7/password-reset`, { method: "POST", cookie, csrf: CSRF, body: "{}" }),
      userCtx("7"),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as typeof envelope).error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });
});
