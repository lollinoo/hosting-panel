import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function POST(req: Request, context: { params: Promise<{ userId: string }> }) {
  const { userId } = await context.params;
  const segmentError = validatePathSegments({ userId });
  if (segmentError) return segmentError;
  return await forwardToUpstream(req, `v1/admin/users/${userId}/reset-password`, "POST");
}
