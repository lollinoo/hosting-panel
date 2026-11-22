import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorEnvelope } from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { errorMessage } from "@/i18n";
import { decryptSession, encryptSession, SESSION_COOKIE_NAME, type SessionData } from "@/lib/session";

// #8 web part, end to end across the BFF: what the browser gets, where the server pages send a flagged
// session, and that the way out (change password, sign out) never loops. Only the API hop is mocked.
const fetchUpstream = vi.fn();
const getServerSession = vi.fn();
class Redirected extends Error {}
const redirect = vi.fn((to: string) => {
  throw new Redirected(to);
});

vi.mock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/server-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/server-session")>()),
  getServerSession: () => getServerSession(),
}));

import { POST as createCustomer } from "@/app/api/admin/customer-account/route";
import { POST as openPort } from "@/app/api/admin/firewall/ports/[name]/open/route";
import { POST as createSite } from "@/app/api/bff/orgs/[orgId]/sites/route";
import { GET as siteLogs } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/logs/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { POST as logout } from "@/app/api/session/logout/route";
import { GET as sessionProbe } from "@/app/api/session/route";
import { serverGet, fetchServerMe } from "@/lib/server-api";
import { keyedSend } from "@/lib/keyed-send";
import ChangePasswordPage from "@/app/account/change-password/page";
import HomePage from "@/app/page";
import AdminLayout from "@/app/admin/layout";
import { getCustomerContext } from "@/app/sites/data";

const session = (mustChangePassword: boolean, over: Partial<SessionData["user"]> = {}): SessionData => ({
  accessToken: "flagged-token",
  csrfToken: "csrf-1",
  activeConsole: "customer",
  activeOrgSlug: null,
  user: {
    id: "u1",
    email: "owner@example.test",
    name: "Owner",
    globalRoles: [],
    hostingAdminOrgIds: [],
    locale: "en",
    isServerAdmin: false,
    mustChangePassword,
    ...over,
  },
});

const refusal = createErrorEnvelope({
  code: "PASSWORD_CHANGE_REQUIRED",
  message: "Change the temporary password first.",
  requestId: "req-8",
});
const refused = { ok: false, status: 403, error: refusal };

async function cookieOf(s: SessionData): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await encryptSession(s)}`;
}
async function request(method: string, path: string, s: SessionData | null, body?: unknown, extra: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      Host: "localhost:3000",
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-1",
      ...(s ? { Cookie: await cookieOf(s) } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  fetchUpstream.mockReset();
  getServerSession.mockReset();
  redirect.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("BFF routes hand PASSWORD_CHANGE_REQUIRED to the browser untouched", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["admin mutation (forwardToUpstream)", async () => createCustomer(await request("POST", "/api/admin/customer-account", session(true), {}))],
    [
      "admin mutation (forwardIdempotent)",
      async () =>
        openPort(await request("POST", "/api/admin/firewall/ports/http_alt/open", session(true), {}, { "Idempotency-Key": "k1" }), {
          params: Promise.resolve({ name: "http_alt" }),
        }),
    ],
    [
      "customer mutation (hand-written route)",
      async () =>
        createSite(await request("POST", "/api/bff/orgs/org1/sites", session(true), {}, { "Idempotency-Key": "k1" }), {
          params: Promise.resolve({ orgId: "org1" }),
        }),
    ],
    [
      "customer read",
      async () =>
        siteLogs(await request("GET", "/api/bff/orgs/org1/managed-sites/s1/logs", session(true)), {
          params: Promise.resolve({ orgId: "org1", siteId: "s1" }),
        }),
    ],
  ];

  it.each(cases)("%s: 403 + code + no-store, and the session cookie is neither cleared nor rewritten", async (_n, call) => {
    fetchUpstream.mockResolvedValueOnce(refused);
    const res = await call();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; retryable: boolean; requestId: string } };
    expect(body.error).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED", retryable: false, requestId: "req-8" });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    expect(fetchUpstream.mock.calls[0]![1]).toMatchObject({ accessToken: "flagged-token" });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("client side of a refused BFF call", () => {
  it("keyedSend returns the code and drops the key; the catalogs turn it into the reload sentence", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(refusal), { status: 403, headers: { "Content-Type": "application/json" } }));
    const keys: Record<string, string> = {};
    const out = await keyedSend(keys, "csrf-1", "open", "POST", "/api/admin/firewall/ports/http_alt/open", {});
    expect(out).toEqual({ ok: false, code: "PASSWORD_CHANGE_REQUIRED" });
    expect(keys).toEqual({});
    expect(out.ok ? "" : errorMessage(en, out.code)).toBe("Choose a new password to go on: reload the page.");
    expect(out.ok ? "" : errorMessage(itMsgs, out.code)).toBe("Per continuare scegli una nuova password: ricarica la pagina.");
  });
});

describe("serverGet and the flagged session", () => {
  it("GET /v1/me answers for a flagged session: no redirect, so the layouts do not loop", async () => {
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 200, data: { data: { user: { mustChangePassword: true } } } });
    getServerSession.mockResolvedValue(session(true));
    await expect(fetchServerMe()).resolves.toEqual({ user: { mustChangePassword: true } });
    expect(redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["the code on another status", { ok: false, status: 500, error: refusal }],
    ["a 403 without a JSON error body", { ok: false, status: 403, error: { raw: "<html>" } }],
    ["a 403 with a non-string code", { ok: false, status: 403, error: { error: { code: 8 } } }],
    ["a 403 with no body at all", { ok: false, status: 403, error: null }],
  ])("%s does not redirect", async (_n, res) => {
    getServerSession.mockResolvedValue(session(false));
    fetchUpstream.mockResolvedValueOnce(res);
    await expect(serverGet("v1/hosts")).resolves.toMatchObject({ ok: false, outcome: "error" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("a dead session (401) still goes to the expired route, never to the change-password page", async () => {
    getServerSession.mockResolvedValue(session(true));
    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 401, error: createErrorEnvelope({ code: "UNAUTHENTICATED", message: "x", requestId: "r" }) });
    await expect(serverGet("v1/hosts")).rejects.toThrow("/api/session/expired");
  });

  it("the redirect target is the page the cookie guards send to as well", async () => {
    getServerSession.mockResolvedValue(session(true));
    fetchUpstream.mockResolvedValueOnce(refused);
    await expect(serverGet("v1/hosts")).rejects.toThrow("/account/change-password");
    expect(redirect).toHaveBeenCalledWith("/account/change-password");
  });
});

describe("pages and layouts for a flagged cookie", () => {
  it("the change-password page renders the form with the CSRF token and makes no API call", async () => {
    getServerSession.mockResolvedValue(session(true));
    const el = (await ChangePasswordPage()) as { props: { children: { props: { csrfToken: string } } } };
    expect(el.props.children.props.csrfToken).toBe("csrf-1");
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("the change-password page without a session goes to /login", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(ChangePasswordPage()).rejects.toThrow("/login");
  });

  it.each([
    ["home", () => HomePage()],
    ["admin layout", () => AdminLayout({ children: null })],
    ["customer context", () => getCustomerContext()],
  ])("%s sends the flagged cookie to the change-password page before any API call", async (_n, run) => {
    getServerSession.mockResolvedValue(session(true, { isServerAdmin: true }));
    await expect(run()).rejects.toThrow("/account/change-password");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("an unflagged customer is not sent to the change-password page", async () => {
    getServerSession.mockResolvedValue(session(false));
    await expect(HomePage()).rejects.toThrow("/apps");
  });
});

describe("the way out of the forced screen", () => {
  it("GET /api/session keeps a flagged session alive and reports the flag", async () => {
    fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: {
          user: { id: "u1", email: "owner@example.test", name: "Owner", locale: "en", isServerAdmin: false, mustChangePassword: true },
          globalRoles: [],
          hostingAdminOrgIds: [],
          memberships: [],
          platformCapabilities: {},
        },
      },
    });
    const res = await sessionProbe(await request("GET", "/api/session", session(true)));
    const body = (await res.json()) as { authenticated: boolean; user: { mustChangePassword: boolean } };
    expect(body).toMatchObject({ authenticated: true, user: { mustChangePassword: true } });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sign-out revokes the token and clears the cookie, even when the API refuses the revoke", async () => {
    fetchUpstream.mockResolvedValueOnce(refused);
    const res = await logout(await request("POST", "/api/session/logout", session(true)));
    expect(res.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledWith("v1/auth/revoke", { method: "POST", accessToken: "flagged-token" });
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=;`);
  });

  it("a successful password change rewrites the cookie with the flag cleared and the same token", async () => {
    fetchUpstream.mockResolvedValueOnce({ ok: true, status: 204 });
    const res = await changePassword(await request("POST", "/api/account/password", session(true), { currentPassword: "old-password-1", newPassword: "new-password-12" }));
    expect(res.status).toBe(204);
    expect(fetchUpstream.mock.calls[0]![0]).toBe("v1/me/password");
    const raw = /hp_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const after = await decryptSession(raw);
    expect(after?.user.mustChangePassword).toBe(false);
    expect(after?.accessToken).toBe("flagged-token");
    expect(after?.csrfToken).toBe("csrf-1");
  });

  it("a wrong current password keeps the flag: the error passes through and the cookie is untouched", async () => {
    fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: createErrorEnvelope({ code: "INVALID_CREDENTIALS", message: "no", requestId: "r" }),
    });
    const res = await changePassword(await request("POST", "/api/account/password", session(true), { currentPassword: "x", newPassword: "new-password-12" }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
