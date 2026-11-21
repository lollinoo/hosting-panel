import { ImportTlsCertificateRequestSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(req: Request, context: Ctx) {
  const { siteId } = await context.params;
  const segmentError = validatePathSegments({ siteId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/sites/${siteId}/tls-certificates`, "GET");
}

export async function POST(req: Request, context: Ctx) {
  const { siteId } = await context.params;
  return forwardIdempotent(req, { siteId }, `v1/admin/sites/${siteId}/tls-certificates`, "POST", {
    timeoutMs: 30_000,
    body: (b) => ImportTlsCertificateRequestSchema.safeParse(b).success,
  });
}
