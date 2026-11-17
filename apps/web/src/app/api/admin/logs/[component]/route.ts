import { LogSourceSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardToUpstream } from "@/lib/bff-proxy";
import { clampTail } from "@/lib/admin-address";

/** Last lines of one panel container or one journal; the executor may take 35 s, so the BFF waits 40. */
export async function GET(req: Request, context: { params: Promise<{ component: string }> }) {
  const { component } = await context.params;
  const bad = validatePathSegments({ component });
  if (bad) return bad;
  if (!LogSourceSchema.safeParse(component).success)
    return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'component' non valido", 400);
  return await forwardToUpstream(req, `v1/admin/logs/${component}?tail=${clampTail(req)}`, "GET", undefined, { timeoutMs: 40000 });
}
