import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  ApiErrorEnvelopeSchema,
  SITE_FILE_CHUNK_BASE64_MAX,
  SITE_FILE_CHUNK_BYTES,
  type SiteDetailDto,
  type SiteFileChunkDto,
  type SiteFileEntryDto,
} from "@hosting-panel/contracts";
import { en } from "@/i18n/en";
import { it as itMsgs } from "@/i18n/it";
import { I18nProvider } from "@/i18n/provider";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();
const getCustomerContext = vi.fn();
const getSite = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
}));
vi.mock("@/app/sites/data", () => ({
  getCustomerContext: (...args: unknown[]) => getCustomerContext(...args),
  getSite: (...args: unknown[]) => getSite(...args),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/sites/s1/files",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { attachmentDisposition, isSafeFilePath } from "@/lib/bff-files";
import { GET as listFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/route";
import {
  GET as readContent,
  PUT as writeContent,
} from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/content/route";
import { GET as downloadFile } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/download/route";
import { POST as createFolder } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/folders/route";
import { POST as moveFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/move/route";
import { POST as deleteFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/delete/route";
import { POST as archiveFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/archive/route";
import { POST as extractFiles } from "@/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/files/extract/route";
import {
  CHUNK_BYTES,
  baseName,
  crumbs,
  fileErrorText,
  fromBase64,
  isEditable,
  isValidName,
  isValidRelativePath,
  joinPath,
  mutationErrorFromResponse,
  parentPath,
  planChunks,
  uploadFile,
  type ChunkSender,
} from "@/lib/file-browser";
import { FileBreadcrumb, FileTable } from "@/components/customer/file-list";
import {
  DeleteFilesForm,
  MoveDialogForm,
  NameDialogForm,
  ReplaceFilesForm,
} from "@/components/customer/file-dialogs";
import { UploadList, type UploadItem } from "@/components/customer/file-uploads";
import { FilesNotReady, FilesPanel } from "@/components/customer/files-panel";
import { Dialog } from "@/components/ui/dialog";
import SiteFilesPage from "@/app/sites/[siteId]/files/page";

const BASE_UPSTREAM = "v1/organizations/org-1/managed-sites/s1";
const JARGON_RE =
  /\b(container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox|relay|smtp|postfix|spf|dkim)\b|HCP-SPEC|AC-F|ADR-/i;

const ctx = (orgId = "org-1", siteId = "s1") => ({
  params: Promise.resolve({ orgId, siteId }),
});

function makeReq(
  method: string,
  opts: {
    query?: string;
    headers?: Record<string, string>;
    omitCsrf?: boolean;
    body?: unknown;
  } = {},
): Request {
  const url = `http://localhost:3000/api/bff/orgs/org-1/managed-sites/s1/files${opts.query ?? ""}`;
  const headers: Record<string, string> = {
    Host: "localhost:3000",
    Origin: "http://localhost:3000",
    ...(opts.omitCsrf ? {} : { "X-CSRF-Token": "csrf" }),
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return new Request(url, { method, headers, body });
}

const validWriteBody = (overrides: Record<string, unknown> = {}) => ({
  path: "wp-content/uploads/hello.txt",
  uploadId: "upload-1234567890ab",
  offset: 0,
  dataBase64: Buffer.from("hello").toString("base64"),
  final: true,
  overwrite: true,
  ...overrides,
});

const wrap = (m: typeof en, child: React.ReactElement) =>
  createElement(I18nProvider, { locale: m === en ? "en" : "it", messages: m, children: child });

const entry = (over: Partial<SiteFileEntryDto> & { name: string }): SiteFileEntryDto => ({
  kind: "file",
  size: 100,
  modifiedAt: "2026-11-10T10:30:00Z",
  writable: true,
  ...over,
});

function collectLeaves(obj: unknown, prefix = ""): Array<[string, unknown]> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [[prefix, obj]];
  }
  const out: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    out.push(...collectLeaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

describe("download handler edge cases", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  it("keeps dangerous filenames confined inside Content-Disposition without breaking out or adding headers", async () => {
    const names = [
      'quote"inside.txt',
      "back\\slash.txt",
      "cr\rlf\nboth\r\n.txt",
      "semi; filename=evil.exe; colons.txt",
      "100%25%20percent.txt",
      "café_€_日本語.pdf",
      "\u202Egpj.exe", // RTL override
      "تقرير.pdf", // Arabic RTL
      "דוח.txt", // Hebrew RTL
    ];

    for (const name of names) {
      const disposition = attachmentDisposition(name);
      expect(disposition).not.toMatch(/[\r\n]/);
      const match = /^attachment; filename="([^"\\\r\n]*)"; filename\*=UTF-8''([^\r\n;]+)$/.exec(disposition);
      expect(match, `safe Content-Disposition structure for ${JSON.stringify(name)}`).not.toBeNull();
      expect(disposition.match(/filename\*=/g)?.length).toBe(1);

      // Verify Node Response headers accept it and preserve single-header isolation
      // (skipping CR/LF in query path because control chars are rejected by isSafeFilePath)
      if (!/[\r\n]/.test(name)) {
        fetchUpstream.mockResolvedValueOnce({
          ok: true,
          status: 200,
          data: { data: { dataBase64: Buffer.from("ok").toString("base64"), size: 2, eof: true } },
        });
        const res = await downloadFile(
          makeReq("GET", { query: `?path=${encodeURIComponent(`docs/${name}`)}` }),
          ctx(),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition")).toBe(disposition);
        await res.arrayBuffer();
      }
    }

    expect(attachmentDisposition("100%20.txt")).toContain("filename*=UTF-8''100%2520.txt");
    expect(attachmentDisposition("it's(1)*2.txt")).toContain("filename*=UTF-8''it%27s%281%29%2A2.txt");
    expect(attachmentDisposition("semi; filename=evil.exe; colons.txt")).toBe(
      'attachment; filename="semi; filename=evil.exe; colons.txt"; filename*=UTF-8\'\'semi%3B%20filename%3Devil.exe%3B%20colons.txt',
    );
  });

  it("always serves application/octet-stream with nosniff and sandbox CSP even for evil.html and x.svg", async () => {
    for (const name of ["evil.html", "x.svg"]) {
      fetchUpstream.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { dataBase64: Buffer.from("<script>alert(1)</script>").toString("base64"), size: 25, eof: true } },
      });
      const res = await downloadFile(
        makeReq("GET", { query: `?path=${encodeURIComponent(name)}` }),
        ctx(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      await res.arrayBuffer();
    }
  });

  it("refuses traversal, leading slash, %2e%2e, NUL, empty path, and missing session before calling upstream", async () => {
    const badQueries = [
      "",
      "?path=",
      "?path=..",
      "?path=../wp-config.php",
      "?path=a/../b",
      "?path=/etc/passwd",
      "?path=%2e%2e",
      "?path=%2e%2e%2Fwp-config.php",
      "?path=a%2F%2e%2e%2Fb",
      "?path=a%00b.txt",
      `?path=${encodeURIComponent("a\u0000b.txt")}`,
    ];

    for (const query of badQueries) {
      const res = await downloadFile(makeReq("GET", { query }), ctx());
      expect(res.status, `query=${query}`).toBe(400);
      expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
    }

    getSessionFromRequest.mockResolvedValueOnce(null);
    const noSessionRes = await downloadFile(makeReq("GET", { query: "?path=index.php" }), ctx());
    expect(noSessionRes.status).toBe(401);
    expect(ApiErrorEnvelopeSchema.parse(await noSessionRes.json()).error.code).toBe("UNAUTHENTICATED");

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("returns JSON error with upstream status on chunk 0 failure, and errors stream on size change or mid-stream failure", async () => {
    const err503 = {
      error: {
        code: "DOCKER_ENGINE_UNAVAILABLE",
        message: "Helper unavailable",
        requestId: "req-1",
        retryable: true,
        details: [],
      },
    };
    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 503, error: err503 });
    const firstErrRes = await downloadFile(makeReq("GET", { query: "?path=file.bin" }), ctx());
    expect(firstErrRes.status).toBe(503);
    expect(firstErrRes.headers.get("content-type")).toContain("application/json");
    expect(firstErrRes.headers.get("content-disposition")).toBeNull();
    expect(await firstErrRes.json()).toEqual(err503);

    const fullChunk = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41).toString("base64");
    const total = SITE_FILE_CHUNK_BYTES + 10;

    // Size shrinks between chunks
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: fullChunk, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: "AQID", size: total - 5, eof: true } } });
    const shrunkRes = await downloadFile(makeReq("GET", { query: "?path=file.bin" }), ctx());
    await expect(shrunkRes.arrayBuffer()).rejects.toThrow();

    // Upstream failure on chunk 1
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: fullChunk, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: false, status: 500, error: { error: { code: "INTERNAL_ERROR" } } });
    const midErrRes = await downloadFile(makeReq("GET", { query: "?path=file.bin" }), ctx());
    await expect(midErrRes.arrayBuffer()).rejects.toThrow();
  });

  it("requests increasing offsets <= 512 KiB and stops fetching when the client cancels", async () => {
    const c0 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41);
    const c1 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x42);
    const c2 = Buffer.from("tail");
    const total = c0.length + c1.length + c2.length;

    const chunks: SiteFileChunkDto[] = [
      { dataBase64: c0.toString("base64"), size: total, eof: false },
      { dataBase64: c1.toString("base64"), size: total, eof: false },
      { dataBase64: c2.toString("base64"), size: total, eof: true },
    ];
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[0] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[1] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[2] } });

    const res = await downloadFile(makeReq("GET", { query: "?path=archive.zip" }), ctx());
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(total);

    const requestedUrls = fetchUpstream.mock.calls.map(([u]) => String(u));
    const offsetsAndLengths = requestedUrls.map((u) => {
      const sp = new URLSearchParams(u.split("?")[1]);
      return { offset: Number(sp.get("offset")), length: Number(sp.get("length")) };
    });
    expect(offsetsAndLengths).toEqual([
      { offset: 0, length: 524_288 },
      { offset: 524_288, length: 524_288 },
      { offset: 1_048_576, length: 524_288 },
    ]);
    for (const item of offsetsAndLengths) {
      expect(item.length).toBeLessThanOrEqual(524_288);
    }

    // Cancel after chunk 1 (2nd pull) -> 3rd chunk is never requested
    fetchUpstream.mockReset();
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[0] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[1] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[2] } });

    const cancelRes = await downloadFile(makeReq("GET", { query: "?path=archive.zip" }), ctx());
    const reader = cancelRes.body!.getReader();
    await reader.read();
    await reader.read();
    await cancelRes.body?.cancel().catch(() => reader.cancel());
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });
});

describe("BFF guards, CSRF, Origin, segment validation, and URL round trips", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({ accessToken: "tok", csrfToken: "csrf" });
  });

  it("refuses missing or wrong CSRF token and foreign Origin across all mutating handlers", async () => {
    const mutatingCalls = (opts: { headers?: Record<string, string>; omitCsrf?: boolean }) => [
      writeContent(makeReq("PUT", { ...opts, body: validWriteBody() }), ctx()),
      createFolder(makeReq("POST", { ...opts, body: { path: "docs" } }), ctx()),
      moveFiles(makeReq("POST", { ...opts, body: { from: "a.txt", to: "b.txt" } }), ctx()),
      deleteFiles(makeReq("POST", { ...opts, body: { paths: ["a.txt"] } }), ctx()),
      archiveFiles(makeReq("POST", { ...opts, body: { paths: ["a.txt"], to: "a.zip" } }), ctx()),
      extractFiles(makeReq("POST", { ...opts, body: { path: "a.zip", to: "" } }), ctx()),
    ];

    const badOptions: Array<{ headers?: Record<string, string>; omitCsrf?: boolean }> = [
      { omitCsrf: true },
      { headers: { "X-CSRF-Token": "wrong-token" } },
      { headers: { Origin: "https://evil.example" } },
    ];
    for (const callOpts of badOptions) {
      const results = await Promise.all(mutatingCalls(callOpts));
      for (const res of results) {
        expect(res.status).toBe(403);
        expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("PERMISSION_DENIED");
      }
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("refuses orgId and siteId with characters outside [a-zA-Z0-9_-]{1,128} on every handler", async () => {
    const badSegments = ["org.1", "org$1", "a/b", "..", "", "a".repeat(129)];

    for (const bad of badSegments) {
      const pairs = [ctx(bad, "s1"), ctx("org-1", bad)];
      for (const c of pairs) {
        const responses = await Promise.all([
          listFiles(makeReq("GET", { query: "?path=" }), c),
          readContent(makeReq("GET", { query: "?path=index.php" }), c),
          downloadFile(makeReq("GET", { query: "?path=index.php" }), c),
          writeContent(makeReq("PUT", { body: validWriteBody() }), c),
          createFolder(makeReq("POST", { body: { path: "docs" } }), c),
          moveFiles(makeReq("POST", { body: { from: "a.txt", to: "b.txt" } }), c),
          deleteFiles(makeReq("POST", { body: { paths: ["a.txt"] } }), c),
          archiveFiles(makeReq("POST", { body: { paths: ["a.txt"], to: "a.zip" } }), c),
          extractFiles(makeReq("POST", { body: { path: "a.zip", to: "" } }), c),
        ]);
        for (const res of responses) {
          expect(res.status, `bad segment=${JSON.stringify(bad)}`).toBe(400);
          expect(ApiErrorEnvelopeSchema.parse(await res.json()).error.code).toBe("VALIDATION_ERROR");
        }
      }
    }

    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("rejects PUT uploadId that is not a valid single segment", async () => {
    for (const badId of ["", "../x", "a/b", "id with spaces", "a.b", "x".repeat(129)]) {
      const res = await writeContent(
        makeReq("PUT", { body: validWriteBody({ uploadId: badId }) }),
        ctx(),
      );
      expect(res.status, `uploadId=${JSON.stringify(badId)}`).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("preserves #, ?, %, spaces, and + through BFF query round trips", async () => {
    const specialPath = "folder #1/file?name=100% + more.txt";
    expect(isSafeFilePath(specialPath, false)).toBe(true);

    fetchUpstream.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { entries: [], truncated: false, dataBase64: "b2s=", size: 2, eof: true } },
    });

    const query = `?path=${encodeURIComponent(specialPath)}`;
    await listFiles(makeReq("GET", { query }), ctx());
    await readContent(makeReq("GET", { query: `${query}&offset=0&length=10` }), ctx());
    const dlRes = await downloadFile(makeReq("GET", { query }), ctx());
    await dlRes.arrayBuffer();

    const expectedEncoded = encodeURIComponent(specialPath);
    expect(fetchUpstream.mock.calls[0]![0]).toBe(`${BASE_UPSTREAM}/files?path=${expectedEncoded}`);
    expect(fetchUpstream.mock.calls[1]![0]).toBe(
      `${BASE_UPSTREAM}/files/content?path=${expectedEncoded}&offset=0&length=10`,
    );
    expect(fetchUpstream.mock.calls[2]![0]).toBe(
      `${BASE_UPSTREAM}/files/content?path=${expectedEncoded}&offset=0&length=${SITE_FILE_CHUNK_BYTES}`,
    );
    expect(dlRes.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''file%3Fname%3D100%25%20%2B%20more.txt",
    );
  });
});

describe("upload planning and retry/restart/conflict semantics", () => {
  it("plans chunks for 0, 1, 512 KiB, 512 KiB + 1 and round-trips sizes not a multiple of 3", async () => {
    expect(planChunks(0)).toEqual([{ offset: 0, end: 0, final: true }]);
    expect(planChunks(1)).toEqual([{ offset: 0, end: 1, final: true }]);
    expect(planChunks(524_288)).toEqual([{ offset: 0, end: 524_288, final: true }]);
    expect(planChunks(524_289)).toEqual([
      { offset: 0, end: 524_288, final: false },
      { offset: 524_288, end: 524_289, final: true },
    ]);

    // Test sizes not a multiple of 3 (both single-chunk and multi-chunk)
    for (const size of [0, 1, 2, 4, 5, 524_288, 524_289, 524_288 * 2 + 2]) {
      const raw = new Uint8Array(size);
      for (let i = 0; i < raw.length; i += 1) {
        raw[i] = (i * 17 + 3) & 0xff;
      }
      const chunks: Array<{ offset: number; dataBase64: string; final: boolean }> = [];
      const res = await uploadFile(
        new Blob([raw]),
        "data.bin",
        false,
        async (c) => {
          expect(c.dataBase64.length).toBeLessThanOrEqual(SITE_FILE_CHUNK_BASE64_MAX);
          expect(c.dataBase64.length % 4).toBe(0);
          chunks.push({ offset: c.offset, dataBase64: c.dataBase64, final: c.final });
          const len = fromBase64(c.dataBase64).length;
          return { status: 200, received: c.offset + len };
        },
        () => {},
        new AbortController().signal,
      );

      expect(res).toEqual({ ok: true });
      expect(chunks.at(-1)?.final).toBe(true);
      expect(chunks.slice(0, -1).every((c) => !c.final)).toBe(true);

      const decodedParts = chunks.map((c) => fromBase64(c.dataBase64));
      const reconstructed = new Uint8Array(decodedParts.reduce((sum, p) => sum + p.length, 0));
      let pos = 0;
      for (const p of decodedParts) {
        reconstructed.set(p, pos);
        pos += p.length;
      }
      expect(reconstructed).toEqual(raw);
    }
  });

  it("retries transient failures with the same uploadId and offset, then fails after 3 retries", async () => {
    vi.useFakeTimers();
    try {
      const seen: Array<{ offset: number; uploadId: string }> = [];
      const promise = uploadFile(
        new Blob([new Uint8Array(CHUNK_BYTES + 5)]),
        "retry.bin",
        false,
        async (c) => {
          seen.push({ offset: c.offset, uploadId: c.uploadId });
          if (c.offset === 0) return { status: 200, received: CHUNK_BYTES };
          return { status: 504 };
        },
        () => {},
        new AbortController().signal,
      );

      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);
      const outcome = await promise;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("OPERATION_AMBIGUOUS");
        expect(outcome.resume.offset).toBe(CHUNK_BYTES);
      }
      // 1st chunk ok (0) + 4 attempts at offset CHUNK_BYTES (initial + 3 retries)
      expect(seen).toHaveLength(5);
      const retryCalls = seen.slice(1);
      expect(retryCalls.every((c) => c.offset === CHUNK_BYTES && c.uploadId === seen[0]!.uploadId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts once from 0 on upload_mismatch at offset > 0 and gives up on a second mismatch", async () => {
    const progress: number[] = [];
    const calls: Array<{ offset: number; uploadId: string }> = [];
    const blob = new Blob([new Uint8Array(CHUNK_BYTES + 16)]);

    const outcome = await uploadFile(
      blob,
      "mismatch.bin",
      false,
      async (c) => {
        calls.push({ offset: c.offset, uploadId: c.uploadId });
        if (c.offset === 0) return { status: 200, received: CHUNK_BYTES };
        return { status: 400, code: "VALIDATION_ERROR", reason: "upload_mismatch" };
      },
      (sent) => progress.push(sent),
      new AbortController().signal,
    );

    expect(calls).toHaveLength(4);
    expect(calls[0]!.uploadId).toBe(calls[1]!.uploadId);
    expect(calls[2]!.offset).toBe(0);
    expect(calls[2]!.uploadId).not.toBe(calls[0]!.uploadId);
    expect(calls[3]!.uploadId).toBe(calls[2]!.uploadId);
    expect(progress).toContain(0);
    expect(outcome).toEqual({
      ok: false,
      code: "VALIDATION_ERROR",
      status: 400,
      reason: "upload_mismatch",
      resume: { uploadId: calls[2]!.uploadId, offset: CHUNK_BYTES },
    });

    // At offset 0, upload_mismatch fails immediately without looping
    let zeroCalls = 0;
    const atZero = await uploadFile(
      new Blob([new Uint8Array(10)]),
      "zero.bin",
      false,
      async () => {
        zeroCalls += 1;
        return { status: 400, code: "VALIDATION_ERROR", reason: "upload_mismatch" };
      },
      () => {},
      new AbortController().signal,
    );
    expect(zeroCalls).toBe(1);
    expect(atZero.ok).toBe(false);
  });

  it("never silently overwrites on ALREADY_EXISTS and surfaces the replace question", async () => {
    const sentOverwrites: boolean[] = [];
    const send: ChunkSender = async (c) => {
      sentOverwrites.push(c.overwrite);
      return { status: 409, code: "ALREADY_EXISTS", reason: "exists" };
    };

    const outcome = await uploadFile(
      new Blob([new Uint8Array(12)]),
      "wp-config.php",
      false,
      send,
      () => {},
      new AbortController().signal,
    );

    expect(sentOverwrites).toEqual([false]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("ALREADY_EXISTS");
    }
    expect(fileErrorText(en, "ALREADY_EXISTS", "upload")).toBe(en.site.files.errors.ALREADY_EXISTS);
    expect(fileErrorText(itMsgs, "ALREADY_EXISTS", "upload")).toBe(itMsgs.site.files.errors.ALREADY_EXISTS);

    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(
        wrap(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(ReplaceFilesForm, {
              names: ["wp-config.php"],
              onReplace: () => {},
              onSkip: () => {},
              onCancel: () => {},
            }),
          ),
        ),
      ).replaceAll("&#x27;", "'");
      expect(html).toContain(m.site.files.upload.replaceTitle);
      expect(html).toContain("wp-config.php");
      expect(html).toContain(m.site.files.upload.replace);
      expect(html).toContain(m.site.files.upload.skip);
    }
  });
});

describe("path helpers", () => {
  it("handles joining, parent, root breadcrumb, and special characters across URL round trips", () => {
    expect(joinPath("", "docs")).toBe("docs");
    expect(joinPath("wp-content", "uploads")).toBe("wp-content/uploads");
    expect(joinPath("wp-content/", "/uploads/")).toBe("wp-content/uploads");

    expect(parentPath("")).toBe("");
    expect(parentPath("index.php")).toBe("");
    expect(parentPath("wp-content/uploads/2026")).toBe("wp-content/uploads");

    expect(baseName("")).toBe("");
    expect(baseName("a/b/c#1?2%3+4.txt")).toBe("c#1?2%3+4.txt");

    expect(crumbs("")).toEqual([]);
    const rootBreadcrumb = renderToStaticMarkup(
      wrap(en, createElement(FileBreadcrumb, { path: "", onOpen: () => {} })),
    );
    expect(rootBreadcrumb).toContain('aria-current="page"');
    expect(rootBreadcrumb).not.toContain("<button");
    expect(rootBreadcrumb).toContain(en.site.files.rootLabel);

    const special = "dir #1/sub?2/100% + file.txt";
    expect(isValidName("100% + #?file.txt")).toBe(true);
    expect(isValidRelativePath(special, false)).toBe(true);
    const url = new URL(`http://localhost:3000/sites/s1/files?path=${encodeURIComponent(special)}`);
    expect(url.searchParams.get("path")).toBe(special);
    expect(crumbs(url.searchParams.get("path")!)).toEqual([
      { name: "dir #1", path: "dir #1" },
      { name: "sub?2", path: "dir #1/sub?2" },
      { name: "100% + file.txt", path: "dir #1/sub?2/100% + file.txt" },
    ]);
  });
});

describe("copy, jargon, error next steps, and cycle 1 SFTP exclusion", () => {
  it("has parity and non-empty strings for every site.files key in both catalogs", () => {
    expect(en.site.tabs.files.trim().length).toBeGreaterThan(0);
    expect(itMsgs.site.tabs.files.trim().length).toBeGreaterThan(0);

    const enLeaves = collectLeaves(en.site.files);
    const itLeaves = collectLeaves(itMsgs.site.files);

    expect(enLeaves.map(([k]) => k).sort()).toEqual(itLeaves.map(([k]) => k).sort());
    for (const [k, v] of [...enLeaves, ...itLeaves]) {
      expect(typeof v, `key ${k}`).toBe("string");
      expect((v as string).trim().length, `empty key ${k}`).toBeGreaterThan(0);
    }
  });

  it("contains no infrastructure jargon under site.files", () => {
    for (const [k, v] of [...collectLeaves(en.site.files), ...collectLeaves(itMsgs.site.files)]) {
      expect(String(v), `jargon in ${k}`).not.toMatch(JARGON_RE);
    }
  });

  it("names a next step in every site.files.errors text", () => {
    const enNextStep = /\b(refresh|try again|choose|change|ask|contact|wait|sign in|delete|try)\b/i;
    const itNextStep =
      /\b(aggiorna|riprova|scegli|correggilo|chiedi|contatta|attendi|accedi|elimina|prova)\b/i;

    for (const [k, text] of Object.entries(en.site.files.errors)) {
      expect(text, `en.site.files.errors.${k}`).toMatch(enNextStep);
    }
    for (const [k, text] of Object.entries(itMsgs.site.files.errors)) {
      expect(text, `it.site.files.errors.${k}`).toMatch(itNextStep);
    }
  });

  it("maps every error code the files routes can return to non-generic copy", () => {
    const routeCodes = [
      "VALIDATION_ERROR",
      "NOT_FOUND",
      "ALREADY_EXISTS",
      "PERMISSION_DENIED",
      "NOT_SUPPORTED",
      "RESOURCE_LOCKED",
      "OPERATION_INTERRUPTED",
      "DOCKER_ENGINE_UNAVAILABLE",
      "OPERATION_AMBIGUOUS",
      "UNAUTHENTICATED",
      "ORGANIZATION_SUSPENDED",
      "INTERNAL_ERROR",
    ] as const;

    for (const m of [en, itMsgs]) {
      for (const code of routeCodes) {
        expect(fileErrorText(m, code, "files"), `${code} in files scope`).not.toBe(m.errors.generic);
      }
      expect(fileErrorText(m, "QUOTA_EXCEEDED", "upload")).not.toBe(m.errors.generic);
      expect(fileErrorText(m, "QUOTA_EXCEEDED", "zip")).not.toBe(m.errors.generic);
    }
  });

  it("states the item count and that deletion cannot be undone", () => {
    const items = [entry({ name: "a.php" }), entry({ name: "b.php" }), entry({ name: "c", kind: "dir", size: 0 })];

    for (const m of [en, itMsgs]) {
      const html = renderToStaticMarkup(
        wrap(
          m,
          createElement(
            Dialog,
            { open: true },
            createElement(DeleteFilesForm, { items, onConfirm: async () => null, onCancel: () => {} }),
          ),
        ),
      ).replaceAll("&#x27;", "'");

      expect(html).toContain("3");
      if (m === en) {
        expect(html.toLowerCase()).toContain("no undo");
        expect(m.site.files.delete.bodyFile.toLowerCase()).toContain("no undo");
        expect(m.site.files.delete.bodyFolder.toLowerCase()).toContain("no undo");
      } else {
        expect(html.toLowerCase()).toContain("non si può annullare");
        expect(m.site.files.delete.bodyFile.toLowerCase()).toContain("non si può annullare");
        expect(m.site.files.delete.bodyFolder.toLowerCase()).toContain("non si può annullare");
      }
    }
  });

  it("keeps SFTP keys and wording out of site.files catalogs and rendered markup", async () => {
    for (const [lang, m] of [["en", en], ["it", itMsgs]] as const) {
      expect(Object.hasOwn(m.site.files, "sftpLink")).toBe(false);
      for (const [k, v] of collectLeaves(m.site.files)) {
        expect(k, `${lang}.site.files key ${k}`).not.toMatch(/sftp/i);
        expect(String(v), `${lang}.site.files.${k}`).not.toMatch(/\bsftp\b/i);
      }
    }

    const entries: SiteFileEntryDto[] = [
      entry({ name: "wp-content", kind: "dir", size: 0 }),
      entry({ name: "index.php", kind: "file", size: 420 }),
      entry({ name: "backup.zip", kind: "file", size: 200 * 1024 * 1024 }),
      entry({ name: "link-item", kind: "link", size: 0 }),
      entry({ name: "sock-item", kind: "other", size: 0 }),
    ];
    const uploadItems: UploadItem[] = [
      {
        id: "u1",
        file: { name: "large.zip", size: 150 * 1024 * 1024 } as File,
        path: "large.zip",
        overwrite: false,
        sent: 1024,
        status: "uploading",
        error: null,
      },
    ];

    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
    getSite.mockResolvedValue({
      ok: true,
      data: { id: "s1", status: "active" } as unknown as SiteDetailDto,
    });
    const pageEl = await SiteFilesPage({ params: Promise.resolve({ siteId: "s1" }) });

    const renderedParts = [
      renderToStaticMarkup(wrap(en, pageEl!)),
      renderToStaticMarkup(wrap(en, createElement(FilesNotReady))),
      renderToStaticMarkup(
        wrap(
          en,
          createElement(FilesPanel, {
            apiBase: "/api/bff/orgs/o1/managed-sites/s1",
            orgId: "o1",
            siteId: "s1",
            csrfToken: "csrf",
          }),
        ),
      ),
      renderToStaticMarkup(
        wrap(
          en,
          createElement(FileTable, {
            entries,
            folderName: en.site.files.rootLabel,
            selected: new Set(["index.php"]),
            onToggle: () => {},
            onToggleAll: () => {},
            onOpen: () => {},
            locale: en.common.dateLocale,
          }),
        ),
      ),
      renderToStaticMarkup(
        wrap(
          en,
          createElement(UploadList, {
            items: uploadItems,
            onCancel: () => {},
            onRetry: () => {},
            onCancelAll: () => {},
            onDismiss: () => {},
          }),
        ),
      ),
      renderToStaticMarkup(
        wrap(
          en,
          createElement(
            Dialog,
            { open: true },
            createElement(MoveDialogForm, {
              apiBase: "/api/bff/orgs/o1/managed-sites/s1",
              items: [entries[1]!],
              from: "",
              onMove: async () => null,
              onCancel: () => {},
            }),
          ),
        ),
      ),
      renderToStaticMarkup(
        wrap(
          en,
          createElement(
            Dialog,
            { open: true },
            createElement(NameDialogForm, {
              title: en.site.files.compress.title,
              label: en.site.files.compress.label,
              hint: en.site.files.compress.hint,
              initial: "archive",
              submitLabel: en.site.files.compress.submit,
              workingLabel: en.site.files.compress.working,
              onSubmit: async () => null,
              onCancel: () => {},
            }),
          ),
        ),
      ),
    ];

    for (const html of renderedParts) {
      expect(html).not.toMatch(/\bsftp\b/i);
    }
  });
});

describe("rendering and accessibility", () => {
  it("renders link and other entries without open/download/edit buttons", () => {
    const linkEntry = entry({ name: "current", kind: "link", size: 0 });
    const otherEntry = entry({ name: "socket", kind: "other", size: 0 });
    const fileEntry = entry({ name: "index.php", kind: "file", size: 120 });

    expect(isEditable(linkEntry)).toBe(false);
    expect(isEditable(otherEntry)).toBe(false);

    const html = renderToStaticMarkup(
      wrap(
        en,
        createElement(FileTable, {
          entries: [linkEntry, otherEntry, fileEntry],
          folderName: en.site.files.rootLabel,
          selected: new Set<string>(),
          onToggle: () => {},
          onToggleAll: () => {},
          onOpen: () => {},
          locale: en.common.dateLocale,
        }),
      ),
    ).replaceAll("&#x27;", "'");

    expect(html).toContain("current");
    expect(html).toContain("socket");
    expect(html).toContain(en.site.files.list.shortcut);
    // Only the regular file should have an open button; link and other are plain text spans
    const buttonMatches = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
    expect(buttonMatches).toHaveLength(1);
    expect(buttonMatches[0]).toContain("index.php");
    expect(html).not.toContain("<a ");
  });

  it("shows the protected text only when PERMISSION_DENIED has details[0].reason === 'protected'", () => {
    for (const m of [en, itMsgs]) {
      expect(fileErrorText(m, "PERMISSION_DENIED", "files", [{ reason: "protected" }])).toBe(
        m.site.files.errors.PERMISSION_DENIED,
      );
      expect(fileErrorText(m, "PERMISSION_DENIED", "files")).toBe(m.errors.PERMISSION_DENIED);
      expect(fileErrorText(m, "PERMISSION_DENIED", "files", [])).toBe(m.errors.PERMISSION_DENIED);
      expect(fileErrorText(m, "PERMISSION_DENIED", "files", [{ reason: "role_denied" }])).toBe(
        m.errors.PERMISSION_DENIED,
      );
      expect(
        fileErrorText(m, "PERMISSION_DENIED", "files", [{ reason: "other" }, { reason: "protected" }]),
      ).toBe(m.errors.PERMISSION_DENIED);

      expect(
        mutationErrorFromResponse(m, 403, {
          error: { code: "PERMISSION_DENIED", details: [{ reason: "protected" }] },
        }),
      ).toBe(m.site.files.errors.PERMISSION_DENIED);
      expect(
        mutationErrorFromResponse(m, 403, {
          error: { code: "PERMISSION_DENIED", details: [{ reason: "forbidden" }] },
        }),
      ).toBe(m.errors.PERMISSION_DENIED);
    }
  });

  it("renders site-not-ready state without toolbar and exposes designed empty-folder copy", async () => {
    for (const m of [en, itMsgs]) {
      const notReadyHtml = renderToStaticMarkup(wrap(m, createElement(FilesNotReady))).replaceAll("&#x27;", "'");
      expect(notReadyHtml).toContain(m.site.files.notReady);
      expect(notReadyHtml).not.toContain('role="toolbar"');
      expect(m.site.files.empty.trim().length).toBeGreaterThan(20);
    }

    getCustomerContext.mockResolvedValue({ session: { csrfToken: "csrf" }, orgId: "org-1" });
    getSite.mockResolvedValue({
      ok: true,
      data: { id: "s1", status: "deploying" } as unknown as SiteDetailDto,
    });
    const deployingPage = await SiteFilesPage({ params: Promise.resolve({ siteId: "s1" }) });
    const deployingHtml = renderToStaticMarkup(wrap(en, deployingPage!)).replaceAll("&#x27;", "'");
    expect(deployingHtml).toContain(en.site.files.notReady);
    expect(deployingHtml).not.toContain('role="toolbar"');
  });

  it("gives every icon-only button an accessible name", () => {
    const panelHtml = renderToStaticMarkup(
      wrap(
        en,
        createElement(FilesPanel, {
          apiBase: "/api/bff/orgs/o1/managed-sites/s1",
          orgId: "o1",
          siteId: "s1",
          csrfToken: "csrf",
        }),
      ),
    );

    const buttons = [...panelHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    expect(buttons.length).toBeGreaterThan(0);

    for (const [, attrs, inner] of buttons) {
      const textOnly = inner!.replace(/<[^>]+>/g, "").trim();
      if (textOnly === "") {
        const hasLabel = /\baria-label="([^"]+)"/.exec(attrs!);
        expect(hasLabel, `icon-only button missing aria-label: <button${attrs}>`).not.toBeNull();
        expect(hasLabel![1]!.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
