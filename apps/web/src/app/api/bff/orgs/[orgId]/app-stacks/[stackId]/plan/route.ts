import { PlanAppStackInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// A preview: the API compiles and diffs without changing anything, so no key.
export async function POST(req: Request, context: { params: Promise<{ orgId: string; stackId: string }> }) {
  const { orgId, stackId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/plan`, "POST", undefined, {
    timeoutMs: 20_000,
    body: (b) => PlanAppStackInputSchema.safeParse(b).success,
  });
}
