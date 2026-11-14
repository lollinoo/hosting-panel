import { SITE_DATABASE_CUSTOM_NAME_PATTERN } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

export async function POST(req: Request, context: SiteCtx) {
  const { name } = await context.params;
  if (!name || !SITE_DATABASE_CUSTOM_NAME_PATTERN.test(name)) {
    return bffErrorResponse("VALIDATION_ERROR", "Invalid database user name.", 400);
  }
  return forwardSiteCall(req, context, `database-users/${name}/reset-password`, "POST", { timeoutMs: 85_000 });
}
