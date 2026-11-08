import { forwardToUpstream } from "@/lib/bff-proxy";
import { setSessionCookie } from "@/lib/server-session";

export async function POST(req: Request) {
  // The API keeps the current session alive, so clear the forced-change flag in the cookie.
  return await forwardToUpstream(req, "v1/me/password", "POST", async (session, _body, response) => {
    await setSessionCookie(response, {
      ...session,
      user: { ...session.user, mustChangePassword: false },
    });
  });
}
