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

import { MAX_BFF_BODY_BYTES } from "@/lib/bff-proxy";
import * as stacksRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/route";
import * as stackRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/route";
import * as actionRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/[action]/route";
import * as planRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/plan/route";
import * as secretsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/secrets/route";
import * as domainsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/domains/route";
import * as domainRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/domains/[domainId]/route";
import * as logsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/components/[componentKey]/logs/route";
import * as backupsRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/backups/route";
import * as restoreRoute from "@/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/backups/[backupId]/restore/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ORG = "org_1";
const STACK = "stk_a1";
const BACKUP = "sbak_0123456789abcdef01234567";
const BASE = `v1/organizations/${ORG}/app-stacks`;
const HASH = "a".repeat(64);
const SECRET = "S3cr3t-planted";
const NOW = "2026-11-22T10:00:00.000Z";
const domain = { hostname: "notes.example.com", componentKey: "web", port: 8080 };
// ADR-0037: the four routing options of one address, always sent together.
const apiPath = { pathPrefix: "/api", componentKey: "web", port: 8080, stripPrefix: true };
const options = { redirectToDomainId: null, compression: true, protection: { username: "guest", password: "correct horse battery" }, pathRoutes: [apiPath] };
const plain = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] };
const VERIFIER = ["", "apr1", "a".repeat(8), "b".repeat(22)].join("$");
const create = {
  templateVersionId: "atv_notes_2",
  name: "Notes",
  parameters: [{ key: "title", value: "Hi" }],
  domains: [domain],
  deploy: true,
};
const twice = [
  { key: "title", value: "a" },
  { key: "title", value: "b" },
];

interface Case {
  name: string;
  handler: Handler;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  params: Record<string, string>;
  path: string;
  body?: unknown;
  /** routes that queue work need the browser's key; synchronous ones forward none */
  idempotency: boolean;
  status: number;
  timeoutMs: number;
  okBodies?: unknown[];
  badBodies?: unknown[];
}

const action = (name: string, timeoutMs: number, body: unknown, badBodies: unknown[], okBodies?: unknown[]): Case => ({
  name,
  handler: actionRoute.POST as unknown as Handler,
  method: "POST",
  params: { orgId: ORG, stackId: STACK, action: name },
  path: `${BASE}/${STACK}/${name}`,
  body,
  idempotency: true,
  status: 202,
  timeoutMs,
  okBodies,
  badBodies,
});
const EMPTY_ONLY = [{ x: 1 }, { parameters: [] }, [], null, "go"];

const cases: Case[] = [
  {
    name: "create",
    handler: stacksRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG },
    path: BASE,
    body: create,
    idempotency: true,
    status: 202,
    timeoutMs: 20_000,
    okBodies: [{ templateVersionId: "atv_notes_2", name: "Notes", deploy: false }],
    badBodies: [
      { ...create, deploy: undefined },
      { ...create, extra: 1 },
      { ...create, hostPath: "/srv/x" },
      { ...create, name: "" },
      { ...create, templateVersionId: "../x" },
      { ...create, parameters: { title: "Hi" } },
      { ...create, parameters: twice },
      { ...create, domains: [{ ...domain, port: 70_000 }] },
      { ...create, domains: [domain, domain] },
      [],
    ],
  },
  {
    name: "delete",
    handler: stackRoute.DELETE as unknown as Handler,
    method: "DELETE",
    params: { orgId: ORG, stackId: STACK },
    path: `${BASE}/${STACK}`,
    body: { confirmName: "Notes", destroyData: false },
    idempotency: true,
    status: 202,
    timeoutMs: 8_000,
    okBodies: [{ confirmName: "Notes", destroyData: true }],
    badBodies: [
      {},
      { confirmName: "Notes" },
      { destroyData: false },
      { confirmName: "Notes", destroyData: "no" },
      { confirmName: "Notes", destroyData: false, extra: 1 },
    ],
  },
  action("deploy", 20_000, {}, [{ x: 1 }, { parameters: {} }, { parameters: twice }, [], null], [{ parameters: [] }]),
  action("start", 8_000, {}, EMPTY_ONLY),
  action("stop", 8_000, {}, EMPTY_ONLY),
  action("restart", 8_000, {}, EMPTY_ONLY),
  action(
    "upgrade",
    20_000,
    { templateVersionId: "atv_notes_3", planHash: HASH },
    [
      {},
      { templateVersionId: "atv_notes_3" },
      { planHash: HASH },
      { templateVersionId: "atv_notes_3", planHash: "abc" },
      { templateVersionId: "atv_notes_3", planHash: HASH, extra: 1 },
    ],
    [{ templateVersionId: "atv_notes_3", planHash: HASH, parameters: [] }],
  ),
  action("rollback", 20_000, { revisionId: "srev_a1", planHash: HASH }, [
    {},
    { revisionId: "srev_a1" },
    { planHash: HASH },
    { revisionId: "srev_a1", planHash: HASH, parameters: [] },
    { templateVersionId: "atv_notes_3", planHash: HASH },
  ]),
  {
    name: "plan",
    handler: planRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG, stackId: STACK },
    path: `${BASE}/${STACK}/plan`,
    body: { templateVersionId: "atv_notes_3" },
    idempotency: false,
    status: 200,
    timeoutMs: 20_000,
    okBodies: [{ revisionId: "srev_a1" }, {}],
    badBodies: [
      { templateVersionId: "atv_notes_3", revisionId: "srev_a1" },
      { revisionId: "srev_a1", parameters: [] },
      { planHash: HASH },
      [],
      null,
    ],
  },
  {
    name: "secret set",
    handler: secretsRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG, stackId: STACK },
    path: `${BASE}/${STACK}/secrets`,
    body: { parameterKey: "admin_password", value: SECRET },
    idempotency: false,
    status: 200,
    timeoutMs: 8_000,
    okBodies: [{ parameterKey: "admin_password", value: "s".repeat(16_384) }],
    badBodies: [
      { value: SECRET },
      { parameterKey: "admin_password" },
      { parameterKey: "admin_password", value: "" },
      { parameterKey: "admin_password", value: "s".repeat(16_385) },
      { parameterKey: "hp_x", value: SECRET },
      { parameterKey: "admin_password", value: SECRET, version: 2 },
      [{ parameterKey: "admin_password", value: SECRET }],
    ],
  },
  {
    name: "domain add",
    handler: domainsRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG, stackId: STACK },
    path: `${BASE}/${STACK}/domains`,
    body: domain,
    idempotency: false,
    status: 201,
    timeoutMs: 8_000,
    okBodies: [{ ...domain, compression: true }, { ...domain, compression: false }],
    badBodies: [
      { hostname: domain.hostname },
      { ...domain, port: 0 },
      { ...domain, componentKey: "Web_1" },
      { ...domain, extra: 1 },
      { ...domain, compression: "yes" },
      { ...domain, protection: { username: "guest", password: "correct horse battery" } },
      [domain],
    ],
  },
  {
    name: "domain options",
    handler: domainRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: { orgId: ORG, stackId: STACK, domainId: "sdom_1" },
    path: `${BASE}/${STACK}/domains/sdom_1`,
    body: options,
    idempotency: false,
    status: 200,
    timeoutMs: 8_000,
    okBodies: [plain, { ...plain, redirectToDomainId: "sdom_2", compression: true }, { ...plain, protection: { username: "guest" } }],
    badBodies: [
      {},
      { compression: true },
      { ...plain, extra: 1 },
      { ...plain, compression: "yes" },
      { ...plain, redirectToDomainId: "../x" },
      // a redirecting address takes neither a password nor paths
      { ...options, redirectToDomainId: "sdom_2" },
      { ...plain, redirectToDomainId: "sdom_2", pathRoutes: [apiPath] },
      // the browser sends a password, never a ready-made verifier
      { ...plain, protection: { username: "guest", passwordHash: VERIFIER } },
      { ...plain, protection: { username: "guest", password: "short" } },
      { ...plain, protection: { username: "-guest", password: "correct horse battery" } },
      { ...plain, protection: { password: "correct horse battery" } },
      { ...plain, pathRoutes: [{ ...apiPath, pathPrefix: "/.well-known" }] },
      { ...plain, pathRoutes: [{ ...apiPath, pathPrefix: "api" }] },
      { ...plain, pathRoutes: [apiPath, { ...apiPath, stripPrefix: false }] },
      { ...plain, pathRoutes: [{ ...apiPath, port: 0 }] },
      { ...plain, pathRoutes: [{ ...apiPath, middleware: "x" }] },
      { ...plain, pathRoutes: Array.from({ length: 5 }, (_, i) => ({ ...apiPath, pathPrefix: `/p${i}` })) },
      [plain],
      null,
    ],
  },
  {
    name: "domain remove",
    handler: domainRoute.DELETE as unknown as Handler,
    method: "DELETE",
    params: { orgId: ORG, stackId: STACK, domainId: "sdom_1" },
    path: `${BASE}/${STACK}/domains/sdom_1`,
    idempotency: false,
    status: 200,
    timeoutMs: 8_000,
    okBodies: [{}],
    badBodies: [{ x: 1 }, [], null],
  },
  {
    name: "backup create",
    handler: backupsRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG, stackId: STACK },
    path: `${BASE}/${STACK}/backups`,
    body: {},
    idempotency: true,
    status: 202,
    timeoutMs: 8_000,
    badBodies: EMPTY_ONLY,
  },
  {
    name: "backup restore",
    handler: restoreRoute.POST as unknown as Handler,
    method: "POST",
    params: { orgId: ORG, stackId: STACK, backupId: BACKUP },
    path: `${BASE}/${STACK}/backups/${BACKUP}/restore`,
    body: { confirmName: "Notes" },
    idempotency: true,
    status: 202,
    timeoutMs: 8_000,
    okBodies: [{ confirmName: "a".repeat(64) }],
    badBodies: [{}, { confirmName: 1 }, { confirmName: "Notes", extra: 1 }, { confirmName: "a".repeat(65) }, { confirmName: "Notes", backupId: BACKUP }, [], null],
  },
  {
    name: "component logs",
    handler: logsRoute.GET as unknown as Handler,
    method: "GET",
    params: { orgId: ORG, stackId: STACK, componentKey: "web" },
    path: `${BASE}/${STACK}/components/web/logs?tail=200`,
    idempotency: false,
    status: 200,
    timeoutMs: 10_000,
  },
];
const mutations = cases.filter((c) => c.method !== "GET");

function req(method: string, over: { headers?: Record<string, string>; body?: unknown; raw?: string; url?: string } = {}) {
  return new Request(over.url ?? "http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body)),
  });
}
const headersFor = (c: Case, key: string): Record<string, string> => (c.idempotency ? { "Idempotency-Key": key } : {});
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const okResponse = (c: Case) => ({ status: c.status, ok: true, data: { data: {} } });
const call = (c: Case, over: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}, params = c.params) =>
  c.handler(req(c.method, { body: c.body, ...over, headers: { ...headersFor(c, "idem-1"), ...over.headers } }), ctxOf(params));

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("application stack BFF routes", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("forwards the exact path, method, token, body and timeout and passes the status through", async () => {
        fetchUpstream.mockResolvedValue(okResponse(c));
        const res = await call(c);
        expect(res.status).toBe(c.status);
        expect(fetchUpstream).toHaveBeenCalledTimes(1);
        const [path, opts] = fetchUpstream.mock.calls[0]!;
        expect(path).toBe(c.path);
        expect(opts).toMatchObject({ method: c.method, accessToken: "tok" });
        expect(opts.timeoutMs ?? 8_000).toBe(c.timeoutMs);
        expect(opts.body).toEqual(c.body);
        expect(res.headers.get("cache-control")).toContain("no-store");
      });

      for (const body of c.okBodies ?? []) {
        it(`forwards the body ${JSON.stringify(body).slice(0, 60)} unchanged`, async () => {
          fetchUpstream.mockResolvedValue(okResponse(c));
          expect((await call(c, { body })).status).toBe(c.status);
          expect(fetchUpstream.mock.calls[0]![1].body).toEqual(body);
        });
      }

      if (c.method !== "GET") {
        it("a wrong CSRF token or a foreign Origin is a 403 and the API is not called", async () => {
          for (const headers of [{ "X-CSRF-Token": "bad" }, { Origin: "http://evil.test" }] as Record<string, string>[]) {
            expect((await call(c, { headers })).status).toBe(403);
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });

        it("guards run in order: session, CSRF and Origin, key, body", async () => {
          const bad = { headers: { Origin: "http://evil.test", "Idempotency-Key": "" }, raw: "{x:" };
          getSession.mockResolvedValueOnce(null);
          expect((await call(c, bad)).status).toBe(401);
          expect((await call(c, bad)).status).toBe(403);
          const res = await call(c, { headers: { "Idempotency-Key": "" }, raw: "{x:" });
          expect(res.status).toBe(400);
          const text = await res.text();
          if (c.idempotency) expect(text).toContain("idempotency-key");
          else expect(text).toContain("JSON");
          expect(fetchUpstream).not.toHaveBeenCalled();
        });

        it("a malformed JSON body is a 400 before the API", async () => {
          expect((await call(c, { raw: "{source:" })).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      it("without a session it is a 401 and the API is not called", async () => {
        getSession.mockResolvedValue(null);
        expect((await call(c)).status).toBe(401);
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      for (const key of Object.keys(c.params).filter((k) => k !== "action")) {
        it(`a bad ${key} segment is a 400 before the session is read`, async () => {
          for (const bad of ["../x", "a b", "a".repeat(129), ""]) {
            const res = await call(c, {}, { ...c.params, [key]: bad });
            expect(res.status, bad).toBe(400);
            expect((await res.json()).error.details[0].field).toBe(key);
          }
          expect(getSession).not.toHaveBeenCalled();
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.badBodies) {
        it("refuses bodies outside the strict contract before the API", async () => {
          for (const body of c.badBodies!) {
            const res = await call(c, { body });
            expect(res.status, JSON.stringify(body)?.slice(0, 80)).toBe(400);
            expect(await res.text()).toContain("VALIDATION_ERROR");
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.idempotency) {
        it("requires the browser's Idempotency-Key, never invents one, and forwards it", async () => {
          const res = await c.handler(req(c.method, { body: c.body }), ctxOf(c.params));
          expect(res.status).toBe(400);
          expect((await res.json()).error.details[0].field).toBe("idempotency-key");
          expect(fetchUpstream).not.toHaveBeenCalled();
          fetchUpstream.mockResolvedValue(okResponse(c));
          await call(c, { headers: { "Idempotency-Key": "stack-key-1" } });
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("stack-key-1");
        });

        it("an empty body is a 400 (a JSON body is required)", async () => {
          expect((await c.handler(req(c.method, { headers: headersFor(c, "k") }), ctxOf(c.params))).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      } else {
        it("needs no Idempotency-Key and forwards none (synchronous route)", async () => {
          fetchUpstream.mockResolvedValue(okResponse(c));
          expect((await call(c)).status).toBe(c.status);
          await call(c, { headers: { "Idempotency-Key": "ignored" } });
          expect(fetchUpstream.mock.calls.map(([, o]) => o.idempotencyKey)).toEqual([undefined, undefined]);
        });
      }

      it("a cross-org or foreign stack 404 envelope passes through unchanged", async () => {
        const envelope = { error: { code: "NOT_FOUND", message: "Not found.", details: [], requestId: "req_1", retryable: false } };
        fetchUpstream.mockResolvedValue({ ok: false, status: 404, error: envelope });
        const res = await call(c);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(envelope);
      });
    });
  }

  it("an empty body is a 400 on plan, secret set and domain add, and forwarded as none on domain remove", async () => {
    for (const c of mutations.filter((m) => !m.idempotency && m.body !== undefined)) {
      expect((await c.handler(req(c.method), ctxOf(c.params))).status, c.name).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("the action route knows only the six queueing actions: anything else is a 404 before the session is read", async () => {
    for (const name of ["foo", "__proto__", "constructor", "toString", "hasOwnProperty", "plan", "secrets", "domains", "components", "backups", "ports", "DEPLOY"]) {
      const res = await (actionRoute.POST as unknown as Handler)(
        req("POST", { headers: { "Idempotency-Key": "k" }, body: {} }),
        ctxOf({ orgId: ORG, stackId: STACK, action: name }),
      );
      expect(res.status, name).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("an accepted envelope passes through unchanged (202 queued, 201 draft)", async () => {
    const queued = {
      data: { stackId: STACK, operationId: "op_1", deploymentId: "sdep_1", status: "queued" },
      links: { stack: `/v1/organizations/${ORG}/app-stacks/${STACK}`, operation: `/v1/organizations/${ORG}/operations/op_1` },
    };
    const draft = { data: { stackId: STACK, operationId: null, deploymentId: null, status: "draft" }, links: { stack: queued.links.stack, operation: null } };
    for (const [c, status, answer] of [
      [cases[0]!, 202, queued],
      [cases[0]!, 201, draft],
      [cases[1]!, 202, queued],
      ...cases.filter((k) => k.handler === (actionRoute.POST as unknown)).map((k) => [k, 202, queued]),
    ] as [Case, number, unknown][]) {
      fetchUpstream.mockResolvedValue({ ok: true, status, data: answer });
      const res = await call(c);
      expect(res.status, c.name).toBe(status);
      expect(await res.json()).toEqual(answer);
    }
  });

  it("a secret value reaches only the secret route's body: never a path, another call or an answer", async () => {
    const secrets = cases.find((c) => c.name === "secret set")!;
    const answer = { data: { key: "admin_password", isSet: true, version: 1, setAt: NOW } };
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const res = await call(secrets);
    expect(await res.json()).toEqual(answer);
    for (const c of cases.filter((k) => k !== secrets)) {
      fetchUpstream.mockResolvedValue(okResponse(c));
      await call(c);
    }
    const carrying = fetchUpstream.mock.calls.filter((args) => JSON.stringify(args).includes(SECRET));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]![0]).toBe(`${BASE}/${STACK}/secrets`);
    expect(carrying[0]![1].body).toEqual({ parameterKey: "admin_password", value: SECRET });
    for (const body of [{ parameterKey: "admin_password", value: SECRET, extra: 1 }, { parameterKey: "BAD KEY", value: SECRET }]) {
      const refused = await call(secrets, { body });
      expect(refused.status).toBe(400);
      expect(await refused.text()).not.toContain(SECRET);
    }
  });

  it("clamps the log tail to 1..500 (default 200) and needs no CSRF header on a read", async () => {
    const logs = cases.find((c) => c.name === "component logs")!;
    for (const [tail, sent] of [["0", 1], ["-5", 1], ["9999", 500], ["500", 500], ["12.7", 12], ["abc", 200], [null, 200]] as const) {
      fetchUpstream.mockReset();
      fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { componentKey: "web", lines: [] } } });
      const url = `http://localhost:3000/x${tail === null ? "" : `?tail=${tail}`}`;
      const res = await logs.handler(new Request(url, { headers: { Host: "localhost:3000" } }), ctxOf(logs.params));
      expect(res.status, String(tail)).toBe(200);
      expect(fetchUpstream.mock.calls[0]![0]).toBe(`${BASE}/${STACK}/components/web/logs?tail=${sent}`);
    }
  });

  it("answers whose parameter arrays name a secret pass without redaction", async () => {
    const answer = {
      data: {
        planHash: HASH,
        parameters: [
          { key: "PASSWORD", change: "updated" },
          { key: "API_KEY", change: "added" },
        ],
        components: [{ key: "web", change: "updated", restart: true }],
      },
    };
    const plan = cases.find((c) => c.name === "plan")!;
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: answer });
    const text = await (await call(plan)).text();
    expect(JSON.parse(text)).toEqual(answer);
    expect(text).not.toContain("REDACTED");
  });
});

const CHUNK = 64 * 1024;
const GUARD = 16 * MAX_BFF_BODY_BYTES;

// A body that never ends: counts what was pulled and whether the reader cancelled it.
function endlessBody() {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= GUARD) {
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

describe("application stack BFF routes: a body that never ends is refused at 1 MiB", () => {
  for (const c of mutations) {
    it(`${c.name}: 413, the stream is cancelled after about the limit, nothing reaches the API`, async () => {
      const { stream, state } = endlessBody();
      const headers = { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...headersFor(c, "k") };
      const res = await c.handler(
        new Request("http://localhost:3000/x", { method: c.method, headers, body: stream, duplex: "half" } as RequestInit),
        ctxOf(c.params),
      );
      expect(res.status).toBe(413);
      expect(state.cancelled).toBe(true);
      expect(state.pulled).toBeLessThanOrEqual(MAX_BFF_BODY_BYTES + CHUNK);
      expect(fetchUpstream).not.toHaveBeenCalled();
    });
  }
});
