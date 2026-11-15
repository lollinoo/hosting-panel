import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

// Forward the stored WordPress details of a site with a 20s upstream timeout.
export async function GET(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress", "GET", { timeoutMs: 20_000 });
}
