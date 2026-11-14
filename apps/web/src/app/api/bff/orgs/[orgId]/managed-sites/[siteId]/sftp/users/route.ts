import { CreateSiteSftpUserRequestSchema } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";

export async function POST(req: Request, context: SiteCtx) {
  return forwardSiteCall(req, context, "sftp/users", "POST", {
    timeoutMs: 130_000,
    body: (b) => CreateSiteSftpUserRequestSchema.safeParse(b).success,
  });
}
