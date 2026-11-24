import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** Opens a terminal in one component of a customer's application (ADR-0041); starting the shell may take 20 s, so the BFF waits 40. */
export async function POST(req: Request, context: { params: Promise<{ stackId: string; componentKey: string }> }) {
  const { stackId, componentKey } = await context.params;
  return (
    validatePathSegments({ stackId, componentKey }) ??
    (await forwardToUpstream(req, `v1/admin/app-stacks/${stackId}/components/${componentKey}/terminal`, "POST", undefined, { timeoutMs: 40000 }))
  );
}
