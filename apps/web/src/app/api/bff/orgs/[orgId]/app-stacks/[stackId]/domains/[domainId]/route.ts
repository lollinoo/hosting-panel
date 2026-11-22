import { AppStackActionInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ orgId: string; stackId: string; domainId: string }> },
) {
  const { orgId, stackId, domainId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, domainId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/domains/${domainId}`, "DELETE", undefined, {
    body: (b) => b === undefined || AppStackActionInputSchema.safeParse(b).success,
  });
}
