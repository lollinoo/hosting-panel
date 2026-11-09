import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function POST(
  req: Request,
  context: { params: Promise<{ orgId: string; siteId: string; domainId: string }> },
) {
  const { orgId, siteId, domainId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId, domainId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/managed-sites/${siteId}/domains/${domainId}/check`, "POST");
}
