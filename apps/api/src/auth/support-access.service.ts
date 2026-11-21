import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { PrincipalContext } from "@hosting-panel/authz";
import type { PermissionKey, SupportAccessDto } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  eq,
  organizations,
  supportAccessGrants,
  users,
  type DatabaseClient,
  type DatabaseExecutor,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { extractClientIp, extractRawHeader, resolveRequestId } from "../common/control-plane.error.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import type { AuthenticatedRequestContext } from "./authz-context.service.js";

/** What a support visit may do on the customer's organization: sites, services, operations only. */
export const SUPPORT_ACCESS_PERMISSIONS = [
  "site.read",
  "site.create",
  "site.update",
  "site.delete",
  "site.files.read",
  "site.files.write",
  "site.sftp.manage",
  "site.databases.manage",
  "site.backups.manage",
  "site.certificates.manage",
  "service.deploy",
  "service.restart",
  "service.stop",
  "service.logs.read",
  "operation.read",
] as const satisfies readonly PermissionKey[];

export const SUPPORT_ACCESS_TTL_MS = 3_600_000;
export const SUPPORT_ACCESS_REASON = "Server administrator support visit";

/** The caller's active visit with the newest expiry, or undefined. */
export async function currentSupportAccess(
  db: DatabaseExecutor,
  principal: PrincipalContext,
): Promise<SupportAccessDto | undefined> {
  const now = Date.now();
  const [grant] = (principal.supportGrants ?? [])
    .filter((g) => Date.parse(g.expiresAt) > now)
    .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
  if (!grant) return undefined;
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, grant.organizationId))
    .limit(1);
  return { organizationId: grant.organizationId, organizationName: org?.name ?? grant.organizationId, expiresAt: grant.expiresAt };
}

/** Opens and closes support visits, one at a time per administrator, audited with the grant. */
@Injectable()
export class SupportAccessService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(ManagedSitesService) private readonly sites: ManagedSitesService,
  ) {}

  public async open(auth: AuthenticatedRequestContext, req: FastifyRequest, siteId: string): Promise<SupportAccessDto> {
    const organizationId = await this.sites.ownerOf(siteId);
    const db = this.dbClient.db;
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    const expiresAt = new Date(Date.now() + SUPPORT_ACCESS_TTL_MS).toISOString();
    await db.transaction(async (tx) => {
      // Two opens at the same moment serialize on the admin's own row, so the second ends the first's visit.
      // NO KEY UPDATE, not UPDATE: a close's audit row takes KEY SHARE on this row through actor_id, and UPDATE would deadlock with it.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, auth.user.id)).for("no key update");
      await endVisits(tx, auth, req);
      await tx.insert(supportAccessGrants).values({
        id: `sag_${randomUUID().replace(/-/g, "")}`,
        organizationId,
        operatorUserId: auth.user.id,
        approvedByUserId: auth.user.id,
        permissions: [...SUPPORT_ACCESS_PERMISSIONS],
        reason: SUPPORT_ACCESS_REASON,
        expiresAt: new Date(expiresAt),
      });
      await audit(tx, auth, req, "admin.support_access.open", organizationId, "site", siteId, { expiresAt });
    });
    return { organizationId, organizationName: org?.name ?? organizationId, expiresAt };
  }

  public async close(auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<void> {
    await this.dbClient.db.transaction((tx) => endVisits(tx, auth, req));
  }
}

/** Deletes every grant of the caller; one close row per grant that was still valid. */
async function endVisits(tx: DatabaseExecutor, auth: AuthenticatedRequestContext, req: FastifyRequest): Promise<void> {
  const ended = await tx.delete(supportAccessGrants).where(eq(supportAccessGrants.operatorUserId, auth.user.id)).returning();
  const now = Date.now();
  for (const grant of ended) {
    if (grant.expiresAt.getTime() <= now) continue;
    await audit(tx, auth, req, "admin.support_access.close", grant.organizationId, "organization", grant.organizationId, {});
  }
}

/** One support audit row in the customer's organization. */
async function audit(
  tx: DatabaseExecutor,
  auth: AuthenticatedRequestContext,
  req: FastifyRequest,
  action: string,
  organizationId: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await appendAuditEvent(tx, {
    actorId: auth.user.id,
    actorType: "user",
    organizationId,
    action,
    targetType,
    targetId,
    ipAddress: extractClientIp(req),
    userAgent: extractRawHeader(req.headers as Record<string, string | string[] | undefined>, "user-agent") ?? null,
    details: { outcome: "succeeded", requestId: resolveRequestId(req), ...details },
  });
}
