import { SetSiteBackupPolicyInputSchema } from "@hosting-panel/contracts";
import { forwardSiteCall, type SiteCtx } from "@/lib/bff-files";

const TIMEOUT_MS = 20_000;

/** The site's destination choice and the choices a customer may pick (no names, endpoints or paths). */
export const GET = (req: Request, context: SiteCtx) =>
  forwardSiteCall(req, context, "backup-policy", "GET", { timeoutMs: TIMEOUT_MS });

/** `{targetIds: string[] | null}`; null returns to the default policy. */
export const PATCH = (req: Request, context: SiteCtx) =>
  forwardSiteCall(req, context, "backup-policy", "PATCH", {
    timeoutMs: TIMEOUT_MS,
    body: (b) => SetSiteBackupPolicyInputSchema.safeParse(b).success,
  });
