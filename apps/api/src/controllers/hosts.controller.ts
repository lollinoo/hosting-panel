import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  CreateHostAllocationInputSchema,
  HostMaintenanceInputSchema,
  HostSecurityInputSchema,
  UpdateHostModeInputSchema,
  type HostAllocationDto,
  type HostDto,
  type ReadMeta,
} from "@hosting-panel/contracts";
import {
  allocateHostTransactional,
  asc,
  eq,
  hostAllocations,
  hosts,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import {
  createApprovedHostMaintenanceCommand,
  isAllowlistedHostMaintenanceAction,
} from "@hosting-panel/host-agent-contracts";
import { evaluateHostModeTransition } from "@hosting-panel/policy-engine";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import {
  DATABASE_CLIENT_TOKEN,
  HOST_AGENT_TOKEN,
} from "../tokens.js";

function mapHostToDto(host: typeof hosts.$inferSelect): HostDto {
  return {
    id: host.id,
    name: host.name,
    hostname: host.hostname,
    ipv4Address: host.ipv4Address,
    ipv6Address: host.ipv6Address ?? null,
    status: host.status,
    hostingMode: host.hostingMode,
    totalCpuMilli: host.totalCpuMilli,
    totalMemoryBytes: host.totalMemoryBytes,
    totalStorageBytes: host.totalStorageBytes,
    securityReviewed: host.securityReviewed,
    sharedApproved: host.sharedApproved,
    metadata: (host.metadata ?? {}) as Record<string, unknown>,
    createdAt: host.createdAt instanceof Date ? host.createdAt.toISOString() : String(host.createdAt),
    updatedAt: host.updatedAt instanceof Date ? host.updatedAt.toISOString() : String(host.updatedAt),
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
    createdAt: alloc.createdAt instanceof Date ? alloc.createdAt.toISOString() : String(alloc.createdAt),
    updatedAt: alloc.updatedAt instanceof Date ? alloc.updatedAt.toISOString() : String(alloc.updatedAt),
  };
}

@Controller("v1")
export class HostsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
  ) {}

  @Get("hosts")
  public async getHosts(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: HostDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "host.read", "host");

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(hosts)
      .orderBy(asc(hosts.name));

    const dtoList = rows.map(mapHostToDto);
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

  @Get("hosts/:hostId")
  public async getHost(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
  ): Promise<{ data: HostDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "host.read", "host", hostId);

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    return { data: mapHostToDto(host) };
  }

  @Patch("hosts/:hostId/mode")
  public async updateHostMode(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: HostDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "host.security.manage",
      "host",
      hostId,
    );

    const body = UpdateHostModeInputSchema.parse(rawBody ?? {});

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    const transition = evaluateHostModeTransition(
      host.hostingMode,
      body.hostingMode,
      {
        securityReviewed: host.securityReviewed,
        sharedApproved: host.sharedApproved,
      },
    );

    if (!transition.allowed) {
      await this.authzService.recordDeniedAudit(auth, req, {
        organizationId: null,
        action: "host.mode.update",
        targetType: "host",
        targetId: hostId,
        reason: transition.reason,
        details: { targetMode: body.hostingMode },
      });
      throw new ControlPlaneError(
        transition.errorCode ?? "SHARED_MODE_GATED",
        transition.reason,
      );
    }

    let updatedHost = host;
    if (host.hostingMode !== body.hostingMode) {
      const [u] = await this.dbClient.db
        .update(hosts)
        .set({
          hostingMode: body.hostingMode,
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, hostId))
        .returning();
      updatedHost = u!;
    }

    await this.authzService.recordAudit(auth, req, {
      action: "host.mode.update",
      targetType: "host",
      targetId: hostId,
      details: {
        previousMode: host.hostingMode,
        targetMode: body.hostingMode,
        reason: body.reason,
      },
    });

    return { data: mapHostToDto(updatedHost) };
  }

  @Post("hosts/:hostId/maintenance")
  public async executeHostMaintenance(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<never> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "host.maintenance.execute",
      "host",
      hostId,
    );

    const body = HostMaintenanceInputSchema.parse(rawBody ?? {});

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    if (!isAllowlistedHostMaintenanceAction(body.action)) {
      await this.authzService.recordDeniedAudit(auth, req, {
        organizationId: null,
        action: "host.maintenance.execute",
        targetType: "host",
        targetId: hostId,
        reason: `Maintenance action '${body.action}' is not allowlisted`,
        details: { action: body.action },
      });
      const error = new Error(`Action '${body.action}' is not in allowlisted maintenance actions`);
      (error as unknown as { code: string }).code = "HOST_POLICY_DENIED";
      throw error;
    }

    const command = createApprovedHostMaintenanceCommand({
      hostId,
      action: body.action,
      reason: body.reason,
    });

    // Invoke Phase1DisabledHostAgent -> throws 422 NOT_SUPPORTED per AC-F1-10
    await this.hostAgent.executeMaintenance(command);
    throw new ControlPlaneError("NOT_SUPPORTED", "Host agent runtime execution is disabled in Phase 1");
  }

  @Post("hosts/:hostId/security")
  public async executeHostSecurity(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<never> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "host.security.manage",
      "host",
      hostId,
    );

    HostSecurityInputSchema.parse(rawBody ?? {});

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    // Call host agent which in Phase 1 returns 422 NOT_SUPPORTED
    throw new ControlPlaneError(
      "NOT_SUPPORTED",
      "Host agent runtime execution is disabled in Phase 1 (HCP-SPEC-002 §1.3 & ADR-006)",
    );
  }

  @Get("allocations")
  public async getAllocations(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: HostAllocationDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "allocation.read", "allocation");

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(hostAllocations)
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

  @Get("hosts/:hostId/allocations")
  public async getHostAllocations(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: HostAllocationDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "allocation.read", "allocation", hostId);

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(hostAllocations)
      .where(eq(hostAllocations.hostId, hostId))
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

  @Post("hosts/:hostId/allocations")
  @HttpCode(HttpStatus.CREATED)
  public async createAllocation(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<{ data: HostAllocationDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "allocation.create",
      "host_allocation",
      hostId,
    );

    const body = CreateHostAllocationInputSchema.parse({
      ...(rawBody as Record<string, unknown> ?? {}),
      hostId,
    });

    const result = await allocateHostTransactional(this.dbClient.db, {
      hostId,
      organizationId: body.organizationId,
      hostingMode: body.hostingMode,
      actorId: auth.user.id,
    });

    return { data: mapAllocationToDto(result.allocation) };
  }
}
