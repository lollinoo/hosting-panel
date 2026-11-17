import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** Opens a terminal on the site; starting the shell may take 20 s, so the BFF waits 40. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return validatePathSegments({ siteId }) ?? (await forwardToUpstream(req, `v1/admin/sites/${siteId}/terminal`, "POST", undefined, { timeoutMs: 40000 }));
}
