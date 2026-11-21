import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ siteId: string; certificateId: string }> };

async function forward(req: Request, context: Ctx, method: "GET" | "DELETE") {
  const { siteId, certificateId } = await context.params;
  const segmentError = validatePathSegments({ siteId, certificateId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/sites/${siteId}/tls-certificates/${certificateId}`, method, undefined, {
    timeoutMs: method === "GET" ? undefined : 20_000,
  });
}

export const GET = (req: Request, context: Ctx) => forward(req, context, "GET");
export const DELETE = (req: Request, context: Ctx) => forward(req, context, "DELETE");
