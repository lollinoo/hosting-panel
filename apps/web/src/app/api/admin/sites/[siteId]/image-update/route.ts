import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Deploys a site again on this version's image. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return await forwardIdempotent(req, { siteId }, `v1/admin/sites/${siteId}/image-update`, "POST");
}
