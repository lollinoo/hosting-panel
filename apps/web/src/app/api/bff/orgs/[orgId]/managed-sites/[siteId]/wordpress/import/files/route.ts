import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

// Discard both import files with a 30s upstream timeout.
export async function DELETE(req: Request, context: SiteCtx): Promise<Response> {
  return forwardSiteCall(req, context, "wordpress/import/files", "DELETE", { timeoutMs: 30_000 });
}
