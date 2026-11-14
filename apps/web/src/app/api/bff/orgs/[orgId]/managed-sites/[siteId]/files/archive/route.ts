import {
  forwardSiteCall,
  isPlainObject,
  isSafeFilePath,
  isSafeFilePathBatch,
} from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const POST = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/archive", "POST", {
    timeoutMs: 120_000,
    idempotency: true,
    body: (b) =>
      isPlainObject(b) &&
      isSafeFilePathBatch(b.paths) &&
      isSafeFilePath(b.to, false),
  });
