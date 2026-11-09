import { NextResponse } from "next/server";
import { getSessionFromRequest } from "./server-session";
import { validateCsrfAndOrigin } from "./bff-guard";
import { bffErrorResponse, bffJsonResponse } from "./bff-response";
import { fetchUpstream, type UpstreamResponse } from "./upstream";
import type { SessionData } from "./session";

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
  opts?: { timeoutMs?: number }
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
    const raw = await req.text();
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
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
