import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Patch, Post, Req } from "@nestjs/common";
import {
  MailRelaySettingsInputSchema,
  SendTestMailInputSchema,
  type MailRelaySettingsDto,
  type MailTestResult,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { MailRelayService } from "../mail/mail-relay.service.js";

const TARGET = "mail_relay";

@Controller("v1/admin/mail-relay")
export class AdminMailRelayController {
  public constructor(
    @Inject(MailRelayService) private readonly mailRelay: MailRelayService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async get(@Req() req: FastifyRequest): Promise<{ data: MailRelaySettingsDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.mailRelay.get() };
  }

  @Patch()
  public async save(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: MailRelaySettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    const input = MailRelaySettingsInputSchema.parse(raw ?? {});
    return { data: await this.mailRelay.save(input, auth.user.id) };
  }

  @Delete()
  public async clear(@Req() req: FastifyRequest): Promise<{ data: MailRelaySettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.mailRelay.clear(auth.user.id) };
  }

  @Post("test")
  @HttpCode(HttpStatus.OK)
  public async test(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: MailTestResult }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    const { to } = SendTestMailInputSchema.parse(raw ?? {});
    return { data: await this.mailRelay.sendTest(to, auth.user.id) };
  }
}
