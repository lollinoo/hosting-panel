import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Asks the API to look for a newer release; it waits on GitHub, so the BFF waits 20 s. */
export async function POST(req: Request) {
  return await forwardIdempotent(req, {}, "v1/admin/updates/panel/check", "POST", { timeoutMs: 20000 });
}
