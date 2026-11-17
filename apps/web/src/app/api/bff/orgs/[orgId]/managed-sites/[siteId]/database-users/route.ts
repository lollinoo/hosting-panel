import { CreateSiteDatabaseUserRequestSchema } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";

export async function POST(req: Request, context: SiteCtx) {
  return forwardSiteCall(req, context, "database-users", "POST", {
    timeoutMs: 85_000,
    body: (parsed) => CreateSiteDatabaseUserRequestSchema.safeParse(parsed).success,
  });
}
