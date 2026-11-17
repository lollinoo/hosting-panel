import { describe, expect, it } from "vitest";
import { classifyUpstream } from "@/lib/server-api";
import { GET as getExpired } from "@/app/api/session/expired/route";
import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/session";
import { getSessionFromRequest } from "@/lib/server-session";

describe("dead API session handling", () => {
  it("classifyUpstream tells a dead session, a missing resource and other failures apart", () => {
    expect(classifyUpstream({ ok: true, status: 200 })).toBe("ok");
    expect(classifyUpstream({ ok: false, status: 401 })).toBe("expired");
    expect(classifyUpstream({ ok: false, status: 404 })).toBe("notFound");
    expect(classifyUpstream({ ok: false, status: 403 })).toBe("error");
    expect(classifyUpstream({ ok: false, status: 500 })).toBe("error");
    expect(classifyUpstream({ ok: false, status: 502 })).toBe("error");
  });

  it("GET /api/session/expired clears the session cookie and sends the user to /login", async () => {
    const res = await getExpired();
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(setCookie.toLowerCase()).toContain("max-age=0");
  });

  it("a foreign cookie with a broken % code is skipped: the session still reads, and alone it means no session", async () => {
    const token = await encryptSession({
      accessToken: "sentinel-access-token",
      csrfToken: "csrf-sentinel-value",
      activeConsole: "customer",
      activeOrgSlug: null,
      user: {
        id: "user_1",
        email: "owner@example.test",
        name: "Owner",
        globalRoles: [],
        hostingAdminOrgIds: [],
        locale: "en",
        isServerAdmin: false,
        mustChangePassword: false,
      },
    });
    const req = (cookie: string) => new Request("http://localhost:3000/api/session", { headers: { Cookie: cookie } });
    const session = await getSessionFromRequest(req(`x=%zz; ${SESSION_COOKIE_NAME}=${token}`));
    expect(session?.user.id).toBe("user_1");
    await expect(getSessionFromRequest(req(`${SESSION_COOKIE_NAME}=%zz`))).resolves.toBeNull();
  });
});
