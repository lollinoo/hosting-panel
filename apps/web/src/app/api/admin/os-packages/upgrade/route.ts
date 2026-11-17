import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Asks the server to install its security updates. */
export async function POST(req: Request) {
  return await forwardIdempotent(req, {}, "v1/admin/os-packages/upgrade", "POST");
}
