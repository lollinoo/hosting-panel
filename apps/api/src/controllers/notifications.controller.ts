import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Req } from "@nestjs/common";
import type { NotificationSettingsDto, NotificationTestResultDto, PermissionKey } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  NOTIFICATION_CHANNEL_TARGET,
  NotificationSettingsService,
  notificationChannelOf,
  type NotificationRequestContext,
} from "../notifications/notification-settings.service.js";

/** A customer's notifications: their own sites, in a customer's words (ADR-0040 N10). */
@Controller("v1/organizations/:orgId/notifications")
export class NotificationsController {
  public constructor(
    @Inject(NotificationSettingsService) private readonly settings: NotificationSettingsService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async get(@Req() req: FastifyRequest, @Param("orgId") orgId: string): Promise<{ data: NotificationSettingsDto }> {
    await this.#require(req, orgId, "notification.read");
    return { data: await this.settings.get(orgId) };
  }

  @Put("channels/:channel")
  public async save(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("channel") channel: string,
    @Body() raw: unknown,
  ): Promise<{ data: NotificationSettingsDto }> {
    const ctx = await this.#require(req, orgId, "notification.manage");
    return { data: await this.settings.save(ctx, notificationChannelOf(channel), raw) };
  }

  @Delete("channels/:channel")
  public async remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("channel") channel: string,
  ): Promise<{ data: NotificationSettingsDto }> {
    const ctx = await this.#require(req, orgId, "notification.manage");
    return { data: await this.settings.remove(ctx, notificationChannelOf(channel)) };
  }

  @Post("channels/:channel/test")
  @HttpCode(HttpStatus.OK)
  public async test(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("channel") channel: string,
  ): Promise<{ data: NotificationTestResultDto }> {
    const ctx = await this.#require(req, orgId, "notification.manage");
    return { data: await this.settings.test(ctx, notificationChannelOf(channel)) };
  }

  /** Another customer's settings answer 404; the kind of channel is looked at only after this. */
  async #require(req: FastifyRequest, orgId: string, permission: PermissionKey): Promise<NotificationRequestContext> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, { organizationId: orgId, permission, targetType: NOTIFICATION_CHANNEL_TARGET });
    return {
      organizationId: orgId,
      userId: auth.user.id,
      audit: (tx, event) =>
        this.authz.recordAudit(auth, req, { organizationId: orgId, ...event, targetType: NOTIFICATION_CHANNEL_TARGET }, tx),
    };
  }
}
