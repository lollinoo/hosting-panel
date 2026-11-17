import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Asks the server to refresh its package lists. */
export async function POST(req: Request) {
  return await forwardIdempotent(req, {}, "v1/admin/os-packages/refresh", "POST");
}
