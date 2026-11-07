import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import type { AuditEventDto, ReadMeta } from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  desc,
  eq,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

function mapAuditEventToDto(event: typeof auditEvents.$inferSelect): AuditEventDto {
  return {
    id: event.id,
    actorId: event.actorId ?? null,
    actorType: event.actorType,
    organizationId: event.organizationId ?? null,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
    details: (event.details ?? {}) as Record<string, unknown>,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
  };
}

@Controller("v1/admin/audit")
export class AdminAuditController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
  ) {}

  @Get()
  public async getAuditEvents(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: AuditEventDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "audit.read", "audit_event");

    const pagination = parsePaginationQuery(rawQuery);
    const orgId = typeof rawQuery?.["organizationId"] === "string" ? rawQuery["organizationId"].trim() : undefined;
    const action = typeof rawQuery?.["action"] === "string" ? rawQuery["action"].trim() : undefined;

    const conditions = [];
    if (orgId) {
      conditions.push(eq(auditEvents.organizationId, orgId));
    }
    if (action) {
      conditions.push(eq(auditEvents.action, action));
    }

    const rows = await this.dbClient.db
      .select()
      .from(auditEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.timestamp));

    const dtoList = rows.map(mapAuditEventToDto);
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
}
