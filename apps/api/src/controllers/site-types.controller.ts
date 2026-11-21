import { Controller, Get, Inject, Param, Req } from "@nestjs/common";
import type { CustomerSiteTypesDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { SiteTemplatesService } from "../site-templates/site-templates.service.js";

/**
 * The site types a customer may pick when creating a site. The list is the same for every organisation (the
 * templates are global); the organisation check only keeps strangers out, in the order of the other customer routes.
 */
@Controller("v1/organizations/:orgId/site-types")
export class SiteTypesController {
  public constructor(
    @Inject(SiteTemplatesService) private readonly templates: SiteTemplatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async list(@Req() req: FastifyRequest, @Param("orgId") orgId: string): Promise<{ data: CustomerSiteTypesDto }> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, { organizationId: orgId, permission: "site.create", targetType: "site" });
    return { data: await this.templates.listForCustomer() };
  }
}
