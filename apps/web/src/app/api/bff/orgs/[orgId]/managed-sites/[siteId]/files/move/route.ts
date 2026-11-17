import { forwardSiteCall, isPlainObject, isSafeFilePath } from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const POST = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files/move", "POST", {
    timeoutMs: 20_000,
    body: (b) =>
      isPlainObject(b) &&
      isSafeFilePath(b.from, false) &&
      isSafeFilePath(b.to, false) &&
      b.from !== b.to &&
      !b.to.startsWith(`${b.from}/`),
  });
