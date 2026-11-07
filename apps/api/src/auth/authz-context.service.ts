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
  isMutatingPermission,
  type AuditMetadata,
  type PermissionKey,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  eq,
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
  type OrganizationRow,
  type UserRow,
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

@Injectable()
export class AuthzContextService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(OidcService) private readonly oidcService: OidcService,
  ) {}

  public async authenticateRequest(req: FastifyRequest): Promise<AuthenticatedRequestContext> {
    const authHeader = extractRawHeader(
      req.headers as Record<string, string | string[] | undefined>,
      "authorization",
    );
    const claims = await this.oidcService.verifyAuthorizationHeader(authHeader);

    const [user] = await this.dbClient.db
      .select()
      .from(users)
      .where(and(eq(users.issuer, claims.issuer), eq(users.subject, claims.subject)))
      .limit(1);

    if (!user) {
      throw new ControlPlaneError(
        "UNAUTHENTICATED",
        "Authenticated principal does not correspond to a registered user.",
      );
    }

    const loaded = await this.loadPrincipalContextForUser(user);
    return {
      user,
      claims,
      principal: loaded.principal,
      activeMembershipSummaries: loaded.activeMembershipSummaries,
    };
  }

  public async loadPrincipalContextForUser(user: UserRow): Promise<{
    readonly principal: PrincipalContext;
    readonly activeMembershipSummaries: readonly AuthenticatedMembershipSummary[];
  }> {
    const db = this.dbClient.db;

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
      list.push({ permission: rp.permissionKey, effect: rp.effect });
      permsByRoleId.set(rp.roleId, list);
    }

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

    const supportGrantRows = await db
      .select()
      .from(supportAccessGrants)
      .where(eq(supportAccessGrants.operatorUserId, user.id));

    const supportGrantRecords: SupportAccessGrantRecord[] = supportGrantRows.map((sg) => ({
      id: sg.id,
      organizationId: sg.organizationId,
      operatorUserId: sg.operatorUserId,
      approvedByUserId: sg.approvedByUserId,
      permissions: sg.permissionsJson,
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
        scopeType: ar.membershipRole.scopeType,
        scopeResourceId: ar.membershipRole.scopeResourceId,
      }));

      // Ensure resource-scoped members whose assigned role includes organization.read
      // retain baseline organization.read metadata access on their own active organization.
      const hasOrgScopedOrgRead = bindings.some(
        (b) =>
          b.scopeType === "organization" &&
          b.permissions.some((p) => p.permission === "organization.read" && p.effect === "allow"),
      );
      const hasResourceRoleWithOrgRead = bindings.some(
        (b) =>
          b.scopeType === "resource" &&
          b.permissions.some((p) => p.permission === "organization.read" && p.effect === "allow"),
      );
      if (!hasOrgScopedOrgRead && hasResourceRoleWithOrgRead) {
        bindings.push({
          roleName: "organization_member_baseline",
          permissions: [{ permission: "organization.read", effect: "allow" }],
          scopeType: "organization",
          scopeResourceId: null,
        });
      }

      tenantMemberships.push({
        membershipId: item.membership.id,
        organizationId: item.organization.id,
        organizationStatus: item.organization.status,
        membershipStatus: item.membership.status,
        roleBindings: bindings,
        resourceGrants: grantsByOrg.get(item.organization.id) ?? [],
      });

      if (item.membership.status === "active") {
        const distinctRoleNames = [
          ...new Set(matchingAssigned.map((ar) => ar.role.name)),
        ];
        activeMembershipSummaries.push({
          membershipId: item.membership.id,
          organization: item.organization,
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
      userStatus: user.status === "active" ? "active" : "suspended",
      isPlatformAdmin: user.isPlatformAdmin,
      memberships: tenantMemberships,
      supportGrants: supportGrantRecords,
    };

    return {
      principal,
      activeMembershipSummaries,
    };
  }

  public async requirePlatformAdmin(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string | null = null,
  ): Promise<void> {
    const decision = evaluatePolicy({
      principal: auth.principal,
      permission: "platform.admin",
    });

    if (!decision.allowed) {
      await this.recordDeniedAudit(auth, req, {
        organizationId: null,
        action,
        targetType,
        targetId,
        reason: decision.reason,
      });
      throw new ControlPlaneError(
        decision.errorCode ?? "PERMISSION_DENIED",
        "Platform administrator privileges are required.",
      );
    }
  }

  public async requireTenantBoundary(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    organizationId: string,
    permission: PermissionKey,
    targetType: string,
    targetId: string | null = null,
  ): Promise<void> {
    const now = new Date();
    const nowMs = now.getTime();

    const hasActiveMembership = auth.principal.memberships.some(
      (m) => m.organizationId === organizationId && m.membershipStatus === "active",
    );
    const hasActiveSupportGrant = (auth.principal.supportGrants ?? []).some(
      (g) =>
        g.organizationId === organizationId &&
        g.operatorUserId === auth.principal.userId &&
        Date.parse(g.expiresAt) > nowMs,
    );

    if (!hasActiveMembership && !hasActiveSupportGrant) {
      const decision = evaluatePolicy({
        principal: auth.principal,
        permission,
        organizationId,
        now,
      });

      if (decision.httpStatus === 403) {
        await this.recordDeniedAudit(auth, req, {
          organizationId,
          action: permission,
          targetType,
          targetId,
          reason: decision.reason,
        });
        throw new ControlPlaneError(
          "PERMISSION_DENIED",
          "Access to customer organization requires an active membership or time-boxed support grant.",
        );
      }

      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
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
    });

    if (!decision.allowed) {
      const shouldAuditDenial =
        decision.httpStatus === 403 &&
        (isMutatingPermission(input.permission) ||
          decision.reason.startsWith("SUPPORT_ACCESS_") ||
          auth.principal.isPlatformAdmin);

      if (shouldAuditDenial) {
        await this.recordDeniedAudit(auth, req, {
          organizationId: input.organizationId,
          action: input.permission,
          targetType: input.targetType,
          targetId: input.targetId ?? input.resource?.id ?? null,
          reason: decision.reason,
        });
      }

      if (decision.errorCode === "NOT_FOUND" || decision.httpStatus === 404) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Requested organization or resource was not found.",
        );
      }

      throw new ControlPlaneError(
        "PERMISSION_DENIED",
        decision.reason === "ORGANIZATION_SUSPENDED"
          ? "Mutating operations are disabled while the organization is commercially suspended."
          : `Permission '${input.permission}' was denied by policy.`,
      );
    }

    return decision;
  }

  public async requireOrgListPermission(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    organizationId: string,
    permission: PermissionKey,
    targetType: string,
  ): Promise<void> {
    const now = new Date();
    const nowMs = now.getTime();

    const orgDecision = evaluatePolicy({
      principal: auth.principal,
      permission,
      organizationId,
      now,
    });

    if (orgDecision.allowed) {
      return;
    }

    if (orgDecision.httpStatus === 404) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization was not found.");
    }

    // Check if an active member holds a resource-scoped role binding or active resource grant for this permission
    if (orgDecision.reason === "DEFAULT_DENY") {
      const activeMemberships = auth.principal.memberships.filter(
        (m) => m.organizationId === organizationId && m.membershipStatus === "active",
      );

      const hasScopedAllow = activeMemberships.some((m) => {
        const viaBinding = m.roleBindings.some(
          (b) =>
            b.scopeType === "resource" &&
            b.permissions.some((p) => p.permission === permission && p.effect === "allow"),
        );
        const viaGrant = m.resourceGrants.some(
          (g) =>
            g.organizationId === organizationId &&
            g.principalUserId === auth.principal.userId &&
            g.permission === permission &&
            g.effect === "allow" &&
            (g.expiresAt === null || Date.parse(g.expiresAt) > nowMs),
        );
        return viaBinding || viaGrant;
      });

      if (hasScopedAllow) {
        return;
      }
    }

    if (
      orgDecision.reason.startsWith("SUPPORT_ACCESS_") ||
      auth.principal.isPlatformAdmin ||
      isMutatingPermission(permission)
    ) {
      await this.recordDeniedAudit(auth, req, {
        organizationId,
        action: permission,
        targetType,
        targetId: null,
        reason: orgDecision.reason,
      });
    }

    throw new ControlPlaneError(
      "PERMISSION_DENIED",
      `Permission '${permission}' was denied by policy.`,
    );
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
      readonly extraMetadata?: AuditMetadata;
    },
  ): Promise<void> {
    // Only reference organizationId if it actually exists in organizations table (audit_events has no FK, so safe either way)
    await appendAuditEvent(this.dbClient.db, {
      organizationId: input.organizationId,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: "denied",
      requestId: resolveRequestId(req),
      ipAddress: extractClientIp(req),
      metadata: {
        reason: input.reason,
        ...(input.extraMetadata ?? {}),
      },
    });
  }
}
