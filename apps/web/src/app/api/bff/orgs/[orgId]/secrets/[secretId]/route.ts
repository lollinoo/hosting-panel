import { getSessionFromRequest } from "@/lib/server-session";
import { validateCsrfAndOrigin, validatePathSegments } from "@/lib/bff-guard";
import { bffJsonResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ orgId: string; secretId: string }> }
) {
  const { orgId, secretId } = await context.params;
  const segmentError = validatePathSegments({ orgId, secretId });
  if (segmentError) return segmentError;

  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  const upstreamRes = await fetchUpstream(
    `v1/organizations/${orgId}/secrets/${secretId}`,
    {
      method: "DELETE",
      accessToken: session!.accessToken,
    }
  );

  if (!upstreamRes.ok) {
    return bffJsonResponse(upstreamRes.error, { status: upstreamRes.status });
  }

  return bffJsonResponse(upstreamRes.data, { status: upstreamRes.status });
}
