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
  type AsyncAcceptedEnvelope,
  type HostAllocationDto,
  type HostDaemonHeartbeatDto,
  type HostDto,
  type HostTelemetryDto,
  type OperationDto,
  type ReadMeta,
  type RuntimeBackend,
} from "@hosting-panel/contracts";
import {
  allocateHostTransactional,
  and,
  asc,
  desc,
  enqueueOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  listHostAgentHeartbeats,
  operationSteps,
  operations,
  organizations,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import {
  createApprovedHostMaintenanceCommand,
  isAllowlistedHostMaintenanceAction,
  isAllowlistedHostSecurityPolicy,
} from "@hosting-panel/host-agent-contracts";
import { evaluateHostModeTransition } from "@hosting-panel/policy-engine";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  paginateItems,
  parsePaginationQuery,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  HOST_AGENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const PLATFORM_OPS_ORG_ID = "org_platform_ops";
const PLATFORM_OPS_ORG_SLUG = "platform-ops";

const HOST_OPERATION_STEPS = [
  { key: "validate_spec", label: "Validate host policy allowlist" },
  { key: "dispatch_ipc", label: "Dispatch signed command to host-agent" },
  { key: "reconcile_state", label: "Verify host posture" },
] as const;

function toIsoString(date: Date | string | null | undefined): string {
  if (!date) {
    return new Date().toISOString();
  }
  return date instanceof Date ? date.toISOString() : String(date);
}

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
    createdAt: toIsoString(host.createdAt),
    updatedAt: toIsoString(host.updatedAt),
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

@Controller("v1")
export class HostsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(HOST_AGENT_TOKEN) private readonly hostAgent: HostAgentPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
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

  @Get("hosts/:hostId/telemetry")
  public async getHostTelemetry(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
  ): Promise<{
    data: {
      hostId: string;
      runtimeBackend: RuntimeBackend;
      telemetry: HostTelemetryDto | null;
      daemons: HostDaemonHeartbeatDto[];
    };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "host.metrics.read",
      "host",
      hostId,
    );

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    const daemons = await listHostAgentHeartbeats(this.dbClient.db, hostId);
    const executorDaemon = daemons.find((d) => d.component === "docker_executor");
    const executorDockerReachable =
      executorDaemon?.status === "online" &&
      executorDaemon.telemetrySnapshot["dockerEngineReachable"] !== false;

    const rawTelemetry = this.hostAgent.isRuntimeAvailable
      ? await this.hostAgent.getHostTelemetry(hostId)
      : null;

    const telemetry: HostTelemetryDto | null = rawTelemetry
      ? {
          hostId,
          cpuUsagePercent: rawTelemetry.cpuUsagePercent,
          memoryUsedBytes: rawTelemetry.memoryUsedBytes,
          memoryTotalBytes: rawTelemetry.memoryTotalBytes ?? host.totalMemoryBytes,
          storageUsedBytes: rawTelemetry.storageUsedBytes,
          storageTotalBytes: rawTelemetry.storageTotalBytes ?? host.totalStorageBytes,
          uptimeSeconds: rawTelemetry.uptimeSeconds ?? 0,
          kernelVersion: rawTelemetry.kernelVersion ?? "unknown",
          dockerEngineReachable: Boolean(
            rawTelemetry.dockerEngineReachable || executorDockerReachable,
          ),
          collectedAt: rawTelemetry.collectedAt,
        }
      : null;

    return {
      data: {
        hostId,
        runtimeBackend: this.config.runtimeBackend,
        telemetry,
        daemons,
      },
    };
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
  @HttpCode(HttpStatus.ACCEPTED)
  public async executeHostMaintenance(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<AsyncAcceptedEnvelope> {
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
      throw new ControlPlaneError(
        "HOST_POLICY_DENIED",
        `Action '${body.action}' is not in allowlisted maintenance actions`,
      );
    }

    if (!this.hostAgent.isRuntimeAvailable) {
      const command = createApprovedHostMaintenanceCommand({
        hostId,
        action: body.action,
        reason: body.reason,
      });
      await this.hostAgent.executeMaintenance(command);
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Host agent runtime execution is disabled in Phase 1",
      );
    }

    const idempotencyKey = requireIdempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
    );
    const organizationId = await this.#resolveHostOperationOrganizationId(host);

    const enqueued = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId,
      kind: "host.maintenance",
      resourceType: "host",
      resourceId: hostId,
      requestedByUserId: auth.user.id,
      idempotencyKey,
      lockKey: `host:${hostId}`,
      outboxPayload: {
        hostAction: body.action,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      steps: HOST_OPERATION_STEPS,
    });

    if (!enqueued.idempotentReplay) {
      await this.authzService.recordAudit(auth, req, {
        organizationId,
        action: "host.maintenance.execute",
        targetType: "host",
        targetId: hostId,
        details: {
          operationId: enqueued.operation.id,
          hostAction: body.action,
          ...(body.reason ? { reason: body.reason } : {}),
        },
      });
      this.outboxWorker.triggerAsync();
    }

    return {
      data: {
        operationId: enqueued.operation.id,
        status: enqueued.operation.status,
        resourceId: hostId,
        submittedAt: toIsoString(enqueued.operation.submittedAt),
      },
      links: {
        self: `/v1/hosts/${hostId}/operations/${enqueued.operation.id}`,
      },
    };
  }

  @Post("hosts/:hostId/security")
  @HttpCode(HttpStatus.ACCEPTED)
  public async executeHostSecurity(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Body() rawBody: unknown,
  ): Promise<AsyncAcceptedEnvelope> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "host.security.manage",
      "host",
      hostId,
    );

    const body = HostSecurityInputSchema.parse(rawBody ?? {});

    const [host] = await this.dbClient.db
      .select()
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    if (!this.hostAgent.isRuntimeAvailable) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Host agent runtime execution is disabled in Phase 1 (HCP-SPEC-002 §1.3 & ADR-006)",
      );
    }

    if (!isAllowlistedHostSecurityPolicy(body.policyRef)) {
      await this.authzService.recordDeniedAudit(auth, req, {
        organizationId: null,
        action: "host.security.manage",
        targetType: "host",
        targetId: hostId,
        reason: `Security policy '${body.policyRef}' is not allowlisted`,
        details: { policyRef: body.policyRef },
      });
      throw new ControlPlaneError(
        "HOST_POLICY_DENIED",
        `Security policy '${body.policyRef}' is not in allowlisted host security policies`,
      );
    }

    const idempotencyKey = requireIdempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
    );
    const organizationId = await this.#resolveHostOperationOrganizationId(host);

    const enqueued = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId,
      kind: "host.security",
      resourceType: "host",
      resourceId: hostId,
      requestedByUserId: auth.user.id,
      idempotencyKey,
      lockKey: `host:${hostId}`,
      outboxPayload: {
        policyRef: body.policyRef,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      steps: HOST_OPERATION_STEPS,
    });

    if (!enqueued.idempotentReplay) {
      await this.authzService.recordAudit(auth, req, {
        organizationId,
        action: "host.security.manage",
        targetType: "host",
        targetId: hostId,
        details: {
          operationId: enqueued.operation.id,
          policyRef: body.policyRef,
          ...(body.reason ? { reason: body.reason } : {}),
        },
      });
      this.outboxWorker.triggerAsync();
    }

    return {
      data: {
        operationId: enqueued.operation.id,
        status: enqueued.operation.status,
        resourceId: hostId,
        submittedAt: toIsoString(enqueued.operation.submittedAt),
      },
      links: {
        self: `/v1/hosts/${hostId}/operations/${enqueued.operation.id}`,
      },
    };
  }

  @Get("hosts/:hostId/operations")
  public async getHostOperations(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: OperationDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "operation.read",
      "host",
      hostId,
    );

    const [host] = await this.dbClient.db
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    const pagination = parsePaginationQuery(rawQuery);
    const ops = await this.dbClient.db
      .select()
      .from(operations)
      .where(and(eq(operations.resourceType, "host"), eq(operations.resourceId, hostId)))
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

  @Get("hosts/:hostId/operations/:opId")
  public async getHostOperation(
    @Req() req: FastifyRequest,
    @Param("hostId") hostId: string,
    @Param("opId") opId: string,
  ): Promise<{ data: OperationDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(
      auth,
      req,
      "operation.read",
      "host",
      hostId,
    );

    const [host] = await this.dbClient.db
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .limit(1);

    if (!host) {
      throw new ControlPlaneError("NOT_FOUND", `Host '${hostId}' not found.`);
    }

    const [op] = await this.dbClient.db
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.id, opId),
          eq(operations.resourceType, "host"),
          eq(operations.resourceId, hostId),
        ),
      )
      .limit(1);

    if (!op) {
      throw new ControlPlaneError("NOT_FOUND", `Operation '${opId}' not found.`);
    }

    const steps = await this.dbClient.db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op.id))
      .orderBy(asc(operationSteps.id));

    return { data: mapOperationToDto(op, steps) };
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

  async #resolveHostOperationOrganizationId(
    host: typeof hosts.$inferSelect,
  ): Promise<string> {
    const [activeAlloc] = await this.dbClient.db
      .select({ organizationId: hostAllocations.organizationId })
      .from(hostAllocations)
      .where(
        and(
          eq(hostAllocations.hostId, host.id),
          eq(hostAllocations.status, "active"),
        ),
      )
      .limit(1);

    if (activeAlloc) {
      return activeAlloc.organizationId;
    }

    await this.dbClient.db
      .insert(organizations)
      .values({
        id: PLATFORM_OPS_ORG_ID,
        platformInstallationId: host.platformInstallationId,
        name: "Platform Infrastructure Operations",
        slug: PLATFORM_OPS_ORG_SLUG,
        status: "active",
      })
      .onConflictDoNothing();

    return PLATFORM_OPS_ORG_ID;
  }
}
