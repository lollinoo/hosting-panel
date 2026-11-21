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

import * as templatesRoute from "@/app/api/admin/site-templates/route";
import * as validateRoute from "@/app/api/admin/site-templates/validate/route";
import * as templateRoute from "@/app/api/admin/site-templates/[templateId]/route";
import * as versionsRoute from "@/app/api/admin/site-templates/[templateId]/versions/route";
import * as upgradeRoute from "@/app/api/admin/sites/[siteId]/template-version/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const SOURCE = "services:\n  web:\n    image: ${HP_MODULE_IMAGE}\n";
const VERSION = "stv_" + "a".repeat(8);
const create = { module: "wordpress", name: "Shop", description: "Blog stack", source: SOURCE };
const T = "stpl_custom1";

interface Case {
  name: string;
  handler: Handler;
  method: "POST" | "PATCH" | "DELETE";
  params: Record<string, string>;
  path: string;
  body?: unknown;
  /** admin mutations that are async/creating need the key; synchronous ones forward none */
  idempotency: boolean;
  status: number;
  badBodies?: unknown[];
}

const cases: Case[] = [
  {
    name: "template create",
    handler: templatesRoute.POST as unknown as Handler,
    method: "POST",
    params: {},
    path: "v1/admin/site-templates",
    body: create,
    idempotency: true,
    status: 201,
    badBodies: [
      { module: "wordpress", name: "Shop" },
      { ...create, source: undefined },
      { ...create, extra: 1 },
      { ...create, source: "x".repeat(65_537) },
      { ...create, module: "joomla" },
      { ...create, hostPath: "/srv/x" },
      { ...create, name: "" },
      { ...create, description: "d".repeat(501) },
      [],
    ],
  },
  {
    name: "template validate",
    handler: validateRoute.POST as unknown as Handler,
    method: "POST",
    params: {},
    path: "v1/admin/site-templates/validate",
    body: { module: "wordpress", source: SOURCE },
    idempotency: false,
    status: 200,
    badBodies: [{ source: SOURCE }, { module: "wordpress" }, { module: "wordpress", source: "" }, { module: "wordpress", source: SOURCE, name: "x" }, { module: "other", source: SOURCE }],
  },
  {
    name: "template update",
    handler: templateRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: { templateId: T },
    path: `v1/admin/site-templates/${T}`,
    body: { enabled: true },
    idempotency: false,
    status: 200,
    badBodies: [{}, { enabled: "yes" }, { name: "" }, { module: "wordpress" }, { source: SOURCE }, { enabled: true, builtIn: false }, { defaultVersionId: "" }],
  },
  {
    name: "template archive",
    handler: templateRoute.DELETE as unknown as Handler,
    method: "DELETE",
    params: { templateId: T },
    path: `v1/admin/site-templates/${T}`,
    idempotency: false,
    status: 200,
  },
  {
    name: "template version create",
    handler: versionsRoute.POST as unknown as Handler,
    method: "POST",
    params: { templateId: T },
    path: `v1/admin/site-templates/${T}/versions`,
    body: { source: SOURCE, makeDefault: false },
    idempotency: true,
    status: 201,
    badBodies: [{}, { makeDefault: true }, { source: SOURCE, makeDefault: "yes" }, { source: SOURCE, module: "wordpress" }, { source: "x".repeat(65_537) }],
  },
  {
    name: "site template version change",
    handler: upgradeRoute.POST as unknown as Handler,
    method: "POST",
    params: { siteId: "site_1" },
    path: "v1/admin/sites/site_1/template-version",
    body: { versionId: VERSION },
    idempotency: true,
    status: 202,
    badBodies: [{}, { versionId: "" }, { versionId: "../x" }, { versionId: 3 }, { versionId: VERSION, extra: 1 }, { versionId: VERSION, templateId: T }],
  },
];

function req(method: string, over: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  return new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body)),
  });
}
const headersFor = (c: Case, key: string): Record<string, string> => (c.idempotency ? { "Idempotency-Key": key } : {});
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const okResponse = (c: Case) => ({ status: c.status, ok: true, data: { data: {} } });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("site template BFF routes", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("forwards the exact path, method, token, body and timeout and passes the status through", async () => {
        fetchUpstream.mockResolvedValue(okResponse(c));
        const res = await c.handler(req(c.method, { headers: headersFor(c, "idem-1"), body: c.body }), ctxOf(c.params));
        expect(res.status).toBe(c.status);
        expect(fetchUpstream).toHaveBeenCalledTimes(1);
        const [path, opts] = fetchUpstream.mock.calls[0]!;
        expect(path).toBe(c.path);
        expect(opts).toMatchObject({ method: c.method, accessToken: "tok" });
        expect(opts.timeoutMs).toBe(c.path.endsWith("template-version") ? undefined : 20_000);
        if (c.body !== undefined) expect(opts.body).toEqual(c.body);
        expect(res.headers.get("cache-control")).toContain("no-store");
      });

      it("a wrong CSRF token or a foreign Origin is a 403 and the API is not called", async () => {
        for (const headers of [{ "X-CSRF-Token": "bad" }, { Origin: "http://evil.test" }] as Record<string, string>[]) {
          const res = await c.handler(req(c.method, { headers: { ...headersFor(c, "k"), ...headers }, body: c.body }), ctxOf(c.params));
          expect(res.status).toBe(403);
        }
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      it("without a session it is a 401 and the API is not called", async () => {
        getSession.mockResolvedValue(null);
        expect((await c.handler(req(c.method, { headers: headersFor(c, "k"), body: c.body }), ctxOf(c.params))).status).toBe(401);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      const keys = Object.keys(c.params);
      if (keys.length > 0) {
        it("a bad path segment is a 400 before the session is read", async () => {
          for (const bad of ["../x", "a b", "a".repeat(129), ""]) {
            const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body: c.body }), ctxOf({ ...c.params, [keys[0]!]: bad }));
            expect(res.status, bad).toBe(400);
          }
          expect(getSession).not.toHaveBeenCalled();
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.badBodies) {
        it("refuses bodies outside the strict contract before the API", async () => {
          for (const body of c.badBodies!) {
            const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body }), ctxOf(c.params));
            expect(res.status, JSON.stringify(body)?.slice(0, 80)).toBe(400);
            expect(await res.text()).toContain("VALIDATION_ERROR");
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });

        it("a malformed JSON body is a 400 before the API", async () => {
          expect((await c.handler(req(c.method, { headers: headersFor(c, "k"), raw: "{source:" }), ctxOf(c.params))).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.idempotency) {
        it("requires the Idempotency-Key and forwards it", async () => {
          expect((await c.handler(req(c.method, { body: c.body }), ctxOf(c.params))).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
          fetchUpstream.mockResolvedValue(okResponse(c));
          await c.handler(req(c.method, { headers: { "Idempotency-Key": "admin-key-1" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("admin-key-1");
        });
      } else {
        it("forwards no Idempotency-Key (synchronous route)", async () => {
          fetchUpstream.mockResolvedValue(okResponse(c));
          await c.handler(req(c.method, { headers: { "Idempotency-Key": "ignored" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBeUndefined();
        });
      }
    });
  }

  it("the archive route accepts an empty body", async () => {
    fetchUpstream.mockResolvedValue({ status: 200, ok: true, data: { data: {} } });
    const res = await (templateRoute.DELETE as unknown as Handler)(req("DELETE"), ctxOf({ templateId: T }));
    expect(res.status).toBe(200);
    expect(fetchUpstream.mock.calls[0]![1].body).toBeUndefined();
  });

  it("the create, version and upgrade routes need a JSON body: an empty one is a 400", async () => {
    for (const [h, params] of [
      [templatesRoute.POST, {}],
      [versionsRoute.POST, { templateId: T }],
      [upgradeRoute.POST, { siteId: "site_1" }],
    ] as unknown as [Handler, Record<string, string>][]) {
      expect((await h(req("POST", { headers: { "Idempotency-Key": "k" } }), ctxOf(params))).status).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a version body without makeDefault is forwarded as sent (the API applies the default)", async () => {
    fetchUpstream.mockResolvedValue({ status: 201, ok: true, data: { data: {} } });
    await (versionsRoute.POST as unknown as Handler)(req("POST", { headers: { "Idempotency-Key": "k" }, body: { source: SOURCE } }), ctxOf({ templateId: T }));
    expect(fetchUpstream.mock.calls[0]![1].body).toEqual({ source: SOURCE });
  });

  it("a source of exactly 65536 bytes is forwarded and 65537 is refused", async () => {
    fetchUpstream.mockResolvedValue({ status: 200, ok: true, data: { data: {} } });
    const handler = validateRoute.POST as unknown as Handler;
    expect((await handler(req("POST", { body: { module: "wordpress", source: "a".repeat(65_536) } }), ctxOf({}))).status).toBe(200);
    expect((await handler(req("POST", { body: { module: "wordpress", source: "a".repeat(65_537) } }), ctxOf({}))).status).toBe(400);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it("returns the validation answer unchanged, with its errors and the preview", async () => {
    const answer = {
      data: {
        valid: false,
        errors: [{ line: 3, column: 5, path: "services.web.image", code: "IMAGE_REQUIRED", message: "image is required" }],
        parameters: [],
        preview: null,
      },
    };
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const res = await (validateRoute.POST as unknown as Handler)(req("POST", { body: { module: "wordpress", source: SOURCE } }), ctxOf({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
  });

  it("returns API refusals with their status and code", async () => {
    for (const [status, code] of [[404, "NOT_FOUND"], [409, "ALREADY_EXISTS"], [409, "RESOURCE_LOCKED"], [403, "PERMISSION_DENIED"]] as const) {
      fetchUpstream.mockResolvedValue({ ok: false, status, error: { error: { code, message: "no", details: [{ reason: "built_in" }] } } });
      const res = await (templateRoute.DELETE as unknown as Handler)(req("DELETE"), ctxOf({ templateId: T }));
      expect(res.status).toBe(status);
      expect(await res.text()).toContain(code);
    }
  });

  it("a site template answer whose parameters and environment are arrays passes without redaction", async () => {
    const answer = {
      data: {
        valid: true,
        errors: [],
        parameters: [{ key: "password", label: "Password", type: "string" }],
        preview: { services: [{ name: "web", environment: [{ name: "PASSWORD", value: "x" }, { name: "API_KEY", value: "y" }] }] },
      },
    };
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const res = await (validateRoute.POST as unknown as Handler)(req("POST", { body: { module: "wordpress", source: SOURCE } }), ctxOf({}));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(answer);
    expect(text).not.toContain("REDACTED");
  });
});
