import { PANEL_CONTAINERS } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Brings one of the panel's containers to this version's image. */
export async function POST(req: Request, context: { params: Promise<{ component: string }> }) {
  const { component } = await context.params;
  if (!(PANEL_CONTAINERS as readonly string[]).includes(component))
    return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'component' non valido", 400);
  return await forwardIdempotent(req, { component }, `v1/admin/updates/components/${component}/apply`, "POST");
}
