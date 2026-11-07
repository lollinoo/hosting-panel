import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { evaluatePolicy, filterAuthorizedResources } from "@hosting-panel/authz";
import {
  ApplicationDetailDtoSchema,
  ApplicationSummaryDtoSchema,
  AsyncAcceptedEnvelopeSchema,
  DeploymentRecordDtoSchema,
  TriggerOperationInputSchema,
  type ApplicationDetailDto,
  type ApplicationSummaryDto,
  type AsyncAcceptedEnvelope,
  type DeploymentRecordDto,
  type ObservationSource,
  type ObservedResourceStatus,
  type OperationKind,
  type PaginatedListEnvelope,
  type ResourceHealthStatus,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import type { HostingProvider } from "@hosting-panel/coolify-adapter";
import {
  and,
   applications,
  asc,
  deploymentRecords,
  desc,
  domains,
  enqueueOperationTransactional,
  eq,
  hostingResources,
  mapOperationToDto,
  type ApplicationRow,
  type DatabaseClient,
  type DeploymentRecordRow,
  type HostingResourceRow,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  paginateItems,
  parsePaginationQuery,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { EventsBusService } from "../operations/events-bus.service.js";
import { HealthProbeService } from "../operations/health-probe.service.js";
import { ProviderContextService } from "../providers/provider-context.service.js";
import { COOLIFY_ADAPTER_TOKEN, DATABASE_CLIENT_TOKEN } from "../tokens.js";

function mapDeploymentRecord(row: DeploymentRecordRow): DeploymentRecordDto {
  return DeploymentRecordDtoSchema.parse({
    id: row.id,
    applicationId: row.applicationResourceId,
    operationId: row.operationId,
    commitSha: row.commitSha,
    imageTag: row.imageTag,
    status: row.status,
    triggeredByUserId: row.triggeredByUserId,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  });
}

function mapApplicationSummary(
  resource: HostingResourceRow,
  appRow: ApplicationRow,
): ApplicationSummaryDto {
  return ApplicationSummaryDtoSchema.parse({
    id: resource.id,
    organizationId: resource.organizationId,
    serverId: resource.serverAllocationId,
    name: resource.name,
    slug: resource.slug,
    environment: appRow.environment,
    status: resource.observedStatus,
    health: resource.health,
    primaryDomain: appRow.primaryDomain,
    lastDeployedAt: appRow.lastDeployedAt ? appRow.lastDeployedAt.toISOString() : null,
    lastObservedAt: resource.lastObservedAt
      ? resource.lastObservedAt.toISOString()
      : null,
    lockedByOperationId: resource.lockedByOperationId,
    createdAt: resource.createdAt.toISOString(),
  });
}

@Controller("v1/organizations/:orgId/applications")
export class ApplicationsController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(COOLIFY_ADAPTER_TOKEN) private readonly coolifyAdapter: HostingProvider,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(ProviderContextService)
    private readonly providerContextService: ProviderContextService,
    @Inject(HealthProbeService) private readonly healthProbeService: HealthProbeService,
    @Inject(EventsBusService) private readonly eventsBus: EventsBusService,
  ) {}

  @Get()
  public async listApplications(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<ApplicationSummaryDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "application.read",
      "application",
    );

    const pagination = parsePaginationQuery(query);

    const rows = await this.dbClient.db
      .select({
        resource: hostingResources,
        application: applications,
      })
      .from(hostingResources)
      .innerJoin(applications, eq(applications.resourceId, hostingResources.id))
      .where(
        and(
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "application"),
        ),
      )
      .orderBy(asc(hostingResources.name), asc(hostingResources.id));

    const targetWrappers = rows.map((row) => ({
      id: row.resource.id,
      organizationId: row.resource.organizationId,
      row,
    }));

    const authorized = filterAuthorizedResources(
      auth.principal,
      orgId,
      "application.read",
      targetWrappers,
    );

    const summaries = authorized.map((item) =>
      mapApplicationSummary(item.row.resource, item.row.application),
    );
    const paged = paginateItems(summaries, pagination);

    return {
      data: paged.data,
      page: paged.page,
      meta: {
        observedAt: summaries[0]?.lastObservedAt ?? new Date().toISOString(),
        source: "coolify",
        stale: false,
      },
    };
  }

  @Get(":appId")
  public async getApplication(
    @Param("orgId") orgId: string,
    @Param("appId") appId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<ApplicationDetailDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "application.read",
      "application",
      appId,
    );

    const db = this.dbClient.db;
    const [found] = await db
      .select({
        resource: hostingResources,
        application: applications,
      })
      .from(hostingResources)
      .innerJoin(applications, eq(applications.resourceId, hostingResources.id))
      .where(
        and(
          eq(hostingResources.id, appId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "application"),
        ),
      )
      .limit(1);

    if (!found) {
      throw new ControlPlaneError("NOT_FOUND", "Application was not found.");
    }

    const resourceTarget = {
      id: found.resource.id,
      organizationId: found.resource.organizationId,
    };

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "application.read",
      targetType: "application",
      resource: resourceTarget,
    });

    const requestId = resolveRequestId(req);
    const { context } = await this.providerContextService.resolveForConnection(
      orgId,
      found.resource.connectionId,
      requestId,
    );
    const snapshot = await this.coolifyAdapter.getApplication(
      context,
      found.resource.providerId,
    );

    let effectiveStatus: ObservedResourceStatus = snapshot.status;
    let effectiveHealth: ResourceHealthStatus = snapshot.health;
    let effectiveSource: ObservationSource = "coolify";

    if (
      found.resource.lockedByOperationId !== null &&
      found.resource.observedStatus === "deploying"
    ) {
      effectiveStatus = "deploying";
      effectiveHealth = "unknown";
    } else if (
      effectiveStatus === "running" &&
      !this.healthProbeService.isApplicationHealthy(found.resource.id)
    ) {
      effectiveStatus = "degraded";
      effectiveHealth = "unhealthy";
      effectiveSource = "external_probe";
    }

    const observedDate = new Date(snapshot.observedAt);
    await db
      .update(hostingResources)
      .set({
        observedStatus: effectiveStatus,
        health: effectiveHealth,
        observedSource: effectiveSource,
        lastObservedAt: observedDate,
      })
      .where(eq(hostingResources.id, found.resource.id));

    const domainRows = await db
      .select()
      .from(domains)
      .where(
        and(
          eq(domains.organizationId, orgId),
          eq(domains.applicationResourceId, found.resource.id),
        ),
      )
      .orderBy(desc(domains.isPrimary), asc(domains.hostname));

    const recentDepRows = await db
      .select()
      .from(deploymentRecords)
      .where(
        and(
          eq(deploymentRecords.organizationId, orgId),
          eq(deploymentRecords.applicationResourceId, found.resource.id),
        ),
      )
      .orderBy(desc(deploymentRecords.createdAt), desc(deploymentRecords.id))
      .limit(10);

    const now = new Date();
    const allowedActions = {
      canDeploy: evaluatePolicy({
        principal: auth.principal,
        permission: "application.deploy",
        organizationId: orgId,
        resource: resourceTarget,
        now,
      }).allowed,
      canRestart: evaluatePolicy({
        principal: auth.principal,
        permission: "application.restart",
        organizationId: orgId,
        resource: resourceTarget,
        now,
      }).allowed,
      canStop: evaluatePolicy({
        principal: auth.principal,
        permission: "application.stop",
        organizationId: orgId,
        resource: resourceTarget,
        now,
      }).allowed,
      canReadLogs: evaluatePolicy({
        principal: auth.principal,
        permission: "application.logs.read",
        organizationId: orgId,
        resource: resourceTarget,
        now,
      }).allowed,
    };

    const domainHostnames =
      domainRows.length > 0
        ? domainRows.map((d) => d.hostname)
        : found.application.primaryDomain
          ? [found.application.primaryDomain]
          : [];

    const dto = ApplicationDetailDtoSchema.parse({
      id: found.resource.id,
      organizationId: found.resource.organizationId,
      serverId: found.resource.serverAllocationId,
      name: found.resource.name,
      slug: found.resource.slug,
      environment: found.application.environment,
      status: effectiveStatus,
      health: effectiveHealth,
      primaryDomain: found.application.primaryDomain,
      lastDeployedAt: found.application.lastDeployedAt
        ? found.application.lastDeployedAt.toISOString()
        : null,
      lastObservedAt: snapshot.observedAt,
      lockedByOperationId: found.resource.lockedByOperationId,
      createdAt: found.resource.createdAt.toISOString(),
      repositoryUrl: found.application.repositoryUrl,
      branch: found.application.branch,
      buildPack: found.application.buildPack,
      domains: domainHostnames,
      allowedActions,
      recentDeployments: recentDepRows.map((row) => mapDeploymentRecord(row)),
      updatedAt: found.resource.updatedAt.toISOString(),
    });

    return {
      data: dto,
      meta: {
        observedAt: snapshot.observedAt,
        source: effectiveSource,
        stale: snapshot.stale === true,
      },
    };
  }

  @Get(":appId/deployments")
  public async listDeployments(
    @Param("orgId") orgId: string,
    @Param("appId") appId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<DeploymentRecordDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "application.read",
      "application",
      appId,
    );

    const [resource] = await this.dbClient.db
      .select()
      .from(hostingResources)
      .where(
        and(
          eq(hostingResources.id, appId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "application"),
        ),
      )
      .limit(1);

    if (!resource) {
      throw new ControlPlaneError("NOT_FOUND", "Application was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "application.read",
      targetType: "application",
      resource: { id: resource.id, organizationId: resource.organizationId },
    });

    const pagination = parsePaginationQuery(query);
    const rows = await this.dbClient.db
      .select()
      .from(deploymentRecords)
      .where(
        and(
          eq(deploymentRecords.organizationId, orgId),
          eq(deploymentRecords.applicationResourceId, appId),
        ),
      )
      .orderBy(desc(deploymentRecords.createdAt), desc(deploymentRecords.id));

    const items = rows.map((row) => mapDeploymentRecord(row));
    const paged = paginateItems(items, pagination);

    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Post(":appId/deploy")
  @HttpCode(202)
  public async deployApplication(
    @Param("orgId") orgId: string,
    @Param("appId") appId: string,
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<AsyncAcceptedEnvelope> {
    return this.#enqueueAppMutation(orgId, appId, "application.deploy", rawBody, req);
  }

  @Post(":appId/restart")
  @HttpCode(202)
  public async restartApplication(
    @Param("orgId") orgId: string,
    @Param("appId") appId: string,
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<AsyncAcceptedEnvelope> {
    return this.#enqueueAppMutation(orgId, appId, "application.restart", rawBody, req);
  }

  async #enqueueAppMutation(
    orgId: string,
    appId: string,
    kind: Extract<OperationKind, "application.deploy" | "application.restart">,
    rawBody: unknown,
    req: FastifyRequest,
  ): Promise<AsyncAcceptedEnvelope> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      kind,
      "application",
      appId,
    );

    const [resource] = await this.dbClient.db
      .select()
      .from(hostingResources)
      .where(
        and(
          eq(hostingResources.id, appId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "application"),
        ),
      )
      .limit(1);

    if (!resource) {
      throw new ControlPlaneError("NOT_FOUND", "Application was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: kind,
      targetType: "application",
      resource: { id: resource.id, organizationId: resource.organizationId },
    });

    const idempotencyKey = requireIdempotencyKey(
      req.headers as Record<string, string | string[] | undefined>,
    );
    const parsedInput = TriggerOperationInputSchema.parse(rawBody ?? {});
    const requestId = resolveRequestId(req);

    const result = await enqueueOperationTransactional(this.dbClient.db, {
      organizationId: orgId,
      resourceType: "application",
      resourceId: resource.id,
      kind,
      requestedByUserId: auth.user.id,
      actorEmail: auth.user.email,
      idempotencyKey,
      payload: parsedInput,
      requestId,
      ipAddress: extractClientIp(req),
    });

    if (!result.ok) {
      throw new ControlPlaneError(result.errorCode, result.message);
    }

    if (!result.deduplicated) {
      this.eventsBus.publishOperationUpdated(mapOperationToDto(result.operation));
    }

    return AsyncAcceptedEnvelopeSchema.parse({
      data: {
        operationId: result.operation.id,
        status: result.operation.status,
        resourceId: resource.id,
        submittedAt: result.operation.submittedAt.toISOString(),
      },
      links: {
        self: `/v1/organizations/${orgId}/operations/${result.operation.id}`,
      },
    });
  }
}
