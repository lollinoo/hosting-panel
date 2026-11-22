import { CreateAppTemplateInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

// The strict contract (source <= 64 KiB) is the veto; the API runs the parser, policy and compiler again.
export const POST = (req: Request) =>
  forwardIdempotent(req, {}, "v1/admin/app-templates", "POST", {
    timeoutMs: 20_000,
    body: (b) => CreateAppTemplateInputSchema.safeParse(b).success,
  });
