import { CreateSiteDatabaseRequestSchema } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";

export async function GET(req: Request, context: SiteCtx) {
  return forwardSiteCall(req, context, "databases", "GET", { timeoutMs: 20_000 });
}

export async function POST(req: Request, context: SiteCtx) {
  return forwardSiteCall(req, context, "databases", "POST", {
    timeoutMs: 85_000,
    body: (parsed) => CreateSiteDatabaseRequestSchema.safeParse(parsed).success,
  });
}
