import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import type { AuditEventDto, ReadMeta } from "@hosting-panel/contracts";
import {
  and,
  auditEvents,
  desc,
  eq,
  gte,
  lt,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

// from is inclusive, to exclusive; limit and cursor are read by parsePaginationQuery.
const AdminAuditRangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine((r) => !r.from || !r.to || Date.parse(r.from) < Date.parse(r.to), { message: "From must be before To.", path: ["from"] });

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

    const { cursor, limit } = parsePaginationQuery(rawQuery);
    const { from, to } = AdminAuditRangeSchema.parse({ from: rawQuery?.["from"], to: rawQuery?.["to"] });
    const orgId = typeof rawQuery?.["organizationId"] === "string" ? rawQuery["organizationId"].trim() : undefined;
    const action = typeof rawQuery?.["action"] === "string" ? rawQuery["action"].trim() : undefined;

    // Keyset over (timestamp, id); the cursor row is read in SQL so its microseconds are kept.
    const rows = await this.dbClient.db
      .select()
      .from(auditEvents)
      .where(
        and(
          orgId ? eq(auditEvents.organizationId, orgId) : undefined,
          action ? eq(auditEvents.action, action) : undefined,
          from ? gte(auditEvents.timestamp, new Date(from)) : undefined,
          to ? lt(auditEvents.timestamp, new Date(to)) : undefined,
          cursor
            ? sql`(${auditEvents.timestamp}, ${auditEvents.id}) < (SELECT a.timestamp, a.id FROM audit_events a WHERE a.id = ${cursor})`
            : undefined,
        ),
      )
      .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(mapAuditEventToDto);

    return {
      data,
      meta: {
        cursor: cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: { nextCursor: hasMore ? data[data.length - 1]!.id : null, hasMore },
    };
  }
}
