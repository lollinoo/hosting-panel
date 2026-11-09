import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ siteId: string }> };

async function forward(req: Request, context: Ctx, method: "GET" | "POST") {
  const { siteId } = await context.params;
  const segmentError = validatePathSegments({ siteId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/sites/${siteId}/domains`, method);
}

export const GET = (req: Request, context: Ctx) => forward(req, context, "GET");
export const POST = (req: Request, context: Ctx) => forward(req, context, "POST");
