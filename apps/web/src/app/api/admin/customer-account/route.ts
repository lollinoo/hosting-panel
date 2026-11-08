import { forwardToUpstream } from "@/lib/bff-proxy";

export async function POST(req: Request) {
  return await forwardToUpstream(req, "v1/admin/customer-account", "POST");
}
