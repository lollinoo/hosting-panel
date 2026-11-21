import { SetDomainTlsRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

const isSetTlsBody = (b: unknown) => SetDomainTlsRequestSchema.safeParse(b).success;

export const POST = async (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, `domains/${(await ctx.params).domainId}/tls`, "POST", {
    timeoutMs: 20_000,
    idempotency: true,
    body: isSetTlsBody,
  });
