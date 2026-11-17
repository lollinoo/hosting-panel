import { TERMINAL_SESSION_ID_PATTERN } from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** Long-polls the session's output; the API waits up to 20 s, so the BFF waits 40. */
export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  if (!TERMINAL_SESSION_ID_PATTERN.test(sessionId)) return bffErrorResponse("VALIDATION_ERROR", "Parametro di percorso 'sessionId' non valido", 400);
  return await forwardToUpstream(req, `v1/admin/terminal/${sessionId}/read`, "POST", undefined, { timeoutMs: 40000 });
}
