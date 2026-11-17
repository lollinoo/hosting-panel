import { createHash } from "node:crypto";
import http from "node:http";
import type { BackupFailureClass, BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeS3, s3Request, signV4 } from "../src/s3-probe.js";

const SECRET_SENTINEL = "sentinel-s3-secret-key-do-not-leak-xyz";
const ACCESS_KEY_SENTINEL = "AKIASENTINELACCESSKEY999";

const BASE_TARGET: BackupTarget = {
  endpoint: "https://s3.example.com:9000",
  region: "us-east-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: ACCESS_KEY_SENTINEL,
  secretAccessKey: SECRET_SENTINEL,
};

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function xmlError(code: string, message = code): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

describe("s3-probe SigV4 signing", () => {
  it("matches AWS SigV4 get-vanilla test vector", () => {
    const auth = signV4({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {
        host: "example.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });

    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("matches AWS S3 GET Object test vector", () => {
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });

    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches AWS S3 Get Bucket (ListObjects) test vector", () => {
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });

    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("probeS3", () => {
  it("runs GET list, PUT probe, and DELETE probe and returns null problem on 200/200/204", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
    const fetchMock: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hdrs = init?.headers as Record<string, string>;
      const bodyStr = init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "";
      calls.push({ url, method: init?.method ?? "GET", headers: hdrs, body: bodyStr });
      if (calls.length === 1) return new Response("<ListBucketResult/>", { status: 200 });
      if (calls.length === 2) return new Response("", { status: 200 });
      return new Response(null, { status: 204 });
    });

    const result = await probeS3(BASE_TARGET, {
      fetch: fetchMock,
      now: () => new Date("2026-11-15T01:00:00.000Z"),
    });

    expect(result).toEqual({ problem: null });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "https://s3.example.com:9000/panel-backups?list-type=2&max-keys=1&prefix=prod%2F",
    );
    expect(calls[1]!.method).toBe("PUT");
    expect(calls[1]!.url).toMatch(
      /^https:\/\/s3\.example\.com:9000\/panel-backups\/prod\/\.hp-probe-[0-9a-f]{16}$/,
    );
    expect(calls[1]!.body).toBe("hp");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url).toBe(calls[1]!.url);
    for (const c of calls) {
      expect(c.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
      expect(c.headers["x-amz-date"]).toBe("20261115T010000Z");
      expect(c.headers.authorization).toContain(`Credential=${ACCESS_KEY_SENTINEL}/20261115/us-east-1/s3/aws4_request`);
    }
  });

  it("handles an empty prefix without inserting a leading slash", async () => {
    const urls: string[] = [];
    const fetchMock: typeof globalThis.fetch = vi.fn(async (input, init) => {
      urls.push(String(input));
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response("", { status: 200 });
    });

    const result = await probeS3({ ...BASE_TARGET, prefix: "" }, { fetch: fetchMock });
    expect(result).toEqual({ problem: null });
    expect(urls[0]).toBe("https://s3.example.com:9000/panel-backups?list-type=2&max-keys=1&prefix=");
    expect(urls[1]).toMatch(/^https:\/\/s3\.example\.com:9000\/panel-backups\/\.hp-probe-[0-9a-f]{16}$/);
    expect(urls[2]).toBe(urls[1]);
  });

  it("maps S3 HTTP error responses to the exact failure classes", async () => {
    const cases: Array<{
      name: string;
      responses: Array<{ status: number; body: string }>;
      expected: BackupFailureClass;
    }> = [
      {
        name: "404 NoSuchBucket",
        responses: [{ status: 404, body: xmlError("NoSuchBucket") }],
        expected: "bucket_missing",
      },
      {
        name: "403 SignatureDoesNotMatch",
        responses: [{ status: 403, body: xmlError("SignatureDoesNotMatch") }],
        expected: "auth_failed",
      },
      {
        name: "403 InvalidAccessKeyId",
        responses: [{ status: 403, body: xmlError("InvalidAccessKeyId") }],
        expected: "auth_failed",
      },
      {
        name: "403 AccessDenied on list",
        responses: [{ status: 403, body: xmlError("AccessDenied") }],
        expected: "auth_failed",
      },
      {
        name: "403 AccessDenied on PUT",
        responses: [
          { status: 200, body: "<ListBucketResult/>" },
          { status: 403, body: xmlError("AccessDenied") },
        ],
        expected: "write_denied",
      },
      {
        name: "400 AuthorizationHeaderMalformed",
        responses: [{ status: 400, body: xmlError("AuthorizationHeaderMalformed", "wrong region") }],
        expected: "wrong_region",
      },
      {
        name: "301 PermanentRedirect",
        responses: [{ status: 301, body: xmlError("PermanentRedirect") }],
        expected: "wrong_region",
      },
      {
        name: "400 body naming region",
        responses: [{ status: 400, body: "Invalid region specified: expected eu-west-1" }],
        expected: "wrong_region",
      },
      {
        name: "500 InternalError",
        responses: [{ status: 500, body: xmlError("InternalError") }],
        expected: "other",
      },
    ];

    for (const c of cases) {
      let idx = 0;
      const fetchMock: typeof globalThis.fetch = vi.fn(async () => {
        const next = c.responses[idx++] ?? { status: 500, body: "" };
        return new Response(next.body, { status: next.status });
      });
      const res = await probeS3(BASE_TARGET, { fetch: fetchMock });
      expect(res, c.name).toEqual({ problem: c.expected });
    }
  });

  it("always attempts DELETE after a PUT that succeeded", async () => {
    const methods: string[] = [];
    const fetchMock: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      const m = init?.method ?? "GET";
      methods.push(m);
      if (m === "GET" || m === "PUT") {
        return new Response("", { status: 200 });
      }
      return new Response(xmlError("AccessDenied"), { status: 403 });
    });

    const result = await probeS3(BASE_TARGET, { fetch: fetchMock });
    expect(methods).toEqual(["GET", "PUT", "DELETE"]);
    expect(result).toEqual({ problem: "write_denied" });
  });

  it("maps fetch cause.code and aborts to unreachable or tls_failed", async () => {
    const cases: Array<{ err: unknown; expected: BackupFailureClass }> = [
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
        expected: "unreachable",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
        expected: "unreachable",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }),
        expected: "unreachable",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
        expected: "unreachable",
      },
      {
        err: new DOMException("Aborted", "AbortError"),
        expected: "unreachable",
      },
      {
        err: new DOMException("Timed out", "TimeoutError"),
        expected: "unreachable",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
        expected: "tls_failed",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), {
          cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
        }),
        expected: "tls_failed",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ERR_SSL_WRONG_VERSION_NUMBER" },
        }),
        expected: "tls_failed",
      },
      {
        err: Object.assign(new TypeError("fetch failed"), { cause: { code: "EPROTO" } }),
        expected: "tls_failed",
      },
    ];

    for (const c of cases) {
      const fetchMock: typeof globalThis.fetch = vi.fn(async () => {
        throw c.err;
      });
      const res = await probeS3(BASE_TARGET, { fetch: fetchMock });
      expect(res).toEqual({ problem: c.expected });
    }
  });

  it("stays inside the shared budget with a fake clock", async () => {
    let nowMs = 1_000_000;
    const methods: string[] = [];
    const fetchMock: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      nowMs += 7_000;
      return new Response("", { status: 200 });
    });

    const result = await probeS3(BASE_TARGET, {
      fetch: fetchMock,
      now: () => new Date(nowMs),
      requestTimeoutMs: 8_000,
      budgetMs: 12_000,
    });

    expect(result).toEqual({ problem: "unreachable" });
    expect(methods).toEqual(["GET", "PUT"]);
    expect(nowMs - 1_000_000).toBe(14_000);
  });

  it("never exposes secrets or credentials in thrown errors from s3Request or probeS3", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected TCP address");
    }
    const port = addr.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const localTarget: BackupTarget = {
      ...BASE_TARGET,
      endpoint: `http://127.0.0.1:${String(port)}`,
    };

    const err = await s3Request(localTarget, "PUT", "prod/obj", Buffer.from("hp")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("unreachable");
    expect(msg).not.toContain(SECRET_SENTINEL);
    expect(msg).not.toContain(ACCESS_KEY_SENTINEL);
    expect(msg).not.toContain(localTarget.endpoint);

    const fetchWithSecretLeak: typeof globalThis.fetch = vi.fn(async () => {
      throw Object.assign(
        new Error(`boom ${SECRET_SENTINEL} ${ACCESS_KEY_SENTINEL} https://s3.example.com`),
        { cause: { code: "ECONNREFUSED" } },
      );
    });
    const thrownFromS3Req = await s3Request(
      BASE_TARGET,
      "GET",
      "",
      undefined,
      { "list-type": "2" },
      { fetch: fetchWithSecretLeak },
    ).catch((e: unknown) => e);
    expect(thrownFromS3Req).toBeInstanceOf(Error);
    expect((thrownFromS3Req as Error).message).not.toContain(SECRET_SENTINEL);
    expect((thrownFromS3Req as Error).message).not.toContain(ACCESS_KEY_SENTINEL);

    await expect(
      probeS3(BASE_TARGET, { fetch: fetchWithSecretLeak }),
    ).resolves.toEqual({ problem: "unreachable" });
  });

  it("executes real signed GET/PUT/DELETE over HTTP against a local server", async () => {
    const seen: Array<{ method: string; url: string; auth: string; sha256: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization ?? "",
          sha256: String(req.headers["x-amz-content-sha256"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(req.method === "DELETE" ? 204 : 200);
        res.end(req.method === "GET" ? "bucket-ok" : "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanupTasks.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Expected TCP address");
    }
    const target: BackupTarget = {
      ...BASE_TARGET,
      endpoint: `http://127.0.0.1:${String(addr.port)}`,
    };

    const putRes = await s3Request(target, "PUT", "");
    expect(putRes.status).toBe(200);
    const getRes = await s3Request(target, "GET", "", undefined, { "list-type": "2", prefix: "prod/" });
    expect(getRes.status).toBe(200);
    expect(getRes.body.toString("utf8")).toBe("bucket-ok");
    const delRes = await s3Request(target, "DELETE", "prod/.hp-probe-123");
    expect(delRes.status).toBe(204);

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "PUT /panel-backups",
      "GET /panel-backups?list-type=2&prefix=prod%2F",
      "DELETE /panel-backups/prod/.hp-probe-123",
    ]);
    for (const s of seen) {
      expect(s.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIASENTINELACCESSKEY999\//);
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("passes redirect: 'manual' on every request and maps 307 without S3 code to wrong_region without a second request", async () => {
    const redirectsSeen: Array<RequestRedirect | undefined> = [];
    const okFetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      redirectsSeen.push(init?.redirect);
      return init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response("", { status: 200 });
    });

    await expect(probeS3(BASE_TARGET, { fetch: okFetch })).resolves.toEqual({ problem: null });
    expect(redirectsSeen).toEqual(["manual", "manual", "manual"]);

    const redirectFetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response("<html>Redirecting</html>", {
        status: 307,
        headers: { location: "http://127.0.0.1:9999/secret" },
      });
    });

    const redirectRes = await probeS3(BASE_TARGET, { fetch: redirectFetch });
    expect(redirectRes).toEqual({ problem: "wrong_region" });
    expect(redirectFetch).toHaveBeenCalledTimes(1);
  });

  it("caps response reading at 64 KiB, cancels endless streams, and returns a failure class within budget", async () => {
    let chunksPulled = 0;
    let streamCancelled = false;
    const endlessFastStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        if (chunksPulled > 200) {
          // Safety fuse so an unfixed reader fails the assertion instead of exhausting heap.
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(16 * 1024).fill(0x41));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const fastFetch: typeof globalThis.fetch = vi.fn(async () => {
      return new Response(endlessFastStream, { status: 200 });
    });

    const fastRes = await probeS3(BASE_TARGET, {
      fetch: fastFetch,
      requestTimeoutMs: 500,
      budgetMs: 1_000,
    });
    expect(fastRes.problem).toBe("other");
    expect(streamCancelled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(6);

    let stalledCancelled = false;
    const stalledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x3c]));
      },
      cancel() {
        stalledCancelled = true;
      },
    });
    const stalledFetch: typeof globalThis.fetch = vi.fn(async () => {
      return new Response(stalledStream, { status: 200 });
    });

    const t0 = performance.now();
    const stalledRes = await probeS3(BASE_TARGET, {
      fetch: stalledFetch,
      requestTimeoutMs: 50,
      budgetMs: 300,
    });
    const elapsedMs = performance.now() - t0;
    expect(stalledRes.problem).toBe("unreachable");
    expect(stalledCancelled).toBe(true);
    expect(elapsedMs).toBeLessThan(300);
  });
});
