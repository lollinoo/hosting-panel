import { UpdateOrganizationSiteLimitInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ orgId: string }> };

// Synchronous and idempotent by nature (it sets a value): no Idempotency-Key.
export async function PATCH(req: Request, context: Ctx) {
  const { orgId } = await context.params;
  const segmentError = validatePathSegments({ orgId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/organizations/${orgId}/site-limit`, "PATCH", undefined, {
    body: (b) => UpdateOrganizationSiteLimitInputSchema.safeParse(b).success,
  });
}
