import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ orgId: string; siteId: string }> };

async function forward(req: Request, context: Ctx, method: "GET" | "POST") {
  const { orgId, siteId } = await context.params;
  const segmentError = validatePathSegments({ orgId, siteId });
  if (segmentError) return segmentError;
  // An address added with a certificate needs the key at the API; a plain address goes without one.
  return forwardToUpstream(req, `v1/organizations/${orgId}/managed-sites/${siteId}/domains`, method, undefined, {
    idempotencyKey: method === "POST",
  });
}

export const GET = (req: Request, context: Ctx) => forward(req, context, "GET");
export const POST = (req: Request, context: Ctx) => forward(req, context, "POST");
