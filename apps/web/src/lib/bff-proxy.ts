import { NextResponse } from "next/server";
import { getSessionFromRequest } from "./server-session";
import { validateCsrfAndOrigin } from "./bff-guard";
import { bffErrorResponse, bffJsonResponse } from "./bff-response";
import { fetchUpstream, type UpstreamResponse } from "./upstream";
import type { SessionData } from "./session";

export const MAX_BFF_BODY_BYTES = 1_048_576;

export type BoundedJsonBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse };

// Read request text incrementally so oversized streams abort once above maxBytes.
export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body || typeof req.body.getReader !== "function") {
    const raw = await req.text();
    return Buffer.byteLength(raw, "utf8") > maxBytes ? null : raw;
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

// JSON is UTF-8 (RFC 8259); no other charset is read.
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;

function unsupportedContentType(): BoundedJsonBodyResult {
  return {
    ok: false,
    response: bffErrorResponse("VALIDATION_ERROR", "Tipo di contenuto non supportato: inviare application/json", 415),
  };
}

// Check Content-Type, Content-Length, stream size (1 MiB cap), and JSON syntax before calling upstream.
// A cross-site form can post text/plain or a form type without a preflight; the panel's pages send JSON.
export async function readBoundedJsonBody(
  req: Request,
  opts?: { requireJsonBody?: boolean },
): Promise<BoundedJsonBodyResult> {
  const contentType = req.headers.get("content-type");
  if (contentType !== null ? !JSON_CONTENT_TYPE.test(contentType.trim()) : opts?.requireJsonBody) {
    return unsupportedContentType();
  }

  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_BFF_BODY_BYTES) {
      return {
        ok: false,
        response: bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413),
      };
    }
  }

  const raw = await readBoundedText(req, MAX_BFF_BODY_BYTES);
  if (raw === null) {
    return {
      ok: false,
      response: bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta troppo grande", 413),
    };
  }

  if (!raw) {
    if (opts?.requireJsonBody) {
      return {
        ok: false,
        response: bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400),
      };
    }
    return { ok: true, body: undefined };
  }
  // A body with no type at all (an untyped Blob) is not the panel's JSON either.
  if (contentType === null) return unsupportedContentType();

  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return {
      ok: false,
      response: bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400),
    };
  }
}

/** Upstream result → browser response; upstream error code and status pass through. */
export function bffUpstreamResponse(upstreamRes: UpstreamResponse): NextResponse {
  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }
  if (upstreamRes.status === 204) {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}

/**
 * Authenticated pass-through to the API. Mutating methods are CSRF + Origin checked;
 * callers validate path segments before building `upstreamPath`.
 */
export async function forwardToUpstream(
  req: Request,
  upstreamPath: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  onSuccess?: (session: SessionData, body: unknown, response: NextResponse) => Promise<void>,
  opts?: { timeoutMs?: number; body?: (b: unknown) => boolean }
): Promise<NextResponse> {
  const session = await getSessionFromRequest(req);
  if (method === "GET") {
    if (!session) return bffErrorResponse("UNAUTHENTICATED", "Sessione non autenticata o scaduta", 401);
  } else {
    const guardError = validateCsrfAndOrigin(req, session);
    if (guardError) return guardError;
  }

  let body: unknown;
  if (method !== "GET") {
    const parsed = await readBoundedJsonBody(req);
    if (!parsed.ok) return parsed.response;
    body = parsed.body;
    if (opts?.body && !opts.body(body)) {
      return bffErrorResponse("VALIDATION_ERROR", "Dati della richiesta non validi", 400);
    }
  }

  const upstreamRes = await fetchUpstream(upstreamPath, {
    method,
    accessToken: session!.accessToken,
    body,
    timeoutMs: opts?.timeoutMs,
  });
  const response = bffUpstreamResponse(upstreamRes);
  if (upstreamRes.ok && onSuccess) await onSuccess(session!, body, response);
  return response;
}
