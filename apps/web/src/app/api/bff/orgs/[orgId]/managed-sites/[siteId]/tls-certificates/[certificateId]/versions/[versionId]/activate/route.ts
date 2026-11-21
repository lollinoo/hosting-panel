import { ActivateTlsVersionRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

const isActivateBody = (b: unknown) => ActivateTlsVersionRequestSchema.safeParse(b).success;

export const POST = async (req: Request, ctx: SiteCtx) => {
  const { certificateId, versionId } = await ctx.params;
  return forwardSiteCall(req, ctx, `tls-certificates/${certificateId}/versions/${versionId}/activate`, "POST", {
    timeoutMs: 20_000,
    idempotency: true,
    body: isActivateBody,
  });
};
