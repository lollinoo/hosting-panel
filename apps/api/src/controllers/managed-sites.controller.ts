import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import {
  CreateManagedSiteInputSchema,
  SiteActionInputSchema,
  type ManagedSiteDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService, type ManagedSiteAccepted } from "../sites/managed-sites.service.js";

interface ManagedSiteAcceptedEnvelope {
  readonly data: ManagedSiteAccepted;
  readonly links: { readonly operation: string };
}

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

@Controller("v1/organizations/:orgId/managed-sites")
export class ManagedSitesController {
  public constructor(
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  public async create(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Body() rawBody: unknown,
  ): Promise<ManagedSiteAcceptedEnvelope> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.create",
      targetType: "site",
    });
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = CreateManagedSiteInputSchema.parse(rawBody ?? {});

    // The site.create audit row is written inside the creating transaction (createSiteTransactional).
    const accepted = await this.sitesService.create({
      organizationId: orgId,
      body,
      actorId: auth.user.id,
      idempotencyKey,
    });
    this.outboxWorker.triggerAsync();
    return this.#accepted(orgId, accepted);
  }

  @Get(":siteId")
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ data: ManagedSiteDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.read",
      targetType: "site",
      targetId: siteId,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return { data: site };
  }

  @Post(":siteId/actions")
  @HttpCode(HttpStatus.ACCEPTED)
  public async act(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody: unknown,
  ): Promise<ManagedSiteAcceptedEnvelope> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    const { action } = SiteActionInputSchema.parse(rawBody ?? {});
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.create",
      targetType: "site",
      targetId: siteId,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    const idempotencyKey = requireIdempotencyKey(headersOf(req));

    const accepted = await this.sitesService.act(siteId, orgId, action, auth.user.id, idempotencyKey);
    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: `site.${action}`,
      targetType: "site",
      targetId: siteId,
      details: { operationId: accepted.operationId },
    });
    this.outboxWorker.triggerAsync();
    return this.#accepted(orgId, accepted);
  }

  #accepted(orgId: string, accepted: ManagedSiteAccepted): ManagedSiteAcceptedEnvelope {
    return {
      data: accepted,
      links: { operation: `/v1/organizations/${orgId}/operations/${accepted.operationId}` },
    };
  }
}
