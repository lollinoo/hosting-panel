import { randomUUID } from "node:crypto";
import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import { readBoundedJsonBody } from "@/lib/bff-proxy";

export async function POST(
  req: Request,
  context: { params: Promise<{ orgId: string; serviceId: string }> }
) {
  const { orgId, serviceId } = await context.params;
  const segmentError = validatePathSegments({ orgId, serviceId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const read = await readBoundedJsonBody(req, { requireJsonBody: true });
  if (!read.ok) return read.response;
  const body = read.body;

  const rawIdempotencyKey = req.headers.get("idempotency-key")?.trim();
  const idempotencyKey =
    rawIdempotencyKey && rawIdempotencyKey.length > 0
      ? rawIdempotencyKey
      : randomUUID();

  const upstreamRes = await fetchUpstream(
    `v1/organizations/${orgId}/services/${serviceId}/lifecycle`,
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
