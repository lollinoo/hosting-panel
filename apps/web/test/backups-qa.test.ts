import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_PROBLEMS, type SiteBackupsDto } from "@hosting-panel/contracts";

const mockUpstream = vi.hoisted(() => ({
  fetchUpstream: vi.fn(),
}));

const mockSession = vi.hoisted(() => ({
  getSessionFromRequest: vi.fn(),
  getServerSession: vi.fn(),
}));

const mockCustomerData = vi.hoisted(() => ({
  getCustomerContext: vi.fn(),
  getSite: vi.fn(),
}));

const mockLocale = vi.hoisted(() => ({
  getRequestLocale: vi.fn(),
}));

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: mockUpstream.fetchUpstream,
}));

vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: mockSession.getSessionFromRequest,
  getServerSession: mockSession.getServerSession,
}));

vi.mock("@/app/sites/data", () => ({
  getCustomerContext: mockCustomerData.getCustomerContext,
  getSite: mockCustomerData.getSite,
}));

vi.mock("@/i18n/server", () => ({
  getRequestLocale: mockLocale.getRequestLocale,
}));

import {
  DELETE as adminDelete,
  GET as adminGet,
  PATCH as adminPatch,
} from "@/app/api/admin/backups/route";
import { POST as adminTestPost } from "@/app/api/admin/backups/test/route";
import { GET as adminSitesGet } from "@/app/api/admin/backups/sites/route";
import { POST as adminSiteRunPost } from "@/app/api/admin/backups/sites/[siteId]/run/route";
import {
  GET as customerGet,
  POST as customerPost,
} from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/route";
import SiteBackupsPage from "@/app/sites/[siteId]/backups/page";
import { startBackupSitesPolling } from "@/components/admin/backup-settings";
import {
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_POLL_LIMIT_MS,
  backupErrorText,
  backupGiveUpText,
  startBackupPolling,
  triggerSiteBackup,
} from "@/components/customer/site-backups";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { MAX_BFF_BODY_BYTES } from "@/lib/bff-files";
import { fetchServerAdminBackupSites } from "@/lib/server-api";

const ORG_ID = "org_qa_1";
const SITE_ID = "site_qa_1";
const CSRF = "csrf-qa-token";
const CUSTOMER_URL = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`;
const ADMIN_URL = "http://localhost:3000/api/admin/backups";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function makeRequest(
  url: string,
  method: string,
  opts: {
    body?: string;
    origin?: string | null;
    csrf?: string | null;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const headers = new Headers();
  headers.set("Host", "localhost:3000");
  if (opts.origin !== null) {
    headers.set("Origin", opts.origin ?? "http://localhost:3000");
  }
  if (opts.csrf !== null && method !== "GET") {
    headers.set("X-CSRF-Token", opts.csrf ?? CSRF);
  }
  if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers.set(k, v);
    }
  }
  return new NextRequest(url, { method, headers, body: opts.body });
}

function siteCtx(orgId = ORG_ID, siteId = SITE_ID) {
  return { params: Promise.resolve({ orgId, siteId }) };
}

function adminSiteCtx(siteId = SITE_ID) {
  return { params: Promise.resolve({ siteId }) };
}

function collectLeafEntries(
  node: unknown,
  prefix = "",
  out: Array<{ key: string; path: string; value: string }> = [],
): Array<{ key: string; path: string; value: string }> {
  if (typeof node === "string") {
    const key = prefix.split(".").pop() ?? prefix;
    out.push({ key, path: prefix, value: node });
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectLeafEntries(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

describe("backups web BFF, timeouts, polling, and copy QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.getSessionFromRequest.mockResolvedValue({
      userId: "u_customer",
      email: "customer@qa.test",
      role: "customer_owner",
      accessToken: "jwt-customer",
      csrfToken: CSRF,
    });
    mockSession.getServerSession.mockResolvedValue({
      userId: "u_customer",
      email: "customer@qa.test",
      role: "customer_owner",
      accessToken: "jwt-customer",
      csrfToken: CSRF,
    });
    mockLocale.getRequestLocale.mockResolvedValue("en");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses oversized (>1 MiB) and non-JSON/non-empty bodies on customer POST without calling upstream", async () => {
    const overLimitHeaderReq = makeRequest(CUSTOMER_URL, "POST", {
      body: "{}",
      headers: { "Content-Length": String(MAX_BFF_BODY_BYTES + 1) },
    });
    const resHeader = await customerPost(overLimitHeaderReq, siteCtx());
    expect(resHeader.status).toBe(413);
    expect(((await resHeader.json()) as Json).error.code).toBe("VALIDATION_ERROR");

    const oversizedBody = JSON.stringify({ pad: "x".repeat(MAX_BFF_BODY_BYTES + 128) });
    const overLimitBodyReq = makeRequest(CUSTOMER_URL, "POST", { body: oversizedBody });
    const resBody = await customerPost(overLimitBodyReq, siteCtx());
    expect(resBody.status).toBe(413);
    expect(((await resBody.json()) as Json).error.code).toBe("VALIDATION_ERROR");

    for (const badBody of ["{not-json", "plain-text", "[]", "123", JSON.stringify({ extra: 1 })]) {
      const res = await customerPost(makeRequest(CUSTOMER_URL, "POST", { body: badBody }), siteCtx());
      expect(res.status, `body=${badBody}`).toBe(400);
      expect(((await res.json()) as Json).error.code).toBe("VALIDATION_ERROR");
    }

    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses traversal and hostile siteId values on customer routes and admin run route before calling upstream", async () => {
    const hostileIds = [
      "..",
      "a/b",
      "../escape",
      "..%2Fescape",
      "a%2Fb",
      "bad'quote",
      "bad\u0000nul",
      "x".repeat(200),
    ];

    for (const badSiteId of hostileIds) {
      const custGetRes = await customerGet(makeRequest(CUSTOMER_URL, "GET"), siteCtx(ORG_ID, badSiteId));
      expect(custGetRes.status, `customer GET ${badSiteId}`).toBe(400);

      const custPostRes = await customerPost(
        makeRequest(CUSTOMER_URL, "POST", { body: "{}" }),
        siteCtx(ORG_ID, badSiteId),
      );
      expect(custPostRes.status, `customer POST ${badSiteId}`).toBe(400);

      const adminRunRes = await adminSiteRunPost(
        makeRequest(`${ADMIN_URL}/sites/${badSiteId}/run`, "POST", {
          body: "{}",
          headers: { "Idempotency-Key": "k-1" },
        }),
        adminSiteCtx(badSiteId),
      );
      expect(adminRunRes.status, `admin run POST ${badSiteId}`).toBe(400);
    }

    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses mutations from another origin or without valid CSRF token before calling upstream", async () => {
    const mutations: Array<(origin: string | null, csrf: string | null) => Promise<Response>> = [
      (origin, csrf) =>
        customerPost(makeRequest(CUSTOMER_URL, "POST", { body: "{}", origin, csrf }), siteCtx()),
      (origin, csrf) =>
        adminPatch(makeRequest(ADMIN_URL, "PATCH", { body: "{}", origin, csrf })),
      (origin, csrf) =>
        adminDelete(makeRequest(ADMIN_URL, "DELETE", { origin, csrf })),
      (origin, csrf) =>
        adminTestPost(makeRequest(`${ADMIN_URL}/test`, "POST", { origin, csrf })),
      (origin, csrf) =>
        adminSiteRunPost(
          makeRequest(`${ADMIN_URL}/sites/${SITE_ID}/run`, "POST", {
            body: "{}",
            origin,
            csrf,
            headers: { "Idempotency-Key": "k-origin" },
          }),
          adminSiteCtx(),
        ),
    ];

    for (const run of mutations) {
      const crossOrigin = await run("https://evil.example", CSRF);
      expect(crossOrigin.status).toBe(403);

      const missingCsrf = await run("http://localhost:3000", null);
      expect(missingCsrf.status).toBe(403);

      const wrongCsrf = await run("http://localhost:3000", "wrong-csrf");
      expect(wrongCsrf.status).toBe(403);
    }

    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("passes upstream 403 PERMISSION_DENIED unchanged when a customer calls admin backup routes", async () => {
    const upstream403 = {
      ok: false as const,
      status: 403,
      error: {
        error: {
          code: "PERMISSION_DENIED",
          message: "Server administrator permission required.",
          requestId: "req_403_qa",
          retryable: false,
          details: [],
        },
      },
    };

    const calls: Array<() => Promise<Response>> = [
      () => adminGet(makeRequest(ADMIN_URL, "GET")),
      () => adminPatch(makeRequest(ADMIN_URL, "PATCH", { body: JSON.stringify({ bucket: "b" }) })),
      () => adminDelete(makeRequest(ADMIN_URL, "DELETE")),
      () => adminTestPost(makeRequest(`${ADMIN_URL}/test`, "POST")),
      () => adminSitesGet(makeRequest(`${ADMIN_URL}/sites`, "GET")),
      () =>
        adminSiteRunPost(
          makeRequest(`${ADMIN_URL}/sites/${SITE_ID}/run`, "POST", {
            body: "{}",
            headers: { "Idempotency-Key": "k-cust-403" },
          }),
          adminSiteCtx(),
        ),
    ];

    for (const callRoute of calls) {
      mockUpstream.fetchUpstream.mockResolvedValueOnce(upstream403);
      const res = await callRoute();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(upstream403.error);
    }
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(calls.length);
  });

  it("redacts forbidden key 'password' via bffJsonResponse while observing that 'secretAccessKey' is not in FORBIDDEN_KEY_PATTERN", async () => {
    // password is in FORBIDDEN_KEY_PATTERN -> bffJsonResponse replaces it with "[REDACTED]".
    // secretAccessKey is NOT in FORBIDDEN_KEY_PATTERN (R60.7) -> BFF passes it through if upstream ever sent it.
    const leakyPayload = {
      data: {
        available: true,
        configured: true,
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "qa-bucket",
        prefix: "",
        accessKeyId: "AKIAQA1",
        secretAccessKeySet: true,
        secretAccessKey: "leaky-s3-secret-value",
        password: "leaky-password-value",
        scheduleHourUtc: 2,
        retentionDays: 14,
        lastNightlyRunOn: null,
        lastTest: null,
        updatedAt: null,
      },
    };

    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: leakyPayload,
    });
    const adminRes = await adminGet(makeRequest(ADMIN_URL, "GET"));
    expect(adminRes.status).toBe(200);
    const adminText = await adminRes.text();
    const adminJson = JSON.parse(adminText) as Json;
    expect(adminJson.data.password).toBe("[REDACTED]");
    expect(adminText).not.toContain("leaky-password-value");
    expect(adminJson.data.secretAccessKey).toBe("leaky-s3-secret-value");

    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: {
          available: true,
          configured: true,
          retentionDays: 14,
          manualKept: 3,
          runningOperationId: null,
          backups: [],
          password: "leaky-cust-password",
          secretAccessKey: "leaky-cust-s3-secret",
        },
      },
    });
    const custRes = await customerGet(makeRequest(CUSTOMER_URL, "GET"), siteCtx());
    expect(custRes.status).toBe(200);
    const custJson = (await custRes.json()) as Json;
    expect(custJson.data.password).toBe("[REDACTED]");
    expect(custJson.data.secretAccessKey).toBe("leaky-cust-s3-secret");
  });

  it("enforces R63 upstream timeouts (45s test, 20s reads and customer POST)", async () => {
    mockUpstream.fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });

    await adminTestPost(makeRequest(`${ADMIN_URL}/test`, "POST"));
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      "v1/admin/backups/test",
      expect.objectContaining({ method: "POST", timeoutMs: 45_000 }),
    );

    await adminSitesGet(makeRequest(`${ADMIN_URL}/sites`, "GET"));
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      "v1/admin/backups/sites",
      expect.objectContaining({ method: "GET", timeoutMs: 20_000 }),
    );

    await customerGet(makeRequest(CUSTOMER_URL, "GET"), siteCtx());
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      expect.objectContaining({ method: "GET", timeoutMs: 20_000 }),
    );

    await customerPost(makeRequest(CUSTOMER_URL, "POST", { body: "{}" }), siteCtx());
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      expect.objectContaining({ method: "POST", timeoutMs: 20_000 }),
    );

    await fetchServerAdminBackupSites();
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      "v1/admin/backups/sites",
      expect.objectContaining({ timeoutMs: 20_000 }),
    );

    mockCustomerData.getCustomerContext.mockResolvedValue({
      orgId: ORG_ID,
      session: { csrfToken: CSRF },
      loadError: null,
    });
    mockCustomerData.getSite.mockResolvedValue({
      ok: true,
      data: { id: SITE_ID, name: "Site QA", organizationId: ORG_ID },
    });
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: {
          available: true,
          configured: true,
          retentionDays: 14,
          manualKept: 3,
          runningOperationId: null,
          backups: [],
        } satisfies SiteBackupsDto,
      },
    });
    await SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) });
    expect(mockUpstream.fetchUpstream).toHaveBeenLastCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("stops customer and admin list polling after 401 and stops customer polling at its 10-minute limit", async () => {
    vi.useFakeTimers();

    // 1) Customer polling stops on 401
    let currentTime = 1_000_000;
    const custFetch401 = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    const onGiveUp = vi.fn();
    const stop401 = startBackupPolling({
      basePath: CUSTOMER_URL,
      fetchImpl: custFetch401 as unknown as typeof fetch,
      now: () => currentTime,
      onData: vi.fn(),
      onUnauthorized,
      onGiveUp,
    });

    currentTime += BACKUP_POLL_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(custFetch401).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(401);
    expect(onGiveUp).not.toHaveBeenCalled();

    currentTime += BACKUP_POLL_INTERVAL_MS * 5;
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 5);
    expect(custFetch401).toHaveBeenCalledTimes(1);
    stop401();

    // 2) Customer polling stops after 10-minute limit and uses stillRunning text
    let limitTime = 2_000_000;
    const runningDto: SiteBackupsDto = {
      available: true,
      configured: true,
      retentionDays: 14,
      manualKept: 3,
      runningOperationId: "op_running_qa",
      backups: [],
    };
    const custFetchRunning = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: runningDto }), { status: 200 }));
    const onData = vi.fn();
    const onGiveUpLimit = vi.fn();
    const stopLimit = startBackupPolling({
      basePath: CUSTOMER_URL,
      fetchImpl: custFetchRunning as unknown as typeof fetch,
      now: () => limitTime,
      onData,
      onUnauthorized: vi.fn(),
      onGiveUp: onGiveUpLimit,
    });

    for (let elapsed = BACKUP_POLL_INTERVAL_MS; elapsed < BACKUP_POLL_LIMIT_MS; elapsed += BACKUP_POLL_INTERVAL_MS) {
      limitTime += BACKUP_POLL_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    }
    expect(onGiveUpLimit).not.toHaveBeenCalled();
    const callsBeforeLimit = custFetchRunning.mock.calls.length;
    expect(callsBeforeLimit).toBeGreaterThan(0);

    limitTime += BACKUP_POLL_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onGiveUpLimit).toHaveBeenCalledTimes(1);
    expect(backupGiveUpText(en)).toBe(en.site.backups.errors.stillRunning);
    expect(backupGiveUpText(itCatalog)).toBe(itCatalog.site.backups.errors.stillRunning);

    limitTime += BACKUP_POLL_INTERVAL_MS * 3;
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(custFetchRunning).toHaveBeenCalledTimes(callsBeforeLimit);
    stopLimit();

    // 3) Admin sites polling stops when load returns stop:true (401)
    const adminLoad = vi.fn().mockResolvedValue({ kind: "error", stop: true });
    const adminOnSites = vi.fn();
    const stopAdmin = startBackupSitesPolling({
      load: adminLoad,
      onSites: adminOnSites,
      onError: vi.fn(),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(adminLoad).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(adminLoad).toHaveBeenCalledTimes(1);
    expect(adminOnSites).not.toHaveBeenCalled();
    stopAdmin();
  });

  it("sends only one request on double click and maps 502/504 to site.backups.errors.uncertain", async () => {
    let resolvePost!: (res: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    );
    const inFlightRef = { current: false };

    const first = triggerSiteBackup({
      basePath: CUSTOMER_URL,
      csrfToken: CSRF,
      inFlightRef,
      fetchImpl: fetchMock as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-double-click",
    });
    const second = triggerSiteBackup({
      basePath: CUSTOMER_URL,
      csrfToken: CSRF,
      inFlightRef,
      fetchImpl: fetchMock as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-double-click-2",
    });

    expect(await second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolvePost(
      new Response(
        JSON.stringify({
          data: { siteId: SITE_ID, backupId: "bkp_1", operationId: "op_1" },
          links: { operation: `/v1/organizations/${ORG_ID}/operations/op_1` },
        }),
        { status: 202 },
      ),
    );
    const firstRes = await first;
    expect(firstRes?.status).toBe(202);
    expect(inFlightRef.current).toBe(false);

    expect(backupErrorText(en, 502, null).message).toBe(en.site.backups.errors.uncertain);
    expect(backupErrorText(en, 504, { error: { code: "INTERNAL_ERROR" } }).message).toBe(
      en.site.backups.errors.uncertain,
    );
    expect(backupErrorText(itCatalog, 502, null).message).toBe(itCatalog.site.backups.errors.uncertain);
    expect(backupErrorText(itCatalog, 504, { error: { code: "INTERNAL_ERROR" } }).message).toBe(
      itCatalog.site.backups.errors.uncertain,
    );
  });

  it("defines all 17 BACKUP_PROBLEMS in IT/EN for admin and customer and never repeats key names as customer copy", () => {
    expect(BACKUP_PROBLEMS).toHaveLength(17);

    for (const problem of BACKUP_PROBLEMS) {
      for (const [localeName, catalog] of [
        ["en", en],
        ["it", itCatalog],
      ] as const) {
        const adminText = catalog.admin.backups.problem[problem];
        const siteText = catalog.site.backups.problem[problem];
        expect(typeof adminText, `${localeName} admin ${problem}`).toBe("string");
        expect(adminText.trim().length, `${localeName} admin ${problem}`).toBeGreaterThan(0);
        expect(adminText, `${localeName} admin ${problem}`).not.toBe(problem);

        expect(typeof siteText, `${localeName} site ${problem}`).toBe("string");
        expect(siteText.trim().length, `${localeName} site ${problem}`).toBeGreaterThan(0);
        expect(siteText, `${localeName} site ${problem}`).not.toBe(problem);
      }
    }

    for (const [localeName, catalog] of [
      ["en", en],
      ["it", itCatalog],
    ] as const) {
      const leaves = collectLeafEntries(catalog.site.backups, "site.backups");
      expect(leaves.length).toBeGreaterThan(20);
      for (const leaf of leaves) {
        expect(leaf.value.trim().length, `${localeName} ${leaf.path}`).toBeGreaterThan(0);
        expect(leaf.value, `${localeName} ${leaf.path}`).not.toBe(leaf.key);
        expect(leaf.value, `${localeName} ${leaf.path}`).not.toBe(leaf.path);
      }
    }
  });
});
