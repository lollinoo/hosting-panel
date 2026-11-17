import { forwardSiteCall, isPlainObject, isSafeFilePath } from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const POST = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/extract", "POST", {
    timeoutMs: 120_000,
    idempotency: true,
    body: (b) =>
      isPlainObject(b) &&
      isSafeFilePath(b.path, false) &&
      isSafeFilePath(b.to, true),
  });
