import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** Opens a support visit on the organisation that holds the site. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const bad = validatePathSegments({ siteId });
  if (bad) return bad;
  return await forwardToUpstream(req, `v1/admin/sites/${siteId}/support-access`, "POST");
}
