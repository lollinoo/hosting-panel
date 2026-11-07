import {
  isValidPathSegment,
  testAdminProviderConnectionUpstream,
} from "../../../../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  resolveBffRequestId,
  verifyCsrfAndOrigin,
} from "../../../../../../../lib/session";

export const dynamic = "force-dynamic";

export interface AdminProviderTestRouteContext {
  readonly params: Promise<{
    readonly id: string;
  }>;
}

export async function POST(
  request: Request,
  context: AdminProviderTestRouteContext,
): Promise<Response> {
  const requestId = resolveBffRequestId(request);
  const session = await readSessionFromRequest(request);

  if (!session) {
    return bffErrorResponse({
      code: "UNAUTHENTICATED",
      message: "Sessione non autenticata.",
      requestId,
    });
  }

  const csrfRejected = verifyCsrfAndOrigin(request, session);
  if (csrfRejected) {
    return csrfRejected;
  }

  if (!session.user.isPlatformAdmin) {
    return bffErrorResponse({
      code: "PERMISSION_DENIED",
      message: "Accesso riservato agli amministratori di piattaforma.",
      requestId,
    });
  }

  const { id } = await context.params;
  if (!isValidPathSegment(id)) {
    return bffErrorResponse({
      code: "NOT_FOUND",
      message: "Connessione provider non trovata.",
      requestId,
    });
  }

  const upstream = await testAdminProviderConnectionUpstream({
    accessToken: session.accessToken,
    providerId: id,
    requestId,
  });

  if (!upstream.ok) {
    return bffJsonResponse(upstream.error, {
      status: upstream.status,
      requestId: upstream.requestId,
    });
  }

  return bffJsonResponse(upstream.data, {
    status: 200,
    requestId: upstream.requestId,
  });
}
