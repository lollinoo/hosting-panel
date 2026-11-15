import { RestoreBackupInputSchema } from "@hosting-panel/contracts";
import { forwardSiteCall } from "@/lib/bff-files";

type BackupCtx = {
  params: Promise<{ orgId: string; siteId: string; backupId: string }>;
};

const BACKUP_MUTATION_TIMEOUT_MS = 20_000;

function isRestoreBody(body: unknown): boolean {
  return RestoreBackupInputSchema.safeParse(body).success;
}

/**
 * Forward backup restore requests to the upstream site-restore endpoint.
 *
 * Purpose: enforce BFF segment validation, CSRF/Origin checks, request schema
 * validation (`RestoreBackupInputSchema`), and idempotency before forwarding.
 */
export async function POST(req: Request, context: BackupCtx): Promise<Response> {
  const params = await context.params;
  const backupId = params.backupId ?? "";
  return forwardSiteCall(
    req,
    { params: Promise.resolve({ ...params, backupId }) },
    `backups/${backupId}/restore`,
    "POST",
    {
      timeoutMs: BACKUP_MUTATION_TIMEOUT_MS,
      idempotency: true,
      body: isRestoreBody,
    },
  );
}
