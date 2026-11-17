import { SiteWordpressUpdateRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

// Start a WordPress update after checking the target against the contract.
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress/updates", "POST", {
    timeoutMs: 20_000,
    idempotency: true,
    body: (b) => SiteWordpressUpdateRequestSchema.safeParse(b).success,
  });
}
