import { Controller, Delete, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import type { SupportAccessDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { SupportAccessService } from "../auth/support-access.service.js";

/** Server administrator support visit: open on a site's owner organization, or leave. */
@Controller("v1/admin")
export class SupportAccessController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(SupportAccessService) private readonly support: SupportAccessService,
  ) {}

  @Post("sites/:siteId/support-access")
  @HttpCode(HttpStatus.CREATED)
  public async open(@Req() req: FastifyRequest, @Param("siteId") siteId: string): Promise<{ data: SupportAccessDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.support.open(auth, req, siteId) };
  }

  @Delete("support-access")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async close(@Req() req: FastifyRequest): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, null);
    await this.support.close(auth, req);
  }
}
