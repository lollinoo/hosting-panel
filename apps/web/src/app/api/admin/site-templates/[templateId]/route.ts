import { UpdateSiteTemplateInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ templateId: string }> };

async function forward(req: Request, context: Ctx, method: "PATCH" | "DELETE") {
  const { templateId } = await context.params;
  const segmentError = validatePathSegments({ templateId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/site-templates/${templateId}`, method, undefined, {
    timeoutMs: 20_000,
    ...(method === "PATCH" ? { body: (b: unknown) => UpdateSiteTemplateInputSchema.safeParse(b).success } : {}),
  });
}

export const PATCH = (req: Request, context: Ctx) => forward(req, context, "PATCH");
// Archives the template (never removes the row); existing sites keep their version.
export const DELETE = (req: Request, context: Ctx) => forward(req, context, "DELETE");
