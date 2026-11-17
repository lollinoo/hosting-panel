import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import { readBoundedJsonBody } from "@/lib/bff-proxy";

export async function POST(
  req: Request,
  context: { params: Promise<{ orgId: string; siteId: string }> }
) {
  const { orgId, siteId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return bffErrorResponse(
      "VALIDATION_ERROR",
      "Intestazione Idempotency-Key obbligatoria",
      400,
      [{ field: "idempotency-key", message: "Intestazione richiesta" }]
    );
  }

  const read = await readBoundedJsonBody(req, { requireJsonBody: true });
  if (!read.ok) return read.response;
  const body = read.body;

  const upstreamRes = await fetchUpstream(
    `v1/organizations/${orgId}/sites/${siteId}/services`,
    {
      method: "POST",
      accessToken: session!.accessToken,
      idempotencyKey,
      body,
    }
  );

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
