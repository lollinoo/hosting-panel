import { getSessionFromRequest, clearSessionCookie } from "@/lib/server-session";
import { bffJsonResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";

export async function POST(req: Request) {
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
