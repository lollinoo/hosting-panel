import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import {
  AdminActivateTlsVersionRequestSchema,
  AdminSetDomainTlsRequestSchema,
  CreateTlsCertificateVersionRequestSchema,
  ImportTlsCertificateRequestSchema,
  type SiteDomainsDto,
  type TlsCertificateDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { TlsCertificatesService, type TlsActor, type TlsAuditFn, type TlsChangeResult } from "../certificates/tls-certificates.service.js";
import { ControlPlaneError, requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";

type Auth = Awaited<ReturnType<typeof requireServerAdmin>>;

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/**
 * The administrator's view of the same routes, for the organisation that owns the site. `requireServerAdmin` runs
 * first (a customer gets 403 and a denied row before anything is read); only here can an ACME certificate that ties
 * with the imported one be evicted (`evictAcme` + `confirmHostname`).
 */
@Controller("v1/admin/sites/:siteId")
export class AdminSiteTlsCertificatesController {
  public constructor(
    @Inject(TlsCertificatesService) private readonly certificates: TlsCertificatesService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get("tls-certificates")
  public async list(@Req() req: FastifyRequest, @Param("siteId") siteId: string): Promise<{ data: TlsCertificateDto[] }> {
    await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.certificates.list(await this.sitesService.ownerOf(siteId)) };
  }

  @Post("tls-certificates")
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: TlsCertificateDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const organizationId = await this.sitesService.ownerOf(siteId);
    const body = ImportTlsCertificateRequestSchema.parse(raw ?? {});
    return {
      data: await this.certificates.importCertificate({
        scope: { organizationId, siteId },
        actor: this.#actor(auth),
        idempotencyKey,
        body,
        audit: this.#audit(auth, req, organizationId),
      }),
    };
  }

  @Get("tls-certificates/:certificateId")
  public async get(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
  ): Promise<{ data: TlsCertificateDto }> {
    await requireServerAdmin(this.authz, req, siteId, "site");
    return { data: await this.certificates.get(await this.sitesService.ownerOf(siteId), certificateId) };
  }

  @Delete("tls-certificates/:certificateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
  ): Promise<void> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const organizationId = await this.sitesService.ownerOf(siteId);
    await this.certificates.deleteCertificate({
      organizationId,
      certificateId,
      siteId,
      audit: this.#audit(auth, req, organizationId),
    });
  }

  @Post("tls-certificates/:certificateId/versions")
  @HttpCode(HttpStatus.CREATED)
  public async addVersion(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: TlsCertificateDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const organizationId = await this.sitesService.ownerOf(siteId);
    const body = CreateTlsCertificateVersionRequestSchema.parse(raw ?? {});
    return {
      data: await this.certificates.addVersion({
        scope: { organizationId, siteId },
        actor: this.#actor(auth),
        certificateId,
        idempotencyKey,
        body,
        audit: this.#audit(auth, req, organizationId),
      }),
    };
  }

  @Post("tls-certificates/:certificateId/versions/:versionId/activate")
  @HttpCode(HttpStatus.ACCEPTED)
  public async activate(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
    @Param("versionId") versionId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto; moved: TlsChangeResult["moved"] }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const organizationId = await this.sitesService.ownerOf(siteId);
    const body = AdminActivateTlsVersionRequestSchema.parse(raw ?? {});
    const result = await this.certificates.activateVersion({
      scope: { organizationId, siteId },
      actor: this.#actor(auth),
      certificateId,
      versionId,
      idempotencyKey,
      body,
      audit: this.#audit(auth, req, organizationId),
      // A server administrator manages every site; the other site must still belong to the same organisation.
      authorizeSite: async (otherSiteId) => {
        if ((await this.sitesService.ownerOf(otherSiteId)) !== organizationId) {
          throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
        }
      },
    });
    if (result.queued) this.outboxWorker.triggerAsync();
    return { data: result.data, moved: result.moved };
  }

  @Post("domains/:domainId/tls")
  @HttpCode(HttpStatus.ACCEPTED)
  public async setDomainTls(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await requireServerAdmin(this.authz, req, siteId, "site");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const organizationId = await this.sitesService.ownerOf(siteId);
    const body = AdminSetDomainTlsRequestSchema.parse(raw ?? {});
    const result = await this.certificates.setDomainTls({
      scope: { organizationId, siteId },
      actor: this.#actor(auth),
      domainId,
      idempotencyKey,
      body,
      audit: this.#audit(auth, req, organizationId),
    });
    if (result.queued) this.outboxWorker.triggerAsync();
    return { data: result.data };
  }

  #actor(auth: Auth): TlsActor {
    // An administrator is not subject to the customers' hourly cap.
    return { userId: auth.user.id, capped: false };
  }

  #audit(auth: Auth, req: FastifyRequest, organizationId: string): TlsAuditFn {
    return (event) => this.authz.recordAudit(auth, req, { organizationId, ...event });
  }
}
