import { UpdateBackupTargetInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ targetId: string }> };

async function forward(req: Request, context: Ctx, method: "PATCH" | "DELETE") {
  const { targetId } = await context.params;
  const segmentError = validatePathSegments({ targetId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/backup-targets/${targetId}`, method, undefined, {
    timeoutMs: 20_000,
    ...(method === "PATCH" ? { body: (b: unknown) => UpdateBackupTargetInputSchema.safeParse(b).success } : {}),
  });
}

export const PATCH = (req: Request, context: Ctx) => forward(req, context, "PATCH");
// Removes the row only when no copy or policy references it (409 BACKUP_TARGET_IN_USE otherwise).
export const DELETE = (req: Request, context: Ctx) => forward(req, context, "DELETE");
