import { type SiteCtx, forwardSiteCall, isPlainObject } from "@/lib/bff-files";

const sub = async (ctx: SiteCtx) => `tls-certificates/${(await ctx.params).certificateId}`;
const isEmptyBody = (b: unknown) => b === undefined || (isPlainObject(b) && Object.keys(b).length === 0);

export const GET = async (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, await sub(ctx), "GET", { timeoutMs: 8_000 });

export const DELETE = async (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, await sub(ctx), "DELETE", { timeoutMs: 20_000, idempotency: true, body: isEmptyBody });
