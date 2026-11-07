import { generateCsrfToken, type ConsoleContext, type SessionData } from "@/lib/session";
import { setSessionCookie } from "@/lib/server-session";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import type { MeDto } from "@hosting-panel/contracts";

export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Body is optional or empty
  }

  const tokenRes = await fetchUpstream<{
    data?: { accessToken: string; user?: unknown };
    accessToken?: string;
  }>("v1/dev/auth/token", {
    method: "POST",
    body,
  });

  if (!tokenRes.ok || !tokenRes.data) {
    const errorData = tokenRes.error as { error?: { message?: string; code?: string } } | undefined;
    return bffErrorResponse(
      "UNAUTHENTICATED",
      errorData?.error?.message || "Autenticazione fallita",
      tokenRes.status || 401
    );
  }

  const accessToken =
    tokenRes.data.data?.accessToken || tokenRes.data.accessToken;

  if (!accessToken) {
    return bffErrorResponse(
      "INTERNAL_ERROR",
      "Token di accesso non restituito dal servizio upstream",
      500
    );
  }

  const meRes = await fetchUpstream<{ data: MeDto }>("v1/me", {
    accessToken,
  });

  if (!meRes.ok || !meRes.data?.data) {
    return bffErrorResponse(
      "UNAUTHENTICATED",
      "Impossibile recuperare il profilo utente",
      401
    );
  }

  const me = meRes.data.data;
  const csrfToken = generateCsrfToken();

  let activeConsole: ConsoleContext = "org";
  let activeOrgSlug: string | null = null;

  if (me.globalRoles.includes("infrastructure_admin")) {
    activeConsole = "infra";
  } else if (me.globalRoles.includes("hosting_admin")) {
    activeConsole = "hosting";
  } else if (me.memberships.length > 0) {
    activeConsole = "org";
    activeOrgSlug = me.memberships[0]?.organizationSlug ?? null;
  }

  const sessionData: SessionData = {
    accessToken,
    csrfToken,
    activeConsole,
    activeOrgSlug,
    user: {
      id: me.user.id,
      email: me.user.email,
      name: me.user.name,
      globalRoles: me.globalRoles,
      hostingAdminOrgIds: me.hostingAdminOrgIds,
    },
  };

  const response = bffJsonResponse({
    ok: true,
    activeConsole,
    activeOrgSlug,
    user: sessionData.user,
  });

  await setSessionCookie(response, sessionData);
  return response;
}
