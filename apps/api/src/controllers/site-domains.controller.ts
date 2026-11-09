import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import { AddSiteDomainInputSchema, type PermissionKey, type SiteDomainsDto } from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { SiteDomainsService, requestedHostnames } from "../sites/site-domains.service.js";

type Auth = Awaited<ReturnType<AuthzContextService["authenticateRequest"]>>;

/** No Idempotency-Key: every call is idempotent by design. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId/domains")
export class SiteDomainsController {
  public constructor(
    @Inject(SiteDomainsService) private readonly domainsService: SiteDomainsService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
  ) {}

  @Get()
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    await this.#require(req, orgId, siteId, "site.read");
    return { data: await this.domainsService.list(siteId, orgId) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async add(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.update");
    const input = AddSiteDomainInputSchema.parse(raw ?? {});
    const data = await this.domainsService.add(siteId, orgId, input);
    await this.#audit(auth, req, orgId, siteId, "site.domain.add", requestedHostnames(input));
    return { data };
  }

  @Delete(":domainId")
  public async remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.update");
    const { hostname } = await this.domainsService.findDomain(siteId, orgId, domainId);
    const data = await this.domainsService.remove(siteId, orgId, domainId);
    await this.#audit(auth, req, orgId, siteId, "site.domain.remove", [hostname]);
    return { data };
  }

  @Post(":domainId/primary")
  @HttpCode(HttpStatus.OK)
  public async setPrimary(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.update");
    const { hostname } = await this.domainsService.findDomain(siteId, orgId, domainId);
    const data = await this.domainsService.setPrimary(siteId, orgId, domainId);
    await this.#audit(auth, req, orgId, siteId, "site.domain.primary", [hostname]);
    return { data };
  }

  @Post(":domainId/check")
  @HttpCode(HttpStatus.OK)
  public async check(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    await this.#require(req, orgId, siteId, "site.read");
    return { data: await this.domainsService.check(siteId, orgId, domainId) };
  }

  /** Another organization's site is a 404 before any permission check. */
  async #require(req: FastifyRequest, orgId: string, siteId: string, permission: PermissionKey): Promise<Auth> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission,
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return auth;
  }

  #audit(auth: Auth, req: FastifyRequest, orgId: string, siteId: string, action: string, hostnames: string[]) {
    return this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action,
      targetType: "site",
      targetId: siteId,
      details: { hostnames },
    });
  }
}
