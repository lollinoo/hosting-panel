import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** One operation, read while the Health page follows a restart. */
export async function GET(req: Request, context: { params: Promise<{ operationId: string }> }) {
  const { operationId } = await context.params;
  const bad = validatePathSegments({ operationId });
  if (bad) return bad;
  return await forwardToUpstream(req, `v1/admin/operations/${operationId}`, "GET", undefined, { timeoutMs: 8000 });
}
