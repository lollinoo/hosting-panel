import { forwardToUpstream } from "@/lib/bff-proxy";

// The executor waits up to ~30 s for the provider's answer; leave room on top.
export const POST = (req: Request) =>
  forwardToUpstream(req, "v1/admin/mail-relay/test", "POST", undefined, { timeoutMs: 45_000 });
