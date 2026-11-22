import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchUpstream = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSession(...a),
  getServerSession: (...a: unknown[]) => getSession(...a),
}));

import { MAX_BFF_BODY_BYTES } from "@/lib/bff-proxy";
import * as templatesRoute from "@/app/api/admin/app-templates/route";
import * as validateRoute from "@/app/api/admin/app-templates/validate/route";
import * as templateRoute from "@/app/api/admin/app-templates/[templateId]/route";
import * as versionsRoute from "@/app/api/admin/app-templates/[templateId]/versions/route";
import * as archiveRoute from "@/app/api/admin/app-templates/[templateId]/archive/route";
import * as serverApi from "@/lib/server-api";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const SOURCE = "version: HCP-STACK/v1\nservices:\n  web:\n    image: registry.test/web@sha256:" + "a".repeat(64) + "\n";
const T = "atpl_notes";
const create = { slug: "notes", source: SOURCE };

interface Case {
  name: string;
  handler: Handler;
  params: Record<string, string>;
  method: "POST" | "PATCH";
  path: string;
  body: unknown;
  idempotency: boolean;
  timeoutMs: number | undefined;
  status: number;
  badBodies: unknown[];
}

const cases: Case[] = [
  {
    name: "template create",
    handler: templatesRoute.POST as unknown as Handler,
    params: {},
    method: "POST",
    path: "v1/admin/app-templates",
    body: create,
    idempotency: true,
    timeoutMs: 20_000,
    status: 201,
    badBodies: [
      { slug: "notes" },
      { source: SOURCE },
      { ...create, builtIn: true },
      { ...create, hostPath: "/srv/x" },
      { ...create, source: "" },
      { ...create, source: "x".repeat(65_537) },
      { ...create, slug: "" },
      { ...create, slug: "A" },
      { ...create, slug: "-x" },
      { ...create, slug: "Notes" },
      { ...create, slug: "n".repeat(49) },
      [],
    ],
  },
  {
    name: "template validate",
    handler: validateRoute.POST as unknown as Handler,
    params: {},
    method: "POST",
    path: "v1/admin/app-templates/validate",
    body: { source: SOURCE },
    idempotency: false,
    timeoutMs: 20_000,
    status: 200,
    badBodies: [{}, { source: "" }, { source: 3 }, { source: SOURCE, slug: "notes" }, { source: SOURCE, builtIn: true }, { source: "x".repeat(65_537) }],
  },
  {
    name: "template update",
    handler: templateRoute.PATCH as unknown as Handler,
    params: { templateId: T },
    method: "PATCH",
    path: `v1/admin/app-templates/${T}`,
    body: { enabled: true },
    idempotency: false,
    timeoutMs: 20_000,
    status: 200,
    badBodies: [{}, { enabled: "yes" }, { source: SOURCE }, { enabled: true, builtIn: false }, { hostPath: "/srv/x" }, { defaultVersionId: "" }, { defaultVersionId: "../x" }],
  },
  {
    name: "template version create",
    handler: versionsRoute.POST as unknown as Handler,
    params: { templateId: T },
    method: "POST",
    path: `v1/admin/app-templates/${T}/versions`,
    body: { source: SOURCE, makeDefault: false },
    idempotency: true,
    timeoutMs: 20_000,
    status: 201,
    badBodies: [{}, { makeDefault: true }, { source: SOURCE, makeDefault: "yes" }, { source: SOURCE, slug: "notes" }, { source: SOURCE, builtIn: true }, { source: "x".repeat(65_537) }],
  },
  {
    name: "template archive",
    handler: archiveRoute.POST as unknown as Handler,
    params: { templateId: T },
    method: "POST",
    path: `v1/admin/app-templates/${T}/archive`,
    body: {},
    idempotency: false,
    timeoutMs: undefined,
    status: 200,
    badBodies: [{ reason: "old" }, { builtIn: false }, [], "x"],
  },
];

function req(method: string, over: { headers?: Record<string, string>; body?: unknown; raw?: string; stream?: ReadableStream<Uint8Array> } = {}) {
  return new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: over.stream ?? over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body)),
    ...(over.stream ? { duplex: "half" } : {}),
  } as RequestInit);
}
const headersFor = (c: Case, key: string): Record<string, string> => (c.idempotency ? { "Idempotency-Key": key } : {});
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

const CHUNK = 64 * 1024;
// A body that never ends: counts what was pulled and whether the reader cancelled it.
function endlessBody() {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= 16 * MAX_BFF_BODY_BYTES) {
          controller.error(new Error("drained"));
          return;
        }
        state.pulled += CHUNK;
        controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("admin application template BFF routes", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("forwards the exact path, method, token, body and timeout and passes status and envelope through", async () => {
        const envelope = { data: { id: T, slug: "notes" } };
        fetchUpstream.mockResolvedValue({ status: c.status, ok: true, data: envelope });
        const res = await c.handler(req(c.method, { headers: headersFor(c, "idem-1"), body: c.body }), ctxOf(c.params));
        expect(res.status).toBe(c.status);
        expect(await res.json()).toEqual(envelope);
        expect(res.headers.get("cache-control")).toContain("no-store");
        expect(fetchUpstream).toHaveBeenCalledTimes(1);
        const [path, opts] = fetchUpstream.mock.calls[0]!;
        expect(path).toBe(c.path);
        expect(opts).toMatchObject({ method: c.method, accessToken: "tok" });
        expect(opts.timeoutMs).toBe(c.timeoutMs);
        expect(opts.body).toEqual(c.body);
      });

      it("a wrong CSRF token or a foreign Origin is a 403 before the key check, and the API is not called", async () => {
        for (const headers of [{ "X-CSRF-Token": "bad" }, { Origin: "http://evil.test" }] as Record<string, string>[]) {
          expect((await c.handler(req(c.method, { headers, body: c.body }), ctxOf(c.params))).status).toBe(403);
        }
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      it("without a session it is a 401 and the API is not called", async () => {
        getSession.mockResolvedValue(null);
        expect((await c.handler(req(c.method, { headers: headersFor(c, "k"), body: c.body }), ctxOf(c.params))).status).toBe(401);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      if (c.params.templateId) {
        it("a bad path segment is a 400 before the session is read", async () => {
          for (const bad of ["../x", "a b", "a".repeat(129), ""]) {
            const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body: c.body }), ctxOf({ templateId: bad }));
            expect(res.status, bad).toBe(400);
          }
          expect(getSession).not.toHaveBeenCalled();
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      it("refuses bodies outside the strict contract, and malformed JSON, before the API", async () => {
        for (const body of c.badBodies) {
          const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body }), ctxOf(c.params));
          expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
          expect(await res.text()).toContain("VALIDATION_ERROR");
        }
        expect((await c.handler(req(c.method, { headers: headersFor(c, "k"), raw: "{source:" }), ctxOf(c.params))).status).toBe(400);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      it("a body that never ends is a 413, its stream is cancelled after about 1 MiB, the API is not called", async () => {
        const { stream, state } = endlessBody();
        const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), stream }), ctxOf(c.params));
        expect(res.status).toBe(413);
        expect(state.cancelled).toBe(true);
        expect(state.pulled).toBeLessThanOrEqual(MAX_BFF_BODY_BYTES + CHUNK);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      if (c.idempotency) {
        it("requires the Idempotency-Key before reading the body, never makes one up, and forwards the client's", async () => {
          const { stream, state } = endlessBody();
          const res = await c.handler(req(c.method, { stream }), ctxOf(c.params));
          expect(res.status).toBe(400);
          expect(await res.text()).toContain("idempotency-key");
          expect(state.pulled).toBe(0);
          expect((await c.handler(req(c.method, { body: c.body }), ctxOf(c.params))).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
          fetchUpstream.mockResolvedValue({ status: c.status, ok: true, data: { data: {} } });
          await c.handler(req(c.method, { headers: { "Idempotency-Key": "admin-key-1" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("admin-key-1");
        });
      } else {
        it("forwards no Idempotency-Key (synchronous route)", async () => {
          fetchUpstream.mockResolvedValue({ status: c.status, ok: true, data: { data: {} } });
          await c.handler(req(c.method, { headers: { "Idempotency-Key": "ignored" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBeUndefined();
        });
      }
    });
  }

  it("the archive route accepts an empty body; create and version need a JSON body", async () => {
    fetchUpstream.mockResolvedValue({ status: 200, ok: true, data: { data: {} } });
    expect((await (archiveRoute.POST as unknown as Handler)(req("POST"), ctxOf({ templateId: T }))).status).toBe(200);
    expect(fetchUpstream.mock.calls[0]![1].body).toBeUndefined();
    fetchUpstream.mockClear();
    for (const [h, params] of [
      [templatesRoute.POST, {}],
      [versionsRoute.POST, { templateId: T }],
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
    expect((await handler(req("POST", { body: { source: "a".repeat(65_536) } }), ctxOf({}))).status).toBe(200);
    expect((await handler(req("POST", { body: { source: "a".repeat(65_537) } }), ctxOf({}))).status).toBe(400);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it("returns API refusals with their status, code and details", async () => {
    const refusals = [
      [404, "NOT_FOUND", "not_found"],
      [409, "ALREADY_EXISTS", "slug_taken"],
      [409, "RESOURCE_LOCKED", "built_in"],
      [409, "IDEMPOTENCY_CONFLICT", "key_reused"],
      [422, "NOT_SUPPORTED", "flag_off"],
    ] as const;
    for (const [status, code, reason] of refusals) {
      const error = { error: { code, message: "no", details: [{ field: "slug", reason }] } };
      fetchUpstream.mockResolvedValue({ ok: false, status, error });
      const res = await (templatesRoute.POST as unknown as Handler)(req("POST", { headers: { "Idempotency-Key": "k" }, body: create }), ctxOf({}));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(error);
    }
  });

  it("a validation answer with issues and arrays of {key: PASSWORD} parameters passes unchanged, unredacted", async () => {
    const answer = {
      data: {
        valid: true,
        issues: [{ line: 3, column: 5, path: "services.web", code: "IMAGE_DIGEST_MISSING", reason: "digest", message: "m" }],
        parameters: [{ key: "PASSWORD", label: "Password", type: "secret" }, { key: "API_KEY", label: "Key", type: "secret" }],
        preview: { components: [{ key: "web", environment: [{ key: "PASSWORD", value: "x" }, { key: "API_KEY", value: "y" }] }] },
      },
    };
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const res = await (validateRoute.POST as unknown as Handler)(req("POST", { body: { source: SOURCE } }), ctxOf({}));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(answer);
    expect(text).not.toContain("REDACTED");
  });
});

describe("application template and stack server reads", () => {
  const ORG = "org_1";
  const reads: [() => Promise<unknown>, string, number | undefined][] = [
    [() => serverApi.fetchServerAdminAppTemplates(), "v1/admin/app-templates", 20_000],
    [() => serverApi.fetchServerAdminAppTemplate(T), `v1/admin/app-templates/${T}`, 20_000],
    [() => serverApi.fetchServerAdminAppTemplateVersion(T, "atv_notes_2"), `v1/admin/app-templates/${T}/versions/atv_notes_2`, 20_000],
    [() => serverApi.fetchServerAdminAppTemplateUsage(T), `v1/admin/app-templates/${T}/usage`, undefined],
    [() => serverApi.fetchServerOrgAppTemplates(ORG), `v1/organizations/${ORG}/app-templates`, undefined],
    [() => serverApi.fetchServerOrgAppTemplate(ORG, T), `v1/organizations/${ORG}/app-templates/${T}`, undefined],
    [() => serverApi.fetchServerOrgAppStacks(ORG), `v1/organizations/${ORG}/app-stacks`, undefined],
    [() => serverApi.fetchServerOrgAppStack(ORG, "stk_a1"), `v1/organizations/${ORG}/app-stacks/stk_a1`, undefined],
    [() => serverApi.fetchServerOrgAppStackDeployments(ORG, "stk_a1"), `v1/organizations/${ORG}/app-stacks/stk_a1/deployments?limit=20`, undefined],
    [() => serverApi.fetchServerOrgAppStackDomains(ORG, "stk_a1"), `v1/organizations/${ORG}/app-stacks/stk_a1/domains`, undefined],
  ];

  it("each read calls exactly its upstream path with the session token and timeout", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
    for (const [read, path, timeoutMs] of reads) {
      fetchUpstream.mockClear();
      await read();
      expect(fetchUpstream.mock.calls, path).toEqual([[path, timeoutMs === undefined ? { accessToken: "tok" } : { accessToken: "tok", timeoutMs }]]);
    }
  });

  it("an id that is not one path segment is never put in a path: not found (null for the list reads), nothing is read", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: [] } });
    const notFound = { ok: false, outcome: "notFound" };
    for (const bad of ["..", ".", "a/b", "a%2Fb", "", "x".repeat(129)]) {
      expect(await serverApi.fetchServerAdminAppTemplate(bad), bad).toEqual(notFound);
      expect(await serverApi.fetchServerAdminAppTemplateVersion(bad, "atv_notes_2"), bad).toEqual(notFound);
      expect(await serverApi.fetchServerAdminAppTemplateVersion(T, bad), bad).toEqual(notFound);
      expect(await serverApi.fetchServerAdminAppTemplateUsage(bad), bad).toEqual(notFound);
      expect(await serverApi.fetchServerOrgAppTemplate(ORG, bad), bad).toEqual(notFound);
      expect(await serverApi.fetchServerOrgAppStack(ORG, bad), bad).toEqual(notFound);
      expect(await serverApi.fetchServerOrgAppStackDeployments(ORG, bad), bad).toBeNull();
      expect(await serverApi.fetchServerOrgAppStackDomains(ORG, bad), bad).toBeNull();
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("notFound and the flag-off code stay apart; the list reads give null on failure", async () => {
    fetchUpstream.mockResolvedValue({ ok: false, status: 404, error: { error: { code: "NOT_FOUND" } } });
    expect(await serverApi.fetchServerOrgAppStack(ORG, "stk_gone")).toMatchObject({ ok: false, outcome: "notFound" });
    expect(fetchUpstream.mock.calls[0]![0]).toBe(`v1/organizations/${ORG}/app-stacks/stk_gone`);
    fetchUpstream.mockResolvedValue({ ok: false, status: 422, error: { error: { code: "NOT_SUPPORTED" } } });
    expect(await serverApi.fetchServerAdminAppTemplates()).toEqual({ ok: false, outcome: "error", status: 422, code: "NOT_SUPPORTED" });
    expect(await serverApi.fetchServerOrgAppStackDeployments(ORG, "stk_a1")).toBeNull();
    expect(await serverApi.fetchServerOrgAppStackDomains(ORG, "stk_a1")).toBeNull();
  });
});
