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
import { filterAuthorizedResources } from "@hosting-panel/authz";
import {
  DatabaseDetailDtoSchema,
  DatabaseSummaryDtoSchema,
  getDatabaseBackupCapabilities,
  type AsyncAcceptedEnvelope,
  type DatabaseDetailDto,
  type DatabaseSummaryDto,
  type PaginatedListEnvelope,
  type SingleReadEnvelope,
} from "@hosting-panel/contracts";
import { CoolifyAdapterError, type HostingProvider } from "@hosting-panel/coolify-adapter";
import {
  and,
  appendAuditEvent,
  asc,
  databases,
  eq,
  hostingResources,
  type DatabaseClient,
  type DatabaseRow,
  type HostingResourceRow,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { ProviderContextService } from "../providers/provider-context.service.js";
import { COOLIFY_ADAPTER_TOKEN, DATABASE_CLIENT_TOKEN } from "../tokens.js";

const TriggerDatabaseRestoreBodySchema = z.strictObject({
  backupId: z.string().trim().min(1).max(64).optional(),
});

function mapDatabaseSummary(
  resource: HostingResourceRow,
  dbRow: DatabaseRow,
): DatabaseSummaryDto {
  const caps = getDatabaseBackupCapabilities(dbRow.engine);
  return DatabaseSummaryDtoSchema.parse({
    id: resource.id,
    organizationId: resource.organizationId,
    serverId: resource.serverAllocationId,
    name: resource.name,
    engine: dbRow.engine,
    engineVersion: dbRow.engineVersion,
    status: resource.observedStatus,
    health: resource.health,
    backupSupported: caps.backupSupported,
    restoreSupported: caps.restoreSupported,
    lastBackupAt: dbRow.lastBackupAt ? dbRow.lastBackupAt.toISOString() : null,
    lastObservedAt: resource.lastObservedAt
      ? resource.lastObservedAt.toISOString()
      : null,
    createdAt: resource.createdAt.toISOString(),
  });
}

@Controller("v1/organizations/:orgId/databases")
export class DatabasesController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(COOLIFY_ADAPTER_TOKEN) private readonly coolifyAdapter: HostingProvider,
    @Inject(AuthzContextService) private readonly authzContext: AuthzContextService,
    @Inject(ProviderContextService)
    private readonly providerContextService: ProviderContextService,
  ) {}

  @Get()
  public async listDatabases(
    @Param("orgId") orgId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
  ): Promise<PaginatedListEnvelope<DatabaseSummaryDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireOrgListPermission(
      auth,
      req,
      orgId,
      "database.read",
      "database",
    );

    const pagination = parsePaginationQuery(query);
    const rows = await this.dbClient.db
      .select({
        resource: hostingResources,
        database: databases,
      })
      .from(hostingResources)
      .innerJoin(databases, eq(databases.resourceId, hostingResources.id))
      .where(
        and(
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "database"),
        ),
      )
      .orderBy(asc(hostingResources.name), asc(hostingResources.id));

    const wrappers = rows.map((row) => ({
      id: row.resource.id,
      organizationId: row.resource.organizationId,
      row,
    }));

    const authorized = filterAuthorizedResources(
      auth.principal,
      orgId,
      "database.read",
      wrappers,
    );

    const items = authorized.map((item) =>
      mapDatabaseSummary(item.row.resource, item.row.database),
    );
    const paged = paginateItems(items, pagination);

    return {
      data: paged.data,
      page: paged.page,
      meta: {
        observedAt: items[0]?.lastObservedAt ?? new Date().toISOString(),
        source: "coolify",
        stale: false,
      },
    };
  }

  @Get(":dbId")
  public async getDatabase(
    @Param("orgId") orgId: string,
    @Param("dbId") dbId: string,
    @Req() req: FastifyRequest,
  ): Promise<SingleReadEnvelope<DatabaseDetailDto>> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "database.read",
      "database",
      dbId,
    );

    const [found] = await this.dbClient.db
      .select({
        resource: hostingResources,
        database: databases,
      })
      .from(hostingResources)
      .innerJoin(databases, eq(databases.resourceId, hostingResources.id))
      .where(
        and(
          eq(hostingResources.id, dbId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "database"),
        ),
      )
      .limit(1);

    if (!found) {
      throw new ControlPlaneError("NOT_FOUND", "Database was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "database.read",
      targetType: "database",
      resource: { id: found.resource.id, organizationId: found.resource.organizationId },
    });

    const caps = getDatabaseBackupCapabilities(found.database.engine);
    const dto = DatabaseDetailDtoSchema.parse({
      ...mapDatabaseSummary(found.resource, found.database),
      storageAllocatedGb: found.database.storageAllocatedGb,
      internalHostname: found.database.internalHostname,
      port: found.database.port,
      backupUnsupportedReason: caps.backupUnsupportedReason,
      updatedAt: found.resource.updatedAt.toISOString(),
    });

    return {
      data: dto,
      meta: {
        observedAt: dto.lastObservedAt ?? new Date().toISOString(),
        source: "coolify",
        stale: false,
      },
    };
  }

  @Post(":dbId/restores")
  @HttpCode(202)
  public async triggerRestore(
    @Param("orgId") orgId: string,
    @Param("dbId") dbId: string,
    @Body() rawBody: unknown,
    @Req() req: FastifyRequest,
  ): Promise<AsyncAcceptedEnvelope> {
    const auth = await this.authzContext.authenticateRequest(req);
    await this.authzContext.requireTenantBoundary(
      auth,
      req,
      orgId,
      "database.backup.restore",
      "database",
      dbId,
    );

    const [found] = await this.dbClient.db
      .select({
        resource: hostingResources,
        database: databases,
      })
      .from(hostingResources)
      .innerJoin(databases, eq(databases.resourceId, hostingResources.id))
      .where(
        and(
          eq(hostingResources.id, dbId),
          eq(hostingResources.organizationId, orgId),
          eq(hostingResources.type, "database"),
        ),
      )
      .limit(1);

    if (!found) {
      throw new ControlPlaneError("NOT_FOUND", "Database was not found.");
    }

    await this.authzContext.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "database.backup.restore",
      targetType: "database",
      resource: { id: found.resource.id, organizationId: found.resource.organizationId },
    });

    const input = TriggerDatabaseRestoreBodySchema.parse(rawBody ?? {});
    const requestId = resolveRequestId(req);
    const { context } = await this.providerContextService.resolveForConnection(
      orgId,
      found.resource.connectionId,
      requestId,
    );

    try {
      const accepted = await this.coolifyAdapter.triggerDatabaseRestore(context, {
        providerDatabaseUuid: found.resource.providerId,
        engine: found.database.engine,
        backupId: input.backupId,
      });

      return {
        data: {
          operationId: accepted.providerId,
          status: "queued",
          resourceId: found.resource.id,
          submittedAt: new Date().toISOString(),
        },
        links: {
          self: `/v1/organizations/${orgId}/databases/${found.resource.id}`,
        },
      };
    } catch (error: unknown) {
      const errorCode =
        error instanceof CoolifyAdapterError ? error.code : "NOT_SUPPORTED";
      await appendAuditEvent(this.dbClient.db, {
        organizationId: orgId,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: "database.backup.restore",
        targetType: "database",
        targetId: found.resource.id,
        outcome: "failed",
        requestId,
        ipAddress: extractClientIp(req),
        metadata: {
          engine: found.database.engine,
          errorCode,
        },
      });
      throw error;
    }
  }
}
