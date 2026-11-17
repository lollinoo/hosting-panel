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

import { format } from "@/i18n";
import { I18nProvider } from "@/i18n/provider";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { formatDate } from "@/lib/file-browser";
import { Dialog } from "@/components/ui/dialog";
import { GET as backupsGet, POST as backupsPost } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/route";
import { POST as restorePost } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/restore/route";
import {
  GET as backupDownloadGet,
  POST as backupDownloadPost,
} from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/download/route";
import SiteBackupsPage from "@/app/sites/[siteId]/backups/page";
import {
  RestoreBackupForm,
  canConfirmRestore,
} from "@/components/customer/restore-backup-dialog";
import {
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_POLL_LIMIT_MS,
  SiteBackups,
  applyArchivePreparing,
  applyRestoreStarted,
  backupErrorText,
  backupExpiry,
  backupGiveUpText,
  restoreBanner,
  siteBackupsBusy,
  startBackupPolling,
  submitPrepareDownload,
  submitRestoreBackup,
  submitSiteBackup,
  triggerPrepareDownload,
  triggerRestoreBackup,
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

function backupRouteContext(orgId = ORG_ID, siteId = SITE_ID, backupId = "bak_1") {
  return { params: Promise.resolve({ orgId, siteId, backupId }) };
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
    archive: null,
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
    lastRestore: null,
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

describe("Site backups restore & download BFF routes", () => {
  it("refuses invalid orgId, siteId, or backupId with 400 before session or upstream across all three handlers", async () => {
    const badIds = ["bad..id", "%2e%2e", "bad id", "a".repeat(129)];
    for (const badId of badIds) {
      const restoreRes = await restorePost(
        new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/${badId}/restore`, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: JSON.stringify({ confirmName: "Demo" }),
        }),
        backupRouteContext(ORG_ID, SITE_ID, badId),
      );
      expect(restoreRes.status).toBe(400);

      const prepRes = await backupDownloadPost(
        new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/${badId}/download`, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: "{}",
        }),
        backupRouteContext(ORG_ID, SITE_ID, badId),
      );
      expect(prepRes.status).toBe(400);

      const getRes = await backupDownloadGet(
        new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/${badId}/download`),
        backupRouteContext(ORG_ID, SITE_ID, badId),
      );
      expect(getRes.status).toBe(400);
    }

    expect(mockSession.getSessionFromRequest).not.toHaveBeenCalled();
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("enforces session 401, CSRF/Origin 403, and 413 body limit on both POST routes", async () => {
    for (const [handler, sub, validBody] of [
      [restorePost, "restore", JSON.stringify({ confirmName: "Demo" })],
      [backupDownloadPost, "download", "{}"],
    ] as const) {
      const url = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/${sub}`;

      mockSession.getSessionFromRequest.mockResolvedValueOnce(null);
      const unauth = await handler(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
          body: validBody,
        }),
        backupRouteContext(),
      );
      expect(unauth.status).toBe(401);

      const badCsrf = await handler(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": "wrong" },
          body: validBody,
        }),
        backupRouteContext(),
      );
      expect(badCsrf.status).toBe(403);

      const badOrigin = await handler(
        new Request(url, {
          method: "POST",
          headers: { origin: "https://evil.example", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: validBody,
        }),
        backupRouteContext(),
      );
      expect(badOrigin.status).toBe(403);

      const oversize = await handler(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: "x".repeat(1_048_577),
        }),
        backupRouteContext(),
      );
      expect(oversize.status).toBe(413);
    }
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("restore POST validates RestoreBackupInputSchema body, forwards upstream path/idempotency/20s timeout, and passes errors through", async () => {
    const url = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/restore`;

    for (const badBody of ["{}", JSON.stringify({ confirmName: "Demo", extra: 1 }), JSON.stringify({ confirmName: "a".repeat(256) }), "[]"]) {
      const badRes = await restorePost(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: badBody,
        }),
        backupRouteContext(),
      );
      expect(badRes.status).toBe(400);
    }
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();

    const accepted = { data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op_res_1" } };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 202,
      data: accepted,
    });
    const okRes = await restorePost(
      new Request(url, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
          "Idempotency-Key": "idem-restore-1",
        },
        body: JSON.stringify({ confirmName: "Demo" }),
      }),
      backupRouteContext(),
    );
    expect(okRes.status).toBe(202);
    expect(await okRes.json()).toEqual(accepted);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/restore`,
      expect.objectContaining({
        method: "POST",
        idempotencyKey: "idem-restore-1",
        body: { confirmName: "Demo" },
        timeoutMs: 20_000,
      }),
    );

    const quotaErr = {
      error: {
        code: "QUOTA_EXCEEDED",
        message: "too_many_requests",
        details: [{ field: "retryAt", reason: "too_many_requests", message: "2026-11-01T12:00:00.000Z" }],
      },
    };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: quotaErr,
    });
    const errRes = await restorePost(
      new Request(url, {
        method: "POST",
        headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
        body: JSON.stringify({ confirmName: "Demo" }),
      }),
      backupRouteContext(),
    );
    expect(errRes.status).toBe(409);
    expect(await errRes.json()).toEqual(quotaErr);
    expect(mockUpstream.fetchUpstream.mock.calls[1]?.[1]?.idempotencyKey).toBeTruthy();
  });

  it("download POST accepts empty or {} body, rejects other bodies, and forwards upstream call", async () => {
    const url = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`;

    for (const badBody of [JSON.stringify({ extra: 1 }), "[]", '"str"']) {
      const badRes = await backupDownloadPost(
        new Request(url, {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
          body: badBody,
        }),
        backupRouteContext(),
      );
      expect(badRes.status).toBe(400);
    }
    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();

    const accepted = { data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op_dl_1" } };
    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: true, status: 202, data: accepted });
    const resObj = await backupDownloadPost(
      new Request(url, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "x-csrf-token": ADMIN_SESSION.csrfToken,
          "Idempotency-Key": "idem-dl-1",
        },
        body: "{}",
      }),
      backupRouteContext(),
    );
    expect(resObj.status).toBe(202);
    expect(await resObj.json()).toEqual(accepted);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`,
      expect.objectContaining({
        method: "POST",
        idempotencyKey: "idem-dl-1",
        timeoutMs: 20_000,
      }),
    );

    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: true, status: 202, data: accepted });
    const resEmpty = await backupDownloadPost(
      new Request(url, {
        method: "POST",
        headers: { origin: "http://localhost:3000", "x-csrf-token": ADMIN_SESSION.csrfToken },
      }),
      backupRouteContext(),
    );
    expect(resEmpty.status).toBe(202);
  });

  it("download GET streams 3 chunks unchanged with 40s limit, pull-based, and sets archive headers", async () => {
    const c0 = new Uint8Array([80, 75, 3, 4]);
    const c1 = new Uint8Array([1, 2, 3]);
    const c2 = new Uint8Array([9, 8]);
    const total = c0.length + c1.length + c2.length;

    mockUpstream.fetchUpstream
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: {
            dataBase64: Buffer.from(c0).toString("base64"),
            size: total,
            eof: false,
            fileName: "demo-backup-2026-11-01-0200.zip",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: {
            dataBase64: Buffer.from(c1).toString("base64"),
            size: total,
            eof: false,
            fileName: "demo-backup-2026-11-01-0200.zip",
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: {
            dataBase64: Buffer.from(c2).toString("base64"),
            size: total,
            eof: true,
            fileName: "demo-backup-2026-11-01-0200.zip",
          },
        },
      });

    const res = await backupDownloadGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`),
      backupRouteContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="demo-backup-2026-11-01-0200.zip"; filename*=UTF-8''demo-backup-2026-11-01-0200.zip`,
    );
    expect(res.headers.get("Content-Length")).toBe(String(total));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("Cache-Control")).toBe("no-store, max-age=0");

    // Chunk 1 must not be fetched until the reader asks for it.
    await Promise.resolve();
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(1);

    const reader = res.body!.getReader();
    const r0 = await reader.read();
    expect(Array.from(r0.value!)).toEqual(Array.from(c0));
    await Promise.resolve();
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(1);

    const r1 = await reader.read();
    expect(Array.from(r1.value!)).toEqual(Array.from(c1));
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(2);

    const r2 = await reader.read();
    expect(Array.from(r2.value!)).toEqual(Array.from(c2));
    expect((await reader.read()).done).toBe(true);

    expect(mockUpstream.fetchUpstream).toHaveBeenNthCalledWith(
      1,
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download?offset=0&length=524288`,
      expect.objectContaining({ method: "GET", timeoutMs: 40_000 }),
    );
    expect(mockUpstream.fetchUpstream).toHaveBeenNthCalledWith(
      2,
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download?offset=4&length=524288`,
      expect.objectContaining({ method: "GET", timeoutMs: 40_000 }),
    );
    expect(mockUpstream.fetchUpstream).toHaveBeenNthCalledWith(
      3,
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download?offset=7&length=524288`,
      expect.objectContaining({ method: "GET", timeoutMs: 40_000 }),
    );
  });

  it("download GET falls back invalid fileName to backup.zip", async () => {
    const bytes = new Uint8Array([1, 2]);
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: {
          dataBase64: Buffer.from(bytes).toString("base64"),
          size: 2,
          eof: true,
          fileName: "../../etc/passwd",
        },
      },
    });

    const res = await backupDownloadGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`),
      backupRouteContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="backup.zip"; filename*=UTF-8''backup.zip`,
    );
  });

  it("download GET errors the stream on chunk 2 upstream error or size change and stops fetching on cancel", async () => {
    const c0 = Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64");

    // Chunk 2 404/502 error
    mockUpstream.fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: c0, size: 8, eof: false, fileName: "a.zip" } } })
      .mockResolvedValueOnce({ ok: false, status: 404, error: { error: { code: "NOT_FOUND", message: "archive_gone" } } });

    const errRes = await backupDownloadGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`),
      backupRouteContext(),
    );
    const reader1 = errRes.body!.getReader();
    await reader1.read();
    await expect(reader1.read()).rejects.toThrow();

    // Size change on chunk 2
    mockUpstream.fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: c0, size: 8, eof: false, fileName: "a.zip" } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: c0, size: 12, eof: true, fileName: "a.zip" } } });

    const sizeRes = await backupDownloadGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`),
      backupRouteContext(),
    );
    const reader2 = sizeRes.body!.getReader();
    await reader2.read();
    await expect(reader2.read()).rejects.toThrow();

    // Cancel stops subsequent fetching
    const fetchBefore = mockUpstream.fetchUpstream.mock.calls.length;
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { dataBase64: c0, size: 12, eof: false, fileName: "a.zip" } },
    });
    const cancelRes = await backupDownloadGet(
      new Request(`http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`),
      backupRouteContext(),
    );
    const reader3 = cancelRes.body!.getReader();
    await reader3.read();
    await reader3.cancel("stop");
    await Promise.resolve();
    expect(mockUpstream.fetchUpstream.mock.calls.length - fetchBefore).toBe(1);
  });

  it("download GET returns 303 with relative Location on errors before the first byte", async () => {
    const url = `https://evil.host.example/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/bak_1/download`;

    // No session -> 303 /login
    mockSession.getSessionFromRequest.mockResolvedValueOnce(null);
    const noSession = await backupDownloadGet(new Request(url), backupRouteContext());
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("Location")).toBe("/login");

    // Upstream 401 -> 303 /login
    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: false, status: 401, error: {} });
    const up401 = await backupDownloadGet(new Request(url), backupRouteContext());
    expect(up401.status).toBe(303);
    expect(up401.headers.get("Location")).toBe("/login");

    // Upstream 404 -> 303 /sites/<siteId>/backups?download=gone
    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: false, status: 404, error: {} });
    const up404 = await backupDownloadGet(new Request(url), backupRouteContext());
    expect(up404.status).toBe(303);
    expect(up404.headers.get("Location")).toBe(`/sites/${SITE_ID}/backups?download=gone`);

    // Upstream 500 -> 303 /sites/<siteId>/backups?download=failed
    mockUpstream.fetchUpstream.mockResolvedValueOnce({ ok: false, status: 500, error: {} });
    const up500 = await backupDownloadGet(new Request(url), backupRouteContext());
    expect(up500.status).toBe(303);
    expect(up500.headers.get("Location")).toBe(`/sites/${SITE_ID}/backups?download=failed`);
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
    expect(html).toMatch(/colspan="6"/i);
    expect(html).toContain(en.site.backups.columns.actions);
    expect(html.match(new RegExp(`>${en.site.backups.restore.button}<`, "g"))).toHaveLength(2);
    expect(html.match(new RegExp(`>${en.site.backups.download.prepare}<`, "g"))).toHaveLength(2);

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

  it("defines all copyProblem, restore, download, E12(c), and E15 checks in IT and EN", () => {
    for (const problem of BACKUP_PROBLEMS) {
      expect(en.site.backups.copyProblem[problem]).toBeTruthy();
      expect(itCatalog.site.backups.copyProblem[problem]).toBeTruthy();
    }

    for (const group of [en.site.backups.restore, en.site.backups.download]) {
      for (const value of Object.values(group)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }
    for (const group of [itCatalog.site.backups.restore, itCatalog.site.backups.download]) {
      for (const value of Object.values(group)) {
        expect(value.trim().length).toBeGreaterThan(0);
      }
    }

    expect(en.site.backups.problem.key_file_missing).toContain("missing or not valid");
    expect(en.site.backups.copyProblem.key_file_missing).toContain("missing or not valid");
    expect(itCatalog.site.backups.problem.key_file_missing).toContain("manca o non è valida");
    expect(itCatalog.site.backups.copyProblem.key_file_missing).toContain("manca o non è valida");
    expect(en.admin.backups.problem.key_file_missing).toContain("missing or not valid");
    expect(en.admin.backups.problem.key_file_missing).toContain("delete the file");
    expect(itCatalog.admin.backups.problem.key_file_missing).toContain("manca o non è valido");
    expect(itCatalog.admin.backups.problem.key_file_missing).toContain("elimina il file");

    const EXTRA_E15 = /\b(snapshot|schema|restic|docker|container|image|volume|network|revision)\b|files\/|databases\//i;
    for (const data of [en, itCatalog]) {
      for (const entry of collectLeafStrings(data.site.backups, "site.backups")) {
        expect(entry.value, entry.path).not.toMatch(EXTRA_E15);
      }
    }
  });
});

describe("SiteBackups restore and download (C1)", () => {
  const basePath = `/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups`;

  it("siteBackupsBusy reflects backups, running restore, and preparing archive", () => {
    expect(siteBackupsBusy(makeBackupsDto())).toBe(false);
    expect(siteBackupsBusy(makeBackupsDto({ runningOperationId: "op_1" }))).toBe(true);
    expect(siteBackupsBusy(makeBackupsDto({ backups: [makeBackupRow({ status: "running" })] }))).toBe(true);
    expect(
      siteBackupsBusy(
        makeBackupsDto({
          lastRestore: {
            backupId: "bak_1",
            backupStartedAt: "2026-11-01T02:00:00.000Z",
            status: "running",
            finishedAt: null,
            problem: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      siteBackupsBusy(
        makeBackupsDto({
          backups: [makeBackupRow({ archive: { status: "preparing", readyUntil: null, problem: null } })],
        }),
      ),
    ).toBe(true);
    expect(
      siteBackupsBusy(
        makeBackupsDto({
          lastRestore: {
            backupId: "bak_1",
            backupStartedAt: "2026-11-01T02:00:00.000Z",
            status: "failed",
            finishedAt: "2026-11-01T02:05:00.000Z",
            problem: "undo_incomplete",
          },
          backups: [makeBackupRow({ status: "succeeded" })],
        }),
      ),
    ).toBe(false);
  });

  it("shows Restore only on succeeded rows, hides when busy, and keeps it after undo_incomplete", () => {
    const rows = [
      makeBackupRow({ id: "bak_ok", status: "succeeded" }),
      makeBackupRow({ id: "bak_fail", status: "failed", problem: "other" }),
      makeBackupRow({ id: "bak_run", status: "running", finishedAt: null, sizeBytes: null }),
    ];

    const idleHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({ backups: [rows[0]!, rows[1]!] }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(idleHtml.match(new RegExp(`>${en.site.backups.restore.button}<`, "g"))).toHaveLength(1);
    expect(idleHtml.match(new RegExp(`>${en.site.backups.download.prepare}<`, "g"))).toHaveLength(1);

    for (const busyDto of [
      makeBackupsDto({ runningOperationId: "op_1", backups: [rows[0]!] }),
      makeBackupsDto({ backups: [rows[0]!, rows[2]!] }),
      makeBackupsDto({
        backups: [rows[0]!],
        lastRestore: {
          backupId: "bak_ok",
          backupStartedAt: "2026-11-01T02:00:00.000Z",
          status: "running",
          finishedAt: null,
          problem: null,
        },
      }),
      makeBackupsDto({
        backups: [
          rows[0]!,
          makeBackupRow({
            id: "bak_prep",
            status: "succeeded",
            archive: { status: "preparing", readyUntil: null, problem: null },
          }),
        ],
      }),
    ]) {
      const busyHtml = renderWithLocale(
        "en",
        createElement(SiteBackups, { basePath, initial: busyDto, csrfToken: "csrf", siteName: "Demo" }),
      );
      expect(busyHtml).not.toContain(`>${en.site.backups.restore.button}<`);
      expect(busyHtml).not.toContain(`>${en.site.backups.download.prepare}<`);
      expect(busyHtml).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${en.site.backups.backupNow}<`));
    }

    const undoHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [rows[0]!],
          lastRestore: {
            backupId: "bak_ok",
            backupStartedAt: "2026-11-01T02:00:00.000Z",
            status: "failed",
            finishedAt: "2026-11-01T02:05:00.000Z",
            problem: "undo_incomplete",
          },
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(undoHtml).toContain(`>${en.site.backups.restore.button}<`);
  });

  it("restore dialog renders date/time, 4 statements, no <form>, Cancel first, and disabled Confirm until exact name", () => {
    const backup = makeBackupRow({ startedAt: "2026-11-01T14:30:00.000Z" });
    for (const [locale, messages] of [
      ["en", en],
      ["it", itCatalog],
    ] as const) {
      const dateText = formatDate(backup.startedAt, locale);
      const html = renderWithLocale(
        locale,
        createElement(
          Dialog,
          { open: true },
          createElement(RestoreBackupForm, {
            backup,
            siteName: "Hotel Bella",
            onConfirm: async () => null,
            onCancel: () => {},
          }),
        ),
      );

      expect(html).toContain(format(messages.site.backups.restore.title, { date: dateText }));
      expect(html).toContain(format(messages.site.backups.restore.body, { date: dateText }));
      expect(html).toContain(messages.site.backups.restore.unavailable);
      expect(html).toContain(messages.site.backups.restore.lostDatabases);
      expect(html).toContain(messages.site.backups.restore.backupFirst);
      expect(html).toContain("<strong>Hotel Bella</strong>");
      expect(html).not.toMatch(/<form\b/i);
      const cancelIdx = html.indexOf(messages.site.backups.restore.cancel);
      const confirmIdx = html.indexOf(messages.site.backups.restore.confirm);
      expect(cancelIdx).toBeGreaterThan(-1);
      expect(confirmIdx).toBeGreaterThan(cancelIdx);
      expect(html).toMatch(
        new RegExp(`<button[^>]*type="button"[^>]*disabled[^>]*>${messages.site.backups.restore.confirm}<`),
      );
    }

    expect(canConfirmRestore("", "Hotel Bella")).toBe(false);
    expect(canConfirmRestore("Hotel", "Hotel Bella")).toBe(false);
    expect(canConfirmRestore("hotel bella", "Hotel Bella")).toBe(false);
    expect(canConfirmRestore("Hotel Bella ", "Hotel Bella")).toBe(false);
    expect(canConfirmRestore("", "")).toBe(false);
    expect(canConfirmRestore("Hotel Bella", "Hotel Bella")).toBe(true);
  });

  it("restore triggers one POST with confirmName/CSRF/Idempotency-Key and guards double-click", async () => {
    let resolveFetch: (v: Response) => void = () => {};
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const inFlightRef = { current: false };

    const p1 = triggerRestoreBackup({
      basePath,
      backupId: "bak_1",
      confirmName: "Demo",
      csrfToken: "csrf-1",
      inFlightRef,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-res-1",
    });
    const p2 = triggerRestoreBackup({
      basePath,
      backupId: "bak_1",
      confirmName: "Demo",
      csrfToken: "csrf-1",
      inFlightRef,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-res-2",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`${basePath}/bak_1/restore`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ confirmName: "Demo" }));
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-1");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-res-1");

    resolveFetch(
      new Response(JSON.stringify({ data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op_res" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1?.status).toBe(202);
    expect(r2).toBeNull();
  });

  it("after 202 restore sets lastRestore running, polls until idle, and renders all outcomes including reload", async () => {
    vi.useFakeTimers();
    const row = makeBackupRow({ id: "bak_1", startedAt: "2026-11-01T02:00:00.000Z" });
    const fetch202 = vi.fn(async () =>
      new Response(JSON.stringify({ data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op_res" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );

    const outcome = await submitRestoreBackup({
      basePath,
      backupId: "bak_1",
      confirmName: "Demo",
      csrfToken: "csrf",
      inFlightRef: { current: false },
      messages: en,
      fetchImpl: fetch202 as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: "started", operationId: "op_res" });

    let state = applyRestoreStarted(makeBackupsDto({ backups: [row] }), row);
    expect(siteBackupsBusy(state)).toBe(true);
    const runningHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, { basePath, initial: state, csrfToken: "csrf", siteName: "Demo" }),
    );
    expect(runningHtml).toContain(
      format(en.site.backups.restore.running, { date: formatDate(row.startedAt, "en") }),
    );

    // Polling keeps running for lastRestore.status === "running" and stops once settled
    const pollFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: state }), { status: 200, headers: { "content-type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: makeBackupsDto({
              backups: [row],
              lastRestore: {
                backupId: "bak_1",
                backupStartedAt: row.startedAt,
                status: "succeeded",
                finishedAt: "2026-11-01T02:10:00.000Z",
                problem: null,
              },
            }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const stop = startBackupPolling({
      basePath,
      fetchImpl: pollFetch as unknown as typeof fetch,
      onData: (dto) => {
        state = dto;
      },
      onUnauthorized: vi.fn(),
      onGiveUp: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(pollFetch).toHaveBeenCalledTimes(1);
    expect(siteBackupsBusy(state)).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(pollFetch).toHaveBeenCalledTimes(2);
    expect(siteBackupsBusy(state)).toBe(false);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(pollFetch).toHaveBeenCalledTimes(2);
    stop();

    // All 4 terminal lastRestore states on initial render (simulating reload)
    const dateText = formatDate(row.startedAt, "en");
    const okHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, { basePath, initial: state, csrfToken: "csrf", siteName: "Demo" }),
    );
    expect(okHtml).toContain(format(en.site.backups.restore.done, { date: dateText }));

    const addrHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [row],
          lastRestore: {
            backupId: "bak_1",
            backupStartedAt: row.startedAt,
            status: "succeeded",
            finishedAt: "2026-11-01T02:10:00.000Z",
            problem: "address_not_updated",
          },
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(addrHtml).toContain(format(en.site.backups.restore.doneAddressNotSet, { date: dateText }));

    // undo_incomplete must NEVER include restore.failed ("your site is exactly as it was")
    const undoHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [row],
          lastRestore: {
            backupId: "bak_1",
            backupStartedAt: row.startedAt,
            status: "failed",
            finishedAt: "2026-11-01T02:10:00.000Z",
            problem: "undo_incomplete",
          },
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(undoHtml).toContain(en.site.backups.copyProblem.undo_incomplete);
    expect(undoHtml).not.toContain(en.site.backups.restore.failed);

    const switchUndoneBanner = restoreBanner(
      en,
      {
        backupId: "bak_1",
        backupStartedAt: row.startedAt,
        status: "failed",
        finishedAt: "2026-11-01T02:10:00.000Z",
        problem: "switch_undone",
      },
      "en",
    );
    expect(switchUndoneBanner?.text).toBe(
      `${en.site.backups.restore.failed} ${en.site.backups.copyProblem.switch_undone}`,
    );
  });

  it("maps confirmName 400, QUOTA_EXCEEDED 409, Retry-After fallback, uncertainAction 502/504, and notReady", () => {
    expect(
      backupErrorText(en, 400, {
        error: { code: "VALIDATION_ERROR", message: "confirmName", details: [{ field: "confirmName", reason: "mismatch", message: "Wrong name" }] },
      }, { action: "restore" }),
    ).toEqual({ kind: "error", message: en.site.backups.restore.wrongName });

    const retryAt = "2026-11-01T12:45:00.000Z";
    const expectedTime = formatDate(retryAt, en.common.dateLocale);
    for (const action of ["backup", "restore", "download"] as const) {
      expect(
        backupErrorText(
          en,
          409,
          {
            error: {
              code: "QUOTA_EXCEEDED",
              message: "too_many_requests",
              details: [{ field: "retryAt", reason: "too_many_requests", message: retryAt }],
            },
          },
          { action },
        ),
      ).toEqual({ kind: "error", message: format(en.site.backups.errors.tooMany, { time: expectedTime }) });
    }

    // Retry-After fallback when retryAt detail is omitted
    const now = new Date("2026-11-01T12:00:00.000Z");
    const expectedFallbackTime = formatDate("2026-11-01T12:30:00.000Z", itCatalog.common.dateLocale);
    expect(
      backupErrorText(
        itCatalog,
        409,
        { error: { code: "QUOTA_EXCEEDED", message: "too_many_requests" } },
        { action: "restore", retryAfter: "1800", now },
      ),
    ).toEqual({
      kind: "error",
      message: format(itCatalog.site.backups.errors.tooMany, { time: expectedFallbackTime }),
    });

    expect(backupErrorText(en, 502, null, { action: "restore" })).toEqual({
      kind: "error",
      message: en.site.backups.errors.uncertainAction,
    });
    expect(backupErrorText(en, 504, null, { action: "download" })).toEqual({
      kind: "error",
      message: en.site.backups.errors.uncertainAction,
    });
    expect(backupErrorText(en, 502, null, { action: "backup" })).toEqual({
      kind: "error",
      message: en.site.backups.errors.uncertain,
    });

    expect(
      backupErrorText(en, 409, {
        error: { code: "RESOURCE_LOCKED", message: "not_ready", details: [{ reason: "not_ready", message: "not_ready" }] },
      }, { action: "restore" }),
    ).toEqual({ kind: "error", message: en.site.backups.errors.notReady });
  });

  it("covers all download archive states, plain link, expired client clock, onlyOne hint, and Prepare POST", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ data: { siteId: SITE_ID, backupId: "bak_null", operationId: "op_dl" } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const prepOutcome = await submitPrepareDownload({
      basePath,
      backupId: "bak_null",
      csrfToken: "csrf-dl",
      inFlightRef: { current: false },
      messages: en,
      fetchImpl: fetchSpy as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-dl-ui",
    });
    expect(prepOutcome).toEqual({ kind: "started", operationId: "op_dl" });
    const [prepUrl, prepInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(prepUrl).toBe(`${basePath}/bak_null/download`);
    expect(prepInit.method).toBe("POST");
    expect(prepInit.body).toBe("{}");
    expect((prepInit.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-dl");
    expect((prepInit.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-dl-ui");

    const preparingState = applyArchivePreparing(
      makeBackupsDto({
        backups: [
          makeBackupRow({ id: "bak_1", archive: { status: "ready", readyUntil: "2099-01-01T00:00:00.000Z", problem: null } }),
          makeBackupRow({ id: "bak_2", archive: null }),
        ],
      }),
      "bak_2",
    );
    expect(preparingState.backups[0]?.archive).toBeNull();
    expect(preparingState.backups[1]?.archive).toEqual({ status: "preparing", readyUntil: null, problem: null });

    // Preparing hides all buttons on other rows
    const prepHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, { basePath, initial: preparingState, csrfToken: "csrf", siteName: "Demo" }),
    );
    expect(prepHtml).toContain(en.site.backups.download.preparing);
    expect(prepHtml).not.toContain(`>${en.site.backups.download.prepare}<`);
    expect(prepHtml).not.toContain(`>${en.site.backups.restore.button}<`);

    // Ready + another row with Prepare shows plain <a download>, readyUntil, warning, and one onlyOne hint linked via aria-describedby
    const readyUntil = new Date(Date.now() + DAY_MS).toISOString();
    const readyHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [
            makeBackupRow({ id: "bak_ready", archive: { status: "ready", readyUntil, problem: null } }),
            makeBackupRow({ id: "bak_other", archive: null }),
          ],
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(readyHtml).toContain(`href="${basePath}/bak_ready/download"`);
    expect(readyHtml).toMatch(/<a[^>]*download[^>]*>Download<\/a>/);
    expect(readyHtml).toContain(format(en.site.backups.download.readyUntil, { time: formatDate(readyUntil, "en") }));
    expect(readyHtml).toContain(en.site.backups.download.warning);
    const onlyOneMatches = readyHtml.match(new RegExp(en.site.backups.download.onlyOne, "g"));
    expect(onlyOneMatches).toHaveLength(1);
    const idMatch = readyHtml.match(/<p id="([^"]+)"[^>]*>Only one download is kept per site/);
    expect(idMatch?.[1]).toBeTruthy();
    expect(readyHtml).toContain(`aria-describedby="${idMatch?.[1]}"`);

    // Ready but expired on client clock -> gone + Prepare (no <a download>)
    const expiredHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [
            makeBackupRow({
              id: "bak_expired",
              archive: { status: "ready", readyUntil: "2020-01-01T00:00:00.000Z", problem: null },
            }),
          ],
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(expiredHtml).toContain(en.site.backups.download.gone);
    expect(expiredHtml).toContain(`>${en.site.backups.download.prepare}<`);
    expect(expiredHtml).not.toContain(`href="${basePath}/bak_expired/download"`);

    // Failed archive -> download.failed + copyProblem + Prepare
    const failedHtml = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath,
        initial: makeBackupsDto({
          backups: [
            makeBackupRow({
              id: "bak_dl_fail",
              archive: { status: "failed", readyUntil: null, problem: "no_space" },
            }),
          ],
        }),
        csrfToken: "csrf",
        siteName: "Demo",
      }),
    );
    expect(failedHtml).toContain(en.site.backups.download.failed);
    expect(failedHtml).toContain(en.site.backups.copyProblem.no_space);
    expect(failedHtml).toContain(`>${en.site.backups.download.prepare}<`);

    // Double-click guard on triggerPrepareDownload
    let resolveDl: (v: Response) => void = () => {};
    const dlSpy = vi.fn(() => new Promise<Response>((r) => { resolveDl = r; }));
    const ref = { current: false };
    const dl1 = triggerPrepareDownload({ basePath, backupId: "bak_1", csrfToken: "c", inFlightRef: ref, fetchImpl: dlSpy as unknown as typeof fetch });
    const dl2 = triggerPrepareDownload({ basePath, backupId: "bak_1", csrfToken: "c", inFlightRef: ref, fetchImpl: dlSpy as unknown as typeof fetch });
    expect(dlSpy).toHaveBeenCalledTimes(1);
    resolveDl(new Response(JSON.stringify({ data: { siteId: SITE_ID, backupId: "bak_1", operationId: "op" } }), { status: 202 }));
    expect(await dl2).toBeNull();
    expect((await dl1)?.status).toBe(202);
  });

  it("renders ?download=gone and ?download=failed alerts on SiteBackupsPage and uses stillWorking on non-backup give-up", async () => {
    mockServerApi.serverGet.mockResolvedValue({
      ok: true,
      data: makeBackupsDto({ backups: [makeBackupRow()] }),
    });

    const goneEl = await SiteBackupsPage({
      params: Promise.resolve({ siteId: SITE_ID }),
      searchParams: Promise.resolve({ download: "gone" }),
    });
    expect(renderWithLocale("en", goneEl)).toContain(en.site.backups.download.gone);

    const failedEl = await SiteBackupsPage({
      params: Promise.resolve({ siteId: SITE_ID }),
      searchParams: Promise.resolve({ download: "failed" }),
    });
    expect(renderWithLocale("en", failedEl)).toContain(en.site.backups.download.fetchFailed);

    const restoreOnlyDto = makeBackupsDto({
      runningOperationId: null,
      lastRestore: {
        backupId: "bak_1",
        backupStartedAt: "2026-11-01T02:00:00.000Z",
        status: "running",
        finishedAt: null,
        problem: null,
      },
    });
    expect(backupGiveUpText(en, restoreOnlyDto)).toBe(en.site.backups.errors.stillWorking);
    expect(backupGiveUpText(itCatalog, restoreOnlyDto)).toBe(itCatalog.site.backups.errors.stillWorking);
    expect(backupGiveUpText(en, makeBackupsDto({ runningOperationId: "op_bak" }))).toBe(en.site.backups.errors.stillRunning);
  });
});
