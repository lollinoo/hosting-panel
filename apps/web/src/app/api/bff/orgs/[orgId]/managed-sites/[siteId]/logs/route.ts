import { getSessionFromRequest } from "@/lib/server-session";
import { validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function GET(req: Request, context: { params: Promise<{ orgId: string; siteId: string }> }) {
  const { orgId, siteId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (!session) return bffErrorResponse("UNAUTHENTICATED", "Sessione non autenticata o scaduta", 401);

  const raw = Number(new URL(req.url).searchParams.get("tail") ?? 200);
  const tail = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 200;

  const upstreamRes = await fetchUpstream(`v1/organizations/${orgId}/managed-sites/${siteId}/logs?tail=${tail}`, {
    method: "GET",
    accessToken: session.accessToken,
  });
  if (!upstreamRes.ok) return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
