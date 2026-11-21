import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// Orphan certificate (assigned to no domain): the API refuses an assigned one with 409 CERTIFICATE_IN_USE.
export async function DELETE(req: Request, context: { params: Promise<{ certificateId: string }> }) {
  const { certificateId } = await context.params;
  const segmentError = validatePathSegments({ certificateId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/tls-certificates/${certificateId}`, "DELETE", undefined, {
    timeoutMs: 20_000,
  });
}
