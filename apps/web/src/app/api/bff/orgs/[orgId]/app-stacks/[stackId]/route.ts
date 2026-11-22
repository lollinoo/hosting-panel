import { DeleteAppStackInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function DELETE(req: Request, context: { params: Promise<{ orgId: string; stackId: string }> }) {
  const { orgId, stackId } = await context.params;
  return forwardIdempotent(req, { orgId, stackId }, `v1/organizations/${orgId}/app-stacks/${stackId}`, "DELETE", {
    body: (b) => DeleteAppStackInputSchema.safeParse(b).success,
  });
}
