import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function POST(req: Request, context: { params: Promise<{ siteId: string; domainId: string }> }) {
  const { siteId, domainId } = await context.params;
  const segmentError = validatePathSegments({ siteId, domainId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/sites/${siteId}/domains/${domainId}/primary`, "POST");
}
