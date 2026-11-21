import { ChangeSiteTemplateVersionInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Moves a site to a newer version of its template (asynchronous: 202 with the operation). */
export async function POST(req: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  return await forwardIdempotent(req, { siteId }, `v1/admin/sites/${siteId}/template-version`, "POST", {
    body: (b) => ChangeSiteTemplateVersionInputSchema.safeParse(b).success,
  });
}
