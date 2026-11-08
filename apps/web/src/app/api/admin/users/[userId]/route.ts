import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function PATCH(req: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  const segmentError = validatePathSegments({ userId });
  if (segmentError) return segmentError;
  return await forwardToUpstream(req, `v1/admin/users/${userId}`, "PATCH");
}
