import { SiteWordpressImportChunkRequestSchema, WordpressImportSlotSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

// Upload one chunk of an import file into the archive or dump slot.
export async function PUT(req: Request, context: SiteCtx): Promise<Response> {
  const slot = WordpressImportSlotSchema.safeParse((await context.params).slot);
  if (!slot.success) return bffErrorResponse("VALIDATION_ERROR", "Invalid file slot.", 400);
  return forwardSiteCall(req, context, `wordpress/import/files/${slot.data}`, "PUT", {
    timeoutMs: 30_000,
    body: (b) => SiteWordpressImportChunkRequestSchema.safeParse(b).success,
  });
}
