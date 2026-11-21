import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import {
  AddSiteDomainInputSchema,
  AdminCreateSiteInputSchema,
  ChangeSiteOwnerInputSchema,
  ChangeSiteTemplateVersionInputSchema,
  DeleteSiteInputSchema,
  RestartInputSchema,
  SetDomainChallengeInputSchema,
  SiteActionInputSchema,
  type AdminSitesListDto,
  type SiteDomainsDto,
} from "@hosting-panel/contracts";
import { appendAuditEvent, type DatabaseExecutor } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import {
  ControlPlaneError,
  extractClientIp,
  extractRawHeader,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService, type ManagedSiteAccepted } from "../sites/managed-sites.service.js";
import { SiteDomainsService, requestedHostnames } from "../sites/site-domains.service.js";

type AuditEvent = { readonly action: string; readonly targetType: string; readonly targetId: string; readonly details: Record<string, unknown> };

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
    const accepted = await this.sitesService.create({ organizationId, body, actorId: auth.user.id, idempotencyKey, audience: "admin" });
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

  /** Restarts the site's container with a reason kept in the audit row. */
  @Post(":siteId/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  public async restart(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { reason } = RestartInputSchema.parse(raw ?? {});
    const owner = await this.sitesService.ownerOf(siteId);
    // The row is written with the operation, once: a failed insert queues nothing (R195 1.4).
    const accepted = await this.sitesService.act(siteId, owner, "restart", auth.user.id, idempotencyKey, (tx, operationId) =>
      appendAuditEvent(tx, {
        actorId: auth.user.id,
        actorType: "user",
        organizationId: null,
        action: "admin.site.restart",
        targetType: "site",
        targetId: siteId,
        ipAddress: extractClientIp(req),
        userAgent: extractRawHeader(headersOf(req), "user-agent"),
        details: { outcome: "succeeded", requestId: resolveRequestId(req), operationId, reason },
      }).then(() => undefined),
    );
    this.outboxWorker.triggerAsync();
    return { data: accepted };
  }

  /** Moves a site to a newer version of its own template; the audit row is written with the operation. */
  @Post(":siteId/template-version")
  @HttpCode(HttpStatus.ACCEPTED)
  public async changeTemplateVersion(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: ManagedSiteAccepted }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const { versionId } = ChangeSiteTemplateVersionInputSchema.parse(raw ?? {});
    const owner = await this.sitesService.ownerOf(siteId);
    const accepted = await this.sitesService.changeTemplateVersion({
      siteId,
      organizationId: owner,
      versionId,
      actorId: auth.user.id,
      idempotencyKey,
      onNew: (tx, operationId, change) =>
        appendAuditEvent(tx, {
          actorId: auth.user.id,
          actorType: "user",
          organizationId: owner,
          action: "admin.site.template_version",
          targetType: "site",
          targetId: siteId,
          ipAddress: extractClientIp(req),
          userAgent: extractRawHeader(headersOf(req), "user-agent"),
          details: { outcome: "succeeded", requestId: resolveRequestId(req), operationId, ...change },
        }),
    });
    this.outboxWorker.triggerAsync();
    return { data: accepted };
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
    const actor =
      input.tlsVersionId === undefined
        ? {}
        : {
            requestedByUserId: auth.user.id,
            idempotencyKey: requireIdempotencyKey(headersOf(req)),
            audit: (tx: DatabaseExecutor, event: AuditEvent) =>
              this.authz.recordAudit(auth, req, { organizationId: owner, ...event }, tx),
          };
    const data = await this.domainsService.add(siteId, owner, input, actor);
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

  @Patch(":siteId/domains/:domainId")
  public async setDomainChallenge(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const owner = await this.sitesService.ownerOf(siteId);
    const { challenge } = SetDomainChallengeInputSchema.parse(raw ?? {});
    const { hostname } = await this.domainsService.findDomain(siteId, owner, domainId);
    const { changed, data } = await this.domainsService.setChallenge(siteId, owner, domainId, challenge);
    // Only a change that was written is audited.
    if (changed) await this.#domainAudit(auth, req, siteId, "admin.site.domain.challenge", [hostname], { challenge });
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
    extra: Record<string, unknown> = {},
  ) {
    return this.authz.recordAudit(auth, req, { action, targetType: "site", targetId: siteId, details: { hostnames, ...extra } });
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
