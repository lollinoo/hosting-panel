import type { FastifyRequest } from "fastify";
import type { AuthenticatedRequestContext, AuthzContextService } from "./authz-context.service.js";

/** Only infrastructure_admin holds platform.users.manage; TOTP is enforced at login for that role. */
export async function requireServerAdmin(
  authz: AuthzContextService,
  req: FastifyRequest,
  targetId: string | null,
  targetType: string = "user",
): Promise<AuthenticatedRequestContext> {
  const auth = await authz.authenticateRequest(req);
  await authz.requirePlatformPermission(auth, req, "platform.users.manage", targetType, targetId);
  return auth;
}
