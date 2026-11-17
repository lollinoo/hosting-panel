import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import {
  PLATFORM_OPS_ORG_ID,
  PanelContainerSchema,
  RestartInputSchema,
  type AdminAlertDto,
  type AdminHealthDto,
  type OperationDto,
  type PanelContainer,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  asc,
  enqueueOperationTransactional,
  eq,
  operationSteps,
  operations,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { ensurePlatformOpsOrg } from "../backups/backup-scheduler.service.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { AdminHealthService } from "../health/admin-health.service.js";
import { PANEL_RESTART_LEASE_MS, PANEL_RESTART_STEPS } from "../health/panel-restart.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";
import { mapOperationToDto } from "./hosts.controller.js";

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/** Platform administrator routes for panel health and alerts. */
@Controller("v1/admin")
export class AdminHealthController {
  public constructor(
    @Inject(AdminHealthService) private readonly adminHealth: AdminHealthService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  /** Panel parts, site containers and disks from stored state. */
  @Get("health")
  public async health(@Req() req: FastifyRequest): Promise<{ data: AdminHealthDto }> {
    await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.adminHealth.health() };
  }

  /** Open alerts computed from stored state. */
  @Get("alerts")
  public async alerts(@Req() req: FastifyRequest): Promise<{ data: AdminAlertDto[] }> {
    await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.adminHealth.alerts() };
  }

  /** Queues a restart of one panel container; the request row is written with the operation. */
  @Post("panel-containers/:component/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  public async restartPanelContainer(
    @Req() req: FastifyRequest,
    @Param("component") rawComponent: string,
    @Body() raw: unknown,
  ): Promise<{ data: { component: PanelContainer; operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, "panel_container");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const component = PanelContainerSchema.parse(rawComponent);
    const { reason } = RestartInputSchema.parse(raw ?? {});
    const part = (await this.adminHealth.health()).components.find((c) => c.component === component);
    if (part?.reason === "runtime_disabled") {
      throw new ControlPlaneError("NOT_SUPPORTED", "The container runtime is disabled on this server.");
    }
    if (part?.state === "not_in_use" || (part?.state === "down" && part.reason === "missing")) {
      throw new ControlPlaneError("PANEL_CONTAINER_ABSENT", "This container is not installed. There is nothing to restart.");
    }
    const operationId = await this.dbClient.db.transaction(async (tx) => {
      await ensurePlatformOpsOrg(tx);
      const enqueued = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
        organizationId: PLATFORM_OPS_ORG_ID,
        kind: "panel.container.restart",
        resourceType: "host",
        resourceId: component,
        requestedByUserId: auth.user.id,
        idempotencyKey,
        lockKey: `panel:container:${component}`,
        leaseDurationMs: PANEL_RESTART_LEASE_MS,
        steps: PANEL_RESTART_STEPS,
        outboxPayload: {},
      });
      const id = enqueued.operation.id;
      if (!enqueued.idempotentReplay) {
        await appendAuditEvent(tx, {
          actorId: auth.user.id,
          actorType: "user",
          organizationId: PLATFORM_OPS_ORG_ID,
          action: "admin.panel_container.restart",
          targetType: "panel_container",
          targetId: component,
          ipAddress: extractClientIp(req),
          userAgent: extractRawHeader(headersOf(req), "user-agent"),
          details: { outcome: "succeeded", requestId: resolveRequestId(req), operationId: id, component, reason },
        });
      }
      return id;
    });
    return { data: { component, operationId } };
  }

  /** Any operation by id, for following a restart. */
  @Get("operations/:operationId")
  public async operation(@Req() req: FastifyRequest, @Param("operationId") operationId: string): Promise<{ data: OperationDto }> {
    await requireServerAdmin(this.authz, req, operationId, "operation");
    const db = this.dbClient.db;
    const [op] = await db.select().from(operations).where(eq(operations.id, operationId)).limit(1);
    if (!op) throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    const steps = await db.select().from(operationSteps).where(eq(operationSteps.operationId, op.id)).orderBy(asc(operationSteps.id));
    return { data: mapOperationToDto(op, steps) };
  }
}
