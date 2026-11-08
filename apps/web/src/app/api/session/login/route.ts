import { generateCsrfToken, type SessionData } from "@/lib/session";
import { setSessionCookie } from "@/lib/server-session";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { bffUpstreamResponse } from "@/lib/bff-proxy";
import { fetchUpstream } from "@/lib/upstream";
import type { LoginResultDto, MeDto } from "@hosting-panel/contracts";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bffErrorResponse("VALIDATION_ERROR", "Corpo della richiesta JSON non valido", 400);
  }

  // Forward only the credential fields; the API validates them.
  const { email, password, totpCode } = body;
  const loginRes = await fetchUpstream<{ data: LoginResultDto }>("v1/auth/login", {
    method: "POST",
    body: { email, password, totpCode },
  });

  if (!loginRes.ok) {
    return bffUpstreamResponse(loginRes);
  }

  const result = loginRes.data?.data;
  if (result?.status === "totp_required") {
    return bffJsonResponse({ status: "totp_required" });
  }
  if (result?.status !== "ok" || !result.accessToken) {
    return bffErrorResponse("INTERNAL_ERROR", "Risposta di login upstream non valida", 502);
  }

  const accessToken = result.accessToken;
  const meRes = await fetchUpstream<{ data: MeDto }>("v1/me", { accessToken });
  if (!meRes.ok || !meRes.data?.data) {
    return bffErrorResponse("UNAUTHENTICATED", "Impossibile recuperare il profilo utente", 401);
  }

  const me = meRes.data.data;
  const isServerAdmin = me.user.isServerAdmin;

  const sessionData: SessionData = {
    accessToken,
    csrfToken: generateCsrfToken(),
    activeConsole: isServerAdmin ? "admin" : "customer",
    activeOrgSlug: isServerAdmin ? null : (me.memberships[0]?.organizationSlug ?? null),
    user: {
      id: me.user.id,
      email: me.user.email,
      name: me.user.name,
      globalRoles: me.globalRoles,
      hostingAdminOrgIds: me.hostingAdminOrgIds,
      locale: me.user.locale,
      isServerAdmin,
      mustChangePassword: me.user.mustChangePassword,
    },
  };

  const response = bffJsonResponse({
    ok: true,
    status: "ok",
    activeConsole: sessionData.activeConsole,
    activeOrgSlug: sessionData.activeOrgSlug,
    mustChangePassword: sessionData.user.mustChangePassword,
    user: sessionData.user,
  });

  await setSessionCookie(response, sessionData);
  return response;
}
