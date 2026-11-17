import { type SiteCtx, forwardSiteCall, isPlainObject } from "@/lib/bff-files";

// Start a WordPress check; the body must be exactly {}.
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress/refresh", "POST", {
    timeoutMs: 20_000,
    idempotency: true,
    body: (b) => isPlainObject(b) && Object.keys(b).length === 0,
  });
}
