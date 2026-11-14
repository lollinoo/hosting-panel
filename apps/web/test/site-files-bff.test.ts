import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorEnvelopeSchema,
  SITE_FILE_BATCH_MAX,
  SITE_FILE_CHUNK_BASE64_MAX,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_PATH_MAX,
  type SiteFileChunkDto,
} from "@hosting-panel/contracts";

const fetchUpstream = vi.fn();
const getSessionFromRequest = vi.fn();

vi.mock("@/lib/upstream", () => ({
  fetchUpstream: (...args: unknown[]) => fetchUpstream(...args),
}));
vi.mock("@/lib/server-session", () => ({
  getSessionFromRequest: (...args: unknown[]) => getSessionFromRequest(...args),
}));

import {
  attachmentDisposition,
  isSafeFilePath,
} from "@/lib/bff-files";
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

const BASE_UPSTREAM = "v1/organizations/org-1/managed-sites/s1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ctx = (orgId = "org-1", siteId = "s1") => ({
  params: Promise.resolve({ orgId, siteId }),
});

function makeReq(
  method: string,
  opts: {
    query?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  } = {},
): Request {
  const url = `http://localhost:3000/api/bff/orgs/org-1/managed-sites/s1/files${opts.query ?? ""}`;
  const headers: Record<string, string> = {
    Host: "localhost:3000",
    Origin: "http://localhost:3000",
    "X-CSRF-Token": "csrf",
    ...(opts.headers ?? {}),
  };
  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
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

describe("site files BFF", () => {
  beforeEach(() => {
    fetchUpstream.mockReset();
    getSessionFromRequest.mockReset();
    getSessionFromRequest.mockResolvedValue({
      accessToken: "tok",
      csrfToken: "csrf",
    });
  });

  it("rejects missing session with 401 on GET and mutating routes without calling upstream", async () => {
    getSessionFromRequest.mockResolvedValue(null);

    const responses = await Promise.all([
      listFiles(makeReq("GET", { query: "?path=" }), ctx()),
      readContent(makeReq("GET", { query: "?path=index.php&offset=0&length=10" }), ctx()),
      downloadFile(makeReq("GET", { query: "?path=index.php" }), ctx()),
      writeContent(makeReq("PUT", { body: validWriteBody() }), ctx()),
      createFolder(makeReq("POST", { body: { path: "docs" } }), ctx()),
      moveFiles(makeReq("POST", { body: { from: "a.txt", to: "b.txt" } }), ctx()),
      deleteFiles(makeReq("POST", { body: { paths: ["a.txt"] } }), ctx()),
      archiveFiles(makeReq("POST", { body: { paths: ["a.txt"], to: "a.zip" } }), ctx()),
      extractFiles(makeReq("POST", { body: { path: "a.zip", to: "" } }), ctx()),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
      const parsed = ApiErrorEnvelopeSchema.parse(await res.json());
      expect(parsed.error.code).toBe("UNAUTHENTICATED");
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("enforces CSRF token and Origin checks on every mutating route", async () => {
    const mutators: Array<() => Promise<Response>> = [
      () => writeContent(makeReq("PUT", { headers: { "X-CSRF-Token": "wrong" }, body: validWriteBody() }), ctx()),
      () => createFolder(makeReq("POST", { headers: { "X-CSRF-Token": "wrong" }, body: { path: "docs" } }), ctx()),
      () => moveFiles(makeReq("POST", { headers: { "X-CSRF-Token": "wrong" }, body: { from: "a", to: "b" } }), ctx()),
      () => deleteFiles(makeReq("POST", { headers: { "X-CSRF-Token": "wrong" }, body: { paths: ["a"] } }), ctx()),
      () => archiveFiles(makeReq("POST", { headers: { "X-CSRF-Token": "wrong" }, body: { paths: ["a"], to: "a.zip" } }), ctx()),
      () => extractFiles(makeReq("POST", { headers: { "X-CSRF-Token": "wrong" }, body: { path: "a.zip", to: "" } }), ctx()),
      () => writeContent(makeReq("PUT", { headers: { Origin: "https://evil.example" }, body: validWriteBody() }), ctx()),
      () => createFolder(makeReq("POST", { headers: { Origin: "https://evil.example" }, body: { path: "docs" } }), ctx()),
      () => moveFiles(makeReq("POST", { headers: { Origin: "https://evil.example" }, body: { from: "a", to: "b" } }), ctx()),
      () => deleteFiles(makeReq("POST", { headers: { Origin: "https://evil.example" }, body: { paths: ["a"] } }), ctx()),
      () => archiveFiles(makeReq("POST", { headers: { Origin: "https://evil.example" }, body: { paths: ["a"], to: "a.zip" } }), ctx()),
      () => extractFiles(makeReq("POST", { headers: { Origin: "https://evil.example" }, body: { path: "a.zip", to: "" } }), ctx()),
    ];

    for (const call of mutators) {
      const res = await call();
      expect(res.status).toBe(403);
      const parsed = ApiErrorEnvelopeSchema.parse(await res.json());
      expect(parsed.error.code).toBe("PERMISSION_DENIED");
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("rejects invalid orgId or siteId path segments with 400", async () => {
    const badRes = await listFiles(
      makeReq("GET", { query: "?path=" }),
      ctx("../bad", "s1"),
    );
    expect(badRes.status).toBe(400);
    const badDl = await downloadFile(
      makeReq("GET", { query: "?path=index.php" }),
      ctx("org-1", "bad/id"),
    );
    expect(badDl.status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("validates file paths for traversal, absolute, control chars, reserved prefix, and length limits", async () => {
    const badPaths = [
      "../x",
      "a/../b",
      "/etc",
      "a//b",
      "a/",
      ".",
      "..",
      "x\u0000",
      "x\n",
      "x\r\ny",
      ".htpanel-upload-abc.part",
      "wp-content/.htpanel-staging",
      "a".repeat(SITE_FILE_PATH_MAX + 1),
      "a".repeat(4097),
      "é".repeat(128), // 256 UTF-8 bytes in one segment
    ];

    for (const bad of badPaths) {
      expect(isSafeFilePath(bad, true), `allowRoot=true for ${JSON.stringify(bad)}`).toBe(false);
      expect(isSafeFilePath(bad, false), `allowRoot=false for ${JSON.stringify(bad)}`).toBe(false);

      const q = `?path=${encodeURIComponent(bad)}`;
      expect((await listFiles(makeReq("GET", { query: q }), ctx())).status).toBe(400);
      expect((await readContent(makeReq("GET", { query: q }), ctx())).status).toBe(400);
      expect((await downloadFile(makeReq("GET", { query: q }), ctx())).status).toBe(400);
      expect((await createFolder(makeReq("POST", { body: { path: bad } }), ctx())).status).toBe(400);
      expect((await moveFiles(makeReq("POST", { body: { from: bad, to: "ok" } }), ctx())).status).toBe(400);
      expect((await moveFiles(makeReq("POST", { body: { from: "ok", to: bad } }), ctx())).status).toBe(400);
      expect((await deleteFiles(makeReq("POST", { body: { paths: [bad] } }), ctx())).status).toBe(400);
      expect((await archiveFiles(makeReq("POST", { body: { paths: [bad], to: "out.zip" } }), ctx())).status).toBe(400);
      expect((await archiveFiles(makeReq("POST", { body: { paths: ["ok"], to: bad } }), ctx())).status).toBe(400);
      expect((await extractFiles(makeReq("POST", { body: { path: bad, to: "" } }), ctx())).status).toBe(400);
      expect((await extractFiles(makeReq("POST", { body: { path: "a.zip", to: bad } }), ctx())).status).toBe(400);
    }

    // Empty root path: allowed for list and extract.to, rejected elsewhere
    expect((await readContent(makeReq("GET", { query: "?path=" }), ctx())).status).toBe(400);
    expect((await downloadFile(makeReq("GET", { query: "?path=" }), ctx())).status).toBe(400);
    expect((await writeContent(makeReq("PUT", { body: validWriteBody({ path: "" }) }), ctx())).status).toBe(400);
    expect((await createFolder(makeReq("POST", { body: { path: "" } }), ctx())).status).toBe(400);
    expect((await moveFiles(makeReq("POST", { body: { from: "", to: "a" } }), ctx())).status).toBe(400);
    expect((await moveFiles(makeReq("POST", { body: { from: "a", to: "" } }), ctx())).status).toBe(400);
    expect((await deleteFiles(makeReq("POST", { body: { paths: [""] } }), ctx())).status).toBe(400);
    expect((await archiveFiles(makeReq("POST", { body: { paths: [""], to: "a.zip" } }), ctx())).status).toBe(400);
    expect((await archiveFiles(makeReq("POST", { body: { paths: ["a"], to: "" } }), ctx())).status).toBe(400);
    expect((await extractFiles(makeReq("POST", { body: { path: "", to: "" } }), ctx())).status).toBe(400);

    // Move same path or into descendant rejected
    expect((await moveFiles(makeReq("POST", { body: { from: "a", to: "a" } }), ctx())).status).toBe(400);
    expect((await moveFiles(makeReq("POST", { body: { from: "a", to: "a/sub" } }), ctx())).status).toBe(400);

    expect(fetchUpstream).not.toHaveBeenCalled();

    // Accepted root & valid hidden files like .htaccess and special chars + / #
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { entries: [], truncated: false } } });
    expect((await listFiles(makeReq("GET", { query: "?path=" }), ctx())).status).toBe(200);
    expect((await listFiles(makeReq("GET", { query: `?path=${encodeURIComponent("wp-content/a+b#c/.htaccess")}` }), ctx())).status).toBe(200);
    expect(fetchUpstream.mock.calls[1]![0]).toBe(
      `${BASE_UPSTREAM}/files?path=wp-content%2Fa%2Bb%23c%2F.htaccess`,
    );
  });

  it("forwards expected upstream paths, methods, bodies, and timeouts across all routes", async () => {
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: {} } });

    await listFiles(makeReq("GET", { query: "?path=wp-content/themes" }), ctx());
    await readContent(makeReq("GET", { query: "?path=index.php&offset=12&length=256" }), ctx());
    const writeBody = validWriteBody();
    await writeContent(makeReq("PUT", { body: writeBody }), ctx());
    await createFolder(makeReq("POST", { body: { path: "wp-content/new-dir" } }), ctx());
    await moveFiles(makeReq("POST", { body: { from: "a.txt", to: "b/a.txt" } }), ctx());
    await deleteFiles(makeReq("POST", { body: { paths: ["a.txt", "b.txt"] } }), ctx());

    expect(fetchUpstream.mock.calls).toEqual([
      [
        `${BASE_UPSTREAM}/files?path=wp-content%2Fthemes`,
        { method: "GET", accessToken: "tok", timeoutMs: 20_000 },
      ],
      [
        `${BASE_UPSTREAM}/files/content?path=index.php&offset=12&length=256`,
        { method: "GET", accessToken: "tok", timeoutMs: 30_000 },
      ],
      [
        `${BASE_UPSTREAM}/files/content`,
        { method: "PUT", accessToken: "tok", body: writeBody, timeoutMs: 30_000 },
      ],
      [
        `${BASE_UPSTREAM}/files/folders`,
        { method: "POST", accessToken: "tok", body: { path: "wp-content/new-dir" }, timeoutMs: 20_000 },
      ],
      [
        `${BASE_UPSTREAM}/files/move`,
        { method: "POST", accessToken: "tok", body: { from: "a.txt", to: "b/a.txt" }, timeoutMs: 20_000 },
      ],
      [
        `${BASE_UPSTREAM}/files/delete`,
        { method: "POST", accessToken: "tok", body: { paths: ["a.txt", "b.txt"] }, timeoutMs: 60_000 },
      ],
    ]);
  });

  it("clamps GET content length to 524288 and rejects invalid offset or length", async () => {
    fetchUpstream.mockResolvedValue({
      ok: true,
      status: 200,
      data: { data: { dataBase64: "", size: 0, eof: true } },
    });

    const clampedRes = await readContent(
      makeReq("GET", { query: "?path=index.php&offset=0&length=999999" }),
      ctx(),
    );
    expect(clampedRes.status).toBe(200);
    expect(fetchUpstream.mock.calls[0]![0]).toBe(
      `${BASE_UPSTREAM}/files/content?path=index.php&offset=0&length=${SITE_FILE_CHUNK_BYTES}`,
    );

    const defaultedRes = await readContent(
      makeReq("GET", { query: "?path=index.php" }),
      ctx(),
    );
    expect(defaultedRes.status).toBe(200);
    expect(fetchUpstream.mock.calls[1]![0]).toBe(
      `${BASE_UPSTREAM}/files/content?path=index.php&offset=0&length=${SITE_FILE_CHUNK_BYTES}`,
    );

    fetchUpstream.mockReset();
    for (const q of [
      "?path=index.php&offset=-1&length=10",
      "?path=index.php&offset=1.5&length=10",
      "?path=index.php&offset=abc&length=10",
      "?path=index.php&offset=0&length=0",
      "?path=index.php&offset=0&length=-5",
      "?path=index.php&offset=0&length=1.2",
    ]) {
      expect((await readContent(makeReq("GET", { query: q }), ctx())).status).toBe(400);
    }
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("rejects oversized PUT content, invalid uploadId, malformed JSON, and oversized bodies (>1 MiB -> 413)", async () => {
    const overBase64 = await writeContent(
      makeReq("PUT", { body: validWriteBody({ dataBase64: "A".repeat(SITE_FILE_CHUNK_BASE64_MAX + 1) }) }),
      ctx(),
    );
    expect(overBase64.status).toBe(400);

    const badUploadId = await writeContent(
      makeReq("PUT", { body: validWriteBody({ uploadId: "a/b" }) }),
      ctx(),
    );
    expect(badUploadId.status).toBe(400);

    const badHeaderLen = await writeContent(
      makeReq("PUT", {
        headers: { "Content-Length": String(1_048_577) },
        body: validWriteBody(),
      }),
      ctx(),
    );
    expect(badHeaderLen.status).toBe(413);
    expect(ApiErrorEnvelopeSchema.parse(await badHeaderLen.json()).error.code).toBe("VALIDATION_ERROR");

    const overRawBody = await writeContent(
      makeReq("PUT", {
        rawBody: JSON.stringify(validWriteBody({ dataBase64: "A".repeat(1_048_600) })),
      }),
      ctx(),
    );
    expect(overRawBody.status).toBe(413);

    const badJson = await createFolder(
      makeReq("POST", { rawBody: "{not json" }),
      ctx(),
    );
    expect(badJson.status).toBe(400);

    expect(fetchUpstream).not.toHaveBeenCalled();

    // Exact boundary base64 length and empty final chunk pass
    fetchUpstream.mockResolvedValue({ ok: true, status: 200, data: { data: { received: 524288 } } });
    const exactRes = await writeContent(
      makeReq("PUT", { body: validWriteBody({ dataBase64: "A".repeat(SITE_FILE_CHUNK_BASE64_MAX) }) }),
      ctx(),
    );
    expect(exactRes.status).toBe(200);

    const emptyRes = await writeContent(
      makeReq("PUT", { body: validWriteBody({ dataBase64: "", final: true }) }),
      ctx(),
    );
    expect(emptyRes.status).toBe(200);
  });

  it("enforces batch bounds (1..SITE_FILE_BATCH_MAX) on delete and archive", async () => {
    const tooMany = Array.from({ length: SITE_FILE_BATCH_MAX + 1 }, (_, i) => `f-${i}.txt`);
    expect((await deleteFiles(makeReq("POST", { body: { paths: [] } }), ctx())).status).toBe(400);
    expect((await deleteFiles(makeReq("POST", { body: { paths: tooMany } }), ctx())).status).toBe(400);
    expect((await archiveFiles(makeReq("POST", { body: { paths: [], to: "a.zip" } }), ctx())).status).toBe(400);
    expect((await archiveFiles(makeReq("POST", { body: { paths: tooMany, to: "a.zip" } }), ctx())).status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("forwards or generates Idempotency-Key and passes 202 through for archive and extract", async () => {
    const accepted = {
      data: { siteId: "s1", operationId: "op-123" },
      links: { operation: "/v1/organizations/org-1/operations/op-123" },
    };
    fetchUpstream.mockResolvedValue({ ok: true, status: 202, data: accepted });

    const archiveWithKey = await archiveFiles(
      makeReq("POST", {
        headers: { "Idempotency-Key": "browser-key-1" },
        body: { paths: ["index.php"], to: "backup.zip" },
      }),
      ctx(),
    );
    expect(archiveWithKey.status).toBe(202);
    expect(await archiveWithKey.json()).toEqual(accepted);
    expect(fetchUpstream.mock.calls[0]).toEqual([
      `${BASE_UPSTREAM}/files/archive`,
      {
        method: "POST",
        accessToken: "tok",
        idempotencyKey: "browser-key-1",
        body: { paths: ["index.php"], to: "backup.zip" },
        timeoutMs: 120_000,
      },
    ]);

    const extractNoKey = await extractFiles(
      makeReq("POST", {
        body: { path: "backup.zip", to: "" },
      }),
      ctx(),
    );
    expect(extractNoKey.status).toBe(202);
    expect(await extractNoKey.json()).toEqual(accepted);
    const extractOpts = fetchUpstream.mock.calls[1]![1] as {
      method: string;
      idempotencyKey: string;
      timeoutMs: number;
    };
    expect(extractOpts.method).toBe("POST");
    expect(extractOpts.timeoutMs).toBe(120_000);
    expect(extractOpts.idempotencyKey).toMatch(UUID_RE);

    const archiveNoKey = await archiveFiles(
      makeReq("POST", {
        headers: { "Idempotency-Key": "   " },
        body: { paths: ["index.php"], to: "backup.zip" },
      }),
      ctx(),
    );
    expect(archiveNoKey.status).toBe(202);
    const archiveGenOpts = fetchUpstream.mock.calls[2]![1] as { idempotencyKey: string };
    expect(archiveGenOpts.idempotencyKey).toMatch(UUID_RE);
  });

  it("passes upstream error envelopes and status codes through unchanged", async () => {
    const errBody = {
      error: {
        code: "NOT_FOUND",
        message: "Percorso non trovato",
        requestId: "req-404",
        retryable: false,
        details: [{ reason: "not_found", message: "missing" }],
      },
    };
    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 404, error: errBody });
    const res404 = await listFiles(makeReq("GET", { query: "?path=missing" }), ctx());
    expect(res404.status).toBe(404);
    expect(await res404.json()).toEqual(errBody);

    const existsBody = {
      error: {
        code: "ALREADY_EXISTS",
        message: "Esiste già",
        requestId: "req-409",
        retryable: false,
        details: [{ reason: "exists", message: "exists" }],
      },
    };
    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 409, error: existsBody });
    const res409 = await createFolder(makeReq("POST", { body: { path: "wp-content" } }), ctx());
    expect(res409.status).toBe(409);
    expect(await res409.json()).toEqual(existsBody);
  });

  it("builds safe Content-Disposition headers without quotes, backslashes, CR, or LF", () => {
    const cases: Array<[string, string]> = [
      ['café "x".txt', 'attachment; filename="caf_ _x_.txt"; filename*=UTF-8\'\'caf%C3%A9%20%22x%22.txt'],
      ['a"b.txt', 'attachment; filename="a_b.txt"; filename*=UTF-8\'\'a%22b.txt'],
      ["résumé.pdf", "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"],
      ["x\r\ny", "attachment; filename=\"x__y\"; filename*=UTF-8''x%0D%0Ay"],
      ["a\\b.txt", "attachment; filename=\"a_b.txt\"; filename*=UTF-8''a%5Cb.txt"],
      ["100%'a(b)*c.txt", "attachment; filename=\"100%'a(b)*c.txt\"; filename*=UTF-8''100%25%27a%28b%29%2Ac.txt"],
    ];

    for (const [input, expected] of cases) {
      const header = attachmentDisposition(input);
      expect(header).toBe(expected);
      expect(header).not.toMatch(/[\r\n]/);
      const fallbackMatch = /^attachment; filename="([^"]*)"; filename\*=UTF-8''/.exec(header);
      expect(fallbackMatch).not.toBeNull();
      expect(fallbackMatch![1]).not.toMatch(/["\\\r\n]/);
    }
  });

  it("streams multi-chunk downloads in order with safe attachment headers", async () => {
    const part1 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41);
    const part2 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x42);
    const part3 = Buffer.from("0123456789");
    const total = part1.length + part2.length + part3.length;

    const chunks: SiteFileChunkDto[] = [
      { dataBase64: part1.toString("base64"), size: total, eof: false },
      { dataBase64: part2.toString("base64"), size: total, eof: false },
      { dataBase64: part3.toString("base64"), size: total, eof: true },
    ];
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[0] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[1] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: chunks[2] } });

    const res = await downloadFile(
      makeReq("GET", { query: `?path=${encodeURIComponent('docs/café "x".txt')}` }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(total));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="caf_ _x_.txt"; filename*=UTF-8\'\'caf%C3%A9%20%22x%22.txt',
    );

    const out = Buffer.from(await res.arrayBuffer());
    expect(out.equals(Buffer.concat([part1, part2, part3]))).toBe(true);

    expect(fetchUpstream.mock.calls.map(([p, o]) => [p, (o as { timeoutMs: number }).timeoutMs])).toEqual([
      [`${BASE_UPSTREAM}/files/content?path=docs%2Fcaf%C3%A9%20%22x%22.txt&offset=0&length=${SITE_FILE_CHUNK_BYTES}`, 30_000],
      [`${BASE_UPSTREAM}/files/content?path=docs%2Fcaf%C3%A9%20%22x%22.txt&offset=${SITE_FILE_CHUNK_BYTES}&length=${SITE_FILE_CHUNK_BYTES}`, 30_000],
      [`${BASE_UPSTREAM}/files/content?path=docs%2Fcaf%C3%A9%20%22x%22.txt&offset=${SITE_FILE_CHUNK_BYTES * 2}&length=${SITE_FILE_CHUNK_BYTES}`, 30_000],
    ]);
  });

  it("handles special download filenames in headers and empty files", async () => {
    for (const [path, basename] of [
      ['a"b.txt', 'a"b.txt'],
      ["sub/résumé.pdf", "résumé.pdf"],
    ] as const) {
      fetchUpstream.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: { dataBase64: "", size: 0, eof: true } },
      });
      const res = await downloadFile(
        makeReq("GET", { query: `?path=${encodeURIComponent(path)}` }),
        ctx(),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(attachmentDisposition(basename));
      expect(res.headers.get("content-length")).toBe("0");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("returns JSON error on first-chunk failure during download", async () => {
    const errBody = {
      error: {
        code: "NOT_FOUND",
        message: "File non trovato",
        requestId: "req-dl-404",
        retryable: false,
        details: [],
      },
    };
    fetchUpstream.mockResolvedValueOnce({ ok: false, status: 404, error: errBody });

    const res = await downloadFile(makeReq("GET", { query: "?path=missing.zip" }), ctx());
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(errBody);
  });

  it("errors the download stream on mid-stream failure, size change, or premature EOF", async () => {
    const chunk0 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41).toString("base64");
    const total = SITE_FILE_CHUNK_BYTES + 100;

    // 1. Upstream failure on second chunk
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: chunk0, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: false, status: 503, error: { error: { code: "DOCKER_ENGINE_UNAVAILABLE" } } });
    const res1 = await downloadFile(makeReq("GET", { query: "?path=a.bin" }), ctx());
    expect(res1.status).toBe(200);
    await expect(res1.arrayBuffer()).rejects.toThrow();

    // 2. Size changed between chunks
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: chunk0, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: "AQID", size: total + 1, eof: true } } });
    const res2 = await downloadFile(makeReq("GET", { query: "?path=a.bin" }), ctx());
    await expect(res2.arrayBuffer()).rejects.toThrow();

    // 3. Premature EOF before expected size
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: chunk0, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: "AQID", size: total, eof: true } } });
    const res3 = await downloadFile(makeReq("GET", { query: "?path=a.bin" }), ctx());
    await expect(res3.arrayBuffer()).rejects.toThrow();

    // 4. Empty chunk with !eof
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: chunk0, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: "", size: total, eof: false } } });
    const res4 = await downloadFile(makeReq("GET", { query: "?path=a.bin" }), ctx());
    await expect(res4.arrayBuffer()).rejects.toThrow();

    // 5. Rejected upstream promise mid-stream
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: chunk0, size: total, eof: false } } })
      .mockRejectedValueOnce(new Error("socket reset"));
    const res5 = await downloadFile(makeReq("GET", { query: "?path=a.bin" }), ctx());
    await expect(res5.arrayBuffer()).rejects.toThrow();
  });

  it("stops fetching chunks when the download consumer cancels the stream", async () => {
    const part = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41).toString("base64");
    const total = SITE_FILE_CHUNK_BYTES * 3;
    fetchUpstream
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: part, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: part, size: total, eof: false } } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: { dataBase64: part, size: total, eof: true } } });

    const res = await downloadFile(makeReq("GET", { query: "?path=big.zip" }), ctx());
    const reader = res.body!.getReader();
    await reader.read(); // chunk 0 (from pre-fetched first chunk)
    await reader.read(); // chunk 1 (2nd fetchUpstream call)
    await reader.cancel();
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });

  it("allows backslash filenames in paths matching SiteFilePathSchema (e.g., deleting a\\b)", async () => {
    expect(isSafeFilePath("a\\b", false)).toBe(true);
    fetchUpstream.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { data: { deleted: ["a\\b"] } },
    });

    const res = await deleteFiles(makeReq("POST", { body: { paths: ["a\\b"] } }), ctx());
    expect(res.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledWith(`${BASE_UPSTREAM}/files/delete`, {
      method: "POST",
      accessToken: "tok",
      body: { paths: ["a\\b"] },
      timeoutMs: 60_000,
    });
  });
});
