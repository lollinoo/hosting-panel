import { forwardToUpstream } from "@/lib/bff-proxy";

export const GET = (req: Request) => forwardToUpstream(req, "v1/admin/alerts", "GET");
