import { UpdateAppTemplateInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function PATCH(req: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const segmentError = validatePathSegments({ templateId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/app-templates/${templateId}`, "PATCH", undefined, {
    timeoutMs: 20_000,
    body: (b) => UpdateAppTemplateInputSchema.safeParse(b).success,
  });
}
