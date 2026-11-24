import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Context = { params: Promise<{ channel: string }> };
const upstream = (channel: string) => `v1/admin/notifications/channels/${channel}`;

// A new address is looked up before it is stored, so a save may take longer than the usual answer.
export async function PUT(req: Request, context: Context) {
  const { channel } = await context.params;
  return validatePathSegments({ channel }) ?? forwardToUpstream(req, upstream(channel), "PUT", undefined, { timeoutMs: 20_000 });
}

export async function DELETE(req: Request, context: Context) {
  const { channel } = await context.params;
  return validatePathSegments({ channel }) ?? forwardToUpstream(req, upstream(channel), "DELETE");
}
