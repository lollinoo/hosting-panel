import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Req } from "@nestjs/common";
import {
  SiteWordpressImportChunkRequestSchema,
  SiteWordpressImportPickRequestSchema,
  SiteWordpressImportStartRequestSchema,
  WordpressImportSlotSchema,
  type ManagedSiteDto,
  type PermissionKey,
  type SiteWordpressAcceptedDto,
  type SiteWordpressImportDto,
  type SiteWordpressImportSlotDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { SiteWordpressImportService } from "../sites/site-wordpress-import.service.js";

interface AcceptedEnvelope {
  readonly data: SiteWordpressAcceptedDto;
  readonly links: { readonly operation: string };
}

const headersOf = (req: FastifyRequest): Record<string, string | string[] | undefined> =>
  req.headers as Record<string, string | string[] | undefined>;

/** Customer routes of the WordPress import. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId/wordpress/import")
export class SiteWordpressImportController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteWordpressImportService) private readonly importService: SiteWordpressImportService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get()
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ readonly data: SiteWordpressImportDto }> {
    const { site } = await this.#authorize(req, orgId, siteId, "site.read");
    return { data: await this.importService.get(site) };
  }

  @Put("files/:slot")
  @HttpCode(200)
  public async putChunk(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("slot") rawSlot: string,
    @Body() rawBody?: unknown,
  ): Promise<{ readonly data: { readonly received: number } }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    const slot = WordpressImportSlotSchema.parse(rawSlot);
    const body = SiteWordpressImportChunkRequestSchema.parse(rawBody ?? {});
    return { data: await this.importService.putChunk(site, slot, body, { auth, req }) };
  }

  @Post("files/:slot/pick")
  @HttpCode(200)
  public async pick(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("slot") rawSlot: string,
    @Body() rawBody?: unknown,
  ): Promise<{ readonly data: SiteWordpressImportSlotDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    const slot = WordpressImportSlotSchema.parse(rawSlot);
    const { path } = SiteWordpressImportPickRequestSchema.parse(rawBody ?? {});
    return { data: await this.importService.pick(site, slot, path, { auth, req }) };
  }

  @Delete("files")
  @HttpCode(204)
  public async discard(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    await this.importService.discard(site, { auth, req });
  }

  @Post()
  @HttpCode(202)
  public async start(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<AcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId, "site.update");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    SiteWordpressImportStartRequestSchema.parse(rawBody ?? {});
    const data = await this.importService.start(site, idempotencyKey, { auth, req });
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
