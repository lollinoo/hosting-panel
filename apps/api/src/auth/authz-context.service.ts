import { Inject, Injectable } from "@nestjs/common";
import {
  evaluatePolicy,
  type AuthorizationDecision,
  type AuthorizationResourceTarget,
  type MembershipRoleBinding,
  type PrincipalContext,
  type ResourceGrantRecord,
  type SupportAccessGrantRecord,
  type TenantMembershipContext,
} from "@hosting-panel/authz";
import {
  type PermissionKey,
  type PresetRoleName,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  eq,
  hostingAdminScopes,
  inArray,
  membershipRoles,
  memberships,
  organizations,
  resourceGrants,
  rolePermissions,
  roles,
  supportAccessGrants,
  users,
  type DatabaseClient,
  type DatabaseExecutor,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { OidcService, type VerifiedJwtClaims } from "./oidc.service.js";

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly userStatus: string;
}

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "suspended" | "archived";
}

export interface AuthenticatedMembershipSummary {
  readonly membershipId: string;
  readonly organization: OrganizationRow;
  readonly roleNames: readonly string[];
}

export interface AuthenticatedRequestContext {
  readonly user: UserRow;
  readonly claims: VerifiedJwtClaims;
  readonly principal: PrincipalContext;
  readonly activeMembershipSummaries: readonly AuthenticatedMembershipSummary[];
}

export interface AuthenticateOptions {
  /** Only GET /v1/me, POST /v1/me/password and POST /v1/auth/revoke pass this (#8). */
  readonly allowPasswordChangePending?: boolean;
}

// Rows of refused requests per actor and minute: above the ~55 of one sweep of every admin route.
const DENIED_ROWS_PER_MINUTE = 120;
const DENIED_ACTORS_MAX = 10_000;

@Injectable()
export class AuthzContextService {
  // shortcut: one fixed minute per actor in this process (a burst across two minutes can write 240), enough while one API process runs.
  private readonly deniedWindows = new Map<string, { start: number; count: number }>();

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(OidcService) private readonly oidcService: OidcService,
  ) {}

  public async authenticateRequest(
    req: FastifyRequest,
    options: AuthenticateOptions = {},
  ): Promise<AuthenticatedRequestContext> {
    const authHeader = extractRawHeader(
      req.headers as Record<string, string | string[] | undefined>,
      "authorization",
    );
    const claims = await this.oidcService.verifyAuthorizationHeader(authHeader);

    const [userById] = await this.dbClient.db
      .select()
      .from(users)
      .where(eq(users.id, claims.subject))
      .limit(1);

    let user = userById;
    if (!user && claims.email) {
      const [userByEmail] = await this.dbClient.db
        .select()
        .from(users)
        .where(eq(users.email, claims.email))
        .limit(1);
      user = userByEmail;
    }

    if (!user) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authenticated principal does not correspond to a registered user.",
      );
    }

    if (user.userStatus !== "active") {
      throw new ControlPlaneError("UNAUTHENTICATED", "User account is not active.");
    }

    // #8: a temporary password opens only the three exempt routes; no audit row, it is not a permission decision.
    if (user.mustChangePassword && !options.allowPasswordChangePending && !isBreakGlass(claims)) {
      throw new ControlPlaneError("PASSWORD_CHANGE_REQUIRED", "Change the temporary password first.");
    }

    const loaded = await this.loadPrincipalContextForUser(user);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        userStatus: user.userStatus,
      },
      claims,
      principal: loaded.principal,
      activeMembershipSummaries: loaded.activeMembershipSummaries,
    };
  }

  public async loadPrincipalContextForUser(user: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly userStatus: string;
    readonly platformRole: "infrastructure_admin" | null;
  }): Promise<{
    readonly principal: PrincipalContext;
    readonly activeMembershipSummaries: readonly AuthenticatedMembershipSummary[];
  }> {
    const db = this.dbClient.db;

    // Load global roles and hosting admin scopes
    const globalRoles: PresetRoleName[] = [];
    if (user.platformRole === "infrastructure_admin") {
      globalRoles.push("infrastructure_admin");
    }

    const adminScopes = await db
      .select()
      .from(hostingAdminScopes)
      .where(eq(hostingAdminScopes.userId, user.id));

    const hostingAdminOrgIds: string[] = [];
    if (adminScopes.length > 0) {
      globalRoles.push("hosting_admin");
      for (const scope of adminScopes) {
        if (scope.organizationId) {
          hostingAdminOrgIds.push(scope.organizationId);
        }
      }
    }

    // Load memberships
    const userMemberships = await db
      .select({
        membership: memberships,
        organization: organizations,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, user.id));

    const membershipIds = userMemberships.map((row) => row.membership.id);

    const assignedRolesRows =
      membershipIds.length > 0
        ? await db
            .select({
              membershipRole: membershipRoles,
              role: roles,
            })
            .from(membershipRoles)
            .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
            .where(inArray(membershipRoles.membershipId, membershipIds))
        : [];

    const roleIds = [...new Set(assignedRolesRows.map((row) => row.role.id))];
    const rolePermRows =
      roleIds.length > 0
        ? await db
            .select()
            .from(rolePermissions)
            .where(inArray(rolePermissions.roleId, roleIds))
        : [];

    const permsByRoleId = new Map<
      string,
      Array<{ readonly permission: PermissionKey; readonly effect: "allow" | "deny" }>
    >();
    for (const rp of rolePermRows) {
      const list = permsByRoleId.get(rp.roleId) ?? [];
      list.push({ permission: rp.permissionKey, effect: "allow" });
      permsByRoleId.set(rp.roleId, list);
    }

    // Load resource grants
    const userGrants = await db
      .select()
      .from(resourceGrants)
      .where(eq(resourceGrants.principalUserId, user.id));

    const grantsByOrg = new Map<string, ResourceGrantRecord[]>();
    for (const g of userGrants) {
      const list = grantsByOrg.get(g.organizationId) ?? [];
      list.push({
        id: g.id,
        organizationId: g.organizationId,
        principalUserId: g.principalUserId,
        resourceId: g.resourceId,
        permission: g.permission,
        effect: g.effect,
        expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      });
      grantsByOrg.set(g.organizationId, list);
    }

    // Load support access grants
    const supportGrantRows = await db
      .select()
      .from(supportAccessGrants)
      .where(eq(supportAccessGrants.operatorUserId, user.id));

    const supportGrantRecords: SupportAccessGrantRecord[] = supportGrantRows.map((sg) => ({
      id: sg.id,
      organizationId: sg.organizationId,
      operatorUserId: sg.operatorUserId,
      approvedByUserId: sg.approvedByUserId,
      permissions: sg.permissions,
      expiresAt: sg.expiresAt.toISOString(),
    }));

    const tenantMemberships: TenantMembershipContext[] = [];
    const activeMembershipSummaries: AuthenticatedMembershipSummary[] = [];

    for (const item of userMemberships) {
      const matchingAssigned = assignedRolesRows.filter(
        (ar) => ar.membershipRole.membershipId === item.membership.id,
      );

      const bindings: MembershipRoleBinding[] = matchingAssigned.map((ar) => ({
        roleName: ar.role.name,
        permissions: permsByRoleId.get(ar.role.id) ?? [],
        scopeType: ar.membershipRole.scopeType as "organization" | "resource",
        scopeResourceId: ar.membershipRole.scopeResourceId,
      }));

      tenantMemberships.push({
        membershipId: item.membership.id,
        organizationId: item.organization.id,
        organizationStatus: item.organization.status,
        membershipStatus: item.membership.status as "active" | "invited" | "suspended" | "revoked",
        roleBindings: bindings,
        resourceGrants: grantsByOrg.get(item.organization.id) ?? [],
      });

      if (item.membership.status === "active") {
        const distinctRoleNames = [
          ...new Set(matchingAssigned.map((ar) => ar.role.name)),
        ];
        activeMembershipSummaries.push({
          membershipId: item.membership.id,
          organization: {
            id: item.organization.id,
            name: item.organization.name,
            slug: item.organization.slug,
            status: item.organization.status,
          },
          roleNames: distinctRoleNames,
        });
      }
    }

    activeMembershipSummaries.sort((a, b) =>
      a.organization.slug.localeCompare(b.organization.slug),
    );

    const principal: PrincipalContext = {
      userId: user.id,
      email: user.email,
      userStatus: user.userStatus === "active" ? "active" : "suspended",
      globalRoles: [...new Set(globalRoles)],
      hostingAdminOrgIds,
      memberships: tenantMemberships,
      supportGrants: supportGrantRecords,
    };

    return {
      principal,
      activeMembershipSummaries,
    };
  }

  public async requirePlatformPermission(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    permission: PermissionKey,
    targetType: string = "platform",
    targetId: string | null = null,
  ): Promise<void> {
    const decision = evaluatePolicy({
      principal: auth.principal,
      permission,
      now: new Date(),
    });

    if (!decision.allowed) {
      await this.recordDeniedAudit(auth, req, {
        organizationId: null,
        action: permission,
        targetType,
        targetId,
        reason: decision.reason,
      });
      throw new ControlPlaneError(
        decision.errorCode ?? "PERMISSION_DENIED",
        `Platform permission '${permission}' denied.`,
      );
    }
  }

  public async requireOrgPermission(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    input: {
      readonly organizationId: string;
      readonly permission: PermissionKey;
      readonly targetType: string;
      readonly targetId?: string | null;
      readonly resource?: AuthorizationResourceTarget;
    },
  ): Promise<AuthorizationDecision> {
    const decision = evaluatePolicy({
      principal: auth.principal,
      permission: input.permission,
      organizationId: input.organizationId,
      resource: input.resource,
      now: new Date(),
    });

    if (!decision.allowed) {
      if (decision.httpStatus === 403) {
        await this.recordDeniedAudit(auth, req, {
          organizationId: input.organizationId,
          action: input.permission,
          targetType: input.targetType,
          targetId: input.targetId ?? input.resource?.id ?? null,
          reason: decision.reason,
        });

        throw new ControlPlaneError(
          decision.errorCode ?? "PERMISSION_DENIED",
          decision.reason === "ORGANIZATION_SUSPENDED"
            ? "Mutating operations are disabled while the organization is commercially suspended."
            : `Permission '${input.permission}' was denied by policy.`,
        );
      }

      // 404 anti-BOLA
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Requested organization or resource was not found.",
      );
    }

    return decision;
  }

  public async recordDeniedAudit(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    input: {
      readonly organizationId: string | null;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string | null;
      readonly reason: string;
      readonly details?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!this.#deniedRowAllowed(auth.user.id)) return;
    await appendAuditEvent(this.dbClient.db, {
      actorId: auth.user.id,
      actorType: "user",
      organizationId: input.organizationId,
      action: input.action,
      targetType: input.targetType,
      // R202 5: a raw path value may hold U+0000, which the database refuses; the denied row must still be written.
      targetId: input.targetId?.replaceAll("\u0000", "\uFFFD") ?? null,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(
        req.headers as Record<string, string | string[] | undefined>,
        "user-agent",
      ),
      details: {
        outcome: "denied",
        reason: input.reason,
        requestId: resolveRequestId(req),
        ...(input.details ?? {}),
      },
    });
  }

  /** Counts a denied row for the actor; false once 120 were written in its current minute. */
  #deniedRowAllowed(actorId: string): boolean {
    const now = Date.now();
    let window = this.deniedWindows.get(actorId);
    if (!window || now - window.start >= 60_000) {
      this.deniedWindows.delete(actorId);
      // The map is bounded: the oldest window goes first.
      if (this.deniedWindows.size >= DENIED_ACTORS_MAX) this.deniedWindows.delete(this.deniedWindows.keys().next().value!);
      window = { start: now, count: 0 };
      this.deniedWindows.set(actorId, window);
    }
    window.count += 1;
    // R207 a.6: the first row the cap drops in a window leaves one trace, nothing of the request.
    if (window.count === DENIED_ROWS_PER_MINUTE + 1) console.warn(JSON.stringify({ event: "audit_denied_rows_capped", actorId }));
    return window.count <= DENIED_ROWS_PER_MINUTE;
  }

  public async recordAudit(
    auth: AuthenticatedRequestContext | null,
    req: FastifyRequest,
    input: {
      readonly organizationId?: string | null;
      readonly action: string;
      readonly targetType: string;
      readonly targetId?: string | null;
      readonly details?: Record<string, unknown>;
    },
    db: DatabaseExecutor = this.dbClient.db,
  ): Promise<void> {
    await appendAuditEvent(db, {
      actorId: auth?.user.id ?? null,
      actorType: "user",
      organizationId: input.organizationId ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(
        req.headers as Record<string, string | string[] | undefined>,
        "user-agent",
      ),
      details: {
        outcome: "succeeded",
        requestId: resolveRequestId(req),
        ...(input.details ?? {}),
      },
    });
  }
}

/** Only a shell on the server mints a break-glass token, for 5 minutes, and recovery must not depend on the flag. */
function isBreakGlass(claims: VerifiedJwtClaims): boolean {
  const amr = claims.rawPayload.amr;
  return Array.isArray(amr) && amr.includes("breakglass");
}
