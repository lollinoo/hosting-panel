import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffErrorResponse } from "@/lib/bff-response";
import { bffUpstreamResponse } from "@/lib/bff-proxy";
import { fetchUpstream } from "@/lib/upstream";

/** Admin mutation pass-through: CSRF + Origin, path segments checked, Idempotency-Key and JSON body required. */
export async function forwardIdempotent(
  req: Request,
  segments: Record<string, string>,
  upstreamPath: string,
  method: "POST" | "DELETE",
) {
  const segmentError = validatePathSegments(segments);
  if (segmentError) return segmentError;
  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return bffErrorResponse("VALIDATION_ERROR", "Intestazione Idempotency-Key obbligatoria", 400, [
      { field: "idempotency-key", message: "Intestazione richiesta" },
    ]);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }
  return bffUpstreamResponse(
    await fetchUpstream(upstreamPath, { method, accessToken: session!.accessToken, idempotencyKey, body }),
  );
}
