import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Context = { params: Promise<{ orgId: string; channel: string }> };
const upstream = (orgId: string, channel: string) => `v1/organizations/${orgId}/notifications/channels/${channel}`;

// A new address is looked up before it is stored, so a save may take longer than the usual answer.
export async function PUT(req: Request, context: Context) {
  const { orgId, channel } = await context.params;
  return (
    validatePathSegments({ orgId, channel }) ??
    forwardToUpstream(req, upstream(orgId, channel), "PUT", undefined, { timeoutMs: 20_000 })
  );
}

export async function DELETE(req: Request, context: Context) {
  const { orgId, channel } = await context.params;
  return validatePathSegments({ orgId, channel }) ?? forwardToUpstream(req, upstream(orgId, channel), "DELETE");
}
