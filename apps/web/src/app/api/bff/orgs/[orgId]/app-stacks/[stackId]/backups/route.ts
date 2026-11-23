import { CreateAppStackBackupInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Queues a backup of the application (ADR-0038): an empty body, the API answers 202 with the operation. The list is read by the page. */
export async function POST(req: Request, context: { params: Promise<{ orgId: string; stackId: string }> }) {
  const { orgId, stackId } = await context.params;
  return forwardIdempotent(req, { orgId, stackId }, `v1/organizations/${orgId}/app-stacks/${stackId}/backups`, "POST", {
    timeoutMs: 8_000,
    body: (b) => CreateAppStackBackupInputSchema.safeParse(b).success,
  });
}
