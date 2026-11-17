import { forwardSiteCall } from "@/lib/bff-files";

interface SftpUserCtx {
  params: Promise<{ orgId: string; siteId: string; userId: string }>;
}

export async function DELETE(req: Request, context: SftpUserCtx) {
  const { userId } = await context.params;
  return forwardSiteCall(req, context, `sftp/users/${userId}`, "DELETE", {
    timeoutMs: 130_000,
  });
}
