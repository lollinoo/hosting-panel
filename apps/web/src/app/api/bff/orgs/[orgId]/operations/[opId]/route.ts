import { getSessionFromRequest } from "@/lib/server-session";
import { validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function GET(
  req: Request,
  context: { params: Promise<{ orgId: string; opId: string }> }
) {
  const { orgId, opId } = await context.params;
  const segmentError = validatePathSegments({ orgId, opId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  if (!session) {
    return bffErrorResponse(
      "UNAUTHENTICATED",
      "Sessione non autenticata o scaduta",
      401
    );
  }

  const upstreamRes = await fetchUpstream(
    `v1/organizations/${orgId}/operations/${opId}`,
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
