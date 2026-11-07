import {
  fetchOperationDetail,
  isValidPathSegment,
} from "../../../../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  resolveBffRequestId,
} from "../../../../../../../lib/session";

export const dynamic = "force-dynamic";

export interface OperationRouteContext {
  readonly params: Promise<{
    readonly orgId: string;
    readonly opId: string;
  }>;
}

export async function GET(
  request: Request,
  context: OperationRouteContext,
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

  const { orgId, opId } = await context.params;
  if (!isValidPathSegment(orgId) || !isValidPathSegment(opId)) {
    return bffErrorResponse({
      code: "NOT_FOUND",
      message: "Operazione non trovata.",
      requestId,
    });
  }

  const upstream = await fetchOperationDetail(
    session.accessToken,
    orgId,
    opId,
    requestId,
  );
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
