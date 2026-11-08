import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  canRemoveOrganizationMember,
  filterAuthorizedResources,
} from "@hosting-panel/authz";
import {
  CreateInvitationInputSchema,
  CreateQuotaReservationInputSchema,
  CreateServiceInstanceInputSchema,
  CreateSiteInputSchema,
  CreateStackRevisionInputSchema,
  ServiceLifecycleInputSchema,
  UpsertEncryptedSecretInputSchema,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  type AsyncAcceptedEnvelope,
  type DomainDto,
  type EncryptedSecretMetadataDto,
  type HostAllocationDto,
  type MemberDto,
  type OperationDto,
  type OperationKind,
  type OrganizationCapabilitiesDto,
  type OrganizationDetailDto,
  type PermissionKey,
  type QuotaReservationDto,
  type ReadMeta,
  type ResourceQuotaDto,
  type ServiceInstanceDto,
  type SiteDetailDto,
  type SiteSummaryDto,
  type StackRevisionDto,
} from "@hosting-panel/contracts";
import {
  and,
  appendStackRevisionTransactional,
  asc,
  createServiceWithRevisionTransactional,
  createSiteTransactional,
  deleteEncryptedSecretTransactional,
  desc,
  domains,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  listEncryptedSecretsMetadata,
  membershipRoles,
  memberships,
  observedStates,
  operationSteps,
  operations,
  organizations,
  quotaReservations,
  reserveQuotaTransactional,
  resourceQuotas,
  roles,
  serviceInstances,
  serviceTemplates,
  sites,
  stackRevisions,
  upsertEncryptedSecretTransactional,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  createApprovedServiceSpec,
  type DockerExecutorPort,
} from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import {
  computeSiteAggregateSummary,
  evaluateServiceDrift,
  type ServiceAggregateInput,
} from "@hosting-panel/hosting-domain";
import { validateDeclarativeServiceInput } from "@hosting-panel/policy-engine";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  paginateItems,
  parsePaginationQuery,
  requireIdempotencyKey,
  resolveOptionalIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const SERVICE_OPERATION_STEPS = [
  { key: "validate_spec", label: "Validate declarative specification" },
  { key: "dispatch_ipc", label: "Dispatch signed request to docker-executor" },
  { key: "reconcile_state", label: "Reconcile observed container state" },
] as const;

function toIsoString(date: Date | string | null | undefined): string {
  if (!date) return new Date().toISOString();
  return date instanceof Date ? date.toISOString() : String(date);
}

function mapQuotaToDto(quota: typeof resourceQuotas.$inferSelect): ResourceQuotaDto {
  return {
    id: quota.id,
    organizationId: quota.organizationId,
    hostAllocationId: quota.hostAllocationId ?? null,
    maxSites: quota.maxSites,
    maxServices: quota.maxServices,
    maxCpuMilli: quota.maxCpuMilli,
    maxMemoryBytes: String(quota.maxMemoryBytes),
    maxStorageBytes: String(quota.maxStorageBytes),
    usedSites: quota.usedSites,
    usedServices: quota.usedServices,
    usedCpuMilli: quota.usedCpuMilli,
    usedMemoryBytes: String(quota.usedMemoryBytes),
    usedStorageBytes: String(quota.usedStorageBytes),
    createdAt: toIsoString(quota.createdAt),
    updatedAt: toIsoString(quota.updatedAt),
  };
}

function mapReservationToDto(res: typeof quotaReservations.$inferSelect): QuotaReservationDto {
  return {
    id: res.id,
    organizationId: res.organizationId,
    resourceQuotaId: res.resourceQuotaId,
    sites: res.sites,
    services: res.services,
    cpuMilli: res.cpuMilli,
    memoryBytes: String(res.memoryBytes),
    storageBytes: String(res.storageBytes),
    status: res.status,
    idempotencyKey: res.idempotencyKey,
    expiresAt: toIsoString(res.expiresAt),
    createdAt: toIsoString(res.createdAt),
  };
}

function mapAllocationToDto(alloc: typeof hostAllocations.$inferSelect): HostAllocationDto {
  return {
    id: alloc.id,
    hostId: alloc.hostId,
    organizationId: alloc.organizationId,
    status: alloc.status,
    hostingMode: alloc.hostingMode,
    dedicatedScope: alloc.dedicatedScope,
    createdAt: toIsoString(alloc.createdAt),
    updatedAt: toIsoString(alloc.updatedAt),
  };
}

function mapSiteSummaryToDto(site: typeof sites.$inferSelect): SiteSummaryDto {
  return {
    id: site.id,
    organizationId: site.organizationId,
    hostAllocationId: site.hostAllocationId,
    name: site.name,
    slug: site.slug,
    status: site.status,
    phpVersion: null,
    createdAt: toIsoString(site.createdAt),
    updatedAt: toIsoString(site.updatedAt),
  };
}

function mapServiceInstanceToDto(svc: typeof serviceInstances.$inferSelect): ServiceInstanceDto {
  return {
    id: svc.id,
    siteId: svc.siteId,
    organizationId: svc.organizationId,
    serviceTemplateId: svc.serviceTemplateId,
    name: svc.name,
    desiredStatus: svc.desiredStatus,
    currentRevisionId: svc.currentRevisionId ?? null,
    createdAt: toIsoString(svc.createdAt),
    updatedAt: toIsoString(svc.updatedAt),
  };
}

function mapStackRevisionToDto(rev: typeof stackRevisions.$inferSelect): StackRevisionDto {
  return {
    id: rev.id,
    serviceInstanceId: rev.serviceInstanceId,
    organizationId: rev.organizationId,
    revisionNumber: rev.revisionNumber,
    specHash: rev.specHash,
    declarativeConfig: (rev.declarativeConfig ?? {}) as Record<string, unknown>,
    secretRefs: (rev.secretRefs ?? {}) as Record<string, string>,
    resourceLimits: (rev.resourceLimits as StackRevisionDto["resourceLimits"]) ?? null,
    authorId: rev.authorId ?? null,
    createdAt: toIsoString(rev.createdAt),
  };
}

function mapDomainToDto(dom: typeof domains.$inferSelect): DomainDto {
  return {
    id: dom.id,
    siteId: dom.siteId,
    organizationId: dom.organizationId,
    hostname: dom.hostname,
    isPrimary: dom.isPrimary,
    status: dom.status,
    createdAt: toIsoString(dom.createdAt),
    updatedAt: toIsoString(dom.updatedAt),
  };
}

const STEP_KEY_ORDER: Readonly<Record<string, number>> = {
  validate_spec: 0,
  dispatch_ipc: 1,
  reconcile_state: 2,
};

function sortOperationSteps(
  steps: readonly (typeof operationSteps.$inferSelect)[],
): (typeof operationSteps.$inferSelect)[] {
  return [...steps].sort((a, b) => {
    const rankA = STEP_KEY_ORDER[a.key] ?? 10;
    const rankB = STEP_KEY_ORDER[b.key] ?? 10;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    const startA = a.startedAt ? a.startedAt.getTime() : Number.MAX_SAFE_INTEGER;
    const startB = b.startedAt ? b.startedAt.getTime() : Number.MAX_SAFE_INTEGER;
    if (startA !== startB) {
      return startA - startB;
    }
    return a.id.localeCompare(b.id);
  });
}

function mapOperationToDto(
  op: typeof operations.$inferSelect,
  steps: (typeof operationSteps.$inferSelect)[],
): OperationDto {
  const orderedSteps = sortOperationSteps(steps);
  return {
    id: op.id,
    organizationId: op.organizationId,
    kind: op.kind,
    status: op.status,
    resourceType: op.resourceType,
    resourceId: op.resourceId,
    requestedByUserId: op.requestedByUserId ?? null,
    errorCode: op.errorCode ?? null,
    errorMessage: op.errorMessage ?? null,
    submittedAt: toIsoString(op.submittedAt),
    startedAt: op.startedAt ? toIsoString(op.startedAt) : null,
    completedAt: op.completedAt ? toIsoString(op.completedAt) : null,
    updatedAt: toIsoString(op.updatedAt),
    steps: orderedSteps.map((s) => ({
      id: s.id,
      key: s.key,
      label: s.label,
      status: s.status,
      message: s.message ?? null,
      startedAt: s.startedAt ? toIsoString(s.startedAt) : null,
      completedAt: s.completedAt ? toIsoString(s.completedAt) : null,
    })),
  };
}

@Controller("v1/organizations/:orgId")
export class OrganizationsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  #buildCapabilities(): OrganizationCapabilitiesDto {
    const runtimeEnabled = this.config.runtimeBackend !== "disabled";
    return {
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable:
        runtimeEnabled && this.dockerExecutor.isRuntimeAvailable,
      hostAgentRuntimeAvailable:
        runtimeEnabled && this.hostAgent.isRuntimeAvailable,
      acmeTlsRuntimeAvailable: false,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    };
  }

  @Get()
  public async getOrganization(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
  ): Promise<{ data: OrganizationDetailDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    const [org] = await this.dbClient.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    const orgSites = await this.dbClient.db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.organizationId, orgId));

    const orgServices = await this.dbClient.db
      .select({ id: serviceInstances.id })
      .from(serviceInstances)
      .where(eq(serviceInstances.organizationId, orgId));

    const [quota] = await this.dbClient.db
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.organizationId, orgId))
      .limit(1);

    return {
      data: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        status: org.status,
        capabilities: this.#buildCapabilities(),
        quotas: quota ? mapQuotaToDto(quota) : null,
        siteCount: orgSites.length,
        serviceCount: orgServices.length,
        createdAt: toIsoString(org.createdAt),
        updatedAt: toIsoString(org.updatedAt),
      },
    };
  }

  @Get("capabilities")
  public async getCapabilities(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
  ): Promise<{ data: OrganizationCapabilitiesDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    return {
      data: this.#buildCapabilities(),
    };
  }

  @Get("secrets")
  public async getSecrets(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: EncryptedSecretMetadataDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    const rawSiteId = rawQuery?.["siteId"];
    const siteIdFilter =
      typeof rawSiteId === "string" && rawSiteId.trim().length > 0
        ? rawSiteId.trim()
        : undefined;

    if (siteIdFilter) {
      const [site] = await this.dbClient.db
        .select()
        .from(sites)
        .where(eq(sites.id, siteIdFilter))
        .limit(1);

      if (!site || site.organizationId !== orgId) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Requested organization or resource was not found.",
        );
      }

      await this.authzService.requireOrgPermission(auth, req, {
        organizationId: orgId,
        permission: "service.configuration.manage",
        targetType: "encrypted_secret",
        targetId: siteIdFilter,
        resource: { id: site.id, organizationId: site.organizationId },
      });
    } else {
      await this.authzService.requireOrgPermission(auth, req, {
        organizationId: orgId,
        permission: "service.configuration.manage",
        targetType: "encrypted_secret",
        targetId: orgId,
      });
    }

    const pagination = parsePaginationQuery(rawQuery);
    const metadataList = await listEncryptedSecretsMetadata(this.dbClient.db, {
      organizationId: orgId,
      ...(siteIdFilter !== undefined ? { siteId: siteIdFilter } : {}),
    });

    const paginated = paginateItems(metadataList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: metadataList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post("secrets")
  @HttpCode(HttpStatus.CREATED)
  public async upsertSecret(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: EncryptedSecretMetadataDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const candidateSiteId =
      rawBody !== null &&
      typeof rawBody === "object" &&
      typeof (rawBody as Record<string, unknown>)["siteId"] === "string" &&
      ((rawBody as Record<string, unknown>)["siteId"] as string).trim().length > 0
        ? ((rawBody as Record<string, unknown>)["siteId"] as string).trim()
        : null;

    if (candidateSiteId !== null) {
      const [site] = await this.dbClient.db
        .select()
        .from(sites)
        .where(eq(sites.id, candidateSiteId))
        .limit(1);

      if (!site || site.organizationId !== orgId) {
        throw new ControlPlaneError(
          "NOT_FOUND",
          "Requested organization or resource was not found.",
        );
      }

      await this.authzService.requireOrgPermission(auth, req, {
        organizationId: orgId,
        permission: "service.configuration.manage",
        targetType: "encrypted_secret",
        targetId: candidateSiteId,
        resource: { id: site.id, organizationId: site.organizationId },
      });
    } else {
      await this.authzService.requireOrgPermission(auth, req, {
        organizationId: orgId,
        permission: "service.configuration.manage",
        targetType: "encrypted_secret",
        targetId: orgId,
      });
    }

    requireIdempotencyKey(req.headers as Record<string, string | string[] | undefined>);
    const body = UpsertEncryptedSecretInputSchema.parse(rawBody ?? {});
    const normalizedSiteId =
      typeof body.siteId === "string" && body.siteId.trim().length > 0
        ? body.siteId.trim()
        : null;

    const saved = await upsertEncryptedSecretTransactional(this.dbClient.db, {
      organizationId: orgId,
      siteId: normalizedSiteId,
      secretKey: body.secretKey,
      value: body.value,
      masterKey: this.config.secretsMasterKey,
      actorId: auth.user.id,
    });

    return { data: saved };
  }

  @Delete("secrets/:secretId")
  public async deleteSecret(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("secretId") secretId: string,
  ): Promise<{ data: { deleted: true; secretId: string } }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "service.configuration.manage",
      targetType: "encrypted_secret",
      targetId: secretId,
    });

    await deleteEncryptedSecretTransactional(this.dbClient.db, {
      organizationId: orgId,
      secretId,
      actorId: auth.user.id,
    });

    return {
      data: {
        deleted: true,
        secretId,
      },
    };
  }

  @Get("allocations")
  public async getOrganizationAllocations(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: HostAllocationDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "allocation.read",
      targetType: "organization",
      targetId: orgId,
    });

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(hostAllocations)
      .where(eq(hostAllocations.organizationId, orgId))
      .orderBy(asc(hostAllocations.createdAt));

    const dtoList = rows.map(mapAllocationToDto);
    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Get("quotas")
  public async getQuotas(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
  ): Promise<{ data: ResourceQuotaDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "quota.read",
      targetType: "organization",
      targetId: orgId,
    });

    const [quota] = await this.dbClient.db
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.organizationId, orgId))
      .limit(1);

    if (!quota) {
      throw new ControlPlaneError("NOT_FOUND", `Resource quota for organization '${orgId}' not found.`);
    }

    return { data: mapQuotaToDto(quota) };
  }

  @Post("quotas/reservations")
  @HttpCode(HttpStatus.CREATED)
  public async createQuotaReservation(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: QuotaReservationDto }> {
    const auth = await this.authzService.authenticateRequest(req);

    // Caller can have site.create or quota.manage
    const hasQuotaManage = auth.principal.globalRoles?.includes("hosting_admin") || false;
    const requiredPerm: PermissionKey = hasQuotaManage ? "quota.manage" : "site.create";

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: requiredPerm,
      targetType: "quota_reservation",
      targetId: null,
    });

    const headers = req.headers as Record<string, string | string[] | undefined>;
    const fallbackKey = resolveOptionalIdempotencyKey(headers, "qres");

    const bodyRaw = (rawBody ?? {}) as Record<string, unknown>;
    const idempotencyKey =
      typeof bodyRaw["idempotencyKey"] === "string" && bodyRaw["idempotencyKey"].length > 0
        ? bodyRaw["idempotencyKey"]
        : fallbackKey;

    const parsed = CreateQuotaReservationInputSchema.parse({
      ...bodyRaw,
      idempotencyKey,
    });

    const [quota] = await this.dbClient.db
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.organizationId, orgId))
      .limit(1);

    if (!quota) {
      throw new ControlPlaneError("NOT_FOUND", `Resource quota for organization '${orgId}' not found.`);
    }

    const result = await reserveQuotaTransactional(this.dbClient.db, {
      organizationId: orgId,
      resourceQuotaId: quota.id,
      idempotencyKey: parsed.idempotencyKey,
      demand: {
        sites: parsed.sites,
        services: parsed.services,
        cpuMilli: parsed.cpuMilli,
        memoryBytes: parsed.memoryBytes,
        storageBytes: parsed.storageBytes,
      },
      actorId: auth.user.id,
    });

    return { data: mapReservationToDto(result.reservation) };
  }

  @Get("members")
  public async getMembers(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: MemberDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.read",
      targetType: "organization",
      targetId: orgId,
    });

    const pagination = parsePaginationQuery(rawQuery);

    const rows = await this.dbClient.db
      .select({
        membership: memberships,
        user: users,
        role: roles,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(membershipRoles, eq(memberships.id, membershipRoles.membershipId))
      .leftJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(eq(memberships.organizationId, orgId))
      .orderBy(asc(users.name));

    const dtoList: MemberDto[] = rows.map((r) => ({
      id: r.membership.id,
      organizationId: orgId,
      userId: r.user.id,
      email: r.user.email,
      name: r.user.name,
      role: (r.role?.name ?? "customer_collaborator") as "customer_owner" | "customer_collaborator",
      createdAt: toIsoString(r.membership.createdAt),
      updatedAt: toIsoString(r.membership.updatedAt),
    }));

    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post("invitations")
  @HttpCode(HttpStatus.CREATED)
  public async createInvitation(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: MemberDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.members.manage",
      targetType: "membership",
    });

    const body = CreateInvitationInputSchema.parse(rawBody ?? {});

    let [user] = await this.dbClient.db
      .select()
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);

    if (!user) {
      const newUserId = `usr_${randomUUID().replace(/-/g, "")}`;
      const [createdUser] = await this.dbClient.db
        .insert(users)
        .values({
          id: newUserId,
          email: body.email,
          name: body.email.split("@")[0] ?? "Member",
          userStatus: "active",
        })
        .returning();
      user = createdUser!;
    }

    const membershipId = `mem_${randomUUID().replace(/-/g, "")}`;
    const [membership] = await this.dbClient.db
      .insert(memberships)
      .values({
        id: membershipId,
        organizationId: orgId,
        userId: user.id,
        status: "active",
      })
      .returning();

    const [role] = await this.dbClient.db
      .select()
      .from(roles)
      .where(eq(roles.name, body.role))
      .limit(1);

    if (role) {
      await this.dbClient.db.insert(membershipRoles).values({
        id: `mr_${randomUUID().replace(/-/g, "")}`,
        membershipId,
        roleId: role.id,
        scopeType: "organization",
      });
    }

    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: "organization.invitation.create",
      targetType: "membership",
      targetId: membershipId,
      details: { email: body.email, role: body.role },
    });

    return {
      data: {
        id: membershipId,
        organizationId: orgId,
        userId: user.id,
        email: user.email,
        name: user.name,
        role: body.role,
        createdAt: toIsoString(membership!.createdAt),
        updatedAt: toIsoString(membership!.updatedAt),
      },
    };
  }

  @Delete("members/:memberId")
  public async deleteMember(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("memberId") memberId: string,
  ): Promise<{ data: { deleted: boolean; membershipId: string } }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "organization.members.manage",
      targetType: "membership",
      targetId: memberId,
    });

    const [targetMembership] = await this.dbClient.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.id, memberId), eq(memberships.organizationId, orgId)))
      .limit(1);

    if (!targetMembership) {
      throw new ControlPlaneError("NOT_FOUND", `Membership '${memberId}' not found.`);
    }

    const targetRolesRows = await this.dbClient.db
      .select({ role: roles })
      .from(membershipRoles)
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(eq(membershipRoles.membershipId, memberId));

    const targetRoleNames = targetRolesRows.map((r) => r.role.name);

    // Count active owners in this organization
    const activeOwnerMemberships = await this.dbClient.db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(membershipRoles, eq(memberships.id, membershipRoles.membershipId))
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(
          eq(memberships.organizationId, orgId),
          eq(memberships.status, "active"),
          eq(roles.name, "customer_owner"),
        ),
      );

    const check = canRemoveOrganizationMember({
      targetRoleNames,
      activeOwnerCount: activeOwnerMemberships.length,
    });

    if (!check.allowed) {
      throw new ControlPlaneError(check.errorCode, check.message);
    }

    await this.dbClient.db
      .delete(memberships)
      .where(eq(memberships.id, memberId));

    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: "organization.member.delete",
      targetType: "membership",
      targetId: memberId,
    });

    return {
      data: {
        deleted: true,
        membershipId: memberId,
      },
    };
  }

  @Get("sites")
  public async getSites(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: SiteSummaryDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.read",
      targetType: "site",
    });

    const pagination = parsePaginationQuery(rawQuery);
    const allSites = await this.dbClient.db
      .select()
      .from(sites)
      .where(eq(sites.organizationId, orgId))
      .orderBy(asc(sites.name));

    const authorizedSites = filterAuthorizedResources(
      auth.principal,
      orgId,
      "site.read",
      allSites,
    );

    const dtoList = authorizedSites.map(mapSiteSummaryToDto);
    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post("sites")
  @HttpCode(HttpStatus.CREATED)
  public async createSite(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: SiteDetailDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    requireIdempotencyKey(req.headers as Record<string, string | string[] | undefined>);

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.create",
      targetType: "site",
    });

    const body = CreateSiteInputSchema.parse(rawBody ?? {});

    // Verify hostAllocationId belongs to :orgId
    const [alloc] = await this.dbClient.db
      .select()
      .from(hostAllocations)
      .where(
        and(
          eq(hostAllocations.id, body.hostAllocationId),
          eq(hostAllocations.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!alloc) {
      throw new ControlPlaneError("NOT_FOUND", `Host allocation '${body.hostAllocationId}' not found.`);
    }

    // Check domain uniqueness if initialDomain provided
    if (body.initialDomain) {
      const [existingDom] = await this.dbClient.db
        .select()
        .from(domains)
        .where(eq(domains.hostname, body.initialDomain))
        .limit(1);

      if (existingDom) {
        throw new ControlPlaneError("DOMAIN_CONFLICT", `Domain '${body.initialDomain}' is already in use.`);
      }
    }

    const result = await createSiteTransactional(this.dbClient.db, {
      organizationId: orgId,
      hostAllocationId: body.hostAllocationId,
      name: body.name,
      slug: body.slug,
      initialDomain: body.initialDomain,
      actorId: auth.user.id,
    });

    const domainList: DomainDto[] = result.domain ? [mapDomainToDto(result.domain)] : [];

    return {
      data: {
        id: result.site.id,
        organizationId: orgId,
        hostAllocationId: result.site.hostAllocationId,
        name: result.site.name,
        slug: result.site.slug,
        status: result.site.status,
        phpVersion: null,
        services: [],
        domains: domainList,
        driftSummary: {
          totalServices: 0,
          inSyncCount: 0,
          driftedCount: 0,
          unknownCount: 0,
          overallDriftStatus: "in_sync",
        },
        createdAt: toIsoString(result.site.createdAt),
        updatedAt: toIsoString(result.site.updatedAt),
      },
    };
  }

  @Get("sites/:siteId")
  public async getSite(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ data: SiteDetailDto }> {
    const auth = await this.authzService.authenticateRequest(req);

    const [site] = await this.dbClient.db
      .select()
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);

    if (!site || site.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    // Enforce anti-BOLA and resource-level check
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.read",
      targetType: "site",
      targetId: siteId,
      resource: { id: site.id, organizationId: site.organizationId },
    });

    const svcs = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, siteId), eq(serviceInstances.organizationId, orgId)))
      .orderBy(asc(serviceInstances.name));

    const doms = await this.dbClient.db
      .select()
      .from(domains)
      .where(and(eq(domains.siteId, siteId), eq(domains.organizationId, orgId)))
      .orderBy(asc(domains.hostname));

    // Compute drift for each service
    const serviceAggregateInputs = [];
    for (const s of svcs) {
      const [obs] = await this.dbClient.db
        .select()
        .from(observedStates)
        .where(eq(observedStates.serviceInstanceId, s.id))
        .limit(1);

      const [rev] = s.currentRevisionId
        ? await this.dbClient.db
            .select()
            .from(stackRevisions)
            .where(eq(stackRevisions.id, s.currentRevisionId))
            .limit(1)
        : [undefined];

      const driftEval = evaluateServiceDrift(
        s.desiredStatus,
        rev?.specHash ?? "",
        obs
          ? {
              observedStatus: obs.observedStatus,
              observedRevisionHash: obs.observedRevisionHash,
              outOfBandModified: obs.outOfBandModified,
              observedAt: obs.observedAt,
            }
          : null,
      );

      serviceAggregateInputs.push({
        id: s.id,
        desiredStatus: s.desiredStatus,
        driftStatus: driftEval.driftStatus,
        operationalStatus: (obs?.observedStatus as ServiceAggregateInput["operationalStatus"]) ?? undefined,
      });
    }

    const aggregateSummary = computeSiteAggregateSummary(serviceAggregateInputs);

    return {
      data: {
        id: site.id,
        organizationId: orgId,
        hostAllocationId: site.hostAllocationId,
        name: site.name,
        slug: site.slug,
        status: aggregateSummary.siteStatus,
        phpVersion: null,
        services: svcs.map(mapServiceInstanceToDto),
        domains: doms.map(mapDomainToDto),
        driftSummary: aggregateSummary.driftSummary,
        createdAt: toIsoString(site.createdAt),
        updatedAt: toIsoString(site.updatedAt),
      },
    };
  }

  @Get("sites/:siteId/services")
  public async getSiteServices(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: ServiceInstanceDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);

    const [site] = await this.dbClient.db
      .select()
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);

    if (!site || site.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "service.read",
      targetType: "site",
      targetId: siteId,
      resource: { id: site.id, organizationId: site.organizationId },
    });

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(and(eq(serviceInstances.siteId, siteId), eq(serviceInstances.organizationId, orgId)))
      .orderBy(asc(serviceInstances.name));

    const dtoList = rows.map(mapServiceInstanceToDto);
    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post("sites/:siteId/services")
  @HttpCode(HttpStatus.CREATED)
  public async createService(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: { service: ServiceInstanceDto; revision: StackRevisionDto } }> {
    const auth = await this.authzService.authenticateRequest(req);
    requireIdempotencyKey(req.headers as Record<string, string | string[] | undefined>);

    const [site] = await this.dbClient.db
      .select()
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);

    if (!site || site.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "service.create",
      targetType: "site",
      targetId: siteId,
      resource: { id: site.id, organizationId: site.organizationId },
    });

    const body = CreateServiceInstanceInputSchema.parse(rawBody ?? {});

    // AC-F1-04: Recursively validate forbidden Docker input attributes
    const unsafeViolations = findUnsafeDockerInputFields(body.configuration);
    if (unsafeViolations.length > 0) {
      throw new ControlPlaneError(
        "HOST_POLICY_DENIED",
        `Forbidden Docker input attributes detected: ${unsafeViolations.join(", ")} (AC-F1-04)`,
      );
    }

    // F1-012: Rejects plaintext secrets in declarative config
    const secretViolations = findPlaintextSecretKeys(body.configuration);
    if (secretViolations.length > 0) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        `Plaintext secret keys detected in declarative configuration: ${secretViolations.join(", ")}. Use secretRefs instead.`,
      );
    }

    const [tpl] = await this.dbClient.db
      .select()
      .from(serviceTemplates)
      .where(eq(serviceTemplates.id, body.serviceTemplateId))
      .limit(1);

    if (!tpl) {
      throw new ControlPlaneError("NOT_FOUND", `Service template '${body.serviceTemplateId}' not found.`);
    }

    const validation = validateDeclarativeServiceInput(
      tpl,
      "dedicated",
      body.configuration,
      body.resourceLimits,
    );

    if (!validation.valid) {
      throw new ControlPlaneError(validation.errorCode ?? "VALIDATION_ERROR", validation.message);
    }

    const result = await createServiceWithRevisionTransactional(this.dbClient.db, {
      siteId,
      organizationId: orgId,
      serviceTemplateId: body.serviceTemplateId,
      name: body.name,
      desiredStatus: body.desiredStatus,
      configuration: body.configuration,
      secretRefs: body.secretRefs,
      resourceLimits: body.resourceLimits,
      actorId: auth.user.id,
    });

    return {
      data: {
        service: mapServiceInstanceToDto(result.service),
        revision: mapStackRevisionToDto(result.revision),
      },
    };
  }

  @Get("services/:serviceId/revisions")
  public async getRevisions(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("serviceId") serviceId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: StackRevisionDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);

    const [svc] = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, serviceId))
      .limit(1);

    if (!svc || svc.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "service.read",
      targetType: "service_instance",
      targetId: serviceId,
      resource: { id: svc.id, organizationId: svc.organizationId },
    });

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(stackRevisions)
      .where(and(eq(stackRevisions.serviceInstanceId, serviceId), eq(stackRevisions.organizationId, orgId)))
      .orderBy(asc(stackRevisions.revisionNumber));

    const dtoList = rows.map(mapStackRevisionToDto);
    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post("services/:serviceId/revisions")
  @HttpCode(HttpStatus.CREATED)
  public async appendRevision(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("serviceId") serviceId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: StackRevisionDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    requireIdempotencyKey(req.headers as Record<string, string | string[] | undefined>);

    const [svc] = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, serviceId))
      .limit(1);

    if (!svc || svc.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "service.configuration.manage",
      targetType: "service_instance",
      targetId: serviceId,
      resource: { id: svc.id, organizationId: svc.organizationId },
    });

    const body = CreateStackRevisionInputSchema.parse(rawBody ?? {});

    // AC-F1-04 check
    const unsafeViolations = findUnsafeDockerInputFields(body.declarativeConfig);
    if (unsafeViolations.length > 0) {
      throw new ControlPlaneError(
        "HOST_POLICY_DENIED",
        `Forbidden Docker input attributes detected: ${unsafeViolations.join(", ")} (AC-F1-04)`,
      );
    }

    // F1-012 check
    const secretViolations = findPlaintextSecretKeys(body.declarativeConfig);
    if (secretViolations.length > 0) {
      throw new ControlPlaneError(
        "VALIDATION_ERROR",
        `Plaintext secret keys detected in declarative configuration: ${secretViolations.join(", ")}. Use secretRefs instead.`,
      );
    }

    const newRev = await appendStackRevisionTransactional(this.dbClient.db, {
      serviceInstanceId: serviceId,
      organizationId: orgId,
      declarativeConfig: body.declarativeConfig,
      secretRefs: body.secretRefs,
      resourceLimits: body.resourceLimits,
      authorId: auth.user.id,
    });

    return { data: mapStackRevisionToDto(newRev) };
  }

  @Post("services/:serviceId/lifecycle")
  @HttpCode(HttpStatus.ACCEPTED)
  public async executeServiceLifecycle(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("serviceId") serviceId: string,
    @Body() rawBody: unknown,
  ): Promise<AsyncAcceptedEnvelope> {
    const auth = await this.authzService.authenticateRequest(req);
    const body = ServiceLifecycleInputSchema.parse(rawBody ?? {});

    const [svc] = await this.dbClient.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, serviceId))
      .limit(1);

    if (!svc || svc.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }

    const requiredPermission: PermissionKey =
      body.action === "deploy"
        ? "service.deploy"
        : body.action === "restart"
          ? "service.restart"
          : "service.stop";

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: requiredPermission,
      targetType: "service_instance",
      targetId: serviceId,
      resource: { id: svc.id, organizationId: svc.organizationId },
    });

    // Preserve Phase 1 disabled runtime behavior (AC-F1-10 -> 422 NOT_SUPPORTED)
    if (!this.dockerExecutor.isRuntimeAvailable) {
      if (body.action === "deploy") {
        const approvedSpec = createApprovedServiceSpec({
          serviceInstanceId: serviceId,
          siteId: svc.siteId,
          organizationId: orgId,
          image: "wordpress:latest",
          containerName: `cnt_${serviceId}`,
        });
        await this.dockerExecutor.deployService(approvedSpec);
      } else if (body.action === "restart") {
        await this.dockerExecutor.restartService(serviceId);
      } else {
        await this.dockerExecutor.stopService(serviceId);
      }

      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Docker executor runtime is disabled in Phase 1 (HCP-SPEC-002 §1.3)",
      );
    }

    const idempotencyKey = requireIdempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
    );

    const operationKind: OperationKind =
      body.action === "deploy"
        ? "service.deploy"
        : body.action === "restart"
          ? "service.restart"
          : "service.stop";

    const enqueued = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId: orgId,
      kind: operationKind,
      resourceType: "service",
      resourceId: serviceId,
      requestedByUserId: auth.user.id,
      idempotencyKey,
      lockKey: `svc:${serviceId}`,
      outboxPayload: {
        ...(body.reason ? { reason: body.reason } : {}),
      },
      steps: SERVICE_OPERATION_STEPS,
    });

    if (!enqueued.idempotentReplay) {
      const nextDesiredStatus = body.action === "stop" ? "stopped" : "running";
      await this.dbClient.db
        .update(serviceInstances)
        .set({
          desiredStatus: nextDesiredStatus,
          updatedAt: new Date(),
        })
        .where(eq(serviceInstances.id, serviceId));

      await this.authzService.recordAudit(auth, req, {
        organizationId: orgId,
        action: `service.lifecycle.${body.action}`,
        targetType: "service_instance",
        targetId: serviceId,
        details: {
          operationId: enqueued.operation.id,
          action: body.action,
          ...(body.reason ? { reason: body.reason } : {}),
        },
      });

      this.outboxWorker.triggerAsync();
    }

    return {
      data: {
        operationId: enqueued.operation.id,
        status: enqueued.operation.status,
        resourceId: serviceId,
        submittedAt: toIsoString(enqueued.operation.submittedAt),
      },
      links: {
        self: `/v1/organizations/${orgId}/operations/${enqueued.operation.id}`,
      },
    };
  }

  @Get("operations")
  public async getOperations(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: OperationDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "operation.read",
      targetType: "organization",
      targetId: orgId,
    });

    const pagination = parsePaginationQuery(rawQuery);
    const ops = await this.dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.organizationId, orgId))
      .orderBy(desc(operations.submittedAt));

    const dtoList: OperationDto[] = [];
    for (const op of ops) {
      const steps = await this.dbClient.db
        .select()
        .from(operationSteps)
        .where(eq(operationSteps.operationId, op.id))
        .orderBy(asc(operationSteps.id));

      dtoList.push(mapOperationToDto(op, steps));
    }

    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Get("operations/:opId")
  public async getOperation(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("opId") opId: string,
  ): Promise<{ data: OperationDto }> {
    const auth = await this.authzService.authenticateRequest(req);

    const [op] = await this.dbClient.db
      .select()
      .from(operations)
      .where(eq(operations.id, opId))
      .limit(1);

    if (!op || op.organizationId !== orgId) {
      throw new ControlPlaneError("NOT_FOUND", `Operation '${opId}' not found.`);
    }

    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "operation.read",
      targetType: "operation",
      targetId: opId,
      resource: { id: op.id, organizationId: op.organizationId },
    });

    const steps = await this.dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op.id))
      .orderBy(asc(operationSteps.id));

    return { data: mapOperationToDto(op, steps) };
  }
}
