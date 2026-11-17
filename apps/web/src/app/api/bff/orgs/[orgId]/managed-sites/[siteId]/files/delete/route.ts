import { forwardSiteCall, isPlainObject, isSafeFilePathBatch } from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const POST = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/delete", "POST", {
    timeoutMs: 60_000,
    body: (b) => isPlainObject(b) && isSafeFilePathBatch(b.paths),
  });
