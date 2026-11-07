import { fetchMe } from "../../../lib/bff-client";
import {
  bffJsonResponse,
  readSessionFromRequest,
  resolveBffRequestId,
  serializeClearSessionCookie,
  type PublicSessionView,
} from "../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = resolveBffRequestId(request);
  const session = await readSessionFromRequest(request);

  if (!session) {
    const unauthenticated: PublicSessionView = {
      authenticated: false,
      user: null,
      activeOrgSlug: null,
      csrfToken: null,
    };
    return bffJsonResponse(unauthenticated, {
      status: 200,
      requestId,
      allowCsrfTokenField: true,
    });
  }

  const meRes = await fetchMe(session.accessToken, requestId);
  if (!meRes.ok) {
    if (meRes.status === 401) {
      const unauthenticated: PublicSessionView = {
        authenticated: false,
        user: null,
        activeOrgSlug: null,
        csrfToken: null,
      };
      return bffJsonResponse(unauthenticated, {
        status: 200,
        requestId: meRes.requestId,
        allowCsrfTokenField: true,
        setCookie: serializeClearSessionCookie(),
      });
    }

    return bffJsonResponse(meRes.error, {
      status: meRes.status,
      requestId: meRes.requestId,
    });
  }

  const me = meRes.data.data;
  const stillMemberOfActiveOrg =
    session.activeOrgSlug !== null &&
    me.memberships.some((m) => m.organizationSlug === session.activeOrgSlug);

  const view: PublicSessionView = {
    authenticated: true,
    user: me.user,
    activeOrgSlug: stillMemberOfActiveOrg ? session.activeOrgSlug : null,
    csrfToken: session.csrfToken,
  };

  return bffJsonResponse(view, {
    status: 200,
    requestId: meRes.requestId,
    allowCsrfTokenField: true,
  });
}
