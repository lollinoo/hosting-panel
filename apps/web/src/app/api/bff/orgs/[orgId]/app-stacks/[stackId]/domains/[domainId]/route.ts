import { AppStackActionInputSchema, UpdateAppStackDomainInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Context = { params: Promise<{ orgId: string; stackId: string; domainId: string }> };

/** Routing options of one address (ADR-0037). The password in the body is forwarded once and kept nowhere here. */
export async function PATCH(req: Request, context: Context) {
  const { orgId, stackId, domainId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, domainId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/domains/${domainId}`, "PATCH", undefined, {
    body: (b) => UpdateAppStackDomainInputSchema.safeParse(b).success,
  });
}

export async function DELETE(req: Request, context: Context) {
  const { orgId, stackId, domainId } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, domainId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/domains/${domainId}`, "DELETE", undefined, {
    body: (b) => b === undefined || AppStackActionInputSchema.safeParse(b).success,
  });
}
