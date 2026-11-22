import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

export async function GET(
  req: Request,
  context: { params: Promise<{ orgId: string; stackId: string; componentKey: string }> },
) {
  const { orgId, stackId, componentKey } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, componentKey });
  if (segmentError) return segmentError;

  const raw = Number(new URL(req.url).searchParams.get("tail") ?? 200);
  const tail = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 200;

  return forwardToUpstream(
    req,
    `v1/organizations/${orgId}/app-stacks/${stackId}/components/${componentKey}/logs?tail=${tail}`,
    "GET",
    undefined,
    { timeoutMs: 10_000 },
  );
}
