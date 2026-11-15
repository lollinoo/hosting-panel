import { forwardToUpstream } from "@/lib/bff-proxy";

export const GET = (req: Request) =>
  forwardToUpstream(req, "v1/admin/backups/sites", "GET", undefined, { timeoutMs: 20_000 });
