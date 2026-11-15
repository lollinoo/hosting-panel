import { createHash, createHmac, randomBytes } from "node:crypto";
import type { BackupFailureClass, BackupTarget } from "@hosting-panel/contracts";

export const S3_PROBE_REQUEST_TIMEOUT_MS = 8_000 as const;
export const S3_PROBE_BUDGET_MS = 12_000 as const;
const S3_PROBE_MAX_BODY_BYTES = 64 * 1024;

const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
  "UND_ERR_ABORTED",
]);

const TLS_CODE_PATTERN = /^(?:CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;
const XML_CODE_PATTERN = /<Code>\s*([^<\s]+)\s*<\/Code>/i;

const sha256Hex = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmacSha256 = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

const compareCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Percent-encodes a URI component per RFC 3986 for AWS SigV4 canonicalization. */
const encodeRfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function encodePathSegment(segment: string): string {
  try {
    return encodeRfc3986(decodeURIComponent(segment));
  } catch {
    return encodeRfc3986(segment);
  }
}

/** Error thrown by S3 transport requests with only the classified failure class in its message. */
export class S3RequestError extends Error {
  public readonly problem: BackupFailureClass;

  public constructor(problem: BackupFailureClass) {
    super(`S3 request failed (${problem})`);
    this.name = "S3RequestError";
    this.problem = problem;
  }
}

/** Computes an AWS Signature Version 4 Authorization header value. */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}): string {
  const day = input.amzDate.slice(0, 8);
  const canonicalUri =
    input.url.pathname.split("/").map(encodePathSegment).join("/") || "/";

  const queryPairs = [...input.url.searchParams.entries()].map(
    ([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const,
  );
  queryPairs.sort((a, b) => compareCodePoint(a[0], b[0]) || compareCodePoint(a[1], b[1]));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");

  const normalizedHeaders = new Map<string, string>();
  for (const [key, value] of Object.entries(input.headers)) {
    const lowerKey = key.toLowerCase();
    const collapsed = value.trim().replace(/\s+/g, " ");
    const prev = normalizedHeaders.get(lowerKey);
    normalizedHeaders.set(lowerKey, prev !== undefined ? `${prev},${collapsed}` : collapsed);
  }

  const signedHeaderList = [...normalizedHeaders.keys()].sort(compareCodePoint);
  const canonicalHeaders = signedHeaderList
    .map((key) => `${key}:${normalizedHeaders.get(key)}\n`)
    .join("");
  const signedHeaders = signedHeaderList.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = [day, input.region, input.service, "aws4_request"].reduce<Buffer | string>(
    (key, part) => hmacSha256(key, part),
    `AWS4${input.secretAccessKey}`,
  );
  const signature = hmacSha256(signingKey, stringToSign).toString("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function classifyFetchError(err: unknown): BackupFailureClass {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const cur = queue.shift();
    if (typeof cur !== "object" || cur === null || seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    const rec = cur as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (rec.name === "AbortError" || rec.name === "TimeoutError") {
      return "unreachable";
    }
    if (typeof rec.code === "string") {
      if (TLS_CODE_PATTERN.test(rec.code) || rec.code === "EPROTO") {
        return "tls_failed";
      }
      if (UNREACHABLE_CODES.has(rec.code)) {
        return "unreachable";
      }
    }
    if (rec.cause !== undefined) {
      queue.push(rec.cause);
    }
    if (Array.isArray(rec.errors)) {
      queue.push(...rec.errors);
    }
  }
  return "other";
}

function classifyS3HttpError(
  step: "get" | "put" | "delete",
  status: number,
  bodyText: string,
): BackupFailureClass {
  const s3Code = XML_CODE_PATTERN.exec(bodyText)?.[1] ?? "";
  if (
    s3Code === "SignatureDoesNotMatch" ||
    s3Code === "InvalidAccessKeyId" ||
    s3Code === "InvalidToken" ||
    s3Code === "ExpiredToken"
  ) {
    return "auth_failed";
  }
  if (s3Code === "NoSuchBucket" || (status === 404 && step === "get")) {
    return "bucket_missing";
  }
  if (
    s3Code === "AuthorizationHeaderMalformed" ||
    s3Code === "PermanentRedirect" ||
    s3Code === "TemporaryRedirect" ||
    s3Code === "IllegalLocationConstraintException" ||
    status === 301 ||
    (status >= 300 && status < 400 && s3Code === "") ||
    (status === 400 && /\bregion\b/i.test(bodyText))
  ) {
    return "wrong_region";
  }
  if (status === 403 || s3Code === "AccessDenied") {
    return step === "get" ? "auth_failed" : "write_denied";
  }
  return "other";
}

async function readBoundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean }> {
  if (!body) {
    return { body: Buffer.alloc(0), truncated: false };
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  let cleanupAbort: (() => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      cleanupAbort = () => signal.removeEventListener("abort", onAbort);
    }
  });
  abortPromise.catch(() => undefined);

  const readLoop = async (): Promise<{ body: Buffer; truncated: boolean }> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.byteLength > 0) {
          const remaining = maxBytes - totalBytes;
          if (value.byteLength > remaining) {
            if (remaining > 0) {
              chunks.push(Buffer.from(value.subarray(0, remaining)));
            }
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(Buffer.from(value));
          totalBytes += value.byteLength;
        }
      }
      return { body: Buffer.concat(chunks), truncated };
    } finally {
      reader.releaseLock();
    }
  };

  try {
    const readPromise = readLoop();
    readPromise.catch(() => undefined);
    return await Promise.race([readPromise, abortPromise]);
  } finally {
    cleanupAbort?.();
  }
}

async function sendS3Request(
  target: BackupTarget,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
  query?: Record<string, string>,
  opts?: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  },
): Promise<{ status: number; body: Buffer; truncated: boolean }> {
  const base = new URL(target.endpoint);
  const cleanKey = key.replace(/^\/+/, "");
  const uriPath = `/${encodeRfc3986(target.bucket)}${
    cleanKey ? `/${cleanKey.split("/").map(encodeRfc3986).join("/")}` : ""
  }`;
  const queryString = query
    ? Object.keys(query)
        .sort(compareCodePoint)
        .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k] ?? "")}`)
        .join("&")
    : "";

  const url = new URL(`${base.origin}${uriPath}${queryString ? `?${queryString}` : ""}`);
  const payload = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payload);
  const amzDate = (opts?.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, "");

  const signedHeaders: Record<string, string> = {
    host: base.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const authorization = signV4({
    method,
    url,
    headers: signedHeaders,
    payloadHash,
    region: target.region,
    service: "s3",
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    amzDate,
  });

  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1, Math.floor(opts?.timeoutMs ?? S3_PROBE_REQUEST_TIMEOUT_MS));
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const res = await fetchFn(url.toString(), {
      method,
      headers: { ...signedHeaders, authorization },
      redirect: "manual",
      ...(method === "PUT" && body !== undefined ? { body: new Uint8Array(body) } : {}),
      signal,
    });
    const { body: responseBody, truncated } = await readBoundedResponseBody(
      res.body,
      S3_PROBE_MAX_BODY_BYTES,
      signal,
    );
    return { status: res.status, body: responseBody, truncated };
  } catch (err) {
    throw new S3RequestError(classifyFetchError(err));
  }
}

/** Sends one SigV4-signed path-style S3 request without leaking credentials in errors. */
export async function s3Request(
  target: BackupTarget,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
  query?: Record<string, string>,
  opts?: {
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  },
): Promise<{ status: number; body: Buffer }> {
  const res = await sendS3Request(target, method, key, body, query, opts);
  return { status: res.status, body: res.body };
}

/** Verifies S3 connectivity, credentials, bucket existence, and write/delete permissions within budget. */
export async function probeS3(
  target: BackupTarget,
  opts?: {
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    requestTimeoutMs?: number;
    budgetMs?: number;
  },
): Promise<{ problem: BackupFailureClass | null }> {
  const nowFn = opts?.now ?? (() => new Date());
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const requestTimeoutMs = opts?.requestTimeoutMs ?? S3_PROBE_REQUEST_TIMEOUT_MS;
  const budgetMs = opts?.budgetMs ?? S3_PROBE_BUDGET_MS;
  const deadline = nowFn().getTime() + budgetMs;

  const callStep = async (
    step: "get" | "put" | "delete",
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Buffer,
    query?: Record<string, string>,
  ): Promise<BackupFailureClass | null> => {
    const remaining = deadline - nowFn().getTime();
    if (remaining <= 0) {
      return "unreachable";
    }
    try {
      const res = await sendS3Request(target, method, key, body, query, {
        fetch: fetchFn,
        now: nowFn,
        timeoutMs: Math.min(requestTimeoutMs, remaining),
      });
      if (res.status >= 200 && res.status < 300) {
        return res.truncated ? "other" : null;
      }
      return classifyS3HttpError(step, res.status, res.body.toString("utf8"));
    } catch (err) {
      return err instanceof S3RequestError ? err.problem : classifyFetchError(err);
    }
  };

  const listPrefix = target.prefix ? `${target.prefix}/` : "";
  const listProblem = await callStep("get", "GET", "", undefined, {
    "list-type": "2",
    "max-keys": "1",
    prefix: listPrefix,
  });
  if (listProblem !== null) {
    return { problem: listProblem };
  }

  const probeId = randomBytes(8).toString("hex");
  const probeKey = target.prefix
    ? `${target.prefix}/.hp-probe-${probeId}`
    : `.hp-probe-${probeId}`;
  const putProblem = await callStep("put", "PUT", probeKey, Buffer.from("hp", "utf8"));
  if (putProblem !== null) {
    return { problem: putProblem };
  }

  const deleteProblem = await callStep("delete", "DELETE", probeKey);
  return { problem: deleteProblem };
}
