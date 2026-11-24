import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** The last lines of one component of a customer's application, for a server administrator (ADR-0041); the API audits every read. */
export async function GET(req: Request, context: { params: Promise<{ stackId: string; componentKey: string }> }) {
  const { stackId, componentKey } = await context.params;
  const segmentError = validatePathSegments({ stackId, componentKey });
  if (segmentError) return segmentError;

  // Only `tail` goes on, as a whole number in the API's range; anything else in the query is dropped.
  const raw = Number(new URL(req.url).searchParams.get("tail") ?? 200);
  const tail = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.trunc(raw))) : 200;

  return forwardToUpstream(req, `v1/admin/app-stacks/${stackId}/components/${componentKey}/logs?tail=${tail}`, "GET", undefined, {
    timeoutMs: 10_000,
  });
}
