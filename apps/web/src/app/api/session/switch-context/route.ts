import { getSessionFromRequest, setSessionCookie } from "@/lib/server-session";
import { validateCsrfAndOrigin } from "@/lib/bff-guard";
import { bffJsonResponse, bffErrorResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import type { ConsoleContext, SessionData } from "@/lib/session";
import type { MeDto } from "@hosting-panel/contracts";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  const guardError = validateCsrfAndOrigin(req, session);
  if (guardError) return guardError;

  let body: { activeConsole?: ConsoleContext; activeOrgSlug?: string | null };
  try {
    body = (await req.json()) as { activeConsole?: ConsoleContext; activeOrgSlug?: string | null };
  } catch {
    return bffErrorResponse(
      "VALIDATION_ERROR",
      "Corpo della richiesta JSON non valido",
      400
    );
  }

  const { activeConsole, activeOrgSlug } = body;
  if (!activeConsole || !["infra", "hosting", "org"].includes(activeConsole)) {
    return bffErrorResponse(
      "VALIDATION_ERROR",
      "Parametro activeConsole non valido (deve essere 'infra', 'hosting' o 'org')",
      400
    );
  }

  // Verify permissions via upstream /v1/me
  const meRes = await fetchUpstream<{ data: MeDto }>("v1/me", {
    accessToken: session!.accessToken,
  });

  if (!meRes.ok || !meRes.data?.data) {
    return bffErrorResponse(
      "UNAUTHENTICATED",
      "Sessione non valida o scaduta su upstream",
      401
    );
  }

  const me = meRes.data.data;

  if (activeConsole === "infra") {
    if (!me.globalRoles.includes("infrastructure_admin")) {
      return bffErrorResponse(
        "PERMISSION_DENIED",
        "Privilegi di Infrastructure Admin richiesti",
        403
      );
    }
  } else if (activeConsole === "hosting") {
    const isHostingAdmin =
      me.globalRoles.includes("hosting_admin") ||
      me.globalRoles.includes("infrastructure_admin");
    if (!isHostingAdmin) {
      return bffErrorResponse(
        "PERMISSION_DENIED",
        "Privilegi di Hosting Admin richiesti",
        403
      );
    }
  } else if (activeConsole === "org") {
    if (!activeOrgSlug) {
      return bffErrorResponse(
        "VALIDATION_ERROR",
        "Parametro activeOrgSlug richiesto per il contesto organizzazione",
        400
      );
    }

    const membership = me.memberships.find(
      (m) => m.organizationSlug === activeOrgSlug
    );
    const isGlobalAdmin =
      me.globalRoles.includes("infrastructure_admin") ||
      me.globalRoles.includes("hosting_admin");

    if (!membership && !isGlobalAdmin) {
      return bffErrorResponse(
        "NOT_FOUND",
        `Organizzazione '${activeOrgSlug}' non trovata o non autorizzata per l'utente`,
        404
      );
    }
  }

  const updatedSession: SessionData = {
    ...session!,
    activeConsole,
    activeOrgSlug: activeConsole === "org" ? (activeOrgSlug ?? null) : null,
  };

  const response = bffJsonResponse({
    ok: true,
    activeConsole: updatedSession.activeConsole,
    activeOrgSlug: updatedSession.activeOrgSlug,
  });

  await setSessionCookie(response, updatedSession);
  return response;
}
