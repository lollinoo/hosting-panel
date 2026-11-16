import { bffUpstreamResponse, readBoundedJsonBody } from "@/lib/bff-proxy";
import { bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

// Open like the login route: no session exists yet. Only the schema's fields go upstream.
export async function POST(req: Request) {
  const parsed = await readBoundedJsonBody(req, { requireJsonBody: true });
  if (!parsed.ok) return parsed.response;
  if (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body)) {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }
  const { token, newPassword } = parsed.body as { token?: unknown; newPassword?: unknown };
  return bffUpstreamResponse(
    await fetchUpstream("v1/auth/password-reset/confirm", { method: "POST", body: { token, newPassword } }),
  );
}
