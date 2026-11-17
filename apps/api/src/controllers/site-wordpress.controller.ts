import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import {
  SiteWordpressUpdateRequestSchema,
  type ManagedSiteDto,
  type PermissionKey,
  type SiteWordpressAcceptedDto,
  type SiteWordpressDto,
  type SiteWordpressPasswordResetDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { SiteWordpressService } from "../sites/site-wordpress.service.js";

const EmptyBodySchema = z.object({}).strict();

interface AcceptedEnvelope {
  readonly data: SiteWordpressAcceptedDto;
  readonly links: { readonly operation: string };
}

const headersOf = (req: FastifyRequest): Record<string, string | string[] | undefined> =>
  req.headers as Record<string, string | string[] | undefined>;

/** Customer routes of the WordPress tab. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId/wordpress")
export class SiteWordpressController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteWordpressService) private readonly wordpressService: SiteWordpressService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get()
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ readonly data: SiteWordpressDto }> {
    const { site } = await this.#authorize(req, orgId, siteId, "site.read");
    return { data: await this.wordpressService.get(site) };
  }

  @Post("refresh")
  @HttpCode(202)
  public async refresh(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<AcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    EmptyBodySchema.parse(rawBody ?? {});
    const data = await this.wordpressService.refresh(site, { auth, req }, idempotencyKey);
    return this.#accepted(orgId, data);
  }

  @Post("updates")
  @HttpCode(202)
  public async update(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<AcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const target = SiteWordpressUpdateRequestSchema.parse(rawBody ?? {});
    const data = await this.wordpressService.update(site, { auth, req }, idempotencyKey, target);
    return this.#accepted(orgId, data);
  }

  @Post("administrators/:userId/password-reset")
  @HttpCode(200)
  public async resetPassword(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("userId") userId: string,
    @Body() rawBody?: unknown,
  ): Promise<{ readonly data: SiteWordpressPasswordResetDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    EmptyBodySchema.parse(rawBody ?? {});
    return { data: await this.wordpressService.resetPassword(site, { auth, req }, userId) };
  }

  #accepted(orgId: string, data: SiteWordpressAcceptedDto): AcceptedEnvelope {
    this.outboxWorker.triggerAsync();
    return { data, links: { operation: `/v1/organizations/${orgId}/operations/${data.operationId}` } };
  }

  /** Resolves the site before the permission check so foreign sites answer 404. */
  async #authorize(
    req: FastifyRequest,
    orgId: string,
    siteId: string,
    permission: PermissionKey,
  ): Promise<{ readonly auth: AuthenticatedRequestContext; readonly site: ManagedSiteDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission,
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return { auth, site };
  }
}
