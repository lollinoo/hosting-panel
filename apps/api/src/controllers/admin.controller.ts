import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  AdminFleetItemDtoSchema,
  AdminProviderConnectionDtoSchema,
  AuditEventDtoSchema,
  AuditEventOutcomeSchema,
  type AdminFleetItemDto,
  type AdminProviderConnectionDto,
  type AuditEventDto,
  type PaginatedListEnvelope,
  type ProviderConnectionStatus,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import { CoolifyAdapterError, type HostingProvider } from "@hosting-panel/coolify-adapter";
import {
  and,
  appendAuditEvent,
  asc,
  auditEvents,
  desc,
  eq,
  hostingResources,
  mapAuditEventToDto,
  organizations,
  providerConnections,
  providerInstances,
  serverAllocations,
  type DatabaseClient,
  type ProviderInstanceRow,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  extractClientIp,
  paginateByKey,
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { ProviderContextService } from "../providers/provider-context.service.js";
import { COOLIFY_ADAPTER_TOKEN, DATABASE_CLIENT_TOKEN } from "../tokens.js";

const STALE_RESOURCE_MS = 5 * 60 * 1_000;

function mapAdminProviderInstance(
  instance: ProviderInstanceRow,
  boundOrgCount: number,
): AdminProviderConnectionDto {
  return AdminProviderConnectionDtoSchema.parse({
    id: instance.id,
    displayName: instance.displayName,
    driver: instance.kind,
    status: instance.status,
    version: instance.version,
    capabilities: instance.capabilitiesJson,
    boundOrganizationCount: boundOrgCount,
    lastCheckedAt: instance.lastCheckedAt ? instance.lastCheckedAt.toISOString() : null,
    createdAt: instance.createdAt.toISOString(),
  });
}

@Controller("v1/admin")
export class AdminController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(COOLIFY_ADAPTER_TOKEN) private readonly coolifyAdapter: HostingProvider,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(ProviderContextService)
    private readonly providerContextService: ProviderContextService,
  ) {}

  @Get("provider-connections")
  public async listProviderConnections(
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<AdminProviderConnectionDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requirePlatformAdmin(
      auth,
      req,
      "admin.provider_connections.read",
      "provider",
    );

    const pagination = parsePaginationQuery(query);
    const db = this.dbClient.db;

    const instances = await db
      .select()
      .from(providerInstances)
      .orderBy(asc(providerInstances.displayName), asc(providerInstances.id));

    const connections = await db
      .select({
        providerInstanceId: providerConnections.providerInstanceId,
        organizationId: providerConnections.organizationId,
      })
      .from(providerConnections);

    const orgSetByInstance = new Map<string, Set<string>>();
    for (const c of connections) {
      const set = orgSetByInstance.get(c.providerInstanceId) ?? new Set<string>();
      set.add(c.organizationId);
      orgSetByInstance.set(c.providerInstanceId, set);
    }

    const items = instances.map((inst) =>
      mapAdminProviderInstance(inst, orgSetByInstance.get(inst.id)?.size ?? 0),
    );
    const paged = paginateItems(items, pagination);

    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Post("provider-connections/:id/test")
  @HttpCode(200)
  public async testProviderConnection(
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<AdminProviderConnectionDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requirePlatformAdmin(
      auth,
      req,
      "provider.connection.test",
      "provider",
      id,
    );

    const requestId = resolveRequestId(req);
    const db = this.dbClient.db;
    const bundle = await this.providerContextService.resolveForAdminTarget(id, requestId);

    try {
      const info = await this.coolifyAdapter.testConnection(bundle.context);
      const checkedAt = new Date(info.observedAt);

      const [updatedInstance] = await db
        .update(providerInstances)
        .set({
          status: "connected",
          version: info.version,
          lastCheckedAt: checkedAt,
        })
        .where(eq(providerInstances.id, bundle.instance.id))
        .returning();

      await db
        .update(providerConnections)
        .set({ status: "connected" })
        .where(eq(providerConnections.id, bundle.connection.id));

      await appendAuditEvent(db, {
        organizationId: null,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: "provider.connection.test",
        targetType: "provider",
        targetId: bundle.instance.id,
        outcome: "succeeded",
        requestId,
        ipAddress: extractClientIp(req),
        metadata: {
          driver: "coolify-v4",
          status: "connected",
          version: info.version,
        },
        occurredAt: checkedAt,
      });

      const boundConns = await db
        .select({ organizationId: providerConnections.organizationId })
        .from(providerConnections)
        .where(eq(providerConnections.providerInstanceId, bundle.instance.id));
      const distinctOrgs = new Set(boundConns.map((c) => c.organizationId)).size;

      return {
        data: mapAdminProviderInstance(updatedInstance ?? bundle.instance, distinctOrgs),
        meta: {
          observedAt: info.observedAt,
          source: "coolify",
          stale: false,
        },
      };
    } catch (error: unknown) {
      let degradedStatus: ProviderConnectionStatus = "unreachable";
      let errorCode = "COOLIFY_UNAVAILABLE";

      if (error instanceof CoolifyAdapterError) {
        errorCode = error.code;
        if (error.code === "UNAUTHENTICATED" || error.code === "PERMISSION_DENIED") {
          degradedStatus = "misconfigured";
        } else if (error.code === "PROVIDER_RATE_LIMIT") {
          degradedStatus = "degraded";
        }
      }

      await db
        .update(providerInstances)
        .set({
          status: degradedStatus,
          lastCheckedAt: new Date(),
        })
        .where(eq(providerInstances.id, bundle.instance.id));

      await appendAuditEvent(db, {
        organizationId: null,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: "provider.connection.test",
        targetType: "provider",
        targetId: bundle.instance.id,
        outcome: "failed",
        requestId,
        ipAddress: extractClientIp(req),
        metadata: {
          driver: "coolify-v4",
          status: degradedStatus,
          errorCode,
        },
      });

      throw error;
    }
  }

  @Get("fleet")
  public async getFleet(
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<AdminFleetItemDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requirePlatformAdmin(
      auth,
      req,
      "admin.fleet.read",
      "fleet",
    );

    const pagination = parsePaginationQuery(query);
    const rows = await this.dbClient.db
      .select({
        resource: hostingResources,
        organization: organizations,
        server: serverAllocations,
      })
      .from(hostingResources)
      .innerJoin(organizations, eq(hostingResources.organizationId, organizations.id))
      .innerJoin(
        serverAllocations,
        eq(hostingResources.serverAllocationId, serverAllocations.id),
      )
      .orderBy(asc(organizations.slug), asc(hostingResources.name), asc(hostingResources.id));

    const nowMs = Date.now();
    const items = rows.map((r) => {
      const observedMs = r.resource.lastObservedAt
        ? r.resource.lastObservedAt.getTime()
        : null;
      const stale = observedMs === null || nowMs - observedMs > STALE_RESOURCE_MS;
      return AdminFleetItemDtoSchema.parse({
        resourceId: r.resource.id,
        resourceType: r.resource.type,
        resourceName: r.resource.name,
        organizationId: r.organization.id,
        organizationName: r.organization.name,
        serverId: r.server.id,
        serverName: r.server.name,
        status: r.resource.observedStatus,
        health: r.resource.health,
        stale,
        lastObservedAt: r.resource.lastObservedAt
          ? r.resource.lastObservedAt.toISOString()
          : null,
      });
    });

    const paged = paginateByKey(items, (item) => item.resourceId, pagination);
    return {
      data: paged.data,
      page: paged.page,
    };
  }

  @Get("audit")
  public async getAuditEvents(
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<AuditEventDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requirePlatformAdmin(
      auth,
      req,
      "audit.read",
      "audit",
    );

    const pagination = parsePaginationQuery(query);
    const filterOrgId =
      typeof query?.["organizationId"] === "string" &&
      query["organizationId"].trim().length > 0
        ? query["organizationId"].trim()
        : undefined;
    const rawOutcome =
      typeof query?.["outcome"] === "string" && query["outcome"].trim().length > 0
        ? query["outcome"].trim()
        : undefined;
    const parsedOutcome = rawOutcome
      ? AuditEventOutcomeSchema.parse(rawOutcome)
      : undefined;

    const conditions = [];
    if (filterOrgId) {
      conditions.push(eq(auditEvents.organizationId, filterOrgId));
    }
    if (parsedOutcome) {
      conditions.push(eq(auditEvents.outcome, parsedOutcome));
    }

    const rows =
      conditions.length > 0
        ? await this.dbClient.db
            .select()
            .from(auditEvents)
            .where(and(...conditions))
            .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        : await this.dbClient.db
            .select()
            .from(auditEvents)
            .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));

    const items = rows.map((r) => AuditEventDtoSchema.parse(mapAuditEventToDto(r)));
    const paged = paginateItems(items, pagination);

    return {
      data: paged.data,
      page: paged.page,
    };
  }
}
