import { AddAppTemplateVersionInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function POST(req: Request, context: { params: Promise<{ templateId: string }> }) {
  const { templateId } = await context.params;
  return await forwardIdempotent(req, { templateId }, `v1/admin/app-templates/${templateId}/versions`, "POST", {
    timeoutMs: 20_000,
    body: (b) => AddAppTemplateVersionInputSchema.safeParse(b).success,
  });
}
