import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Starts the administrator's restore of one site; the API checks the body. */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return await forwardIdempotent(req, { siteId }, `v1/admin/backups/sites/${siteId}/restore`, "POST", {
    timeoutMs: 30_000,
  });
}
