import { randomUUID } from "node:crypto";
import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function GET(
  req: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const segmentError = validatePathSegments({ orgId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (!session) {
    return bffErrorResponse(
      "UNAUTHENTICATED",
      "Sessione non autenticata o scaduta",
      401
    );
  }

  let siteId: string | null;
  try {
    const url = new URL(req.url);
    siteId = url.searchParams.get("siteId");
  } catch {
    return bffErrorResponse(
      "VALIDATION_ERROR",
      "URL richiesta non valido",
      400
    );
  }

  if (siteId !== null && siteId.length > 0) {
    const siteSegmentError = validatePathSegments({ siteId });
    if (siteSegmentError) return siteSegmentError;
  }

  const querySuffix =
    siteId && siteId.length > 0
      ? `?siteId=${encodeURIComponent(siteId)}`
      : "";

  const upstreamRes = await fetchUpstream(
    `v1/organizations/${orgId}/secrets${querySuffix}`,
    {
      method: "GET",
      accessToken: session.accessToken,
    }
  );

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  const segmentError = validatePathSegments({ orgId });
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

  const upstreamRes = await fetchUpstream(`v1/organizations/${orgId}/secrets`, {
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
