import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_FILE_CHUNK_BASE64_MAX } from "@hosting-panel/contracts";
import { encryptSession, SESSION_COOKIE_NAME, type SessionData } from "../src/lib/session";
import {
  GET as getImport,
  POST as postImport,
} from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/route";
import { DELETE as deleteFiles } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/route";
import { PUT as putChunk } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/[slot]/route";
import { POST as postPick } from "../src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/import/files/[slot]/pick/route";

const ORG = "org-1";
const SITE = "site-1";
const CSRF = "csrf-import-test-token";
const BASE = `/api/bff/orgs/${ORG}/managed-sites/${SITE}/wordpress/import`;
const UPSTREAM = `/v1/organizations/${ORG}/managed-sites/${SITE}/wordpress/import`;
const UPLOAD_ID = "upl0000000000000001";
const CHUNK = { uploadId: UPLOAD_ID, offset: 0, dataBase64: "AAAA", final: true };

async function makeSessionCookie(): Promise<string> {
  const session: SessionData = {
    accessToken: "upstream-jwt-token-sentinel",
    csrfToken: CSRF,
    activeConsole: "customer",
    activeOrgSlug: null,
    user: {
      id: "usr-1",
      email: "admin@example.test",
      name: "Owner",
      locale: "en",
      mustChangePassword: false,
      isServerAdmin: false,
      globalRoles: [],
      hostingAdminOrgIds: [],
    },
  };
  return `${SESSION_COOKIE_NAME}=${await encryptSession(session)}`;
}

function makeReq(
  path: string,
  opts: { method?: string; cookie?: string | null; csrf?: string | null; origin?: string; body?: string; key?: string } = {},
): Request {
  const headers: Record<string, string> = { Host: "localhost:3000", Origin: opts.origin ?? "http://localhost:3000" };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://localhost:3000${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
}

const siteCtx = () => ({ params: Promise.resolve({ orgId: ORG, siteId: SITE }) });
const slotCtx = (slot: string) => ({ params: Promise.resolve({ orgId: ORG, siteId: SITE, slot }) });

function installFetchStub(status = 200, payload: unknown = { data: {} }, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | undefined }> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
  });
  vi.stubGlobal("fetch", stub);
  return { stub, calls };
}

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

// Each changing route with a body that would otherwise pass.
const mutations = (cookie: string, opts: { csrf?: string | null; origin?: string }) => [
  () => postImport(makeReq(BASE, { method: "POST", cookie, body: '{"confirm":true}', key: "k-1", ...opts }), siteCtx()),
  () => deleteFiles(makeReq(`${BASE}/files`, { method: "DELETE", cookie, ...opts }), siteCtx()),
  () => putChunk(makeReq(`${BASE}/files/dump`, { method: "PUT", cookie, body: JSON.stringify(CHUNK), ...opts }), slotCtx("dump")),
  () =>
    postPick(
      makeReq(`${BASE}/files/archive/pick`, { method: "POST", cookie, body: '{"path":"imports/site.zip"}', ...opts }),
      slotCtx("archive"),
    ),
];

describe("WordPress import BFF routes", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = await makeSessionCookie();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GET forwards to GET .../wordpress/import with no-store, and answers 401 without a session before any upstream call", async () => {
    const state = { data: { running: null, earlierImportUnfinished: false } };
    const { calls } = installFetchStub(200, state);
    const res = await getImport(makeReq(BASE, { cookie }), siteCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual(state);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(pathOf(calls[0]!.url).endsWith(UPSTREAM)).toBe(true);

    const { stub } = installFetchStub();
    const anon = await getImport(makeReq(BASE), siteCtx());
    expect(anon.status).toBe(401);
    expect(stub).not.toHaveBeenCalled();
  });

  it("every changing route refuses a missing CSRF token, a wrong one and a foreign Origin before any upstream call", async () => {
    const { stub } = installFetchStub();
    for (const opts of [{ csrf: null }, { csrf: "csrf-wrong-token" }, { csrf: CSRF, origin: "https://evil.example.test" }]) {
      for (const call of mutations(cookie, opts)) {
        expect((await call()).status, JSON.stringify(opts)).toBe(403);
      }
    }
    for (const call of mutations("", { csrf: CSRF })) {
      expect([401, 403]).toContain((await call()).status);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("a slot other than archive or dump is refused with 400 before any upstream call", async () => {
    const { stub } = installFetchStub();
    for (const slot of ["..", "archive/..", "archive%2Fdump", "archive%2F..", "", "files", "ARCHIVE", "dump ", "pick"]) {
      const put = await putChunk(
        makeReq(`${BASE}/files/x`, { method: "PUT", cookie, csrf: CSRF, body: JSON.stringify(CHUNK) }),
        slotCtx(slot),
      );
      const pick = await postPick(
        makeReq(`${BASE}/files/x/pick`, { method: "POST", cookie, csrf: CSRF, body: '{"path":"imports/site.zip"}' }),
        slotCtx(slot),
      );
      expect([put.status, pick.status], JSON.stringify(slot)).toEqual([400, 400]);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("POST start forwards exactly {confirm:true} with the browser's Idempotency-Key and passes the 202 on", async () => {
    const accepted = { data: { siteId: SITE, operationId: "op-1" } };
    const { calls } = installFetchStub(202, accepted);
    const res = await postImport(
      makeReq(BASE, { method: "POST", cookie, csrf: CSRF, body: '{"confirm":true}', key: "key-import-1" }),
      siteCtx(),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(accepted);
    expect(calls[0]!.method).toBe("POST");
    expect(pathOf(calls[0]!.url).endsWith(UPSTREAM)).toBe(true);
    expect(calls[0]!.headers.get("idempotency-key")).toBe("key-import-1");
    expect(JSON.parse(calls[0]!.body ?? "null")).toEqual({ confirm: true });
  });

  it("POST start without an Idempotency-Key gets a generated one, as the shipped update route does", async () => {
    const { calls } = installFetchStub(202, { data: {} });
    const res = await postImport(makeReq(BASE, { method: "POST", cookie, csrf: CSRF, body: '{"confirm":true}' }), siteCtx());
    expect(res.status).toBe(202);
    expect(calls[0]!.headers.get("idempotency-key")).toMatch(/\S+/);
  });

  it("POST start refuses any body other than exactly {confirm:true} before any upstream call", async () => {
    const { stub } = installFetchStub();
    const bodies = ["{}", '{"confirm":false}', '{"confirm":"true"}', '{"confirm":true,"force":true}', "[]", "null", "{bad"];
    for (const body of bodies) {
      const res = await postImport(makeReq(BASE, { method: "POST", cookie, csrf: CSRF, body }), siteCtx());
      expect(res.status, body).toBe(400);
    }
    const none = await postImport(makeReq(BASE, { method: "POST", cookie, csrf: CSRF }), siteCtx());
    expect(none.status).toBe(400);
    expect(stub).not.toHaveBeenCalled();
  });

  it("DELETE files forwards to DELETE .../import/files with no body and passes the 204 on", async () => {
    const { calls } = installFetchStub(204);
    const res = await deleteFiles(makeReq(`${BASE}/files`, { method: "DELETE", cookie, csrf: CSRF }), siteCtx());
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(calls[0]!.method).toBe("DELETE");
    expect(pathOf(calls[0]!.url).endsWith(`${UPSTREAM}/files`)).toBe(true);
    expect(calls[0]!.body).toBeUndefined();
  });

  it("PUT forwards one chunk to PUT .../import/files/:slot unchanged", async () => {
    for (const slot of ["archive", "dump"]) {
      const slotState = { data: { slot, state: "partial", size: 3 } };
      const { calls } = installFetchStub(200, slotState);
      const res = await putChunk(
        makeReq(`${BASE}/files/${slot}`, { method: "PUT", cookie, csrf: CSRF, body: JSON.stringify({ ...CHUNK, final: false }) }),
        slotCtx(slot),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(slotState);
      expect(calls[0]!.method).toBe("PUT");
      expect(pathOf(calls[0]!.url).endsWith(`${UPSTREAM}/files/${slot}`)).toBe(true);
      expect(JSON.parse(calls[0]!.body ?? "null")).toEqual({ ...CHUNK, final: false });
      expect(calls[0]!.headers.get("idempotency-key")).toBeNull();
    }
  });

  it("PUT refuses a bad chunk body with 400 and a body over 1 MiB with 413, before any upstream call", async () => {
    const { stub } = installFetchStub();
    const bad = [
      { ...CHUNK, uploadId: "short" },
      { ...CHUNK, uploadId: "../../etc/passwd0000" },
      { ...CHUNK, uploadId: 7 },
      { ...CHUNK, offset: -1 },
      { ...CHUNK, offset: 1.5 },
      { ...CHUNK, offset: "0" },
      { ...CHUNK, dataBase64: "A".repeat(SITE_FILE_CHUNK_BASE64_MAX + 4) },
      { ...CHUNK, dataBase64: "not base64!" },
      { uploadId: UPLOAD_ID, offset: 0, dataBase64: "AAAA" },
      { ...CHUNK, final: "true" },
      { ...CHUNK, path: "imports/site.zip" },
      { ...CHUNK, overwrite: true },
    ];
    for (const body of bad) {
      const res = await putChunk(
        makeReq(`${BASE}/files/dump`, { method: "PUT", cookie, csrf: CSRF, body: JSON.stringify(body) }),
        slotCtx("dump"),
      );
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const huge = JSON.stringify({ ...CHUNK, dataBase64: "A".repeat(1_048_576) });
    const tooBig = await putChunk(makeReq(`${BASE}/files/dump`, { method: "PUT", cookie, csrf: CSRF, body: huge }), slotCtx("dump"));
    expect(tooBig.status).toBe(413);
    expect(stub).not.toHaveBeenCalled();
  });

  it("pick forwards {path} to POST .../import/files/:slot/pick", async () => {
    const { calls } = installFetchStub(200, { data: { slot: "archive", state: "complete" } });
    const res = await postPick(
      makeReq(`${BASE}/files/archive/pick`, { method: "POST", cookie, csrf: CSRF, body: '{"path":"imports/site.zip"}' }),
      slotCtx("archive"),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe("POST");
    expect(pathOf(calls[0]!.url).endsWith(`${UPSTREAM}/files/archive/pick`)).toBe(true);
    expect(JSON.parse(calls[0]!.body ?? "null")).toEqual({ path: "imports/site.zip" });
  });

  it("pick refuses an unsafe path or an extra key before any upstream call", async () => {
    const { stub } = installFetchStub();
    const bad = [
      { path: ".htpanel-import/archive" },
      { path: "imports/.htpanel-x/site.zip" },
      { path: "../site.zip" },
      { path: "imports/../../site.zip" },
      { path: "/etc/passwd" },
      { path: "" },
      { path: 7 },
      {},
      { path: "imports/site.zip", overwrite: true },
    ];
    for (const body of bad) {
      const res = await postPick(
        makeReq(`${BASE}/files/dump/pick`, { method: "POST", cookie, csrf: CSRF, body: JSON.stringify(body) }),
        slotCtx("dump"),
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(stub).not.toHaveBeenCalled();
  });

  it("passes upstream refusals on with status and code, redacting internal fields and dropping upstream headers", async () => {
    const envelope = {
      error: { code: "RESOURCE_LOCKED", message: "x", details: [{ reason: "earlier_import_unfinished", hostPath: "/srv/sentinel" }] },
    };
    installFetchStub(409, envelope, { "X-Upstream-Internal": "sentinel-header" });
    const res = await postImport(
      makeReq(BASE, { method: "POST", cookie, csrf: CSRF, body: '{"confirm":true}', key: "k-2" }),
      siteCtx(),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get("x-upstream-internal")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as typeof envelope;
    expect(body.error.code).toBe("RESOURCE_LOCKED");
    expect(body.error.details[0]!.reason).toBe("earlier_import_unfinished");
    expect(JSON.stringify(body)).not.toContain("/srv/sentinel");
  });
});
