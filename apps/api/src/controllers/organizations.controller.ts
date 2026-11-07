import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  canRemoveOrganizationMember,
  resolveEffectiveOrgPermissions,
} from "@hosting-panel/authz";
import {
  CreateInvitationInputSchema,
  DEFAULT_COOLIFY_V4_CAPABILITIES,
  MemberDtoSchema,
  OrganizationCapabilitiesDtoSchema,
  OrganizationDetailDtoSchema,
  QuotaAllocationDtoSchema,
  type MemberDto,
  type OrganizationCapabilitiesDto,
  type OrganizationDetailDto,
  type PaginatedListEnvelope,
  type QuotaAllocationDto,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  eq,
  hostingResources,
  inArray,
  membershipRoles,
  memberships,
  or,
  organizations,
  providerConnections,
  providerInstances,
  quotaAllocations,
  roles,
  serverAllocations,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { OidcService } from "../auth/oidc.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  paginateByKey,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

@Controller("v1/organizations/:orgId")
export class OrganizationsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(OidcService) private readonly oidcService: OidcService,
  ) {}

  @Get()
  public async getOrganization(
    @Param("orgId") orgId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<OrganizationDetailDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    const db = this.dbClient.db;
    const [orgRow] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!orgRow) {
      throw new ControlPlaneError("NOT_FOUND", "Organization was not found.");
    }

    const activeMembers = await db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")));

    const orgServers = await db
      .select({ id: serverAllocations.id })
      .from(serverAllocations)
      .where(eq(serverAllocations.organizationId, orgId));

    const orgResources = await db
      .select({ id: hostingResources.id, type: hostingResources.type })
      .from(hostingResources)
      .where(eq(hostingResources.organizationId, orgId));

    const applicationCount = orgResources.filter((r) => r.type === "application").length;
    const databaseCount = orgResources.filter((r) => r.type === "database").length;

    const dto = OrganizationDetailDtoSchema.parse({
      id: orgRow.id,
      slug: orgRow.slug,
      name: orgRow.name,
      type: orgRow.type,
      status: orgRow.status,
      primaryLocale: orgRow.primaryLocale,
      memberCount: activeMembers.length,
      serverCount: orgServers.length,
      applicationCount,
      databaseCount,
      createdAt: orgRow.createdAt.toISOString(),
      updatedAt: orgRow.updatedAt.toISOString(),
    });

    return { data: dto };
  }

  @Get("capabilities")
  public async getCapabilities(
    @Param("orgId") orgId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<OrganizationCapabilitiesDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    const db = this.dbClient.db;
    const [connInstance] = await db
      .select({ instance: providerInstances })
      .from(providerConnections)
      .innerJoin(
        providerInstances,
        eq(providerConnections.providerInstanceId, providerInstances.id),
      )
      .where(eq(providerConnections.organizationId, orgId))
      .limit(1);

    const now = new Date();
    const dto = OrganizationCapabilitiesDtoSchema.parse({
      organizationId: orgId,
      permissions: resolveEffectiveOrgPermissions(auth.principal, orgId, now),
      features: connInstance?.instance.capabilitiesJson ?? DEFAULT_COOLIFY_V4_CAPABILITIES,
      evaluatedAt: now.toISOString(),
    });

    return { data: dto };
  }

  @Get("members")
  public async listMembers(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<MemberDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    const pagination = parsePaginationQuery(query);
    const db = this.dbClient.db;

    const memberRows = await db
      .select({
        membership: memberships,
        user: users,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")))
      .orderBy(asc(memberships.createdAt), asc(memberships.id));

    const mbrIds = memberRows.map((r) => r.membership.id);
    const assignedRoles =
      mbrIds.length > 0
        ? await db
            .select({
              membershipRole: membershipRoles,
              role: roles,
            })
            .from(membershipRoles)
            .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
            .where(inArray(membershipRoles.membershipId, mbrIds))
        : [];

    const items = memberRows.map((row) => {
      const roleNames = [
        ...new Set(
          assignedRoles
            .filter((ar) => ar.membershipRole.membershipId === row.membership.id)
            .map((ar) => ar.role.name),
        ),
      ];
      return MemberDtoSchema.parse({
        membershipId: row.membership.id,
        organizationId: orgId,
        userId: row.user.id,
        email: row.user.email,
        displayName: row.user.displayName,
        roles: roleNames,
        joinedAt: row.membership.createdAt.toISOString(),
      });
    });

    const paged = paginateByKey(items, (item) => item.membershipId, pagination);
    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Post("invitations")
  @HttpCode(201)
  public async createInvitation(
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<MemberDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.members.manage",
      targetType: "organization",
      targetId: orgId,
    });

    const input = CreateInvitationInputSchema.parse(rawBody ?? {});
    const normalizedEmail = input.email.trim().toLowerCase();
    if (input.roles.includes("platform_admin")) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        "Role 'platform_admin' cannot be granted via organization invitation.",
      );
    }

    const db = this.dbClient.db;
    const now = new Date();
    const requestId = resolveRequestId(req);

    const createdMember = await db.transaction(async (tx) => {
      let [targetUser] = await tx
        .select()
        .from(users)
        .where(eq(users.email, normalizedEmail))
        .limit(1);

      if (!targetUser) {
        const userId = generatePrefixedId("usr");
        const localPart = normalizedEmail.split("@")[0] ?? "Utente Invitato";
        const [insertedUser] = await tx
          .insert(users)
          .values({
            id: userId,
            issuer: this.oidcService.issuer,
            subject: userId,
            email: normalizedEmail,
            emailVerified: false,
            displayName: localPart,
            status: "active",
            isPlatformAdmin: false,
            createdAt: now,
          })
          .returning();
        if (!insertedUser) {
          throw new ControlPlaneError("INTERNAL_ERROR", "Failed to create invited user.");
        }
        targetUser = insertedUser;
      }

      const [existingMembership] = await tx
        .select()
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, orgId),
            eq(memberships.userId, targetUser.id),
          ),
        )
        .limit(1);

      if (existingMembership && existingMembership.status === "active") {
        throw new ControlPlaneError(
          "VALIDATION_ERROR",
          "User is already an active member of this organization.",
        );
      }

      let membershipId = existingMembership?.id;
      if (!membershipId) {
        membershipId = generatePrefixedId("mbr");
        await tx.insert(memberships).values({
          id: membershipId,
          organizationId: orgId,
          userId: targetUser.id,
          status: "invited",
          createdAt: now,
        });
      }

      const systemRoles = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.isSystem, true), inArray(roles.name, [...input.roles])));

      for (const sysRole of systemRoles) {
        await tx.insert(membershipRoles).values({
          id: generatePrefixedId("mrole"),
          membershipId,
          roleId: sysRole.id,
          scopeType: "organization",
          scopeResourceId: null,
        });
      }

      await appendAuditEvent(tx, {
        organizationId: orgId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: "organization.invitation.create",
        targetType: "membership",
        targetId: membershipId,
        outcome: "succeeded",
        requestId,
        ipAddress: extractClientIp(req),
        metadata: {
          invitedEmail: normalizedEmail,
        },
        occurredAt: now,
      });

      return MemberDtoSchema.parse({
        membershipId,
        organizationId: orgId,
        userId: targetUser.id,
        email: targetUser.email,
        displayName: targetUser.displayName,
        roles: [...new Set(input.roles)],
        joinedAt: now.toISOString(),
      });
    });

    return { data: createdMember };
  }

  @Delete("members/:memberId")
  @HttpCode(200)
  public async removeMember(
    @Param("orgId") orgId: string,
    @Param("memberId") memberId: string,
    @Req() req: FastifyRequest,
  ): Promise<{
    readonly data: {
      readonly deleted: true;
      readonly membershipId: string;
    };
  }> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.members.manage",
      targetType: "membership",
      targetId: memberId,
    });

    const db = this.dbClient.db;
    const requestId = resolveRequestId(req);

    const [targetMembership] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, orgId),
          or(eq(memberships.id, memberId), eq(memberships.userId, memberId)),
        ),
      )
      .limit(1);

    if (!targetMembership) {
      throw new ControlPlaneError("NOT_FOUND", "Organization member was not found.");
    }

    const orgActiveMemberships = await db
      .select({ id: memberships.id, status: memberships.status })
      .from(memberships)
      .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, "active")));

    const orgActiveIds = orgActiveMemberships.map((m) => m.id);
    const allRoleRows =
      orgActiveIds.length > 0
        ? await db
            .select({
              membershipRole: membershipRoles,
              role: roles,
            })
            .from(membershipRoles)
            .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
            .where(inArray(membershipRoles.membershipId, orgActiveIds))
        : [];

    const targetRoleNames = [
      ...new Set(
        allRoleRows
          .filter((r) => r.membershipRole.membershipId === targetMembership.id)
          .map((r) => r.role.name),
      ),
    ];

    const activeOwnerMembershipIds = new Set(
      allRoleRows
        .filter(
          (r) =>
            r.role.name === "customer_owner" &&
            r.membershipRole.scopeType === "organization",
        )
        .map((r) => r.membershipRole.membershipId),
    );

    const check = canRemoveOrganizationMember({
      targetRoleNames,
      activeOwnerCount: activeOwnerMembershipIds.size,
    });

    if (!check.allowed) {
      await this.authzContext.recordDeniedAudit(auth, req, {
        organizationId: orgId,
        action: "organization.member.remove",
        targetType: "membership",
        targetId: targetMembership.id,
        reason: "LAST_OWNER_PROTECTED",
      });
      throw new ControlPlaneError(check.errorCode, check.message);
    }

    await db.delete(memberships).where(eq(memberships.id, targetMembership.id));

    await appendAuditEvent(db, {
      organizationId: orgId,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: "organization.member.remove",
      targetType: "membership",
      targetId: targetMembership.id,
      outcome: "succeeded",
      requestId,
      ipAddress: extractClientIp(req),
      metadata: {
        removedUserId: targetMembership.userId,
      },
    });

    return {
      data: {
        deleted: true,
        membershipId: targetMembership.id,
      },
    };
  }

  @Get("quotas")
  public async getQuotas(
    @Param("orgId") orgId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<QuotaAllocationDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "quota.read",
      targetType: "quota",
      targetId: orgId,
    });

    const [quota] = await this.dbClient.db
      .select()
      .from(quotaAllocations)
      .where(eq(quotaAllocations.organizationId, orgId))
      .limit(1);

    if (!quota) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Quota allocation was not found for organization.",
      );
    }

    const dto = QuotaAllocationDtoSchema.parse({
      organizationId: quota.organizationId,
      planCode: quota.planCode,
      serversUsed: quota.serversUsed,
      serversLimit: quota.serversLimit,
      applicationsUsed: quota.applicationsUsed,
      applicationsLimit: quota.applicationsLimit,
      databasesUsed: quota.databasesUsed,
      databasesLimit: quota.databasesLimit,
      domainsUsed: quota.domainsUsed,
      domainsLimit: quota.domainsLimit,
      updatedAt: quota.updatedAt.toISOString(),
    });

    return { data: dto };
  }
}
