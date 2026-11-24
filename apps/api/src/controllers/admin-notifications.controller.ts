import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Req } from "@nestjs/common";
import type { NotificationSettingsDto, NotificationTestResultDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import {
  NOTIFICATION_CHANNEL_TARGET,
  NotificationSettingsService,
  notificationChannelOf,
  type NotificationRequestContext,
} from "../notifications/notification-settings.service.js";

/** The server's notifications: every kind of alert, for the server administrators only (ADR-0040 N10). */
@Controller("v1/admin/notifications")
export class AdminNotificationsController {
  public constructor(
    @Inject(NotificationSettingsService) private readonly settings: NotificationSettingsService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async get(@Req() req: FastifyRequest): Promise<{ data: NotificationSettingsDto }> {
    await requireServerAdmin(this.authz, req, null, NOTIFICATION_CHANNEL_TARGET);
    return { data: await this.settings.get(null) };
  }

  @Put("channels/:channel")
  public async save(
    @Req() req: FastifyRequest,
    @Param("channel") channel: string,
    @Body() raw: unknown,
  ): Promise<{ data: NotificationSettingsDto }> {
    const ctx = await this.#admin(req);
    return { data: await this.settings.save(ctx, notificationChannelOf(channel), raw) };
  }

  @Delete("channels/:channel")
  public async remove(@Req() req: FastifyRequest, @Param("channel") channel: string): Promise<{ data: NotificationSettingsDto }> {
    const ctx = await this.#admin(req);
    return { data: await this.settings.remove(ctx, notificationChannelOf(channel)) };
  }

  @Post("channels/:channel/test")
  @HttpCode(HttpStatus.OK)
  public async test(@Req() req: FastifyRequest, @Param("channel") channel: string): Promise<{ data: NotificationTestResultDto }> {
    const ctx = await this.#admin(req);
    return { data: await this.settings.test(ctx, notificationChannelOf(channel)) };
  }

  async #admin(req: FastifyRequest): Promise<NotificationRequestContext> {
    const auth = await requireServerAdmin(this.authz, req, null, NOTIFICATION_CHANNEL_TARGET);
    return {
      organizationId: null,
      userId: auth.user.id,
      audit: (tx, event) => this.authz.recordAudit(auth, req, { ...event, targetType: NOTIFICATION_CHANNEL_TARGET }, tx),
    };
  }
}
