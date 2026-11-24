import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  APP_STACK_LOG_TAIL_DEFAULT,
  AppStackLogsQuerySchema,
  type AdminAppStackDto,
  type AdminAppStacksDto,
  type AppStackComponentLogsDto,
  type AppTerminalSessionDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AdminAppStacksService } from "../app-stacks/admin-app-stacks.service.js";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppTemplatesService } from "../app-templates/app-templates.service.js";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { AdminTerminalService } from "../terminal/admin-terminal.service.js";

type RawQuery = Record<string, string | string[] | undefined>;

/**
 * The server administrator's routes on customers' applications. The list and the page of one application only read;
 * the two things an administrator can do are read the logs of a component and open a terminal in it (ADR-0041).
 * Nothing here deploys, stops, changes or deletes an application: that stays with its customer.
 */
@Controller("v1/admin/app-stacks")
export class AdminAppStacksController {
  public constructor(
    @Inject(AppTemplatesService) private readonly templates: AppTemplatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
    @Inject(AdminAppStacksService) private readonly stacks: AdminAppStacksService,
    @Inject(AdminTerminalService) private readonly terminal: AdminTerminalService,
  ) {}

  /** Read-only list for the administrator's «Applicazioni» page (ADR-0035 §9). */
  @Get()
  public async list(@Req() req: FastifyRequest): Promise<{ data: AdminAppStacksDto }> {
    await requireServerAdmin(this.authz, req, null, "app_stack");
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return { data: await this.templates.adminStacks() };
  }

  /** The page of one customer's application: its customer and its components. */
  @Get(":stackId")
  public async detail(@Req() req: FastifyRequest, @Param("stackId") stackId: string): Promise<{ data: AdminAppStackDto }> {
    await requireServerAdmin(this.authz, req, stackId, "app_stack");
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return { data: await this.stacks.detail(stackId) };
  }

  /** The last lines of one component, masked like the customer's; every read leaves an audit row. */
  @Get(":stackId/components/:componentKey/logs")
  public async logs(
    @Req() req: FastifyRequest,
    @Param("stackId") stackId: string,
    @Param("componentKey") componentKey: string,
    @Query() rawQuery?: RawQuery,
  ): Promise<{ data: AppStackComponentLogsDto }> {
    const auth = await requireServerAdmin(this.authz, req, stackId, "app_stack");
    requireAppFeature(this.gate, "applicationStacksAvailable");
    const tail = AppStackLogsQuerySchema.parse(rawQuery ?? {}).tail ?? APP_STACK_LOG_TAIL_DEFAULT;
    const { organizationId, logs } = await this.stacks.logs(stackId, componentKey, tail);
    await this.authz.recordAudit(auth, req, {
      organizationId,
      action: "admin.app_stack.logs.read",
      targetType: "app_stack",
      targetId: stackId,
      details: { componentKey, tail },
    });
    return { data: logs };
  }

  /** Opens a terminal session in the container of one component, after a fresh six-digit code. */
  @Post(":stackId/components/:componentKey/terminal")
  @HttpCode(201)
  public async openTerminal(
    @Req() req: FastifyRequest,
    @Param("stackId") stackId: string,
    @Param("componentKey") componentKey: string,
    @Body() body: unknown,
  ): Promise<{ data: AppTerminalSessionDto }> {
    const auth = await requireServerAdmin(this.authz, req, stackId, "app_stack");
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return { data: await this.terminal.openInComponent(auth, req, stackId, componentKey, body) };
  }
}
