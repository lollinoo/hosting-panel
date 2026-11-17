import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import type { OsPackagesDto, PanelContainer, UpdatesDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { UpdatesService } from "../updates/updates.service.js";

/** Platform administrator routes for panel, component, site image and system package updates. */
@Controller("v1/admin")
export class AdminUpdatesController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(UpdatesService) private readonly updatesService: UpdatesService,
  ) {}

  /** What can be updated. */
  @Get("updates")
  public async updates(@Req() req: FastifyRequest): Promise<{ data: UpdatesDto }> {
    await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.updates() };
  }

  /** Checks for a newer panel release. */
  @Post("updates/panel/check")
  @HttpCode(HttpStatus.OK)
  public async checkPanel(@Req() req: FastifyRequest): Promise<{ data: UpdatesDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.checkPanel(auth, req) };
  }

  /** Queues the panel update. */
  @Post("updates/panel/apply")
  @HttpCode(HttpStatus.ACCEPTED)
  public async applyPanel(@Req() req: FastifyRequest, @Body() _raw: unknown): Promise<{ data: { operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.applyPanel(auth, req) };
  }

  /** Queues one component's move to its pinned image. */
  @Post("updates/components/:component/apply")
  @HttpCode(HttpStatus.ACCEPTED)
  public async applyComponent(
    @Req() req: FastifyRequest,
    @Param("component") component: string,
    @Body() _raw: unknown,
  ): Promise<{ data: { component: PanelContainer; operationId: string | null } }> {
    const auth = await requireServerAdmin(this.authz, req, component, "panel_container");
    return { data: await this.updatesService.applyComponent(auth, req, component) };
  }

  /** Queues one site's move to the pinned PHP image. */
  @Post("sites/:siteId/image-update")
  @HttpCode(HttpStatus.ACCEPTED)
  public async updateSiteImage(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() _raw: unknown,
  ): Promise<{ data: { siteId: string; operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.updatesService.updateSiteImage(auth, req, siteId) };
  }

  /** System packages with an update. */
  @Get("os-packages")
  public async osPackages(@Req() req: FastifyRequest): Promise<{ data: OsPackagesDto }> {
    await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.osPackages() };
  }

  /** Queues a refresh of the package lists. */
  @Post("os-packages/refresh")
  @HttpCode(HttpStatus.ACCEPTED)
  public async refreshOsPackages(@Req() req: FastifyRequest, @Body() _raw: unknown): Promise<{ data: { operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.refreshOsPackages(auth, req) };
  }

  /** Queues the system package upgrade. */
  @Post("os-packages/upgrade")
  @HttpCode(HttpStatus.ACCEPTED)
  public async upgradeOsPackages(@Req() req: FastifyRequest, @Body() _raw: unknown): Promise<{ data: { operationId: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, "platform");
    return { data: await this.updatesService.upgradeOsPackages(auth, req) };
  }
}
