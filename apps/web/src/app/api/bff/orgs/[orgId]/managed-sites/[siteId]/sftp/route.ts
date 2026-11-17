import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";

export async function GET(req: Request, context: SiteCtx) {
  return forwardSiteCall(req, context, "sftp", "GET", { timeoutMs: 20_000 });
}
