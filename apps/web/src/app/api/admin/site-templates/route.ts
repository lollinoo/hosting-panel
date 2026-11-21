import { CreateSiteTemplateInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";

// The strict contract (module, name, description, source <= 64 KiB) is the veto; the API runs the full policy check.
export const POST = (req: Request) =>
  forwardIdempotent(req, {}, "v1/admin/site-templates", "POST", {
    timeoutMs: 20_000,
    body: (b) => CreateSiteTemplateInputSchema.safeParse(b).success,
  });
