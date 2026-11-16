import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { AdminAlertDto, AdminHealthDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { AdminHealthService } from "../health/admin-health.service.js";

/** Platform administrator routes for panel health and alerts. */
@Controller("v1/admin")
export class AdminHealthController {
  public constructor(
    @Inject(AdminHealthService) private readonly adminHealth: AdminHealthService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
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
}
