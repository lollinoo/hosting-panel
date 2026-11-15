import { forwardToUpstream } from "@/lib/bff-proxy";

// The executor tests the saved target for up to ~30 s; leave headroom like the mail test.
export const POST = (req: Request) =>
  forwardToUpstream(req, "v1/admin/backups/test", "POST", undefined, { timeoutMs: 45_000 });
