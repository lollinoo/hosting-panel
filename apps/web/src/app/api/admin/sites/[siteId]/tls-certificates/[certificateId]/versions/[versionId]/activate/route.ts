import { AdminActivateTlsVersionRequestSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function POST(
  req: Request,
  context: { params: Promise<{ siteId: string; certificateId: string; versionId: string }> },
) {
  const { siteId, certificateId, versionId } = await context.params;
  return forwardIdempotent(
    req,
    { siteId, certificateId, versionId },
    `v1/admin/sites/${siteId}/tls-certificates/${certificateId}/versions/${versionId}/activate`,
    "POST",
    { timeoutMs: 20_000, body: (b) => AdminActivateTlsVersionRequestSchema.safeParse(b).success },
  );
}
