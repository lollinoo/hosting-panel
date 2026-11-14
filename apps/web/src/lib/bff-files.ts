import { randomUUID } from "node:crypto";
import {
  SITE_FILE_BATCH_MAX,
  SITE_FILE_CHUNK_BASE64_MAX,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_PATH_MAX,
  SITE_FILE_SEGMENT_MAX_BYTES,
} from "@hosting-panel/contracts";
import { validateCsrfAndOrigin, validatePathSegments } from "./bff-guard";
import { bffUpstreamResponse } from "./bff-proxy";
import { bffErrorResponse } from "./bff-response";
import { getSessionFromRequest } from "./server-session";
import { fetchUpstream } from "./upstream";

export const FILE_CHUNK_BYTES = SITE_FILE_CHUNK_BYTES;
export const MAX_CHUNK_BASE64 = SITE_FILE_CHUNK_BASE64_MAX;
export const MAX_BFF_BODY_BYTES = 1_048_576;

export type SiteCtx = { params: Promise<Record<string, string>> };

export interface ForwardSiteCallOptions {
  timeoutMs: number;
  query?: (u: URLSearchParams) => string | null;
  body?: (b: unknown) => boolean;
  idempotency?: boolean;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a customer-supplied site-relative file path before forwarding to the API.
 * Not a security boundary (the executor's mount namespace is), just early hygiene.
 */
export function isSafeFilePath(p: unknown, allowRoot: boolean): p is string {
  if (typeof p !== "string") return false;
  if (p === "") return allowRoot;
  if (p.length > SITE_FILE_PATH_MAX) return false;

  for (let i = 0; i < p.length; i += 1) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }

  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".htpanel-")) {
      return false;
    }
    if (Buffer.byteLength(seg, "utf8") > SITE_FILE_SEGMENT_MAX_BYTES) {
      return false;
    }
  }
  return true;
}

export function isSafeFilePathBatch(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= SITE_FILE_BATCH_MAX &&
    v.every((p) => isSafeFilePath(p, false))
  );
}

/** Builds a safe Content-Disposition attachment header with ASCII fallback and RFC 5987 filename*. */
export function attachmentDisposition(name: string): string {
  const safeName = name.length > 0 ? name : "download";
  const fallback = safeName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  let encoded: string;
  try {
    encoded = encodeURIComponent(safeName);
  } catch {
    // Fallback for malformed lone UTF-16 surrogates.
    encoded = encodeURIComponent(fallback);
  }
  const rfc5987 = encoded.replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987}`;
}

export async function forwardSiteCall(
  req: Request,
  context: SiteCtx,
  sub: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  opts: ForwardSiteCallOptions,
): Promise<Response> {
  const params = await context.params;
  const segments: Record<string, string> = {
    orgId: params.orgId ?? "",
    siteId: params.siteId ?? "",
    ...params,
  };
  const segmentError = validatePathSegments(segments);
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (method === "GET") {
    if (!session) {
      return bffErrorResponse("UNAUTHENTICATED", "Sessione non autenticata o scaduta", 401);
    }
  } else {
    const guardError = validateCsrfAndOrigin(req, session);
    if (guardError) return guardError;
  }

  let body: unknown;
  if (method !== "GET") {
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_BFF_BODY_BYTES) {
        return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413);
      }
    }

    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BFF_BODY_BYTES) {
      return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413);
    }

    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
    }

    if (opts.body && !opts.body(body)) {
      return bffErrorResponse("VALIDATION_ERROR", "Dati della richiesta non validi", 400);
    }
  }

  let querySuffix = "";
  if (opts.query) {
    let searchParams: URLSearchParams;
    try {
      searchParams = new URL(req.url).searchParams;
    } catch {
      return bffErrorResponse("VALIDATION_ERROR", "URL della richiesta non valido", 400);
    }
    const qs = opts.query(searchParams);
    if (qs === null) {
      return bffErrorResponse("VALIDATION_ERROR", "Parametri di ricerca non validi", 400);
    }
    if (qs.length > 0) {
      querySuffix = `?${qs}`;
    }
  }

  const rawIdempotencyKey = opts.idempotency
    ? req.headers.get("idempotency-key")?.trim()
    : undefined;
  const idempotencyKey = opts.idempotency
    ? rawIdempotencyKey && rawIdempotencyKey.length > 0
      ? rawIdempotencyKey
      : randomUUID()
    : undefined;

  const upstreamPath = `v1/organizations/${segments.orgId}/managed-sites/${segments.siteId}/${sub}${querySuffix}`;
  const upstreamRes = await fetchUpstream(upstreamPath, {
    method,
    accessToken: session!.accessToken,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(body !== undefined ? { body } : {}),
    timeoutMs: opts.timeoutMs,
  });
  return bffUpstreamResponse(upstreamRes);
}
