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

import * as targetsRoute from "@/app/api/admin/backup-targets/route";
import * as targetRoute from "@/app/api/admin/backup-targets/[targetId]/route";
import * as testRoute from "@/app/api/admin/backup-targets/[targetId]/test/route";
import * as initRoute from "@/app/api/admin/backup-targets/[targetId]/initialize/route";
import * as policyRoute from "@/app/api/admin/backup-policies/[scope]/route";
import * as sitePolicyRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backup-policy/route";
import * as downloadRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/download/route";
import * as restoreRoute from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/restore/route";
import * as adminRestoreRoute from "@/app/api/admin/backups/sites/[siteId]/restore/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const TARGET = `bkt_${"a".repeat(32)}`;
const AGE = `age1${"q".repeat(58)}`;
const OTHER = `bkt_${"b".repeat(32)}`;
const s3Body = {
  kind: "s3",
  name: "Off-site",
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "my-backups",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-value-123",
};

interface Case {
  name: string;
  handler: Handler;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  params: Record<string, string>;
  path: string;
  body?: unknown;
  timeoutMs: number | undefined;
  /** customer: key generated when absent; admin: required (400); none: no key is forwarded */
  idempotency: "customer" | "admin" | "none";
  badBodies?: unknown[];
  status?: number;
}

const T = { targetId: TARGET };
const C = { orgId: "org_1", siteId: "site_1" };
const CP = "v1/organizations/org_1/managed-sites/site_1";
const pathLike = [{ path: "/srv/x" }, { root: "/srv/x" }, { localRoot: "/srv/x" }, { hostPath: "/srv/x" }, { dir: "../x" }];

const cases: Case[] = [
  { name: "targets list", handler: targetsRoute.GET as unknown as Handler, method: "GET", params: {}, path: "v1/admin/backup-targets", timeoutMs: 20_000, idempotency: "none" },
  {
    name: "target create (s3)",
    handler: targetsRoute.POST as unknown as Handler,
    method: "POST",
    params: {},
    path: "v1/admin/backup-targets",
    body: s3Body,
    timeoutMs: 20_000,
    idempotency: "admin",
    badBodies: [{ ...s3Body, extra: 1 }, { ...s3Body, secretAccessKey: undefined }, { kind: "ftp", name: "x" }],
  },
  {
    name: "target create (local)",
    handler: targetsRoute.POST as unknown as Handler,
    method: "POST",
    params: {},
    path: "v1/admin/backup-targets",
    body: { kind: "local", name: "Disk" },
    timeoutMs: 20_000,
    idempotency: "admin",
    // The root comes from the server configuration: a path-like key never reaches the API.
    badBodies: pathLike.map((extra) => ({ kind: "local", name: "Disk", ...extra })),
  },
  {
    name: "target update",
    handler: targetRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: T,
    path: `v1/admin/backup-targets/${TARGET}`,
    body: { enabled: false },
    timeoutMs: 20_000,
    idempotency: "none",
    badBodies: [{}, { id: OTHER }, { kind: "local" }, { root: "/srv/x" }, { archived: false }],
  },
  { name: "target delete", handler: targetRoute.DELETE as unknown as Handler, method: "DELETE", params: T, path: `v1/admin/backup-targets/${TARGET}`, timeoutMs: 20_000, idempotency: "none", status: 204 },
  { name: "target test", handler: testRoute.POST as unknown as Handler, method: "POST", params: T, path: `v1/admin/backup-targets/${TARGET}/test`, body: {}, timeoutMs: 45_000, idempotency: "admin", badBodies: [{ force: true }, { path: "/x" }] },
  { name: "target initialize", handler: initRoute.POST as unknown as Handler, method: "POST", params: T, path: `v1/admin/backup-targets/${TARGET}/initialize`, body: {}, timeoutMs: 45_000, idempotency: "admin", badBodies: [{ force: true }, { path: "/x" }] },
  { name: "default policy get", handler: policyRoute.GET as unknown as Handler, method: "GET", params: { scope: "default" }, path: "v1/admin/backup-policies/default", timeoutMs: 20_000, idempotency: "none" },
  {
    name: "default policy patch",
    handler: policyRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: { scope: "default" },
    path: "v1/admin/backup-policies/default",
    body: { scheduleHourUtc: 3, retentionDays: 14, targetIds: [TARGET] },
    timeoutMs: 20_000,
    idempotency: "none",
    badBodies: [{ scheduleHourUtc: 24 }, { retentionDays: 0 }, { targetIds: [TARGET, TARGET] }, { targetIds: [TARGET, OTHER, `bkt_${"c".repeat(32)}`] }, { scope: "panel" }],
  },
  { name: "panel policy get", handler: policyRoute.GET as unknown as Handler, method: "GET", params: { scope: "panel" }, path: "v1/admin/backup-policies/panel", timeoutMs: 20_000, idempotency: "none" },
  {
    name: "panel policy patch",
    handler: policyRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: { scope: "panel" },
    path: "v1/admin/backup-policies/panel",
    body: { targetIds: [TARGET] },
    timeoutMs: 20_000,
    idempotency: "none",
    // The panel has no schedule of its own.
    badBodies: [{ scheduleHourUtc: 3 }, { targetIds: ["../x"] }],
  },
  { name: "site policy get", handler: sitePolicyRoute.GET as unknown as Handler, method: "GET", params: C, path: `${CP}/backup-policy`, timeoutMs: 20_000, idempotency: "none" },
  {
    name: "site policy patch",
    handler: sitePolicyRoute.PATCH as unknown as Handler,
    method: "PATCH",
    params: C,
    path: `${CP}/backup-policy`,
    body: { targetIds: [TARGET] },
    timeoutMs: 20_000,
    idempotency: "none",
    badBodies: [{}, { targetIds: [] }, { targetIds: [TARGET, TARGET] }, { targetIds: [TARGET], retentionDays: 5 }, { targetIds: [TARGET], scheduleHourUtc: 3 }],
  },
];

function req(method: string, over: { headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  return new Request("http://localhost:3000/x", {
    method,
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000", "X-CSRF-Token": "csrf", "Content-Type": "application/json", ...over.headers },
    body: method === "GET" ? undefined : (over.raw ?? (over.body === undefined ? undefined : JSON.stringify(over.body))),
  });
}
const headersFor = (c: Case, key: string): Record<string, string> => (c.idempotency === "admin" ? { "Idempotency-Key": key } : {});
const ctxOf = (params: Record<string, string>) => ({ params: Promise.resolve(params) });
const okResponse = (c: Case) => (c.status === 204 ? { status: 204, ok: true } : { status: c.method === "POST" ? 201 : 200, ok: true, data: { data: {} } });

beforeEach(() => {
  fetchUpstream.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
});

describe("backup targets and policies BFF routes", () => {
  for (const c of cases) {
    describe(c.name, () => {
      it("forwards the exact path, method, token and timeout", async () => {
        fetchUpstream.mockResolvedValue(okResponse(c));
        const res = await c.handler(req(c.method, { headers: headersFor(c, "idem-1"), body: c.body }), ctxOf(c.params));
        expect(res.status).toBe(c.status ?? (c.method === "POST" ? 201 : 200));
        expect(fetchUpstream).toHaveBeenCalledTimes(1);
        const [path, opts] = fetchUpstream.mock.calls[0]!;
        expect(path).toBe(c.path);
        expect(opts).toMatchObject({ method: c.method, accessToken: "tok" });
        expect(opts.timeoutMs).toBe(c.timeoutMs);
        if (c.body !== undefined) expect(opts.body).toEqual(c.body);
        expect(res.headers.get("cache-control")).toContain("no-store");
      });

      it("a bad path segment is a 400 before the session is read", async () => {
        const keys = Object.keys(c.params);
        if (keys.length === 0 || keys[0] === "scope") return;
        for (const bad of ["../x", "a".repeat(129)]) {
          const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body: c.body }), ctxOf({ ...c.params, [keys.at(-1)!]: bad }));
          expect(res.status).toBe(400);
        }
        expect(getSession).not.toHaveBeenCalled();
        expect(fetchUpstream).not.toHaveBeenCalled();
      });

      if (c.method !== "GET") {
        it("a wrong CSRF token or a foreign Origin is a 403 and the API is not called", async () => {
          for (const headers of [{ "X-CSRF-Token": "bad" }, { Origin: "http://evil.test" }] as Record<string, string>[]) {
            const res = await c.handler(req(c.method, { headers: { ...headersFor(c, "k"), ...headers }, body: c.body }), ctxOf(c.params));
            expect(res.status).toBe(403);
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      } else {
        it("an unauthenticated GET is a 401 and the API is not called", async () => {
          getSession.mockResolvedValue(null);
          expect((await c.handler(req("GET"), ctxOf(c.params))).status).toBe(401);
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.badBodies) {
        it("refuses bodies outside the strict contract before the API", async () => {
          for (const body of c.badBodies!) {
            const res = await c.handler(req(c.method, { headers: headersFor(c, "k"), body }), ctxOf(c.params));
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(await res.text()).toContain("VALIDATION_ERROR");
          }
          expect(fetchUpstream).not.toHaveBeenCalled();
        });
      }

      if (c.idempotency === "admin") {
        it("requires the Idempotency-Key and forwards it", async () => {
          expect((await c.handler(req(c.method, { body: c.body }), ctxOf(c.params))).status).toBe(400);
          expect(fetchUpstream).not.toHaveBeenCalled();
          fetchUpstream.mockResolvedValue(okResponse(c));
          await c.handler(req(c.method, { headers: { "Idempotency-Key": "admin-key-1" }, body: c.body }), ctxOf(c.params));
          expect(fetchUpstream.mock.calls[0]![1].idempotencyKey).toBe("admin-key-1");
        });
      }
    });
  }

  it("target test and initialize need a JSON body: an empty one is a 400", async () => {
    for (const h of [testRoute.POST, initRoute.POST] as unknown as Handler[]) {
      expect((await h(req("POST", { headers: { "Idempotency-Key": "k" } }), ctxOf(T))).status).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a target delete accepts an empty body", async () => {
    fetchUpstream.mockResolvedValue({ status: 204, ok: true });
    const res = await (targetRoute.DELETE as unknown as Handler)(req("DELETE"), ctxOf(T));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("a policy scope other than default|panel is a 400 before the session is read", async () => {
    for (const scope of ["other", "default_site", "site", "..", "Default"]) {
      for (const h of [policyRoute.GET, policyRoute.PATCH] as unknown as Handler[]) {
        const res = await h(req(h === (policyRoute.GET as unknown) ? "GET" : "PATCH", { body: { targetIds: [] } }), ctxOf({ scope }));
        expect(res.status, scope).toBe(400);
      }
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("a site policy PATCH accepts null (inherit) and returns the upstream refusal unchanged", async () => {
    fetchUpstream.mockResolvedValue({ status: 200, ok: true, data: { data: {} } });
    expect((await (sitePolicyRoute.PATCH as unknown as Handler)(req("PATCH", { body: { targetIds: null } }), ctxOf(C))).status).toBe(200);
    fetchUpstream.mockResolvedValue({
      status: 409,
      ok: false,
      error: { error: { code: "BACKUP_TARGET_IN_USE", message: "in use", details: [] } },
    });
    const res = await (targetRoute.DELETE as unknown as Handler)(req("DELETE"), ctxOf(T));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("BACKUP_TARGET_IN_USE");
  });

  it("a target PATCH carrying a secret never echoes it on an upstream error", async () => {
    fetchUpstream.mockResolvedValue({ status: 422, ok: false, error: { error: { code: "VALIDATION_ERROR", message: "bad", details: [] } } });
    const res = await (targetRoute.PATCH as unknown as Handler)(req("PATCH", { body: { secretAccessKey: "secret-value-123" } }), ctxOf(T));
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain("secret-value-123");
  });
});

describe("restore and download bodies carry an optional targetId", () => {
  const dl = { ...C, backupId: "bkp_1" };
  const prepare = downloadRoute.POST as unknown as Handler;
  const restore = restoreRoute.POST as unknown as Handler;
  const adminRestore = adminRestoreRoute.POST as unknown as Handler;

  it("download prepare: no body and {} pass byte-identically, {targetId} passes, anything else is a 400", async () => {
    fetchUpstream.mockResolvedValue({ status: 202, ok: true, data: { data: {} } });
    await prepare(req("POST"), ctxOf(dl));
    await prepare(req("POST", { body: {} }), ctxOf(dl));
    await prepare(req("POST", { body: { targetId: TARGET } }), ctxOf(dl));
    expect(fetchUpstream).toHaveBeenCalledTimes(3);
    expect("body" in fetchUpstream.mock.calls[0]![1]).toBe(false);
    expect(fetchUpstream.mock.calls[1]![1].body).toEqual({});
    expect(fetchUpstream.mock.calls[2]![1].body).toEqual({ targetId: TARGET });
    expect(fetchUpstream.mock.calls[0]![0]).toBe(`${CP}/backups/bkp_1/download`);
    // M4 contract (PrepareDownloadInputSchema): `format` is 'zip' | 'zip.age'; zip.age needs a recipient and zip refuses one.
    await prepare(req("POST", { body: { format: "zip" } }), ctxOf(dl));
    await prepare(req("POST", { body: { targetId: TARGET, format: "zip.age", recipient: AGE } }), ctxOf(dl));
    expect(fetchUpstream.mock.calls[3]![1].body).toEqual({ format: "zip" });
    expect(fetchUpstream.mock.calls[4]![1].body).toEqual({ targetId: TARGET, format: "zip.age", recipient: AGE });
    for (const body of [{ targetId: "../x" }, { targetId: TARGET, format: "tar" }, { format: "zip", recipient: AGE }, { format: "zip.age" }, { recipient: AGE }, { path: "/x" }, []]) {
      expect((await prepare(req("POST", { body }), ctxOf(dl))).status, JSON.stringify(body)).toBe(400);
    }
    expect(fetchUpstream).toHaveBeenCalledTimes(5);
  });

  it("customer restore: {confirmName} is forwarded unchanged, targetId is optional, extra keys are refused", async () => {
    fetchUpstream.mockResolvedValue({ status: 202, ok: true, data: { data: {} } });
    await restore(req("POST", { headers: { "Idempotency-Key": "k" }, body: { confirmName: "shop" } }), ctxOf(dl));
    await restore(req("POST", { headers: { "Idempotency-Key": "k" }, body: { confirmName: "shop", targetId: TARGET } }), ctxOf(dl));
    expect(fetchUpstream.mock.calls[0]![1].body).toEqual({ confirmName: "shop" });
    expect(fetchUpstream.mock.calls[1]![1].body).toEqual({ confirmName: "shop", targetId: TARGET });
    expect((await restore(req("POST", { headers: { "Idempotency-Key": "k" }, body: { confirmName: "shop", targetId: "../x" } }), ctxOf(dl))).status).toBe(400);
    expect((await restore(req("POST", { headers: { "Idempotency-Key": "k" }, body: { confirmName: "shop", path: "/x" } }), ctxOf(dl))).status).toBe(400);
  });

  it("admin restore: {confirmName} is forwarded unchanged and accepts targetId", async () => {
    fetchUpstream.mockResolvedValue({ status: 202, ok: true, data: { data: {} } });
    const p = ctxOf({ siteId: "site_1" });
    const headers = { "Idempotency-Key": "k" };
    expect((await adminRestore(req("POST", { headers, body: { confirmName: "shop" } }), p)).status).toBe(202);
    expect((await adminRestore(req("POST", { headers, body: { confirmName: "shop", targetId: TARGET } }), p)).status).toBe(202);
    expect(fetchUpstream.mock.calls[0]![1].body).toEqual({ confirmName: "shop" });
    expect(fetchUpstream.mock.calls[1]![1].body).toEqual({ confirmName: "shop", targetId: TARGET });
  });
});
