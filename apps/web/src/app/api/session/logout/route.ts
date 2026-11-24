import { getSessionFromRequest, clearSessionCookie } from "@/lib/server-session";
import { bffJsonResponse } from "@/lib/bff-response";
import { validateOrigin } from "@/lib/bff-guard";
import { fetchUpstream } from "@/lib/upstream";

export async function POST(req: Request) {
  // It also clears a cookie that no longer reads as a session, so it cannot ask for the CSRF token.
  const originError = validateOrigin(req, { required: true });
  if (originError) return originError;
  const session = await getSessionFromRequest(req);

  if (session?.accessToken) {
    await fetchUpstream("v1/auth/revoke", {
      method: "POST",
      accessToken: session.accessToken,
    });
  }

  const response = bffJsonResponse({ ok: true });
  clearSessionCookie(response);
  return response;
}
