import { CreateBackupTargetInputSchema } from "@hosting-panel/contracts";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { forwardToUpstream } from "@/lib/bff-proxy";

const UPSTREAM = "v1/admin/backup-targets";

export const GET = (req: Request) => forwardToUpstream(req, UPSTREAM, "GET", undefined, { timeoutMs: 20_000 });

// A local target carries no path: the strict contract refuses root/path-like keys here.
export const POST = (req: Request) =>
  forwardIdempotent(req, {}, UPSTREAM, "POST", {
    timeoutMs: 20_000,
    body: (b) => CreateBackupTargetInputSchema.safeParse(b).success,
  });
