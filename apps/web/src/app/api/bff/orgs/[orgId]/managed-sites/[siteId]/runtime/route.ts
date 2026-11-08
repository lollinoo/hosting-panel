import { ChangeSiteRuntimeInputSchema } from "@hosting-panel/contracts";
import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function PATCH(req: Request, context: { params: Promise<{ orgId: string; siteId: string }> }) {
  const { orgId, siteId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return bffErrorResponse("VALIDATION_ERROR", "Intestazione Idempotency-Key obbligatoria per il cambio di versione PHP", 400, [
      { field: "idempotency-key", message: "Intestazione richiesta" },
    ]);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }
  const body = ChangeSiteRuntimeInputSchema.safeParse(raw);
  if (!body.success) {
    return bffErrorResponse("VALIDATION_ERROR", "Versione PHP non supportata", 400, [
      { field: "phpVersion", message: "Valore non ammesso" },
    ]);
  }

  const upstreamRes = await fetchUpstream(`v1/organizations/${orgId}/managed-sites/${siteId}/runtime`, {
    method: "PATCH",
    accessToken: session!.accessToken,
    idempotencyKey,
    body: body.data,
  });
  if (!upstreamRes.ok) return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
