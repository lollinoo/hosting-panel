import { forwardSiteCall, isSafeFilePath } from "@/lib/bff-files";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

export const GET = (req: Request, context: Ctx) =>
  forwardSiteCall(req, context, "files", "GET", {
    timeoutMs: 20_000,
    query: (u) => {
      const path = u.get("path") ?? "";
      return isSafeFilePath(path, true) ? `path=${encodeURIComponent(path)}` : null;
    },
  });
