import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Restarts a site's container with the administrator's reason. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return await forwardIdempotent(req, { siteId }, `v1/admin/sites/${siteId}/restart`, "POST");
}
