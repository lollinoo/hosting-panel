import { SetAppStackSecretInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// Write-only: the value travels in this body alone and the answer carries only its state.
export async function POST(req: Request, context: { params: Promise<{ orgId: string; stackId: string }> }) {
  const { orgId, stackId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/secrets`, "POST", undefined, {
    body: (b) => SetAppStackSecretInputSchema.safeParse(b).success,
  });
}
