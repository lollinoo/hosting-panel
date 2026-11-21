import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchUpstream = vi.fn();
const getSession = vi.fn();
vi.mock("@/lib/upstream", async () => ({
  ...(await vi.importActual<object>("@/lib/upstream")),
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...a: unknown[]) => getSession(...a),
}));

import * as importRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/route";
import * as certRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/route";
import * as versionsRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import * as activateRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/tls-certificates/[certificateId]/versions/[versionId]/activate/route";
import * as domainTlsRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/[domainId]/tls/route";
import * as adminImportRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/route";
import * as adminCertRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/route";
import * as adminVersionsRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/versions/route";
import * as adminActivateRoute from "@/app/api/admin/sites/[siteId]/tls-certificates/[certificateId]/versions/[versionId]/activate/route";
import * as adminDomainTlsRoute from "@/app/api/admin/sites/[siteId]/domains/[domainId]/tls/route";
import * as adminOrphanRoute from "@/app/api/admin/tls-certificates/[certificateId]/route";
const realFetchUpstream = async (...a: Parameters<typeof import("@/lib/upstream").fetchUpstream>) =>
  (await vi.importActual<typeof import("@/lib/upstream")>("@/lib/upstream")).fetchUpstream(...a);

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETSECRET\n-----END PRIVATE KEY-----\n";
const VERSION = `ctv_${"a".repeat(32)}`;
const pemBody = { format: "pem", leafPem: PEM, chainPem: "", privateKeyPem: KEY };

interface Case {
  name: string;
  handler: Handler;
  method: "GET" | "POST" | "DELETE";
  params: Record<string, string>;
  path: string;
  body?: unknown;
  timeoutMs: number | undefined;
  /** customer: key generated when absent; admin: required (400); none: no key is forwarded */
  idempotency: "customer" | "admin" | "none";
  /** a body the strict contract must refuse */
  badBodies?: unknown[];
  status?: number;
}

const C = { orgId: "org_1", siteId: "site_1" };
const CP = "v1/organizations/org_1/managed-sites/site_1";
const AP = "v1/admin/sites/site_1";
const privateKeyBodies = (base: Record<string, unknown>) => [
  { ...base, password: "hunter2" },
  { ...base, format: "pkcs12" },
  { ...base, pkcs12Base64: "AAAA" },
  { ...base, extra: 1 },
];

const cases: Case[] = [
  { name: "customer list", handler: importRoute.GET as unknown as Handler, method: "GET", params: C, path: `${CP}/tls-certificates`, timeoutMs: 8000, idempotency: "none" },
  {
    name: "customer import",
    handler: importRoute.POST as unknown as Handler,
    method: "POST",
    params: C,
    path: `${CP}/tls-certificates`,
    body: { name: "shop", ...pemBody },
    timeoutMs: 30_000,
    idempotency: "customer",
    badBodies: [...privateKeyBodies({ name: "shop", ...pemBody }), { name: "shop", format: "pem", leafPem: PEM }, { ...pemBody }],
  },
  { name: "customer get", handler: certRoute.GET as unknown as Handler, method: "GET", params: { ...C, certificateId: "cert_1" }, path: `${CP}/tls-certificates/cert_1`, timeoutMs: 8000, idempotency: "none" },
  {
    name: "customer delete",
    handler: certRoute.DELETE as unknown as Handler,
    method: "DELETE",
    params: { ...C, certificateId: "cert_1" },
    path: `${CP}/tls-certificates/cert_1`,
    timeoutMs: 20_000,
    idempotency: "customer",
    status: 204,
    badBodies: [{ force: true }],
  },
  {
    name: "customer new version",
    handler: versionsRoute.POST as unknown as Handler,
    method: "POST",
    params: { ...C, certificateId: "cert_1" },
    path: `${CP}/tls-certificates/cert_1/versions`,
    body: pemBody,
    timeoutMs: 30_000,
    idempotency: "customer",
    badBodies: privateKeyBodies(pemBody),
  },
  {
    name: "customer activate",
    handler: activateRoute.POST as unknown as Handler,
    method: "POST",
    params: { ...C, certificateId: "cert_1", versionId: VERSION },
    path: `${CP}/tls-certificates/cert_1/versions/${VERSION}/activate`,
    body: { domainIds: ["dom_1"] },
    timeoutMs: 20_000,
    idempotency: "customer",
    badBodies: [{ domainIds: ["dom_1"], evictAcme: true, confirmHostname: "a.test" }, { domainIds: [] }, { domainIds: ["a", "a"] }],
  },
  {
    name: "customer domain tls",
    handler: domainTlsRoute.POST as unknown as Handler,
    method: "POST",
    params: { ...C, domainId: "dom_1" },
    path: `${CP}/domains/dom_1/tls`,
    body: { mode: "manual", versionId: VERSION },
    timeoutMs: 20_000,
    idempotency: "customer",
    badBodies: [{ mode: "acme", challenge: "dns-01" }, { mode: "manual" }, { mode: "manual", versionId: "../x" }, { mode: "other" }],
  },
  { name: "admin list", handler: adminImportRoute.GET as unknown as Handler, method: "GET", params: { siteId: "site_1" }, path: `${AP}/tls-certificates`, timeoutMs: undefined, idempotency: "none" },
  {
    name: "admin import",
    handler: adminImportRoute.POST as unknown as Handler,
    method: "POST",
    params: { siteId: "site_1" },
    path: `${AP}/tls-certificates`,
    body: { name: "shop", ...pemBody },
    timeoutMs: 30_000,
    idempotency: "admin",
    badBodies: privateKeyBodies({ name: "shop", ...pemBody }),
  },
  { name: "admin get", handler: adminCertRoute.GET as unknown as Handler, method: "GET", params: { siteId: "site_1", certificateId: "cert_1" }, path: `${AP}/tls-certificates/cert_1`, timeoutMs: undefined, idempotency: "none" },
  { name: "admin delete", handler: adminCertRoute.DELETE as unknown as Handler, method: "DELETE", params: { siteId: "site_1", certificateId: "cert_1" }, path: `${AP}/tls-certificates/cert_1`, timeoutMs: 20_000, idempotency: "none", status: 204 },
  {
    name: "admin new version",
    handler: adminVersionsRoute.POST as unknown as Handler,
    method: "POST",
    params: { siteId: "site_1", certificateId: "cert_1" },
    path: `${AP}/tls-certificates/cert_1/versions`,
    body: pemBody,
    timeoutMs: 30_000,
    idempotency: "admin",
    badBodies: privateKeyBodies(pemBody),
  },
  {
    name: "admin activate",
    handler: adminActivateRoute.POST as unknown as Handler,
    method: "POST",
    params: { siteId: "site_1", certificateId: "cert_1", versionId: VERSION },
    path: `${AP}/tls-certificates/cert_1/versions/${VERSION}/activate`,
    body: { evictAcme: true, confirmHostname: "shop.example.test" },
    timeoutMs: 20_000,
    idempotency: "admin",
    badBodies: [{ evictAcme: true }, { confirmHostname: "a.test" }, { password: "x" }],
  },
  {
    name: "admin domain tls",
    handler: adminDomainTlsRoute.POST as unknown as Handler,
    method: "POST",
    params: { siteId: "site_1", domainId: "dom_1" },
    path: `${AP}/domains/dom_1/tls`,
    body: { mode: "acme", challenge: "dns-01" },
    timeoutMs: 20_000,
    idempotency: "admin",
    badBodies: [{ mode: "manual" }, { mode: "acme", challenge: "tls-alpn" }],
  },
  { name: "admin orphan delete", handler: adminOrphanRoute.DELETE as unknown as Handler, method: "DELETE", params: { certificateId: "cert_1" }, path: "v1/admin/tls-certificates/cert_1", timeoutMs: 20_000, idempotency: "none", status: 204 },
];

function req(c: Pick<Case, "method">, over: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  const hasBody = c.method !== "GET";
  return new Request("http://localhost:3000/x", {
    method: c.method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: hasBody ? (over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body))) : undefined,
  });
}
const headersFor = (c: Case, key: string): Record<string, string> => (c.idempotency === "none" ? {} : { "Idempotency-Key": key });
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const okResponse = (c: Case) => (c.status === 204 ? { status: 204, ok: true } : { status: c.method === "POST" ? 201 : 200, ok: true, data: { data: {} } });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("TLS BFF routes (customer and admin)", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("forwards the exact path, method, token and timeout", async () => {
        fetchUpstream.mockResolvedValue(okResponse(c));
        const res = await c.handler(req(c, { headers: headersFor(c, "idem-1"), body: c.body }), ctxOf(c.params));
        expect(res.status).toBe(c.status ?? (c.method === "POST" ? 201 : 200));
        expect(fetchUpstream).toHaveBeenCalledTimes(1);
        const [path, opts] = fetchUpstream.mock.calls[0]!;
        expect(path).toBe(c.path);
        expect(opts).toMatchObject({ method: c.method, accessToken: "tok" });
        expect(opts.timeoutMs).toBe(c.timeoutMs);
        expect(res.headers.get("cache-control")).toContain("no-store");
        if (c.status === 204) expect(await res.text()).toBe("");
      });

      it("a bad path segment is a 400 before the session is read", async () => {
        for (const bad of ["../x", "a".repeat(129)]) {
          const first = Object.keys(c.params).at(-1)!;
          const res = await c.handler(req(c, { headers: headersFor(c, "k"), body: c.body }), ctxOf({ ...c.params, [first]: bad }));
          expect(res.status).toBe(400);
        }
        expect(getSession).not.toHaveBeenCalled();
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      if (c.method !== "GET") {
        it("a wrong CSRF token is a 403 and the API is not called", async () => {
          const res = await c.handler(req(c, { headers: { ...headersFor(c, "k"), "X-CSRF-Token": "bad" }, body: c.body }), ctxOf(c.params));
          expect(res.status).toBe(403);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });

        it("a foreign Origin is a 403 and the API is not called", async () => {
          const res = await c.handler(req(c, { headers: { ...headersFor(c, "k"), Origin: "http://evil.test" }, body: c.body }), ctxOf(c.params));
          expect(res.status).toBe(403);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.badBodies) {
        it("refuses bodies outside the strict contract (PFX, passwords, unknown keys) before the API", async () => {
          for (const body of c.badBodies!) {
            const res = await c.handler(req(c, { headers: headersFor(c, "k"), body }), ctxOf(c.params));
            expect(res.status, JSON.stringify(Object.keys(body as object))).toBe(400);
            const text = await res.text();
            expect(text).toContain("VALIDATION_ERROR");
            expect(text).not.toContain("BEGIN");
            expect(text).not.toContain("hunter2");
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.idempotency === "customer") {
        it("forwards the Idempotency-Key as sent, and generates one when absent", async () => {
          fetchUpstream.mockResolvedValue(okResponse(c));
          await c.handler(req(c, { headers: { "Idempotency-Key": "client-key-1" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("client-key-1");
          await c.handler(req(c, { body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[1]![1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        });
      }

      if (c.idempotency === "admin") {
        it("requires the Idempotency-Key and forwards it", async () => {
          const res = await c.handler(req(c, { body: c.body }), ctxOf(c.params));
          expect(res.status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
          fetchUpstream.mockResolvedValue(okResponse(c));
          await c.handler(req(c, { headers: { "Idempotency-Key": "admin-key-1" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("admin-key-1");
        });
      }

      if (c.method === "GET") {
        it("an unauthenticated GET is a 401 and the API is not called", async () => {
          getSession.mockResolvedValue(null);
          const res = await c.handler(req(c), ctxOf(c.params));
          expect(res.status).toBe(401);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }
    });
  }

  it("a customer delete accepts an empty body and a JSON object body", async () => {
    const c = cases.find((x) => x.name === "customer delete")!;
    fetchUpstream.mockResolvedValue({ status: 204, ok: true });
    expect((await c.handler(req(c), ctxOf(c.params))).status).toBe(204);
    expect((await c.handler(req(c, { body: {} }), ctxOf(c.params))).status).toBe(204);
    expect(fetchUpstream.mock.calls[0]![1].body).toBeUndefined();
  });

  it("an admin mutation with an invalid JSON body is a 400", async () => {
    const c = cases.find((x) => x.name === "admin import")!;
    const res = await c.handler(req(c, { headers: { "Idempotency-Key": "k" }, raw: "{not json" }), ctxOf(c.params));
    expect(res.status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("an import with a ~600 KiB certificate chain is rejected at the BFF by the per-field contract cap, one of 500 KiB passes", async () => {
    const c = cases.find((x) => x.name === "customer import")!;
    const big = (n: number) => ({ name: "shop", ...pemBody, chainPem: "A".repeat(n) });
    expect((await c.handler(req(c, { body: big(600 * 1024) }), ctxOf(c.params))).status).toBe(400);
    fetchUpstream.mockResolvedValue({ status: 201, ok: true, data: { data: {} } });
    expect((await c.handler(req(c, { body: big(500 * 1024) }), ctxOf(c.params))).status).toBe(201);
  });

  it("an upstream refusal keeps its code and status and never echoes the request", async () => {
    const c = cases.find((x) => x.name === "customer import")!;
    fetchUpstream.mockResolvedValue({
      status: 422,
      ok: false,
      error: { error: { code: "CERTIFICATE_KEY_MISMATCH", message: "The private key does not match.", details: [] } },
    });
    const res = await c.handler(req(c, { body: c.body }), ctxOf(c.params));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("CERTIFICATE_KEY_MISMATCH");
    expect(text).not.toContain("BEGIN");
    expect(text).not.toContain("SECRETSECRET");
  });
});

describe("upstream error sanitising (lib/upstream.ts)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = async (status: number, body: string, contentType: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": contentType } })));
    return realFetchUpstream("v1/x", { accessToken: "t" });
  };

  for (const ct of ["text/plain", "text/html; charset=utf-8", ""]) {
    it(`a ${ct || "typeless"} error body is replaced by a fixed INTERNAL_ERROR, status kept, text dropped`, async () => {
      const r = await call(502, KEY, ct);
      expect(r.ok).toBe(false);
      expect(r.status).toBe(502);
      const json = JSON.stringify(r.error);
      expect(json).not.toContain("BEGIN");
      expect(json).not.toContain("SECRETSECRET");
      expect(r.error).toMatchObject({ error: { code: "INTERNAL_ERROR", details: [] } });
    });
  }

  it("reaches the browser as the fixed envelope with no-store and without the text", async () => {
    const c = cases.find((x) => x.name === "customer import")!;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(KEY, { status: 502, headers: { "content-type": "text/plain" } })));
    fetchUpstream.mockImplementation((...a: unknown[]) => realFetchUpstream(...(a as Parameters<typeof realFetchUpstream>)));
    const res = await c.handler(req(c, { body: c.body }), ctxOf(c.params));
    expect(res.status).toBe(502);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("BEGIN");
    expect(text).not.toContain("SECRETSECRET");
  });

  it("a JSON error body still passes through and an empty error body stays sanitised", async () => {
    const j = await call(409, JSON.stringify({ error: { code: "CERTIFICATE_IN_USE", message: "m", details: [] } }), "application/json");
    expect(j.error).toMatchObject({ error: { code: "CERTIFICATE_IN_USE" } });
    const empty = await call(503, "", "text/plain");
    expect(empty.status).toBe(503);
    expect(empty.error).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("a successful non-JSON body is still returned as raw", async () => {
    const r = await call(200, "pong", "text/plain");
    expect(r).toMatchObject({ ok: true, status: 200, data: { raw: "pong" } });
  });
});

describe("server fetchers", () => {
  it("build the exact upstream paths and whitelist the inventory query", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
    vi.doMock("@/lib/server-session", () => ({ getSessionFromRequest: vi.fn(), getServerSession: async () => ({ accessToken: "tok" }) }));
    vi.doMock("@/lib/upstream", () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a), getApiInternalUrl: () => "" }));
    const api = await import("@/lib/server-api");
    fetchUpstream.mockResolvedValue({ status: 200, ok: true, data: { data: [] } });

    expect(await api.fetchServerSiteTlsCertificates("o1", "s1")).toEqual([]);
    expect(await api.fetchServerAdminSiteTlsCertificates("s1")).toEqual([]);
    await api.fetchServerAdminTlsCertificates({ filter: "expired", q: "shop&x=1 é" });
    await api.fetchServerAdminTlsCertificates({ filter: "bogus" as never, q: "  " });
    await api.fetchServerAdminTlsCertificates({ filter: "all", q: "a".repeat(400) });
    await api.fetchServerAdminTlsAlerts();
    const paths = fetchUpstream.mock.calls.map((x) => x[0]);
    expect(paths[0]).toBe("v1/organizations/o1/managed-sites/s1/tls-certificates");
    expect(paths[1]).toBe("v1/admin/sites/s1/tls-certificates");
    expect(paths[2]).toBe("v1/admin/tls-certificates?filter=expired&q=shop%26x%3D1+%C3%A9");
    expect(paths[3]).toBe("v1/admin/tls-certificates");
    expect(paths[4]).toBe(`v1/admin/tls-certificates?filter=all&q=${"a".repeat(253)}`);
    expect(paths[5]).toBe("v1/admin/tls-certificates/alerts");
    fetchUpstream.mockResolvedValue({ status: 500, ok: false, error: {} });
    expect(await api.fetchServerAdminTlsAlerts()).toBeNull();
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/server-session");
    vi.doUnmock("@/lib/upstream");
  });
});
