import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BACKUP_PROBLEMS,
  type SiteBackupDto,
  type SiteBackupsDto,
} from "@hosting-panel/contracts";

const mockUpstream = vi.hoisted(() => ({
  fetchUpstream: vi.fn(),
}));

const mockSession = vi.hoisted(() => ({
  getSessionFromRequest: vi.fn(),
}));

const mockCustomerData = vi.hoisted(() => ({
  getCustomerContext: vi.fn(),
  getSite: vi.fn(),
}));

const mockServerApi = vi.hoisted(() => ({
  serverGet: vi.fn(),
}));

const mockLocale = vi.hoisted(() => ({
  getRequestLocale: vi.fn(),
}));

const mockNav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: mockUpstream.fetchUpstream,
}));

vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: mockSession.getSessionFromRequest,
}));

vi.mock("@/app/sites/data", () => ({
  getCustomerContext: mockCustomerData.getCustomerContext,
  getSite: mockCustomerData.getSite,
}));

vi.mock("@/lib/server-api", () => ({
  serverGet: mockServerApi.serverGet,
}));

vi.mock("@/i18n/server", () => ({
  getRequestLocale: mockLocale.getRequestLocale,
}));

vi.mock("next/navigation", () => ({
  notFound: mockNav.notFound,
}));

import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { GET as backupsGet, POST as backupsPost } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/route";
import SiteBackupsPage from "@/app/sites/[siteId]/backups/page";
import {
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_POLL_LIMIT_MS,
  SiteBackups,
  backupErrorText,
  backupExpiry,
  backupGiveUpText,
  startBackupPolling,
  submitSiteBackup,
  triggerSiteBackup,
} from "@/components/customer/site-backups";

const DAY_MS = 86_400_000;
const ORG_ID = "org_demo_1";
const SITE_ID = "site_demo_1";

const ADMIN_SESSION = {
  userId: "user_1",
  email: "owner@example.com",
  name: "Owner",
  role: "customer_owner" as const,
  orgId: ORG_ID,
  accessToken: "access-token-1",
  csrfToken: "csrf-valid-token",
};

function routeContext(orgId = ORG_ID, siteId = SITE_ID) {
  return { params: Promise.resolve({ orgId, siteId }) };
}

function makeBackupRow(overrides: Partial<SiteBackupDto> = {}): SiteBackupDto {
  return {
    id: "bak_1",
    kind: "nightly",
    status: "succeeded",
    startedAt: "2026-11-01T02:00:00.000Z",
    finishedAt: "2026-11-01T02:05:00.000Z",
    sizeBytes: 12_345_678,
    problem: null,
    ...overrides,
  };
}

function makeBackupsDto(overrides: Partial<SiteBackupsDto> = {}): SiteBackupsDto {
  return {
    available: true,
    configured: true,
    retentionDays: 14,
    manualKept: 3,
    runningOperationId: null,
    backups: [],
    ...overrides,
  };
}

function decodeHtml(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&");
}

function renderWithLocale(locale: "en" | "it", element: ReactElement): string {
  const messages = locale === "it" ? itCatalog : en;
  return decodeHtml(
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages, children: element })),
  );
}

function collectLeafStrings(node: unknown, prefix = ""): Array<{ path: string; value: string }> {
  if (typeof node === "string") {
    return [{ path: prefix, value: node }];
  }
  if (node && typeof node === "object") {
    const out: Array<{ path: string; value: string }> = [];
    for (const [k, v] of Object.entries(node)) {
      const nextPath = prefix ? `${prefix}.${k}` : k;
      out.push(...collectLeafStrings(v, nextPath));
    }
    return out;
  }
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession.getSessionFromRequest.mockResolvedValue(ADMIN_SESSION);
  mockLocale.getRequestLocale.mockResolvedValue("en");
  mockCustomerData.getCustomerContext.mockResolvedValue({
    session: ADMIN_SESSION,
    orgId: ORG_ID,
    loadError: null,
  });
  mockCustomerData.getSite.mockResolvedValue({
    ok: true,
    data: {
      id: SITE_ID,
      orgId: ORG_ID,
      name: "Demo",
      primaryDomain: "example.com",
      status: "ready",
    },
  });
  mockUpstream.fetchUpstream.mockResolvedValue({
    ok: true,
    status: 200,
    data: { data: makeBackupsDto() },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Site backups BFF route", () => {
  it("GET validates path segments before calling upstream", async () => {
    const res = await backupsGet(
      new Request("http://localhost:3000/api/bff/orgs/bad..id/managed-sites/site_1/backups"),
      routeContext("bad..id", "site_1"),
    );

    expect(res.status).toBe(400);
    expect(mockSession.getSessionFromRequest).not.toHaveBeenCalled();
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("GET forwards to upstream backups endpoint with a 20 second timeout", async () => {
    const payload = { data: makeBackupsDto({ backups: [makeBackupRow()] }) };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: payload,
    });

    const res = await backupsGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`),
      routeContext(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      expect.objectContaining({
        method: "GET",
        timeoutMs: 20_000,
      }),
    );
  });

  it("POST rejects invalid orgId or siteId before session or upstream", async () => {
    const res = await backupsPost(
      new Request("http://localhost:3000/api/bff/orgs/org_1/managed-sites/bad%2Fsite/backups", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
        },
        body: "{}",
      }),
      routeContext("org_1", "bad/site"),
    );

    expect(res.status).toBe(400);
    expect(mockSession.getSessionFromRequest).not.toHaveBeenCalled();
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("POST rejects unauthenticated requests with 401 and bad CSRF with 403", async () => {
    mockSession.getSessionFromRequest.mockResolvedValueOnce(null);
    const unauth = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
        body: "{}",
      }),
      routeContext(),
    );
    expect(unauth.status).toBe(401);

    const badCsrf = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": "wrong-token",
        },
        body: "{}",
      }),
      routeContext(),
    );
    expect(badCsrf.status).toBe(403);
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("POST forwards Idempotency-Key when provided and sends {} upstream with 20s timeout", async () => {
    const accepted = {
      data: { siteId: SITE_ID, backupId: "bak_9", operationId: "op_9" },
      links: { operation: `/v1/organizations/${ORG_ID}/operations/op_9` },
    };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 202,
      data: accepted,
    });

    const res = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
          "Idempotency-Key": "caller-key-123",
        },
        body: "{}",
      }),
      routeContext(),
    );

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(accepted);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      expect.objectContaining({
        method: "POST",
        timeoutMs: 20_000,
        body: {},
        accessToken: ADMIN_SESSION.accessToken,
        idempotencyKey: "caller-key-123",
      }),
    );
  });

  it("POST generates an Idempotency-Key when absent and still sends {} upstream for empty body", async () => {
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 202,
      data: {
        data: { siteId: SITE_ID, backupId: "bak_10", operationId: "op_10" },
        links: { operation: `/v1/organizations/${ORG_ID}/operations/op_10` },
      },
    });

    const res = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
        },
      }),
      routeContext(),
    );

    expect(res.status).toBe(202);
    const callArgs = mockUpstream.fetchUpstream.mock.calls[0]?.[1] as {
      idempotencyKey: string;
      accessToken: string;
      body: unknown;
      timeoutMs: number;
    };
    expect(callArgs.body).toEqual({});
    expect(callArgs.accessToken).toBe(ADMIN_SESSION.accessToken);
    expect(callArgs.timeoutMs).toBe(20_000);
    expect(callArgs.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("POST rejects non-empty JSON bodies, malformed JSON, and oversized payloads", async () => {
    const nonEmpty = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
        },
        body: JSON.stringify({ unexpected: true }),
      }),
      routeContext(),
    );
    expect(nonEmpty.status).toBe(400);

    const malformed = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
        },
        body: "{not-json",
      }),
      routeContext(),
    );
    expect(malformed.status).toBe(400);

    const oversize = await backupsPost(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
        },
        body: "x".repeat(1_048_577),
      }),
      routeContext(),
    );
    expect(oversize.status).toBe(413);
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });
});

describe("backupExpiry helper", () => {
  it("returns the day before expiry for future backups and on the exact boundary moment", () => {
    const startedAt = "2026-11-01T02:00:00.000Z";
    const expiresAtMs = Date.parse(startedAt) + 14 * DAY_MS;
    const expectedDisplayedExpiry = new Date(expiresAtMs - DAY_MS);

    const future = backupExpiry(
      makeBackupRow({ startedAt, status: "succeeded" }),
      14,
      new Date("2026-11-10T00:00:00.000Z"),
    );
    expect(future).toBeInstanceOf(Date);
    expect((future as Date).toISOString()).toBe(expectedDisplayedExpiry.toISOString());

    const boundary = backupExpiry(
      makeBackupRow({ startedAt, status: "succeeded" }),
      14,
      new Date(expiresAtMs),
    );
    expect(boundary).toBeInstanceOf(Date);
    expect((boundary as Date).toISOString()).toBe(expectedDisplayedExpiry.toISOString());
  });

  it("returns the previous UTC day for a backup started just after midnight UTC while keeping keptLatest tied to startedAt + retentionDays", () => {
    const startedAt = "2026-11-01T00:05:00.000Z";
    const expiresAtMs = Date.parse(startedAt) + 14 * DAY_MS;

    const displayed = backupExpiry(
      makeBackupRow({ startedAt, status: "succeeded" }),
      14,
      new Date("2026-11-05T12:00:00.000Z"),
    );
    expect(displayed).toBeInstanceOf(Date);
    expect((displayed as Date).toISOString()).toBe("2026-11-14T00:05:00.000Z");

    const atRetentionInstant = backupExpiry(
      makeBackupRow({ startedAt, status: "succeeded" }),
      14,
      new Date(expiresAtMs),
    );
    expect(atRetentionInstant).toBeInstanceOf(Date);
    expect((atRetentionInstant as Date).toISOString()).toBe("2026-11-14T00:05:00.000Z");

    const pastRetention = backupExpiry(
      makeBackupRow({ startedAt, status: "succeeded" }),
      14,
      new Date(expiresAtMs + 1),
    );
    expect(pastRetention).toBe("keptLatest");
  });

  it("returns keptLatest when expiry date is strictly in the past", () => {
    const startedAt = "2026-11-01T02:00:00.000Z";
    const pastNow = new Date(Date.parse(startedAt) + 14 * DAY_MS + 1);
    expect(backupExpiry(makeBackupRow({ startedAt, status: "succeeded" }), 14, pastNow)).toBe("keptLatest");
  });

  it("returns null for failed and running rows", () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    expect(backupExpiry(makeBackupRow({ status: "failed", problem: "unreachable" }), 14, now)).toBeNull();
    expect(backupExpiry(makeBackupRow({ status: "running", finishedAt: null, sizeBytes: null }), 14, now)).toBeNull();
  });
});

describe("SiteBackups UI component", () => {
  const basePath = `/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`;

  it("renders unavailable message with no button when available is false", () => {
    const html = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ available: false, configured: false }),
        csrfToken: "csrf",
      }),
    );

    expect(html).toContain(en.site.backups.notAvailable);
    expect(html).not.toContain(en.site.backups.backupNow);
    expect(html).not.toContain("<button");
  });

  it("renders not-set-up guidance with no button when configured is false", () => {
    const html = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ available: true, configured: false }),
        csrfToken: "csrf",
      }),
    );

    expect(html).toContain(en.site.backups.notSetUp);
    expect(html).not.toContain(en.site.backups.backupNow);
    expect(html).not.toContain("<button");
  });

  it("renders empty state, retention subtitle, manual hint, and active Back up now button", () => {
    const html = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ available: true, configured: true, retentionDays: 14, manualKept: 3 }),
        csrfToken: "csrf",
      }),
    );

    expect(html).toContain(en.site.backups.empty);
    expect(html).toContain("14");
    expect(html).toContain("3");
    expect(html).toContain(en.site.backups.backupNow);
    expect(html).not.toMatch(/\brestore\b|\bdownload\b/i);
  });

  it("renders backup table rows with kind, size, status, expiry, keptLatest, and failure problem beneath the row", () => {
    const okRecent = makeBackupRow({
      id: "bak_recent",
      kind: "manual",
      status: "succeeded",
      startedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      sizeBytes: 2_097_152,
    });
    const okOldKept = makeBackupRow({
      id: "bak_old",
      kind: "nightly",
      status: "succeeded",
      startedAt: "2025-01-01T02:00:00.000Z",
      sizeBytes: 1_024,
    });
    const failedRow = makeBackupRow({
      id: "bak_fail",
      kind: "nightly",
      status: "failed",
      startedAt: new Date(Date.now() - DAY_MS).toISOString(),
      sizeBytes: null,
      problem: "auth_failed",
    });

    const html = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ backups: [okRecent, okOldKept, failedRow] }),
        csrfToken: "csrf",
      }),
    );

    expect(html).toContain(en.site.backups.kind.manual);
    expect(html).toContain(en.site.backups.kind.nightly);
    expect(html).toContain(en.site.backups.status.succeeded);
    expect(html).toContain(en.site.backups.status.failed);
    expect(html).toContain("2 MB");
    expect(html).toContain(en.site.backups.keptLatest);
    expect(html).toContain(en.site.backups.problem.auth_failed);
    expect(html).toMatch(/colspan="5"/i);
    expect(html).not.toMatch(/\brestore\b|\bdownload\b/i);

    const itHtml = renderWithLocale(
      "it",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ backups: [okRecent, failedRow] }),
        csrfToken: "csrf",
      }),
    );
    expect(itHtml).toContain(itCatalog.site.backups.backupNow);
    expect(itHtml).toContain(itCatalog.site.backups.problem.auth_failed);
  });

  it("disables Back up now button and shows running status when a backup is running", () => {
    const html = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          runningOperationId: "op_running_1",
          backups: [makeBackupRow({ status: "running", finishedAt: null, sizeBytes: null })],
        }),
        csrfToken: "csrf",
      }),
    );

    expect(html).toContain(en.site.backups.running);
    expect(html).toContain(en.site.backups.status.running);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("maps POST error responses accurately including 400 not_configured and 409 not_ready", () => {
    const notConfigured = backupErrorText(en, 400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "not_configured",
        details: [{ message: "not_configured" }],
      },
    });
    expect(notConfigured).toEqual({ kind: "notSetUp", message: en.site.backups.notSetUp });

    const notReady = backupErrorText(en, 409, {
      error: {
        code: "RESOURCE_LOCKED",
        message: "Site is still starting.",
        details: [{ reason: "not_ready", message: "not_ready" }],
      },
    });
    expect(notReady).toEqual({ kind: "error", message: en.site.backups.errors.notReady });

    const otherLocked = backupErrorText(en, 409, {
      error: { code: "RESOURCE_LOCKED", message: "Locked" },
    });
    expect(otherLocked).toEqual({ kind: "error", message: en.errors.RESOURCE_LOCKED });

    const suspended = backupErrorText(en, 403, {
      error: { code: "ORGANIZATION_SUSPENDED", message: "Suspended" },
    });
    expect(suspended).toEqual({ kind: "error", message: en.site.backups.errors.ORGANIZATION_SUSPENDED });

    const notSupported = backupErrorText(en, 422, {
      error: { code: "NOT_SUPPORTED", message: "Unavailable" },
    });
    expect(notSupported).toEqual({ kind: "notAvailable", message: en.site.backups.notAvailable });

    const unauth = backupErrorText(en, 401, null);
    expect(unauth).toEqual({ kind: "error", message: en.site.files.errors.UNAUTHENTICATED });

    const ambiguous502 = backupErrorText(en, 502, null);
    expect(ambiguous502).toEqual({ kind: "error", message: en.site.backups.errors.uncertain });

    const ambiguous504 = backupErrorText(en, 504, null);
    expect(ambiguous504).toEqual({ kind: "error", message: en.site.backups.errors.uncertain });

    const upstream502 = backupErrorText(en, 502, {
      error: { code: "OPERATION_AMBIGUOUS", message: "Upstream error" },
    });
    expect(upstream502).toEqual({ kind: "error", message: en.site.backups.errors.uncertain });

    const upstream504 = backupErrorText(en, 504, {
      error: { code: "INTERNAL_ERROR", message: "Timeout" },
    });
    expect(upstream504).toEqual({ kind: "error", message: en.site.backups.errors.uncertain });

    expect(backupErrorText(itCatalog, 502, null)).toEqual({
      kind: "error",
      message: itCatalog.site.backups.errors.uncertain,
    });
    expect(backupErrorText(itCatalog, 504, null)).toEqual({
      kind: "error",
      message: itCatalog.site.backups.errors.uncertain,
    });
  });

  it("returns the localized stillRunning message when polling reaches the time limit", () => {
    expect(backupGiveUpText(en)).toBe(en.site.backups.errors.stillRunning);
    expect(backupGiveUpText(itCatalog)).toBe(itCatalog.site.backups.errors.stillRunning);
  });

  it("guards double-click so rapid triggers send only one POST with Idempotency-Key and {}", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const inFlightRef = { current: false };

    const first = triggerSiteBackup({
      basePath,
      csrfToken: "csrf-123",
      inFlightRef,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-key-1",
    });
    const second = triggerSiteBackup({
      basePath,
      csrfToken: "csrf-123",
      inFlightRef,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-key-2",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(basePath);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-key-1");

    resolveFetch(
      new Response(
        JSON.stringify({
          data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op_1" },
          links: { operation: `/v1/organizations/${ORG_ID}/operations/op_1` },
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const [res1, res2] = await Promise.all([first, second]);
    expect(res1?.status).toBe(202);
    expect(res2).toBeNull();
  });

  it("polls boundedly every 2s until complete, stops on 401, and stops after 10 minutes", async () => {
    vi.useFakeTimers();

    // Case 1: polls until runningOperationId becomes null
    let polls = 0;
    const onData = vi.fn();
    const fetchUntilDone = vi.fn(async () => {
      polls += 1;
      return new Response(
        JSON.stringify({
          data: makeBackupsDto({
            runningOperationId: polls < 2 ? "op_1" : null,
            backups: [makeBackupRow({ status: polls < 2 ? "running" : "succeeded" })],
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const stopDone = startBackupPolling({
      basePath,
      fetchImpl: fetchUntilDone as unknown as typeof fetch,
      onData,
      onUnauthorized: vi.fn(),
      onGiveUp: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(fetchUntilDone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(fetchUntilDone).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(fetchUntilDone).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenCalledTimes(2);
    stopDone();

    // Case 2: stops on 401
    const onUnauthorized = vi.fn();
    const fetch401 = vi.fn(async () => new Response("{}", { status: 401 }));
    const stop401 = startBackupPolling({
      basePath,
      fetchImpl: fetch401 as unknown as typeof fetch,
      onData: vi.fn(),
      onUnauthorized,
      onGiveUp: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onUnauthorized).toHaveBeenCalledWith(401);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(fetch401).toHaveBeenCalledTimes(1);
    stop401();

    // Case 3: stops at BACKUP_POLL_LIMIT_MS (10 min) with onGiveUp
    const onGiveUp = vi.fn();
    const fetchForever = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: makeBackupsDto({ runningOperationId: "op_slow" }) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const stopLimit = startBackupPolling({
      basePath,
      fetchImpl: fetchForever as unknown as typeof fetch,
      onData: vi.fn(),
      onUnauthorized: vi.fn(),
      onGiveUp,
    });

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_LIMIT_MS + BACKUP_POLL_INTERVAL_MS);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    stopLimit();
  });

  it("keeps the backup list visible after triggering Back up now with wrapped poll responses and ignores bodies without data", async () => {
    vi.useFakeTimers();

    const existingRow = makeBackupRow({ id: "bak_existing", kind: "nightly", status: "succeeded" });
    let state = makeBackupsDto({ backups: [existingRow] });
    const inFlightRef = { current: false };
    let pollStep = 0;

    const triggerFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { siteId: SITE_ID, backupId: "bak_now", operationId: "op_now_1" },
          links: { operation: `/v1/organizations/${ORG_ID}/operations/op_now_1` },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );

    const missingDataOutcome = await submitSiteBackup({
      basePath,
      csrfToken: "csrf-123",
      inFlightRef,
      messages: en,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ operationId: "unwrapped_should_not_pass" }), {
            status: 202,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-missing-data",
    });
    expect(missingDataOutcome).toEqual({ kind: "error", message: en.site.backups.loadFailed });

    const triggerOutcome = await submitSiteBackup({
      basePath,
      csrfToken: "csrf-123",
      inFlightRef,
      messages: en,
      fetchImpl: triggerFetch as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-wrapped-1",
    });
    expect(triggerOutcome).toEqual({ kind: "started", operationId: "op_now_1" });
    if (triggerOutcome.kind !== "started") throw new Error("expected started outcome");
    state = { ...state, runningOperationId: triggerOutcome.operationId };

    const pollFetch = vi.fn(async () => {
      pollStep += 1;
      if (pollStep === 1) {
        return new Response(
          JSON.stringify({
            data: makeBackupsDto({
              runningOperationId: "op_now_1",
              backups: [
                existingRow,
                makeBackupRow({ id: "bak_now", kind: "manual", status: "running", finishedAt: null, sizeBytes: null }),
              ],
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (pollStep === 2) {
        // Malformed wrapper missing `data` or containing an empty `{}` must be ignored as a failed read.
        return new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pollStep === 3) {
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          data: makeBackupsDto({
            runningOperationId: null,
            backups: [existingRow, makeBackupRow({ id: "bak_now", kind: "manual", status: "succeeded" })],
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const onData = vi.fn((dto: SiteBackupsDto) => {
      state = dto;
    });
    const stop = startBackupPolling({
      basePath,
      fetchImpl: pollFetch as unknown as typeof fetch,
      onData,
      onUnauthorized: vi.fn(),
      onGiveUp: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onData).toHaveBeenCalledTimes(1);
    const runningHtml = renderWithLocale("en", createElement(SiteBackups, { basePath, initial: state, csrfToken: "csrf" }));
    expect(runningHtml).not.toContain(en.site.backups.notAvailable);
    expect(runningHtml).toContain(en.site.backups.status.running);
    expect(runningHtml).toContain(en.site.backups.kind.nightly);

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onData).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onData).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onData).toHaveBeenCalledTimes(2);
    const doneHtml = renderWithLocale("en", createElement(SiteBackups, { basePath, initial: state, csrfToken: "csrf" }));
    expect(doneHtml).not.toContain(en.site.backups.notAvailable);
    expect(doneHtml).toContain(en.site.backups.kind.manual);

    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(pollFetch).toHaveBeenCalledTimes(4);
    stop();
  });
});

describe("SiteBackupsPage server component", () => {
  it("loads site backups with serverGet and 20s timeout", async () => {
    mockServerApi.serverGet.mockResolvedValueOnce({
      ok: true,
      data: makeBackupsDto({ backups: [makeBackupRow()] }),
    });

    const element = await SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) });
    const html = renderWithLocale("en", element);

    expect(mockServerApi.serverGet).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups`,
      { timeoutMs: 20_000 },
    );
    expect(html).toContain(en.site.backups.title);
    expect(html).toContain(en.site.backups.backupNow);
  });

  it("renders permission, suspension, service-unavailable errors and triggers notFound on 404", async () => {
    mockServerApi.serverGet.mockResolvedValueOnce({
      ok: false,
      outcome: "error",
      status: 403,
      code: "ORGANIZATION_SUSPENDED",
    });
    const suspendedHtml = renderWithLocale(
      "en",
      await SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) }),
    );
    expect(suspendedHtml).toContain(en.site.backups.errors.ORGANIZATION_SUSPENDED);

    mockServerApi.serverGet.mockResolvedValueOnce({
      ok: false,
      outcome: "error",
      status: 403,
      code: "PERMISSION_DENIED",
    });
    const deniedHtml = renderWithLocale(
      "en",
      await SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) }),
    );
    expect(deniedHtml).toContain(en.errors.PERMISSION_DENIED);

    mockServerApi.serverGet.mockResolvedValueOnce({
      ok: false,
      outcome: "error",
      status: 503,
      code: "HOST_AGENT_UNAVAILABLE",
    });
    const unavailableHtml = renderWithLocale(
      "en",
      await SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) }),
    );
    expect(unavailableHtml).toContain(en.site.backups.loadFailed);

    mockServerApi.serverGet.mockResolvedValueOnce({
      ok: false,
      outcome: "notFound",
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );

    mockCustomerData.getSite.mockResolvedValueOnce({
      ok: false,
      outcome: "notFound",
      status: 404,
      code: "NOT_FOUND",
    });
    await expect(SiteBackupsPage({ params: Promise.resolve({ siteId: SITE_ID }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});

describe("Backups catalog completeness and D17 banned words", () => {
  it("defines all 17 problem texts in both Italian and English", () => {
    for (const problem of BACKUP_PROBLEMS) {
      expect(en.site.backups.problem[problem]).toBeTruthy();
      expect(itCatalog.site.backups.problem[problem]).toBeTruthy();
    }
  });

  it("contains no banned infrastructure or storage terms in customer copy (en and it)", () => {
    const JARGON_PATTERN =
      /\b(container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim)\b|HCP-SPEC|AC-F|ADR-/i;
    const BACKUP_BANNED_PATTERN = /\b(restic|s3|snapshot|bucket|repository|repo)\b/i;

    const catalogs = [
      { lang: "en", data: en },
      { lang: "it", data: itCatalog },
    ] as const;

    const violations: string[] = [];
    for (const { lang, data } of catalogs) {
      const entries = [
        ...collectLeafStrings(data.site.backups, "site.backups"),
        { path: "site.tabs.backups", value: data.site.tabs.backups },
        { path: "site.delete.body", value: data.site.delete.body },
      ];
      for (const entry of entries) {
        if (JARGON_PATTERN.test(entry.value) || BACKUP_BANNED_PATTERN.test(entry.value)) {
          violations.push(`${lang}.${entry.path}: ${entry.value}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
