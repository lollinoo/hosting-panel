import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorEnvelopeSchema, createErrorEnvelope } from "@hosting-panel/contracts";
import { encryptSession, SESSION_COOKIE_NAME, type SessionData } from "../src/lib/session";
import {
  GET as getDatabases,
  POST as postDatabases,
} from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/route";
import { DELETE as deleteDatabase } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/[name]/route";
import { POST as postDatabaseUsers } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/route";
import { DELETE as deleteDatabaseUser } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/route";
import { POST as postResetPassword } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/reset-password/route";
import {
  PUT as putGrant,
  DELETE as deleteGrant,
} from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/database-users/[name]/grants/[database]/route";

const ORG = "org-1";
const SITE = "site-1";
const PRIMARY_DB = "wp_0123456789ab";
const CUSTOM_DB = "wp_0123456789ab_shop";
const CUSTOM_USER = "wp_0123456789ab_reader";
const CSRF = "csrf-db-test-token";

async function makeSessionCookie(csrfToken = CSRF): Promise<string> {
  const session: SessionData = {
    accessToken: "upstream-jwt-token-secret",
    csrfToken,
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
  const encrypted = await encryptSession(session);
  return `${SESSION_COOKIE_NAME}=${encrypted}`;
}

function makeReq(
  path: string,
  opts: {
    method?: string;
    cookie?: string | null;
    csrf?: string | null;
    origin?: string | null;
    body?: string | null;
  } = {}
): Request {
  const headers: Record<string, string> = {
    Host: "localhost:3000",
  };
  if (opts.origin !== null) {
    headers["Origin"] = opts.origin ?? "http://localhost:3000";
  }
  if (opts.cookie !== null && opts.cookie !== undefined) {
    headers["Cookie"] = opts.cookie;
  }
  if (opts.csrf !== null && opts.csrf !== undefined) {
    headers["X-CSRF-Token"] = opts.csrf;
  }
  if (opts.body !== null && opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return new Request(`http://localhost:3000${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== null && opts.body !== undefined ? { body: opts.body } : {}),
  });
}

function siteCtx(orgId = ORG, siteId = SITE) {
  return { params: Promise.resolve({ orgId, siteId }) };
}

function nameCtx(name: string, orgId = ORG, siteId = SITE) {
  return { params: Promise.resolve({ orgId, siteId, name }) };
}

function grantCtx(name: string, database: string, orgId = ORG, siteId = SITE) {
  return { params: Promise.resolve({ orgId, siteId, name, database }) };
}

function installFetchStub(status = 200, payload: unknown = { data: {} }) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | undefined }> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, headers, body });
    if (status === 204) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

describe("site databases BFF routes", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await makeSessionCookie();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated requests with 401 on all 6 routes without calling upstream", async () => {
    const { stub } = installFetchStub();
    const base = `/api/bff/orgs/${ORG}/managed-sites/${SITE}`;
    const responses = await Promise.all([
      getDatabases(makeReq(`${base}/databases`, { method: "GET" }), siteCtx()),
      postDatabases(makeReq(`${base}/databases`, { method: "POST", body: JSON.stringify({ name: "shop" }) }), siteCtx()),
      deleteDatabase(makeReq(`${base}/databases/${CUSTOM_DB}`, { method: "DELETE" }), nameCtx(CUSTOM_DB)),
      postDatabaseUsers(
        makeReq(`${base}/database-users`, { method: "POST", body: JSON.stringify({ name: "reader" }) }),
        siteCtx()
      ),
      deleteDatabaseUser(makeReq(`${base}/database-users/${CUSTOM_USER}`, { method: "DELETE" }), nameCtx(CUSTOM_USER)),
      postResetPassword(
        makeReq(`${base}/database-users/${CUSTOM_USER}/reset-password`, { method: "POST" }),
        nameCtx(CUSTOM_USER)
      ),
      putGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${PRIMARY_DB}`, { method: "PUT" }),
        grantCtx(CUSTOM_USER, PRIMARY_DB)
      ),
      deleteGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${CUSTOM_DB}`, { method: "DELETE" }),
        grantCtx(CUSTOM_USER, CUSTOM_DB)
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects missing CSRF token and cross-site Origin with 403 on all mutating handlers without calling upstream", async () => {
    const { stub } = installFetchStub();
    const base = `/api/bff/orgs/${ORG}/managed-sites/${SITE}`;

    const sendMutations = (opts: { csrf?: string | null; origin?: string | null }) =>
      Promise.all([
        postDatabases(
          makeReq(`${base}/databases`, { method: "POST", cookie, body: JSON.stringify({ name: "shop" }), ...opts }),
          siteCtx()
        ),
        deleteDatabase(
          makeReq(`${base}/databases/${CUSTOM_DB}`, { method: "DELETE", cookie, ...opts }),
          nameCtx(CUSTOM_DB)
        ),
        postDatabaseUsers(
          makeReq(`${base}/database-users`, {
            method: "POST",
            cookie,
            body: JSON.stringify({ name: "reader" }),
            ...opts,
          }),
          siteCtx()
        ),
        deleteDatabaseUser(
          makeReq(`${base}/database-users/${CUSTOM_USER}`, { method: "DELETE", cookie, ...opts }),
          nameCtx(CUSTOM_USER)
        ),
        postResetPassword(
          makeReq(`${base}/database-users/${CUSTOM_USER}/reset-password`, { method: "POST", cookie, ...opts }),
          nameCtx(CUSTOM_USER)
        ),
        putGrant(
          makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${PRIMARY_DB}`, { method: "PUT", cookie, ...opts }),
          grantCtx(CUSTOM_USER, PRIMARY_DB)
        ),
        deleteGrant(
          makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${CUSTOM_DB}`, { method: "DELETE", cookie, ...opts }),
          grantCtx(CUSTOM_USER, CUSTOM_DB)
        ),
      ]);

    const missingCsrf = await sendMutations({ csrf: null });
    const wrongCsrf = await sendMutations({ csrf: "wrong-csrf" });
    const evilOrigin = await sendMutations({ csrf: CSRF, origin: "https://evil.example" });

    for (const res of [...missingCsrf, ...wrongCsrf, ...evilOrigin]) {
      expect(res.status).toBe(403);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("PERMISSION_DENIED");
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects malformed orgId, siteId, [name], and [database] path segments with 400 without calling upstream", async () => {
    const { stub } = installFetchStub();
    const base = `/api/bff/orgs/${ORG}/managed-sites/${SITE}`;

    const badSegmentResponses = await Promise.all([
      getDatabases(makeReq(`${base}/databases`, { cookie }), siteCtx("../bad", SITE)),
      getDatabases(makeReq(`${base}/databases`, { cookie }), siteCtx(ORG, "bad/site")),
      // Primary prefix without custom suffix is rejected for deleteDatabase, deleteDatabaseUser, resetPassword, grants [name]
      deleteDatabase(
        makeReq(`${base}/databases/${PRIMARY_DB}`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx(PRIMARY_DB)
      ),
      deleteDatabase(
        makeReq(`${base}/databases/pma_0123456789ab_1`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx("pma_0123456789ab_1")
      ),
      deleteDatabaseUser(
        makeReq(`${base}/database-users/${PRIMARY_DB}`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx(PRIMARY_DB)
      ),
      deleteDatabaseUser(
        makeReq(`${base}/database-users/wp_0123456789ab_Upper`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx("wp_0123456789ab_Upper")
      ),
      postResetPassword(
        makeReq(`${base}/database-users/${PRIMARY_DB}/reset-password`, { method: "POST", cookie, csrf: CSRF }),
        nameCtx(PRIMARY_DB)
      ),
      postResetPassword(
        makeReq(`${base}/database-users/wp_0123456789ab_-bad/reset-password`, { method: "POST", cookie, csrf: CSRF }),
        nameCtx("wp_0123456789ab_-bad")
      ),
      // Grants reject primary or malformed user [name]
      putGrant(
        makeReq(`${base}/database-users/${PRIMARY_DB}/grants/${CUSTOM_DB}`, { method: "PUT", cookie, csrf: CSRF }),
        grantCtx(PRIMARY_DB, CUSTOM_DB)
      ),
      // Grants reject malformed [database]
      putGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/not_a_site_db`, { method: "PUT", cookie, csrf: CSRF }),
        grantCtx(CUSTOM_USER, "not_a_site_db")
      ),
      deleteGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/pma_0123456789ab`, { method: "DELETE", cookie, csrf: CSRF }),
        grantCtx(CUSTOM_USER, "pma_0123456789ab")
      ),
      deleteGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/wp_0123456789ab_${"a".repeat(17)}`, {
          method: "DELETE",
          cookie,
          csrf: CSRF,
        }),
        grantCtx(CUSTOM_USER, `wp_0123456789ab_${"a".repeat(17)}`)
      ),
    ]);

    for (const res of badSegmentResponses) {
      expect(res.status).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("rejects invalid POST bodies on databases and database-users with 400 without calling upstream", async () => {
    const { stub } = installFetchStub();
    const base = `/api/bff/orgs/${ORG}/managed-sites/${SITE}`;
    const invalidPayloads = [
      "{}",
      JSON.stringify({ name: "Shop!" }),
      JSON.stringify({ name: "_shop" }),
      JSON.stringify({ name: "a-b" }),
      JSON.stringify({ name: "a".repeat(17) }),
      JSON.stringify({ name: "shop", extra: true }),
      JSON.stringify(["shop"]),
      "{not-json",
    ];

    for (const body of invalidPayloads) {
      const dbRes = await postDatabases(
        makeReq(`${base}/databases`, { method: "POST", cookie, csrf: CSRF, body }),
        siteCtx()
      );
      expect(dbRes.status, `db:${body}`).toBe(400);

      const userRes = await postDatabaseUsers(
        makeReq(`${base}/database-users`, { method: "POST", cookie, csrf: CSRF, body }),
        siteCtx()
      );
      expect(userRes.status, `user:${body}`).toBe(400);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("forwards GET /databases with 20s timeout and returns payload untouched", async () => {
    const dto = {
      prefix: PRIMARY_DB,
      databases: [{ name: PRIMARY_DB, sizeBytes: 1024, primary: true }],
      users: [{ name: PRIMARY_DB, databases: [PRIMARY_DB], primary: true }],
      limits: { databases: 10, users: 10 },
      phpMyAdminAvailable: true,
    };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { calls } = installFetchStub(200, { data: dto });

    const res = await getDatabases(
      makeReq(`/api/bff/orgs/${ORG}/managed-sites/${SITE}/databases`, { cookie }),
      siteCtx()
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: dto });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/managed-sites/${SITE}/databases`);

    const delays = [
      ...setTimeoutSpy.mock.calls.map((c) => c[1]),
      ...abortTimeoutSpy.mock.calls.map((c) => c[0]),
    ];
    expect(delays).toContain(20_000);
  });

  it("forwards all 7 mutations with 85s timeout and preserves temporaryPassword only on user creation and reset", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const abortTimeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const base = `/api/bff/orgs/${ORG}/managed-sites/${SITE}`;

    // 1. POST /databases -> 201
    {
      const createdDb = { database: { name: CUSTOM_DB, sizeBytes: 0, primary: false } };
      const { calls } = installFetchStub(201, { data: createdDb });
      const res = await postDatabases(
        makeReq(`${base}/databases`, {
          method: "POST",
          cookie,
          csrf: CSRF,
          body: JSON.stringify({ name: "shop" }),
        }),
        siteCtx()
      );
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json).toEqual({ data: createdDb });
      expect(json.data).not.toHaveProperty("temporaryPassword");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/managed-sites/${SITE}/databases`);
      expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ name: "shop" });
    }

    // 2. DELETE /databases/[name] -> 204
    {
      const { calls } = installFetchStub(204);
      const res = await deleteDatabase(
        makeReq(`${base}/databases/${CUSTOM_DB}`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx(CUSTOM_DB)
      );
      expect(res.status).toBe(204);
      expect(calls[0]!.method).toBe("DELETE");
      expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/managed-sites/${SITE}/databases/${CUSTOM_DB}`);
    }

    // 3. POST /database-users -> 201 with temporaryPassword passed through unchanged
    {
      const secretPw = "TempPw!9xQm#2Zr7";
      const createdUser = {
        user: { name: CUSTOM_USER, primary: false, databases: [] },
        temporaryPassword: secretPw,
      };
      const { calls } = installFetchStub(201, { data: createdUser });
      const res = await postDatabaseUsers(
        makeReq(`${base}/database-users`, {
          method: "POST",
          cookie,
          csrf: CSRF,
          body: JSON.stringify({ name: "reader" }),
        }),
        siteCtx()
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ data: createdUser });
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/managed-sites/${SITE}/database-users`);
      expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ name: "reader" });
    }

    // 4. DELETE /database-users/[name] -> 204
    {
      const { calls } = installFetchStub(204);
      const res = await deleteDatabaseUser(
        makeReq(`${base}/database-users/${CUSTOM_USER}`, { method: "DELETE", cookie, csrf: CSRF }),
        nameCtx(CUSTOM_USER)
      );
      expect(res.status).toBe(204);
      expect(calls[0]!.method).toBe("DELETE");
      expect(calls[0]!.url).toContain(`/v1/organizations/${ORG}/managed-sites/${SITE}/database-users/${CUSTOM_USER}`);
    }

    // 5. POST /database-users/[name]/reset-password -> 200 with temporaryPassword unchanged
    {
      const rotatedPw = "ResetPw!8kLp$4Wn2";
      const resetDto = { temporaryPassword: rotatedPw };
      const { calls } = installFetchStub(200, { data: resetDto });
      const res = await postResetPassword(
        makeReq(`${base}/database-users/${CUSTOM_USER}/reset-password`, { method: "POST", cookie, csrf: CSRF }),
        nameCtx(CUSTOM_USER)
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: resetDto });
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain(
        `/v1/organizations/${ORG}/managed-sites/${SITE}/database-users/${CUSTOM_USER}/reset-password`
      );
    }

    // 6. PUT /database-users/[name]/grants/[database] -> 204 (accepts primary DB)
    {
      const { calls } = installFetchStub(204);
      const res = await putGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${PRIMARY_DB}`, {
          method: "PUT",
          cookie,
          csrf: CSRF,
        }),
        grantCtx(CUSTOM_USER, PRIMARY_DB)
      );
      expect(res.status).toBe(204);
      expect(calls[0]!.method).toBe("PUT");
      expect(calls[0]!.url).toContain(
        `/v1/organizations/${ORG}/managed-sites/${SITE}/database-users/${CUSTOM_USER}/grants/${PRIMARY_DB}`
      );
    }

    // 7. DELETE /database-users/[name]/grants/[database] -> 204 (accepts custom DB)
    {
      const { calls } = installFetchStub(204);
      const res = await deleteGrant(
        makeReq(`${base}/database-users/${CUSTOM_USER}/grants/${CUSTOM_DB}`, {
          method: "DELETE",
          cookie,
          csrf: CSRF,
        }),
        grantCtx(CUSTOM_USER, CUSTOM_DB)
      );
      expect(res.status).toBe(204);
      expect(calls[0]!.method).toBe("DELETE");
      expect(calls[0]!.url).toContain(
        `/v1/organizations/${ORG}/managed-sites/${SITE}/database-users/${CUSTOM_USER}/grants/${CUSTOM_DB}`
      );
    }

    const delays = [
      ...setTimeoutSpy.mock.calls.map((c) => c[1]),
      ...abortTimeoutSpy.mock.calls.map((c) => c[0]),
    ];
    expect(delays.filter((d) => d === 85_000).length).toBeGreaterThanOrEqual(7);
  });

  it("passes upstream error statuses such as 409 and 503 through cleanly", async () => {
    installFetchStub(
      503,
      createErrorEnvelope({
        code: "DOCKER_ENGINE_UNAVAILABLE",
        message: "Database service unavailable",
        requestId: "req-503",
      })
    );
    const res = await postDatabases(
      makeReq(`/api/bff/orgs/${ORG}/managed-sites/${SITE}/databases`, {
        method: "POST",
        cookie,
        csrf: CSRF,
        body: JSON.stringify({ name: "shop" }),
      }),
      siteCtx()
    );
    expect(res.status).toBe(503);
    expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });
});
