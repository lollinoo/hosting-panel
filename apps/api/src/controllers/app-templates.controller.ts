import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import type { CustomerAppTemplateDto, CustomerAppTemplatesDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppTemplatesService } from "../app-templates/app-templates.service.js";
import { AuthzContextService } from "../auth/authz-context.service.js";

/**
 * The application templates a customer may install: published, and passing today's checks. The catalogue is the same
 * for every organisation; the organisation check keeps strangers out, in the order of the other customer routes.
 */
@Controller("v1/organizations/:orgId/app-templates")
export class AppTemplatesController {
  public constructor(
    @Inject(AppTemplatesService) private readonly templates: AppTemplatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  @Get()
  public async list(@Req() req: FastifyRequest, @Param("orgId") orgId: string): Promise<{ data: CustomerAppTemplatesDto }> {
    await this.#member(req, orgId);
    return { data: await this.templates.listForCustomer() };
  }

  @Get(":templateId")
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("templateId") templateId: string,
  ): Promise<{ data: CustomerAppTemplateDto }> {
    await this.#member(req, orgId);
    return { data: await this.templates.getForCustomer(templateId) };
  }

  async #member(req: FastifyRequest, orgId: string): Promise<void> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, { organizationId: orgId, permission: "app.read", targetType: "app_template" });
    requireAppFeature(this.gate, "applicationStacksAvailable");
  }
}
