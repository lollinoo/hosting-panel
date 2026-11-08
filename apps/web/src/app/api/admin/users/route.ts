import { forwardToUpstream } from "@/lib/bff-proxy";

export async function GET(req: Request) {
  return await forwardToUpstream(req, "v1/admin/users", "GET");
}
