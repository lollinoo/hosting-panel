import { ArchiveAppTemplateInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// Archives the template (never removes the row); installed stacks keep their version.
export async function POST(req: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  const segmentError = validatePathSegments({ templateId });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/admin/app-templates/${templateId}/archive`, "POST", undefined, {
    body: (b) => b === undefined || ArchiveAppTemplateInputSchema.safeParse(b).success,
  });
}
