import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import {
  AddSiteDomainInputSchema,
  AdminCreateSiteInputSchema,
  ChangeSiteOwnerInputSchema,
  DeleteSiteInputSchema,
  SiteActionInputSchema,
  type AdminSitesListDto,
  type SiteDomainsDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { ControlPlaneError, requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService, type ManagedSiteAccepted } from "../sites/managed-sites.service.js";
import { SiteDomainsService, requestedHostnames } from "../sites/site-domains.service.js";

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

@Controller("v1/admin/sites")
export class AdminSitesController {
  public constructor(
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
    @Inject(SiteDomainsService) private readonly domainsService: SiteDomainsService,
  ) {}

  @Get()
  public async list(@Req() req: FastifyRequest): Promise<{ data: AdminSitesListDto }> {
    await requireServerAdmin(this.authz, req, null, "site");
    return { data: await this.sitesService.listAll() };
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  public async create(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, null, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { ownerOrganizationId, ...body } = AdminCreateSiteInputSchema.parse(raw ?? {});
    const organizationId = await this.sitesService.resolveOwner(ownerOrganizationId);
    const accepted = await this.sitesService.create({ organizationId, body, actorId: auth.user.id, idempotencyKey });
    return this.#done(auth, req, "admin.site.create", accepted, { owner: ownerOrganizationId });
  }

  @Post(":siteId/owner")
  @HttpCode(HttpStatus.ACCEPTED)
  public async changeOwner(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { ownerOrganizationId } = ChangeSiteOwnerInputSchema.parse(raw ?? {});
    const from = await this.sitesService.ownerOf(siteId);
    const to = await this.sitesService.resolveOwner(ownerOrganizationId);
    const accepted = await this.sitesService.reassign(siteId, to, auth.user.id, idempotencyKey);
    return this.#done(auth, req, "admin.site.reassign", accepted, { from, to });
  }

  @Post(":siteId/actions")
  @HttpCode(HttpStatus.ACCEPTED)
  public async act(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { action } = SiteActionInputSchema.parse(raw ?? {});
    if (action !== "retry") {
      throw new ControlPlaneError("VALIDATION_ERROR", "Only Try again is available here. Use the site's page for the other actions.");
    }
    const accepted = await this.sitesService.adminRetry(siteId, auth.user.id, idempotencyKey);
    return this.#done(auth, req, "admin.site.retry", accepted);
  }

  @Delete(":siteId")
  @HttpCode(HttpStatus.ACCEPTED)
  public async remove(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { confirmName } = DeleteSiteInputSchema.parse(raw ?? {});
    const owner = await this.sitesService.ownerOf(siteId);
    const accepted = await this.sitesService.remove(siteId, owner, confirmName, auth.user.id, idempotencyKey);
    return this.#done(auth, req, "admin.site.delete", accepted);
  }

  @Get(":siteId/domains")
  public async listDomains(@Req() req: FastifyRequest, @Param("siteId") siteId: string): Promise<{ data: SiteDomainsDto }> {
    await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.domainsService.list(siteId, await this.sitesService.ownerOf(siteId)) };
  }

  @Post(":siteId/domains")
  @HttpCode(HttpStatus.CREATED)
  public async addDomain(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const owner = await this.sitesService.ownerOf(siteId);
    const input = AddSiteDomainInputSchema.parse(raw ?? {});
    const data = await this.domainsService.add(siteId, owner, input);
    await this.#domainAudit(auth, req, siteId, "admin.site.domain.add", requestedHostnames(input));
    return { data };
  }

  @Delete(":siteId/domains/:domainId")
  public async removeDomain(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const owner = await this.sitesService.ownerOf(siteId);
    const { hostname } = await this.domainsService.findDomain(siteId, owner, domainId);
    const data = await this.domainsService.remove(siteId, owner, domainId);
    await this.#domainAudit(auth, req, siteId, "admin.site.domain.remove", [hostname]);
    return { data };
  }

  @Post(":siteId/domains/:domainId/primary")
  @HttpCode(HttpStatus.OK)
  public async setPrimaryDomain(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const owner = await this.sitesService.ownerOf(siteId);
    const { hostname } = await this.domainsService.findDomain(siteId, owner, domainId);
    const data = await this.domainsService.setPrimary(siteId, owner, domainId);
    await this.#domainAudit(auth, req, siteId, "admin.site.domain.primary", [hostname]);
    return { data };
  }

  @Post(":siteId/domains/:domainId/check")
  @HttpCode(HttpStatus.OK)
  public async checkDomain(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
  ): Promise<{ data: SiteDomainsDto }> {
    await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.domainsService.check(siteId, await this.sitesService.ownerOf(siteId), domainId) };
  }

  #domainAudit(
    auth: Awaited<ReturnType<typeof requireServerAdmin>>,
    req: FastifyRequest,
    siteId: string,
    action: string,
    hostnames: string[],
  ) {
    return this.authz.recordAudit(auth, req, { action, targetType: "site", targetId: siteId, details: { hostnames } });
  }

  async #done(
    auth: Awaited<ReturnType<typeof requireServerAdmin>>,
    req: FastifyRequest,
    action: string,
    accepted: ManagedSiteAccepted,
    details: Record<string, unknown> = {},
  ): Promise<{ data: ManagedSiteAccepted }> {
    await this.authz.recordAudit(auth, req, {
      action,
      targetType: "site",
      targetId: accepted.siteId,
      details: { operationId: accepted.operationId, ...details },
    });
    this.outboxWorker.triggerAsync();
    return { data: accepted };
  }
}
