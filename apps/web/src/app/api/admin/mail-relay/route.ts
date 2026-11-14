import { forwardToUpstream } from "@/lib/bff-proxy";

const UPSTREAM = "v1/admin/mail-relay";

export const GET = (req: Request) => forwardToUpstream(req, UPSTREAM, "GET");
export const PATCH = (req: Request) => forwardToUpstream(req, UPSTREAM, "PATCH");
export const DELETE = (req: Request) => forwardToUpstream(req, UPSTREAM, "DELETE");
