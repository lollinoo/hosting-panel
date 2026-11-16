import { SiteWordpressImportPickRequestSchema, WordpressImportSlotSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

// Use a file already among the site's files as the archive or dump slot.
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  const slot = WordpressImportSlotSchema.safeParse((await context.params).slot);
  if (!slot.success) return bffErrorResponse("VALIDATION_ERROR", "Invalid file slot.", 400);
  return forwardSiteCall(req, context, `wordpress/import/files/${slot.data}/pick`, "POST", {
    timeoutMs: 30_000,
    body: (b) => SiteWordpressImportPickRequestSchema.safeParse(b).success,
  });
}
