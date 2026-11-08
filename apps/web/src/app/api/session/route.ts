import { getSessionFromRequest, clearSessionCookie } from "@/lib/server-session";
import { bffJsonResponse } from "@/lib/bff-response";
import { fetchUpstream } from "@/lib/upstream";
import type { MeDto } from "@hosting-panel/contracts";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return bffJsonResponse({ authenticated: false });
  }

  const upstreamRes = await fetchUpstream<{ data: MeDto }>("v1/me", {
    accessToken: session.accessToken,
  });

  if (!upstreamRes.ok || !upstreamRes.data?.data) {
    const res = bffJsonResponse({ authenticated: false });
    clearSessionCookie(res);
    return res;
  }

  const me = upstreamRes.data.data;

  return bffJsonResponse({
    authenticated: true,
    csrfToken: session.csrfToken,
    activeConsole: session.activeConsole,
    activeOrgSlug: session.activeOrgSlug,
    user: {
      id: me.user.id,
      email: me.user.email,
      name: me.user.name,
      globalRoles: me.globalRoles,
      hostingAdminOrgIds: me.hostingAdminOrgIds,
      locale: me.user.locale,
      isServerAdmin: me.user.isServerAdmin,
      mustChangePassword: me.user.mustChangePassword,
    },
    memberships: me.memberships,
    platformCapabilities: me.platformCapabilities,
  });
}
