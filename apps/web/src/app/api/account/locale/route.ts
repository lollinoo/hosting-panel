import { forwardToUpstream } from "@/lib/bff-proxy";
import { setSessionCookie } from "@/lib/server-session";

export async function PATCH(req: Request) {
  return await forwardToUpstream(req, "v1/me/locale", "PATCH", async (session, body, response) => {
    // Upstream accepted it, so it is "it" | "en".
    const locale = (body as { locale: "it" | "en" }).locale;
    await setSessionCookie(response, { ...session, user: { ...session.user, locale } });
  });
}
