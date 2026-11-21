import { forwardIdempotent } from "@/lib/bff-idempotent";
import { isPlainObject } from "@/lib/bff-files";

// The executor may take ~30 s on the destination; leave headroom like the legacy test route.
export async function POST(req: Request, context: { params: Promise<{ targetId: string }> }) {
  const { targetId } = await context.params;
  return forwardIdempotent(req, { targetId }, `v1/admin/backup-targets/${targetId}/initialize`, "POST", {
    timeoutMs: 45_000,
    body: (b) => isPlainObject(b) && Object.keys(b).length === 0,
  });
}
