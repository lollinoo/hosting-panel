import { AppStackActionInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function DELETE(
  req: Request,
  context: { params: Promise<{ orgId: string; stackId: string; linkId: string }> },
) {
  const { orgId, stackId, linkId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, linkId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/links/${linkId}`, "DELETE", undefined, {
    body: (b) => b === undefined || AppStackActionInputSchema.safeParse(b).success,
  });
}
