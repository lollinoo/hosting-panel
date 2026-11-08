import { describe, expect, it } from "vitest";
import { classifyUpstream } from "@/lib/server-api";
import { GET as getExpired } from "@/app/api/session/expired/route";
import { SESSION_COOKIE_NAME } from "@/lib/session";

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
});
