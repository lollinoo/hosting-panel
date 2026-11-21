import { AdminSetDomainTlsRequestSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function POST(req: Request, context: { params: Promise<{ siteId: string; domainId: string }> }) {
  const { siteId, domainId } = await context.params;
  return forwardIdempotent(req, { siteId, domainId }, `v1/admin/sites/${siteId}/domains/${domainId}/tls`, "POST", {
    timeoutMs: 20_000,
    body: (b) => AdminSetDomainTlsRequestSchema.safeParse(b).success,
  });
}
