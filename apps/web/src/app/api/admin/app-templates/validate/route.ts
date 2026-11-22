import { ValidateAppTemplateInputSchema } from "@hosting-panel/contracts";
import { forwardToUpstream } from "@/lib/bff-proxy";

// A pure check that writes nothing: no Idempotency-Key. The API answers 200 for any well-formed request.
export const POST = (req: Request) =>
  forwardToUpstream(req, "v1/admin/app-templates/validate", "POST", undefined, {
    timeoutMs: 20_000,
    body: (b) => ValidateAppTemplateInputSchema.safeParse(b).success,
  });
