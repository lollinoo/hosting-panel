import {
  isValidPathSegment,
  triggerDomainRecheckUpstream,
} from "../../../../../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  requireIdempotencyHeader,
  resolveBffRequestId,
  verifyCsrfAndOrigin,
} from "../../../../../../../../lib/session";

export const dynamic = "force-dynamic";

export interface DomainRecheckRouteContext {
  readonly params: Promise<{
    readonly orgId: string;
    readonly domainId: string;
  }>;
}

export async function POST(
  request: Request,
  context: DomainRecheckRouteContext,
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

  const idemCheck = requireIdempotencyHeader(request);
  if (!idemCheck.ok) {
    return idemCheck.response;
  }

  const { orgId, domainId } = await context.params;
  if (!isValidPathSegment(orgId) || !isValidPathSegment(domainId)) {
    return bffErrorResponse({
      code: "NOT_FOUND",
      message: "Dominio o organizzazione non trovata.",
      requestId,
    });
  }

  const upstream = await triggerDomainRecheckUpstream({
    accessToken: session.accessToken,
    orgId,
    domainId,
    idempotencyKey: idemCheck.key,
    requestId,
  });

  if (!upstream.ok) {
    return bffJsonResponse(upstream.error, {
      status: upstream.status,
      requestId: upstream.requestId,
    });
  }

  return bffJsonResponse(upstream.data, {
    status: 202,
    requestId: upstream.requestId,
  });
}
