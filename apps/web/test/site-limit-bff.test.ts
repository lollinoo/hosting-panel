import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchUpstream = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSession(...a),
}));

import * as limitRoute from "@/app/api/admin/organizations/[orgId]/site-limit/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const PATCH = limitRoute.PATCH as unknown as Handler;

const ORG = "org_1";
const PATH = `v1/admin/organizations/${ORG}/site-limit`;
const ctx = (orgId = ORG) => ({ params: Promise.resolve({ orgId }) });

function req(over: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  return new Request("http://localhost:3000/x", {
    method: "PATCH",
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body)),
  });
}

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("site limit BFF route", () => {
  it.each([{ maxSites: 3 }, { maxSites: 0 }, { maxSites: 10_000 }, { maxSites: null }])("forwards %j to the API unchanged", async (body) => {
    const answer = { data: { organizationId: ORG, maxSites: body.maxSites, usedSites: 2 } };
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const res = await PATCH(req({ body }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
    const [path, opts] = fetchUpstream.mock.calls[0]!;
    expect(path).toBe(PATH);
    expect(opts).toMatchObject({ method: "PATCH", accessToken: "tok", body });
    // The API route is synchronous and idempotent by nature: no key is forwarded.
    expect(opts.idempotencyKey).toBeUndefined();
  });

  it.each([
    { maxSites: -1 },
    { maxSites: 1.5 },
    { maxSites: "3" },
    { maxSites: 10_001 },
    { maxSites: undefined },
    {},
    { maxSites: 3, extra: 1 },
    { maxSites: 3, organizationId: "org_2" },
    null,
    [],
  ])("refuses %j before the API", async (body) => {
    const res = await PATCH(req({ body }), ctx());
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("VALIDATION_ERROR");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("an empty or malformed body is a 400 before the API", async () => {
    expect((await PATCH(req(), ctx())).status).toBe(400);
    expect((await PATCH(req({ raw: "{maxSites:" }), ctx())).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a bad organisation segment is a 400 before the session is read", async () => {
    for (const bad of ["../x", "a b", "a".repeat(129), ""]) {
      expect((await PATCH(req({ body: { maxSites: 1 } }), ctx(bad))).status, bad).toBe(400);
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a wrong CSRF token or a foreign Origin is a 403 and the API is not called", async () => {
    for (const headers of [{ "X-CSRF-Token": "bad" }, { Origin: "http://evil.test" }] as Record<string, string>[]) {
      expect((await PATCH(req({ headers, body: { maxSites: 1 } }), ctx())).status).toBe(403);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("without a session it is a 401 and the API is not called", async () => {
    getSession.mockResolvedValue(null);
    expect((await PATCH(req({ body: { maxSites: 1 } }), ctx())).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("returns the API refusal with its status and code", async () => {
    for (const [status, code] of [[403, "PERMISSION_DENIED"], [404, "NOT_FOUND"]] as const) {
      fetchUpstream.mockResolvedValue({ ok: false, status, error: { error: { code, message: "no", details: [] } } });
      const res = await PATCH(req({ body: { maxSites: 1 } }), ctx());
      expect(res.status).toBe(status);
      expect(await res.text()).toContain(code);
    }
  });
});
