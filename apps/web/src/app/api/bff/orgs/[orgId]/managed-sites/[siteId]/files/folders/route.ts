import { forwardSiteCall, isPlainObject, isSafeFilePath } from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const POST = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/folders", "POST", {
    timeoutMs: 20_000,
    body: (b) => isPlainObject(b) && isSafeFilePath(b.path, false),
  });
