import { forwardToUpstream } from "@/lib/bff-proxy";

const UPSTREAM = "v1/admin/backups";

export const GET = (req: Request) => forwardToUpstream(req, UPSTREAM, "GET", undefined, { timeoutMs: 20_000 });
export const PATCH = (req: Request) => forwardToUpstream(req, UPSTREAM, "PATCH");
export const DELETE = (req: Request) => forwardToUpstream(req, UPSTREAM, "DELETE");
