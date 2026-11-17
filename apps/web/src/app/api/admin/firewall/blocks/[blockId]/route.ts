import { FIREWALL_BLOCK_ID_PATTERN } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { FIREWALL_BFF_TIMEOUT_MS } from "@/lib/admin-firewall";

/** Lifts one block. */
export async function DELETE(req: Request, context: { params: Promise<{ blockId: string }> }) {
  const { blockId } = await context.params;
  if (!FIREWALL_BLOCK_ID_PATTERN.test(blockId))
    return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'blockId' non valido", 400);
  return await forwardIdempotent(req, { blockId }, `v1/admin/firewall/blocks/${blockId}`, "DELETE", { timeoutMs: FIREWALL_BFF_TIMEOUT_MS });
}
