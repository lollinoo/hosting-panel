import { forwardToUpstream } from "@/lib/bff-proxy";
import { forwardIdempotent } from "@/lib/bff-idempotent";

export async function GET(req: Request) {
  return await forwardToUpstream(req, "v1/admin/sites", "GET");
}

export async function POST(req: Request) {
  return await forwardIdempotent(req, {}, "v1/admin/sites", "POST");
}
