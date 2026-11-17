import { SiteWordpressImportStartRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

// Forward the import state of a site with a 20s upstream timeout.
export async function GET(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress/import", "GET", { timeoutMs: 20_000 });
}

// Start an import; the body must be exactly {confirm:true}.
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress/import", "POST", {
    timeoutMs: 20_000,
    idempotency: true,
    body: (b) => SiteWordpressImportStartRequestSchema.safeParse(b).success,
  });
}
