import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Starts the panel's own update. */
export async function POST(req: Request) {
  return await forwardIdempotent(req, {}, "v1/admin/updates/panel/apply", "POST");
}
