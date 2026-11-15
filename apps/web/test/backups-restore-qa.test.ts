import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
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
  getServerSession: vi.fn(),
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
  getServerSession: mockSession.getServerSession,
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

import { POST as restorePost } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/restore/route";
import {
  GET as downloadGet,
  POST as downloadPost,
} from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/backups/[backupId]/download/route";
import { Dialog } from "@/components/ui/dialog";
import { RestoreBackupForm } from "@/components/customer/restore-backup-dialog";
import {
  BACKUP_POLL_INTERVAL_MS,
  BACKUP_POLL_LIMIT_MS,
  SiteBackups,
  backupErrorText,
  backupGiveUpText,
  restoreBanner,
  startBackupPolling,
  submitPrepareDownload,
  submitRestoreBackup,
  triggerPrepareDownload,
  triggerRestoreBackup,
} from "@/components/customer/site-backups";
import { en } from "@/i18n/en";
import { it as itCatalog } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";
import { FILE_CHUNK_BYTES, MAX_BFF_BODY_BYTES } from "@/lib/bff-files";

const ORG_ID = "org_qa_restore_1";
const SITE_ID = "site_qa_restore_1";
const BACKUP_ID = "bkp_0123456789abcdef0123456789abcdef";
const CSRF = "csrf-qa-restore-token";
const BASE_BFF = `http://localhost:3000/api/bff/orgs/${ORG_ID}/managed-sites/${SITE_ID}/backups/${BACKUP_ID}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

// Builds a NextRequest with default same-origin and CSRF headers unless overridden.
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

// Builds Next.js route handler context params for a backup route.
function backupCtx(orgId = ORG_ID, siteId = SITE_ID, backupId = BACKUP_ID) {
  return { params: Promise.resolve({ orgId, siteId, backupId }) };
}

// Collects all string leaves with their dotted paths under an object.
function collectLeaves(
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
      collectLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

// Collects all recursive dotted leaf paths for key-parity comparison.
function collectKeyPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (node && typeof node === "object") {
    return Object.entries(node)
      .flatMap(([k, v]) => collectKeyPaths(v, prefix ? `${prefix}.${k}` : k))
      .sort();
  }
  return [];
}

// Renders a React element wrapped in I18nProvider to decoded static HTML.
function renderWithLocale(locale: "en" | "it", element: ReactElement): string {
  const messages = locale === "it" ? itCatalog : en;
  const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages, children: element }));
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

describe("backups restore & download web QA (BFF guards, Location, streaming, leaks, copy, UI)", () => {
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

  it("refuses hostile backupId and siteId values, bad origin/CSRF, oversized bodies, and non-JSON before calling upstream", async () => {
    const hostileValues = ["..", "%2e%2e", "x".repeat(129), "bad id", "a/b"];

    for (const hostile of hostileValues) {
      for (const ctx of [
        backupCtx(ORG_ID, SITE_ID, hostile),
        backupCtx(ORG_ID, hostile, BACKUP_ID),
      ]) {
        const resRestore = await restorePost(
          makeRequest(`${BASE_BFF}/restore`, "POST", { body: JSON.stringify({ confirmName: "Site" }) }),
          ctx,
        );
        expect(resRestore.status, `POST restore ${hostile}`).toBe(400);

        const resPrep = await downloadPost(
          makeRequest(`${BASE_BFF}/download`, "POST", { body: "{}" }),
          ctx,
        );
        expect(resPrep.status, `POST download ${hostile}`).toBe(400);

        const resGet = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), ctx);
        expect(resGet.status, `GET download ${hostile}`).toBe(400);
      }
    }

    // Foreign Origin and missing/invalid CSRF refused on both POSTs
    for (const [handler, url, validBody] of [
      [restorePost, `${BASE_BFF}/restore`, JSON.stringify({ confirmName: "Site" })],
      [downloadPost, `${BASE_BFF}/download`, "{}"],
    ] as const) {
      const foreignOrigin = await handler(
        makeRequest(url, "POST", { body: validBody, origin: "https://evil.example" }),
        backupCtx(),
      );
      expect(foreignOrigin.status).toBe(403);

      const noCsrf = await handler(
        makeRequest(url, "POST", { body: validBody, csrf: null }),
        backupCtx(),
      );
      expect(noCsrf.status).toBe(403);

      const wrongCsrf = await handler(
        makeRequest(url, "POST", { body: validBody, csrf: "wrong-csrf" }),
        backupCtx(),
      );
      expect(wrongCsrf.status).toBe(403);
    }

    // Oversized body (>1 MiB) and non-JSON / invalid schema refused on both POSTs
    const oversizedPayload = JSON.stringify({ confirmName: "x".repeat(MAX_BFF_BODY_BYTES + 64) });
    for (const [handler, url] of [
      [restorePost, `${BASE_BFF}/restore`],
      [downloadPost, `${BASE_BFF}/download`],
    ] as const) {
      const headerTooBig = await handler(
        makeRequest(url, "POST", {
          body: "{}",
          headers: { "Content-Length": String(MAX_BFF_BODY_BYTES + 1) },
        }),
        backupCtx(),
      );
      expect(headerTooBig.status).toBe(413);

      const bodyTooBig = await handler(
        makeRequest(url, "POST", { body: oversizedPayload }),
        backupCtx(),
      );
      expect(bodyTooBig.status).toBe(413);

      const badJson = await handler(
        makeRequest(url, "POST", { body: "{not-json" }),
        backupCtx(),
      );
      expect(badJson.status).toBe(400);
    }

    // Schema refusals: restore rejects {}, download POST rejects non-empty object
    const emptyRestore = await restorePost(
      makeRequest(`${BASE_BFF}/restore`, "POST", { body: "{}" }),
      backupCtx(),
    );
    expect(emptyRestore.status).toBe(400);

    const extraDownload = await downloadPost(
      makeRequest(`${BASE_BFF}/download`, "POST", { body: JSON.stringify({ extra: 1 }) }),
      backupCtx(),
    );
    expect(extraDownload.status).toBe(400);

    expect(mockUpstream.fetchUpstream).not.toHaveBeenCalled();
  });

  it("passes upstream 404 through on POSTs and turns pre-first-byte GET errors into relative 303 redirects built only from siteId", async () => {
    const upstream404 = {
      ok: false as const,
      status: 404,
      error: { error: { code: "NOT_FOUND", message: "Backup not found", requestId: "req_1" } },
    };
    mockUpstream.fetchUpstream.mockResolvedValue(upstream404);

    const rPostRestore = await restorePost(
      makeRequest(`${BASE_BFF}/restore`, "POST", {
        body: JSON.stringify({ confirmName: "Site" }),
      }),
      backupCtx(),
    );
    expect(rPostRestore.status).toBe(404);
    expect(((await rPostRestore.json()) as Json).error.code).toBe("NOT_FOUND");

    const rPostDownload = await downloadPost(
      makeRequest(`${BASE_BFF}/download`, "POST", { body: "{}" }),
      backupCtx(),
    );
    expect(rPostDownload.status).toBe(404);
    expect(((await rPostDownload.json()) as Json).error.code).toBe("NOT_FOUND");

    // GET 401 -> 303 /login with empty body, unaffected by foreign Host / X-Forwarded-Host / upstream Location
    mockUpstream.fetchUpstream.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ Location: "https://evil.example/steal" }),
      error: {
        error: { code: "UNAUTHENTICATED", message: "https://evil.example/", requestId: "req_2" },
      },
    });
    const rGet401 = await downloadGet(
      makeRequest(`${BASE_BFF}/download`, "GET", {
        headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example" },
      }),
      backupCtx(),
    );
    expect(rGet401.status).toBe(303);
    expect(rGet401.headers.get("Location")).toBe("/login");
    expect(await rGet401.text()).toBe("");

    // GET 404 -> 303 /sites/<siteId>/backups?download=gone with empty body
    mockUpstream.fetchUpstream.mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers({ Location: "https://evil.example/phish" }),
      error: {
        error: {
          code: "NOT_FOUND",
          message: "https://evil.example/",
          requestId: "req_3",
          details: [{ reason: "archive_gone", message: "https://evil.example/" }],
        },
      },
    });
    const rGet404 = await downloadGet(
      makeRequest(`${BASE_BFF}/download`, "GET", {
        headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example" },
      }),
      backupCtx(),
    );
    expect(rGet404.status).toBe(303);
    expect(rGet404.headers.get("Location")).toBe(`/sites/${SITE_ID}/backups?download=gone`);
    expect(await rGet404.text()).toBe("");

    // GET 500 / 409 / throw -> 303 /sites/<siteId>/backups?download=failed with empty body
    for (const failMock of [
      () =>
        mockUpstream.fetchUpstream.mockResolvedValueOnce({
          ok: false,
          status: 500,
          headers: new Headers({ Location: "https://evil.example/" }),
          error: { error: { code: "INTERNAL_ERROR", message: "https://evil.example/", requestId: "req_4" } },
        }),
      () =>
        mockUpstream.fetchUpstream.mockResolvedValueOnce({
          ok: false,
          status: 409,
          error: { error: { code: "RESOURCE_LOCKED", message: "archive_preparing", requestId: "req_5" } },
        }),
      () => mockUpstream.fetchUpstream.mockRejectedValueOnce(new Error("connect ECONNREFUSED")),
    ]) {
      failMock();
      const res = await downloadGet(
        makeRequest(`${BASE_BFF}/download`, "GET", {
          headers: { Host: "evil.example", "X-Forwarded-Host": "evil.example" },
        }),
        backupCtx(),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe(`/sites/${SITE_ID}/backups?download=failed`);
      expect(await res.text()).toBe("");
    }
  });

  it("streams GET without buffering, enforces 524288/40s per chunk, errors on mid-stream faults, and sanitizes fileName", async () => {
    const chunk0Bytes = Buffer.alloc(FILE_CHUNK_BYTES, 0x41);
    const totalSize = FILE_CHUNK_BYTES * 2;

    // 1. Headers & chunk 0 resolve immediately even when chunk 1 never resolves
    mockUpstream.fetchUpstream.mockImplementation(async (path: string) => {
      if (path.includes("offset=0")) {
        return {
          ok: true,
          status: 200,
          data: {
            data: {
              dataBase64: chunk0Bytes.toString("base64"),
              size: totalSize,
              eof: false,
              fileName: "site-backup-2026-11-15-0300.zip",
            },
          },
        };
      }
      return new Promise(() => {});
    });

    const streamRes = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), backupCtx());
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("Content-Type")).toBe("application/zip");
    expect(streamRes.headers.get("Content-Length")).toBe(String(totalSize));
    expect(streamRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(streamRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(streamRes.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(1);
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledWith(
      `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/${BACKUP_ID}/download?offset=0&length=524288`,
      expect.objectContaining({ method: "GET", timeoutMs: 40_000 }),
    );

    const reader = streamRes.body!.getReader();
    const firstRead = await reader.read();
    expect(firstRead.done).toBe(false);
    expect(firstRead.value?.byteLength).toBe(FILE_CHUNK_BYTES);
    // Chunk 1 has STILL not been requested until reader pulls again
    expect(mockUpstream.fetchUpstream).toHaveBeenCalledTimes(1);
    await reader.cancel();

    // 2. Every mid-stream fault errors the stream instead of closing cleanly
    const chunk2Faults: Array<{ label: string; chunk1: unknown }> = [
      {
        label: "upstream 502 error",
        chunk1: { ok: false, status: 502, error: { error: { code: "INTERNAL_ERROR", message: "boom" } } },
      },
      {
        label: "size changed mid-stream",
        chunk1: {
          ok: true,
          status: 200,
          data: {
            data: {
              dataBase64: Buffer.from("abc").toString("base64"),
              size: totalSize + 100,
              eof: true,
            },
          },
        },
      },
      {
        label: "empty non-EOF chunk",
        chunk1: {
          ok: true,
          status: 200,
          data: { data: { dataBase64: "", size: totalSize, eof: false } },
        },
      },
      {
        label: "early EOF before expected size",
        chunk1: {
          ok: true,
          status: 200,
          data: { data: { dataBase64: Buffer.from("short").toString("base64"), size: totalSize, eof: true } },
        },
      },
    ];

    for (const fault of chunk2Faults) {
      mockUpstream.fetchUpstream.mockReset();
      mockUpstream.fetchUpstream
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: {
            data: {
              dataBase64: chunk0Bytes.toString("base64"),
              size: totalSize,
              eof: false,
              fileName: "ok.zip",
            },
          },
        })
        .mockResolvedValueOnce(fault.chunk1);

      const res = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), backupCtx());
      expect(res.status, fault.label).toBe(200);
      const r = res.body!.getReader();
      const first = await r.read();
      expect(first.done, fault.label).toBe(false);
      await expect(
        (async () => {
          while (true) {
            const next = await r.read();
            if (next.done) {
              return "CLEAN_EOF";
            }
          }
        })(),
        fault.label,
      ).rejects.toThrow();
      expect(mockUpstream.fetchUpstream).toHaveBeenNthCalledWith(
        2,
        `v1/organizations/${ORG_ID}/managed-sites/${SITE_ID}/backups/${BACKUP_ID}/download?offset=${FILE_CHUNK_BYTES}&length=524288`,
        expect.objectContaining({ timeoutMs: 40_000 }),
      );
    }

    // 3. Invalid upstream fileNames fall back to backup.zip and never split headers
    for (const badName of ["../x.zip", 'bad"quote.zip', "bad\r\nX-Evil: 1.zip", "bad\nname.zip"]) {
      mockUpstream.fetchUpstream.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: {
            dataBase64: Buffer.from("zip").toString("base64"),
            size: 3,
            eof: true,
            fileName: badName,
          },
        },
      });
      const res = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), backupCtx());
      expect(res.status).toBe(200);
      const disp = res.headers.get("Content-Disposition") ?? "";
      expect(disp).toBe('attachment; filename="backup.zip"; filename*=UTF-8\'\'backup.zip');
      expect(disp).not.toMatch(/[\r\n]/);
    }
  });

  it("documents exact passthrough vs stripping behavior when upstream emits secretAccessKey or a host path", async () => {
    const leakedSecret = "LEAKED-S3-SECRET-123";
    const leakedPath = "/var/lib/hosting-panel/backups/op_123.zip";

    // POST restore & POST download: bffJsonResponse redacts forbidden DTO keys (hostPath -> [REDACTED])
    // but forwards other extra upstream JSON fields such as secretAccessKey verbatim.
    mockUpstream.fetchUpstream.mockResolvedValue({
      ok: true,
      status: 202,
      data: {
        data: { siteId: SITE_ID, backupId: BACKUP_ID, operationId: "op_1" },
        secretAccessKey: leakedSecret,
        hostPath: leakedPath,
      },
    });
    const postRestoreRes = await restorePost(
      makeRequest(`${BASE_BFF}/restore`, "POST", { body: JSON.stringify({ confirmName: "Site" }) }),
      backupCtx(),
    );
    const postRestoreText = await postRestoreRes.text();
    expect(postRestoreText).toContain(leakedSecret);
    expect(postRestoreText).not.toContain(leakedPath);
    expect(postRestoreText).toContain('"[REDACTED]"');

    const postDlRes = await downloadPost(
      makeRequest(`${BASE_BFF}/download`, "POST", { body: "{}" }),
      backupCtx(),
    );
    const postDlText = await postDlRes.text();
    expect(postDlText).toContain(leakedSecret);
    expect(postDlText).not.toContain(leakedPath);
    expect(postDlText).toContain('"[REDACTED]"');

    // GET download 200: only streams decoded dataBase64 bytes and validated fileName -> strips extra JSON fields & path filenames
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        data: {
          dataBase64: Buffer.from("PKZIP").toString("base64"),
          size: 5,
          eof: true,
          fileName: leakedPath,
          secretAccessKey: leakedSecret,
        },
        secretAccessKey: leakedSecret,
        hostPath: leakedPath,
      },
    });
    const getOkRes = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), backupCtx());
    expect(getOkRes.status).toBe(200);
    expect(getOkRes.headers.get("Content-Disposition")).toContain("backup.zip");
    expect(getOkRes.headers.get("Content-Disposition")).not.toContain(leakedPath);
    const getOkBody = await getOkRes.text();
    expect(getOkBody).toBe("PKZIP");
    expect(getOkBody).not.toContain(leakedSecret);
    expect(getOkBody).not.toContain(leakedPath);

    // GET download error (!ok): returns 303 with empty body and siteId-only Location -> strips all upstream secret/path data
    mockUpstream.fetchUpstream.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: {
        error: {
          code: "INTERNAL_ERROR",
          message: `${leakedSecret} ${leakedPath}`,
          requestId: "req_leak",
        },
      },
    });
    const getErrRes = await downloadGet(makeRequest(`${BASE_BFF}/download`, "GET"), backupCtx());
    expect(getErrRes.status).toBe(303);
    expect(getErrRes.headers.get("Location")).toBe(`/sites/${SITE_ID}/backups?download=failed`);
    expect(await getErrRes.text()).toBe("");
  });

  it("enforces E15 wording, IT/EN key parity, next-step advice on all 22 problems, and E12(c) key_file_missing texts", () => {
    const forbiddenE15 =
      /snapshot|schema|restic|docker|container|image|volume|network|revision|files\/|databases\//i;
    const enNext = /check|fix|use|put|free|try|give|create|reload|save|enter|set up|contact|make|restore|wait/i;
    const itNext =
      /controlla|correggi|usa|rimetti|libera|riprova|dai|crea|ricarica|salva|inserisci|configura|contatta|fanne|ripristina|attendi|ripeti/i;

    // 1. E15 forbidden words absent across all of site.backups in both languages
    for (const [localeName, catalog] of [
      ["en", en],
      ["it", itCatalog],
    ] as const) {
      const leaves = collectLeaves(catalog.site.backups, "site.backups");
      for (const leaf of leaves) {
        expect(leaf.value, `${localeName} ${leaf.path}`).not.toMatch(forbiddenE15);
        expect(leaf.value.trim().length, `${localeName} ${leaf.path}`).toBeGreaterThan(0);
        expect(leaf.value, `${localeName} ${leaf.path}`).not.toBe(leaf.key);
      }
    }

    // 2. Key parity between EN and IT for site.backups (including copyProblem, restore, download)
    expect(collectKeyPaths(en.site.backups)).toEqual(collectKeyPaths(itCatalog.site.backups));
    for (const section of ["copyProblem", "restore", "download"] as const) {
      expect(Object.keys(en.site.backups[section]).sort()).toEqual(
        Object.keys(itCatalog.site.backups[section]).sort(),
      );
      expect(Object.keys(en.site.backups[section]).length).toBeGreaterThan(0);
    }

    // 3. All 22 BACKUP_PROBLEMS exist in site.backups.problem, site.backups.copyProblem, and admin.backups.problem with next steps
    expect(BACKUP_PROBLEMS).toHaveLength(22);
    for (const problem of BACKUP_PROBLEMS) {
      for (const [localeName, catalog, re] of [
        ["en", en, enNext],
        ["it", itCatalog, itNext],
      ] as const) {
        for (const [groupName, map] of [
          ["site.backups.problem", catalog.site.backups.problem],
          ["site.backups.copyProblem", catalog.site.backups.copyProblem],
          ["admin.backups.problem", catalog.admin.backups.problem],
        ] as const) {
          const text = map[problem];
          expect(typeof text, `${localeName} ${groupName}.${problem}`).toBe("string");
          expect(text.trim().length, `${localeName} ${groupName}.${problem}`).toBeGreaterThan(0);
          expect(text, `${localeName} ${groupName}.${problem}`).toMatch(re);
        }
      }
    }

    // 4. E12(c) key_file_missing texts
    expect(en.site.backups.problem.key_file_missing).toContain("missing or not valid");
    expect(en.site.backups.copyProblem.key_file_missing).toContain("missing or not valid");
    expect(itCatalog.site.backups.problem.key_file_missing).toContain("manca o non è valida");
    expect(itCatalog.site.backups.copyProblem.key_file_missing).toContain("manca o non è valida");
    expect(en.admin.backups.problem.key_file_missing).toContain("missing or not valid");
    expect(en.admin.backups.problem.key_file_missing).toContain("delete the file");
    expect(itCatalog.admin.backups.problem.key_file_missing).toContain("manca o non è valido");
    expect(itCatalog.admin.backups.problem.key_file_missing).toContain("elimina il file");
  });

  it("handles E11 quota formatting (retryAt + Retry-After fallback), undo_incomplete UI, polling stop conditions, and double-click guards", async () => {
    // 1. E11 409 QUOTA_EXCEEDED for all three actions using retryAt detail and Retry-After fallback
    const retryAt = "2026-11-15T09:30:00.000Z";
    const fixedNow = new Date("2026-11-15T08:00:00.000Z");
    const expectedFromDetailEn = backupErrorText(
      en,
      409,
      {
        error: {
          code: "QUOTA_EXCEEDED",
          details: [{ field: "retryAt", reason: "too_many_requests", message: retryAt }],
        },
      },
      { action: "restore", locale: "en", now: fixedNow },
    );
    const expectedFromHeaderEn = backupErrorText(
      en,
      409,
      { error: { code: "QUOTA_EXCEEDED", details: [] } },
      { action: "download", retryAfter: "5400", locale: "en", now: fixedNow },
    );
    expect(expectedFromHeaderEn.message).toBe(expectedFromDetailEn.message);

    for (const action of ["backup", "restore", "download"] as const) {
      const fromDetailIt = backupErrorText(
        itCatalog,
        409,
        {
          error: {
            code: "QUOTA_EXCEEDED",
            details: [{ field: "retryAt", reason: "too_many_requests", message: retryAt }],
          },
        },
        { action, locale: "it", now: fixedNow },
      );
      const fromHeaderIt = backupErrorText(
        itCatalog,
        409,
        { error: { code: "QUOTA_EXCEEDED" } },
        { action, retryAfter: "5400", locale: "it", now: fixedNow },
      );
      expect(fromDetailIt.message).toBe(fromHeaderIt.message);
      expect(fromDetailIt.message).toContain("6");
    }

    // 2. After undo_incomplete: Restore button is rendered and "exactly as it was" is NOT shown
    const row: SiteBackupDto = {
      id: BACKUP_ID,
      kind: "manual",
      status: "succeeded",
      startedAt: "2026-11-15T04:00:00.000Z",
      finishedAt: "2026-11-15T04:02:00.000Z",
      sizeBytes: 2048,
      problem: null,
      archive: null,
    };
    const dtoUndoIncomplete: SiteBackupsDto = {
      available: true,
      configured: true,
      retentionDays: 14,
      manualKept: 3,
      runningOperationId: null,
      lastRestore: {
        backupId: BACKUP_ID,
        backupStartedAt: row.startedAt,
        status: "failed",
        finishedAt: "2026-11-15T05:00:00.000Z",
        problem: "undo_incomplete",
      },
      backups: [row],
    };

    const htmlEn = renderWithLocale(
      "en",
      createElement(SiteBackups, {
        basePath: BASE_BFF.replace(`/${BACKUP_ID}`, ""),
        initial: dtoUndoIncomplete,
        csrfToken: CSRF,
        siteName: "Site Alpha",
      }),
    );
    expect(htmlEn).toContain(en.site.backups.restore.button);
    expect(htmlEn).toContain(en.site.backups.copyProblem.undo_incomplete);
    expect(htmlEn).not.toContain("exactly as it was");
    expect(restoreBanner(en, dtoUndoIncomplete.lastRestore, "en")?.text).toBe(
      en.site.backups.copyProblem.undo_incomplete,
    );

    const htmlIt = renderWithLocale(
      "it",
      createElement(SiteBackups, {
        basePath: BASE_BFF.replace(`/${BACKUP_ID}`, ""),
        initial: dtoUndoIncomplete,
        csrfToken: CSRF,
        siteName: "Site Alpha",
      }),
    );
    expect(htmlIt).toContain(itCatalog.site.backups.restore.button);
    expect(htmlIt).not.toContain("esattamente com'era");

    // Dialog form keeps Cancel focused and has no <form> submit wrapper
    const formHtml = renderWithLocale(
      "en",
      createElement(
        Dialog,
        { open: true },
        createElement(RestoreBackupForm, {
          backup: row,
          siteName: "Site Alpha",
          onConfirm: async () => null,
          onCancel: () => {},
        }),
      ),
    );
    expect(formHtml).not.toContain("<form");
    expect(formHtml).toContain(en.site.backups.restore.cancel);

    // 3. Polling stops on 401 and at BACKUP_POLL_LIMIT_MS
    vi.useFakeTimers();
    const fetch401 = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn();
    const stop401 = startBackupPolling({
      basePath: "/api/bff/x/backups",
      fetchImpl: fetch401 as unknown as typeof fetch,
      onData: vi.fn(),
      onUnauthorized,
      onGiveUp: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(fetch401).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(401);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 5);
    expect(fetch401).toHaveBeenCalledTimes(1);
    stop401();

    let nowMs = 1_000;
    const restoringDto: SiteBackupsDto = {
      ...dtoUndoIncomplete,
      lastRestore: {
        backupId: BACKUP_ID,
        backupStartedAt: row.startedAt,
        status: "running",
        finishedAt: null,
        problem: null,
      },
    };
    const fetchRunning = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: restoringDto }), { status: 200 }),
      );
    const onGiveUp = vi.fn();
    const stopLimit = startBackupPolling({
      basePath: "/api/bff/x/backups",
      fetchImpl: fetchRunning as unknown as typeof fetch,
      now: () => nowMs,
      onData: vi.fn(),
      onUnauthorized: vi.fn(),
      onGiveUp,
    });
    for (
      let elapsed = BACKUP_POLL_INTERVAL_MS;
      elapsed < BACKUP_POLL_LIMIT_MS;
      elapsed += BACKUP_POLL_INTERVAL_MS
    ) {
      nowMs += BACKUP_POLL_INTERVAL_MS;
      await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    }
    const callsBeforeGiveUp = fetchRunning.mock.calls.length;
    nowMs += BACKUP_POLL_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(backupGiveUpText(en, restoringDto)).toBe(en.site.backups.errors.stillWorking);
    await vi.advanceTimersByTimeAsync(BACKUP_POLL_INTERVAL_MS * 3);
    expect(fetchRunning).toHaveBeenCalledTimes(callsBeforeGiveUp);
    stopLimit();
    vi.useRealTimers();

    // 4. Double-click guard on Restore confirmation and Prepare download sends one request each
    let resolveRestore!: (r: Response) => void;
    const restoreFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    const restoreRef = { current: false };
    const r1 = submitRestoreBackup({
      basePath: "/api/bff/x/backups",
      backupId: BACKUP_ID,
      confirmName: "Site Alpha",
      csrfToken: CSRF,
      inFlightRef: restoreRef,
      messages: en,
      fetchImpl: restoreFetch as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-r1",
    });
    const r2 = triggerRestoreBackup({
      basePath: "/api/bff/x/backups",
      backupId: BACKUP_ID,
      confirmName: "Site Alpha",
      csrfToken: CSRF,
      inFlightRef: restoreRef,
      fetchImpl: restoreFetch as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-r2",
    });
    expect(await r2).toBeNull();
    expect(restoreFetch).toHaveBeenCalledTimes(1);
    resolveRestore(
      new Response(
        JSON.stringify({ data: { siteId: SITE_ID, backupId: BACKUP_ID, operationId: "op_1" } }),
        { status: 202 },
      ),
    );
    expect(await r1).toEqual({ kind: "started", operationId: "op_1" });

    let resolvePrep!: (r: Response) => void;
    const prepFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvePrep = resolve;
        }),
    );
    const prepRef = { current: false };
    const p1 = submitPrepareDownload({
      basePath: "/api/bff/x/backups",
      backupId: BACKUP_ID,
      csrfToken: CSRF,
      inFlightRef: prepRef,
      messages: en,
      fetchImpl: prepFetch as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-p1",
    });
    const p2 = triggerPrepareDownload({
      basePath: "/api/bff/x/backups",
      backupId: BACKUP_ID,
      csrfToken: CSRF,
      inFlightRef: prepRef,
      fetchImpl: prepFetch as unknown as typeof fetch,
      makeIdempotencyKey: () => "idem-p2",
    });
    expect(await p2).toBeNull();
    expect(prepFetch).toHaveBeenCalledTimes(1);
    resolvePrep(
      new Response(
        JSON.stringify({ data: { siteId: SITE_ID, backupId: BACKUP_ID, operationId: "op_2" } }),
        { status: 202 },
      ),
    );
    expect(await p1).toEqual({ kind: "started", operationId: "op_2" });
  });
});
