import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import { readBoundedJsonBody } from "@/lib/bff-proxy";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ hostId: string }> }
) {
  const { hostId } = await context.params;
  const segmentError = validatePathSegments({ hostId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const read = await readBoundedJsonBody(req, { requireJsonBody: true });
  if (!read.ok) return read.response;
  const body = read.body;

  const idempotencyKey = req.headers.get("idempotency-key");

  const upstreamRes = await fetchUpstream(`v1/hosts/${hostId}/mode`, {
    method: "PATCH",
    accessToken: session!.accessToken,
    idempotencyKey,
    body,
  });

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
