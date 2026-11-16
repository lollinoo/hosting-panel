import { forwardToUpstream } from "@/lib/bff-proxy";

/** Ends the caller's support visit. */
export async function DELETE(req: Request) {
  return await forwardToUpstream(req, "v1/admin/support-access", "DELETE");
}
