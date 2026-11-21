import { ImportTlsCertificateRequestSchema } from "@hosting-panel/contracts";
import { type SiteCtx, forwardSiteCall } from "@/lib/bff-files";

// Strict contract check at the BFF: PFX, passwords and unknown keys never reach the API (ADR-0031).
const isImportBody = (b: unknown) => ImportTlsCertificateRequestSchema.safeParse(b).success;

export const GET = (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, "tls-certificates", "GET", { timeoutMs: 8_000 });

export const POST = (req: Request, ctx: SiteCtx) =>
  forwardSiteCall(req, ctx, "tls-certificates", "POST", { timeoutMs: 30_000, idempotency: true, body: isImportBody });
