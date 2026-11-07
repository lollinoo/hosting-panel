import { revokeUpstreamAccessToken } from "../../../../lib/bff-client";
import {
  bffErrorResponse,
  bffJsonResponse,
  readSessionFromRequest,
  resolveBffRequestId,
  serializeClearSessionCookie,
  verifyCsrfAndOrigin,
  verifyRequestOrigin,
} from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveBffRequestId(request);
  const session = await readSessionFromRequest(request);

  if (!session) {
    const originCheck = verifyRequestOrigin(request);
    if (!originCheck.ok) {
      return bffErrorResponse({
        code: "PERMISSION_DENIED",
        message: originCheck.reason ?? "Origine della richiesta non autorizzata.",
        requestId,
      });
    }

    return bffJsonResponse(
      { data: { loggedOut: true } },
      {
        status: 200,
        requestId,
        setCookie: serializeClearSessionCookie(),
      },
    );
  }

  const csrfRejected = verifyCsrfAndOrigin(request, session);
  if (csrfRejected) {
    return csrfRejected;
  }

  await revokeUpstreamAccessToken(session.accessToken, requestId);

  return bffJsonResponse(
    { data: { loggedOut: true } },
    {
      status: 200,
      requestId,
      setCookie: serializeClearSessionCookie(),
    },
  );
}
