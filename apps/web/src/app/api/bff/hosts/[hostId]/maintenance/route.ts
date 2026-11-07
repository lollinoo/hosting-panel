import { randomUUID } from "node:crypto";
import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function POST(
  req: Request,
  context: { params: Promise<{ hostId: string }> }
) {
  const { hostId } = await context.params;
  const segmentError = validatePathSegments({ hostId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bffErrorResponse(
      "VALIDATION_ERROR",
      "Corpo della richiesta JSON non valido",
      400
    );
  }

  const rawIdempotencyKey = req.headers.get("idempotency-key")?.trim();
  const idempotencyKey =
    rawIdempotencyKey && rawIdempotencyKey.length > 0
      ? rawIdempotencyKey
      : randomUUID();

  const upstreamRes = await fetchUpstream(`v1/hosts/${hostId}/maintenance`, {
    method: "POST",
    accessToken: session!.accessToken,
    idempotencyKey,
    body,
  });

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
