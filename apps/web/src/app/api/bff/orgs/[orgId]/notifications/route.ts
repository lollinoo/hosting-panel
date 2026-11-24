import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function GET(req: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  return validatePathSegments({ orgId }) ?? forwardToUpstream(req, `v1/organizations/${orgId}/notifications`, "GET");
}
