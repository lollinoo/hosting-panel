import { CreateAppStackLinkInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function POST(req: Request, context: { params: Promise<{ orgId: string; stackId: string }> }) {
  const { orgId, stackId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/links`, "POST", undefined, {
    body: (b) => CreateAppStackLinkInputSchema.safeParse(b).success,
  });
}
