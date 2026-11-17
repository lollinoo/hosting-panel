import { TERMINAL_SESSION_ID_PATTERN } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** Sends one input to the caller's own session. */
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  if (!TERMINAL_SESSION_ID_PATTERN.test(sessionId)) return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'sessionId' non valido", 400);
  return await forwardToUpstream(req, `v1/admin/terminal/${sessionId}/write`, "POST", undefined, { timeoutMs: 8000 });
}
