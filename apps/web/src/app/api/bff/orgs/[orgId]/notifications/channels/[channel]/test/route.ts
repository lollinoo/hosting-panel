import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

// The API sends the message before it answers: one mail per owner, or one call that may wait for the other side.
export async function POST(req: Request, context: { params: Promise<{ orgId: string; channel: string }> }) {
  const { orgId, channel } = await context.params;
  return (
    validatePathSegments({ orgId, channel }) ??
    forwardToUpstream(req, `v1/organizations/${orgId}/notifications/channels/${channel}/test`, "POST", undefined, {
      timeoutMs: 45_000,
    })
  );
}
