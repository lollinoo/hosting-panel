import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// The API sends the message before it answers: up to five mails, or one call that may wait for the other side.
export async function POST(req: Request, context: { params: Promise<{ channel: string }> }) {
  const { channel } = await context.params;
  return (
    validatePathSegments({ channel }) ??
    forwardToUpstream(req, `v1/admin/notifications/channels/${channel}/test`, "POST", undefined, { timeoutMs: 45_000 })
  );
}
