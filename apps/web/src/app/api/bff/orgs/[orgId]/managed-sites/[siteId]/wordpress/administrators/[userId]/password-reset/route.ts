import { WORDPRESS_USER_ID_PATTERN } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall, isPlainObject } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

// Reset an administrator's password; waits up to 85s and never replays (no Idempotency-Key).
export async function POST(req: Request, context: SiteCtx): Promise<Response> {
  const userId = (await context.params).userId ?? "";
  if (!WORDPRESS_USER_ID_PATTERN.test(userId)) {
    return bffErrorResponse("VALIDATION_ERROR", "Invalid user id.", 400);
  }
  return forwardSiteCall(req, context, `wordpress/administrators/${userId}/password-reset`, "POST", {
    timeoutMs: 85_000,
    body: (b) => isPlainObject(b) && Object.keys(b).length === 0,
  });
}
