import { CreateTlsCertificateVersionRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

const isVersionBody = (b: unknown) => CreateTlsCertificateVersionRequestSchema.safeParse(b).success;

export const POST = async (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, `tls-certificates/${(await ctx.params).certificateId}/versions`, "POST", {
    timeoutMs: 30_000,
    idempotency: true,
    body: isVersionBody,
  });
