import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";
import { clampTail } from "@/lib/admin-address";

/** Last lines of a site's container for an administrator; the executor may take 35 s. */
export async function GET(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const bad = validatePathSegments({ siteId });
  if (bad) return bad;
  return await forwardToUpstream(req, `v1/admin/sites/${siteId}/logs?tail=${clampTail(req)}`, "GET", undefined, { timeoutMs: 40000 });
}
