import { CreateTlsCertificateVersionRequestSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function POST(
  req: Request,
  context: { params: Promise<{ siteId: string; certificateId: string }> },
) {
  const { siteId, certificateId } = await context.params;
  return forwardIdempotent(
    req,
    { siteId, certificateId },
    `v1/admin/sites/${siteId}/tls-certificates/${certificateId}/versions`,
    "POST",
    { timeoutMs: 30_000, body: (b) => CreateTlsCertificateVersionRequestSchema.safeParse(b).success },
  );
}
