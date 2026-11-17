import { FirewallPortNameSchema } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { FIREWALL_BFF_TIMEOUT_MS } from "@/lib/admin-firewall";

/** Opens one port of the safe list. */
export async function POST(req: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  if (!FirewallPortNameSchema.safeParse(name).success)
    return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'name' non valido", 400);
  return await forwardIdempotent(req, { name }, `v1/admin/firewall/ports/${name}/open`, "POST", { timeoutMs: FIREWALL_BFF_TIMEOUT_MS });
}
