import { SITE_DATABASE_CUSTOM_NAME_PATTERN, SITE_DATABASE_NAME_PATTERN } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";
import { bffErrorResponse } from "@/lib/bff-response";

async function forwardGrant(req: Request, context: SiteCtx, method: "PUT" | "DELETE") {
  const { name, database } = await context.params;
  if (!name || !SITE_DATABASE_CUSTOM_NAME_PATTERN.test(name)) {
    return bffErrorResponse("VALIDATION_ERROR", "Invalid database user name.", 400);
  }
  if (!database || !SITE_DATABASE_NAME_PATTERN.test(database)) {
    return bffErrorResponse("VALIDATION_ERROR", "Invalid database name.", 400);
  }
  return forwardSiteCall(req, context, `database-users/${name}/grants/${database}`, method, {
    timeoutMs: 85_000,
  });
}

export async function PUT(req: Request, context: SiteCtx) {
  return forwardGrant(req, context, "PUT");
}

export async function DELETE(req: Request, context: SiteCtx) {
  return forwardGrant(req, context, "DELETE");
}
