import { forwardSiteCall } from "@/lib/bff-files";

interface SftpUserCtx {
  params: Promise<{ orgId: string; siteId: string; userId: string }>;
}

export async function POST(req: Request, context: SftpUserCtx) {
  const { userId } = await context.params;
  return forwardSiteCall(req, context, `sftp/users/${userId}/reset-password`, "POST", {
    timeoutMs: 130_000,
  });
}
