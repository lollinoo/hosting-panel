import { z } from "zod";
import { fetchMe } from "../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  resolveBffRequestId,
  sealSession,
  serializeSessionCookie,
  verifyCsrfAndOrigin,
} from "../../../../lib/session";

export const dynamic = "force-dynamic";

const SwitchOrgBodySchema = z.strictObject({
  organizationSlug: z.string().trim().min(1).max(128),
});

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveBffRequestId(request);
  const session = await readSessionFromRequest(request);

  if (!session) {
    return bffErrorResponse({
      code: "UNAUTHENTICATED",
      message: "Sessione non autenticata. Effettua nuovamente l'accesso.",
      requestId,
    });
  }

  const csrfRejected = verifyCsrfAndOrigin(request, session);
  if (csrfRejected) {
    return csrfRejected;
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Corpo JSON della richiesta non valido.",
      requestId,
    });
  }

  const parsed = SwitchOrgBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return bffErrorResponse({
      code: "VALIDATION_ERROR",
      message: "Parametro organizationSlug mancante o non valido.",
      requestId,
    });
  }

  const meRes = await fetchMe(session.accessToken, requestId);
  if (!meRes.ok) {
    return bffJsonResponse(meRes.error, {
      status: meRes.status,
      requestId: meRes.requestId,
    });
  }

  const membership = meRes.data.data.memberships.find(
    (item) => item.organizationSlug === parsed.data.organizationSlug,
  );
  if (!membership) {
    return bffErrorResponse({
      code: "NOT_FOUND",
      message: "Organizzazione non trovata o non associata all'utente corrente.",
      requestId: meRes.requestId,
    });
  }

  const updatedSealed = await sealSession({
    accessToken: session.accessToken,
    csrfToken: session.csrfToken,
    activeOrgSlug: membership.organizationSlug,
    user: meRes.data.data.user,
  });

  return bffJsonResponse(
    {
      data: {
        activeOrgSlug: membership.organizationSlug,
        organizationId: membership.organizationId,
        organizationName: membership.organizationName,
      },
    },
    {
      status: 200,
      requestId: meRes.requestId,
      setCookie: serializeSessionCookie(updatedSealed),
    },
  );
}
