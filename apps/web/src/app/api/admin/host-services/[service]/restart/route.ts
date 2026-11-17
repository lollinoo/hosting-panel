import { HOST_SERVICES } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Restarts one of the panel's four services with the administrator's reason. */
export async function POST(req: Request, context: { params: Promise<{ service: string }> }) {
  const { service } = await context.params;
  if (!(HOST_SERVICES as readonly string[]).includes(service))
    return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'service' non valido", 400);
  return await forwardIdempotent(req, { service }, `v1/admin/host-services/${service}/restart`, "POST");
}
