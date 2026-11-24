import { RestoreAppStackBackupInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Queues the restore of one backup into the same application (ADR-0038): the body carries the application's name, typed again. */
export async function POST(req: Request, context: { params: Promise<{ orgId: string; stackId: string; backupId: string }> }) {
  const { orgId, stackId, backupId } = await context.params;
  return forwardIdempotent(
    req,
    { orgId, stackId, backupId },
    `v1/organizations/${orgId}/app-stacks/${stackId}/backups/${backupId}/restore`,
    "POST",
    { timeoutMs: 8_000, body: (b) => RestoreAppStackBackupInputSchema.safeParse(b).success },
  );
}
