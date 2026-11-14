import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorEnvelopeSchema } from "@hosting-panel/contracts";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
}));

import * as routeModule from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/databases/phpmyadmin/route";
import {
  PMA_COOKIE_MAX_AGE_S,
  PMA_COOKIE_NAME,
  openPmaCookie,
  pmaPrefix,
  sessionBindingId,
} from "@/lib/phpmyadmin-forwarder";
import { getSessionSecretKey, type SessionData } from "@/lib/session";

const { POST } = routeModule;

const BASE_SESSION: SessionData = {
  accessToken: "tok-1",
  csrfToken: "csrf-1",
  activeConsole: "customer",
  activeOrgSlug: "org-1",
  user: {
    id: "u-1",
    email: "owner@example.test",
    name: "Owner",
    globalRoles: [],
    hostingAdminOrgIds: [],
    locale: "en",
    isServerAdmin: false,
    mustChangePassword: false,
  },
};

function ctx(orgId = "org-1", siteId = "site-1") {
  return { params: Promise.resolve({ orgId, siteId }) };
}

function makePostReq(opts: {
  headers?: Record<string, string>;
  omitCsrf?: boolean;
  rawBody?: string;
} = {}): Request {
  const headers: Record<string, string> = {
    Host: "localhost:3000",
    Origin: "http://localhost:3000",
    ...(opts.omitCsrf ? {} : { "X-CSRF-Token": BASE_SESSION.csrfToken }),
    ...(opts.headers ?? {}),
  };
  return new Request(
    "http://localhost:3000/api/bff/orgs/org-1/managed-sites/site-1/databases/phpmyadmin",
    {
      method: "POST",
      headers,
      ...(opts.rawBody !== undefined ? { body: opts.rawBody } : {}),
    },
  );
}

function getSetCookies(res: Response): string[] {
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

describe("BFF POST .../databases/phpmyadmin", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue(BASE_SESSION);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports POST only", () => {
    expect(typeof POST).toBe("function");
    expect((routeModule as Record<string, unknown>).GET).toBeUndefined();
    expect((routeModule as Record<string, unknown>).PUT).toBeUndefined();
    expect((routeModule as Record<string, unknown>).DELETE).toBeUndefined();
    expect((routeModule as Record<string, unknown>).PATCH).toBeUndefined();
  });

  it("enforces path segment validation, session, origin, and CSRF before calling API", async () => {
    const badPath = await POST(makePostReq(), ctx("org-1", "bad/site"));
    expect(badPath.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(await badPath.json()).error.code).toBe("VALIDATION_ERROR");

    getSessionFromRequest.mockResolvedValueOnce(null);
    const noSession = await POST(makePostReq(), ctx());
    expect(noSession.status).toBe(401);
    expect(ApiErrorEnvelopeSchema.parse(await noSession.json()).error.code).toBe("UNAUTHENTICATED");

    const badOrigin = await POST(
      makePostReq({ headers: { Origin: "https://evil.example.test" } }),
      ctx(),
    );
    expect(badOrigin.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(await badOrigin.json()).error.code).toBe("PERMISSION_DENIED");

    const missingCsrf = await POST(makePostReq({ omitCsrf: true }), ctx());
    expect(missingCsrf.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(await missingCsrf.json()).error.code).toBe("PERMISSION_DENIED");

    const wrongCsrf = await POST(makePostReq({ headers: { "X-CSRF-Token": "wrong" } }), ctx());
    expect(wrongCsrf.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(await wrongCsrf.json()).error.code).toBe("PERMISSION_DENIED");

    const badJson = await POST(makePostReq({ rawBody: "{not-json" }), ctx());
    expect(badJson.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(await badJson.json()).error.code).toBe("VALIDATION_ERROR");

    const unexpectedBody = await POST(makePostReq({ rawBody: '{"extra":1}' }), ctx());
    expect(unexpectedBody.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(await unexpectedBody.json()).error.code).toBe("VALIDATION_ERROR");

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("calls API with 130 s timeout, sets sealed hp_pma cookie, and returns only { data: { url } }", async () => {
    const username = "pma_0123456789ab";
    const temporaryPassword = "SecretPmaTempPassword1234";
    fetchUpstream.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: { data: { username, temporaryPassword } },
    });

    const res = await POST(makePostReq(), ctx("org-1", "site-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");

    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(fetchUpstream).toHaveBeenCalledWith(
      "v1/organizations/org-1/managed-sites/site-1/databases/phpmyadmin",
      {
        method: "POST",
        accessToken: BASE_SESSION.accessToken,
        timeoutMs: 130_000,
      },
    );

    const rawText = await res.text();
    expect(rawText).not.toContain(username);
    expect(rawText).not.toContain(temporaryPassword);
    const json = JSON.parse(rawText) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["data"]);
    expect(json.data).toEqual({ url: "/phpmyadmin/site-1/" });

    const cookies = getSetCookies(res);
    const pmaCookie = cookies.find((c) => c.startsWith(`${PMA_COOKIE_NAME}=`));
    expect(pmaCookie).toBeDefined();
    expect(pmaCookie).not.toContain(username);
    expect(pmaCookie).not.toContain(temporaryPassword);
    expect(pmaCookie).toMatch(/HttpOnly/i);
    expect(pmaCookie).toMatch(/SameSite=Strict/i);
    expect(pmaCookie).toContain(`Path=${pmaPrefix("site-1")}`);
    expect(pmaCookie).toContain(`Max-Age=${PMA_COOKIE_MAX_AGE_S}`);
    expect(pmaCookie).not.toMatch(/;\s*Secure\b/i);

    const cookieValue = pmaCookie!.slice(`${PMA_COOKIE_NAME}=`.length).split(";")[0]!;
    const opened = await openPmaCookie(getSessionSecretKey(), cookieValue);
    expect(opened).toEqual({
      siteId: "site-1",
      orgId: "org-1",
      username,
      password: temporaryPassword,
      sid: sessionBindingId(BASE_SESSION),
    });
  });

  it("sets Secure attribute on hp_pma when NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BFF_SESSION_SECRET", "prod-session-secret-key-32-chars-minimum!");
    fetchUpstream.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: {
        data: {
          username: "pma_abcdef123456",
          temporaryPassword: "ProdSecretPassword123456",
        },
      },
    });

    const res = await POST(makePostReq({ rawBody: "{}" }), ctx("org-1", "site-1"));
    expect(res.status).toBe(200);
    const pmaCookie = getSetCookies(res).find((c) => c.startsWith(`${PMA_COOKIE_NAME}=`));
    expect(pmaCookie).toMatch(/;\s*Secure\b/i);
  });

  it("rejects non-conforming upstream sign-on responses with 502 and sets no cookie", async () => {
    const badBodies = [
      { data: { username: "wp_0123456789ab", temporaryPassword: "ValidLengthPassword12345" } },
      { data: { username: "pma_0123456789ab", temporaryPassword: "too-short" } },
      { data: { username: "pma_0123456789ab", temporaryPassword: "ValidLengthPassword12345", extra: 1 } },
      { data: { username: "pma_0123456789ab", temporaryPassword: "ValidLengthPassword12345" }, extra: true },
      null,
    ];

    for (const badBody of badBodies) {
      fetchUpstream.mockResolvedValueOnce({
        status: 200,
        ok: true,
        data: badBody,
      });
      const res = await POST(makePostReq(), ctx());
      expect(res.status).toBe(502);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("INTERNAL_ERROR");
      expect(getSetCookies(res)).toHaveLength(0);
    }
  });

  it("passes upstream errors through with status and code and sets no cookie", async () => {
    for (const [status, code] of [
      [403, "ORGANIZATION_SUSPENDED"],
      [404, "NOT_FOUND"],
      [409, "RESOURCE_LOCKED"],
      [422, "NOT_SUPPORTED"],
      [503, "DOCKER_ENGINE_UNAVAILABLE"],
      [504, "INTERNAL_ERROR"],
    ] as const) {
      const errorPayload = {
        error: {
          code,
          message: `Upstream ${code}`,
          requestId: "req-1",
          retryable: status >= 500,
          details: [],
        },
      };
      fetchUpstream.mockResolvedValueOnce({
        status,
        ok: false,
        error: errorPayload,
      });

      const res = await POST(makePostReq(), ctx());
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(errorPayload);
      expect(getSetCookies(res)).toHaveLength(0);
    }
  });
});
