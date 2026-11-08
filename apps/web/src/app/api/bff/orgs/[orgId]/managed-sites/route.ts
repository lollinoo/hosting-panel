import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function POST(req: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const segmentError = validatePathSegments({ orgId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return bffErrorResponse("VALIDATION_ERROR", "Intestazione Idempotency-Key obbligatoria per la creazione del sito", 400, [
      { field: "idempotency-key", message: "Intestazione richiesta" },
    ]);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }

  const upstreamRes = await fetchUpstream(`v1/organizations/${orgId}/managed-sites`, {
    method: "POST",
    accessToken: session!.accessToken,
    idempotencyKey,
    body,
  });
  if (!upstreamRes.ok) return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
