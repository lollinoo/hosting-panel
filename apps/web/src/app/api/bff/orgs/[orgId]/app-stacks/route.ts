import { CreateAppStackInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

// Public values only; secrets go to …/secrets after a draft create. The API compiles before it queues.
export async function POST(req: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  return forwardIdempotent(req, { orgId }, `v1/organizations/${orgId}/app-stacks`, "POST", {
    timeoutMs: 20_000,
    body: (b) => CreateAppStackInputSchema.safeParse(b).success,
  });
}
