import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { AdminAppStacksDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppTemplatesService } from "../app-templates/app-templates.service.js";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";

@Controller("v1/admin/app-stacks")
export class AdminAppStacksController {
  public constructor(
    @Inject(AppTemplatesService) private readonly templates: AppTemplatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  /** Read-only list for the administrator's «Applicazioni» page (ADR-0035 §9). There is no admin action on a stack. */
  @Get()
  public async list(@Req() req: FastifyRequest): Promise<{ data: AdminAppStacksDto }> {
    await requireServerAdmin(this.authz, req, null, "app_stack");
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return { data: await this.templates.adminStacks() };
  }
}
