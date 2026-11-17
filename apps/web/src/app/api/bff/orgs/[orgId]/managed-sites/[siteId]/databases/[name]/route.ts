import { SITE_DATABASE_CUSTOM_NAME_PATTERN } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

export async function DELETE(req: Request, context: SiteCtx) {
  const { name } = await context.params;
  if (!name || !SITE_DATABASE_CUSTOM_NAME_PATTERN.test(name)) {
    return bffErrorResponse("VALIDATION_ERROR", "Invalid database name.", 400);
  }
  return forwardSiteCall(req, context, `databases/${name}`, "DELETE", { timeoutMs: 85_000 });
}
