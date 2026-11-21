import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import {
  ActivateTlsVersionRequestSchema,
  CreateTlsCertificateVersionRequestSchema,
  ImportTlsCertificateRequestSchema,
  SetDomainTlsRequestSchema,
  type PermissionKey,
  type SiteDomainsDto,
  type TlsCertificateDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { TlsCertificatesService, type TlsActor, type TlsAuditFn, type TlsChangeResult } from "../certificates/tls-certificates.service.js";
import { requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";

type Auth = Awaited<ReturnType<AuthzContextService["authenticateRequest"]>>;

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/**
 * Imported TLS certificates of a site's organisation. Every route authenticates, finds the site inside the organisation
 * (404) and checks the permission before it reads the body; a certificate, version or domain of another organisation
 * is a 404 that names nothing.
 */
@Controller("v1/organizations/:orgId/managed-sites/:siteId")
export class SiteTlsCertificatesController {
  public constructor(
    @Inject(TlsCertificatesService) private readonly certificates: TlsCertificatesService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get("tls-certificates")
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ data: TlsCertificateDto[] }> {
    await this.#require(req, orgId, siteId, "site.read");
    return { data: await this.certificates.list(orgId) };
  }

  @Post("tls-certificates")
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() raw: unknown,
  ): Promise<{ data: TlsCertificateDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.certificates.manage");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = ImportTlsCertificateRequestSchema.parse(raw ?? {});
    return {
      data: await this.certificates.importCertificate({
        scope: { organizationId: orgId, siteId },
        actor: this.#actor(auth),
        idempotencyKey,
        body,
        audit: this.#audit(auth, req, orgId),
      }),
    };
  }

  @Get("tls-certificates/:certificateId")
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
  ): Promise<{ data: TlsCertificateDto }> {
    await this.#require(req, orgId, siteId, "site.read");
    return { data: await this.certificates.get(orgId, certificateId) };
  }

  @Delete("tls-certificates/:certificateId")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
  ): Promise<void> {
    const auth = await this.#require(req, orgId, siteId, "site.certificates.manage");
    await this.certificates.deleteCertificate({
      organizationId: orgId,
      certificateId,
      siteId,
      audit: this.#audit(auth, req, orgId),
    });
  }

  @Post("tls-certificates/:certificateId/versions")
  @HttpCode(HttpStatus.CREATED)
  public async addVersion(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: TlsCertificateDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.certificates.manage");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = CreateTlsCertificateVersionRequestSchema.parse(raw ?? {});
    return {
      data: await this.certificates.addVersion({
        scope: { organizationId: orgId, siteId },
        actor: this.#actor(auth),
        certificateId,
        idempotencyKey,
        body,
        audit: this.#audit(auth, req, orgId),
      }),
    };
  }

  @Post("tls-certificates/:certificateId/versions/:versionId/activate")
  @HttpCode(HttpStatus.ACCEPTED)
  public async activate(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("certificateId") certificateId: string,
    @Param("versionId") versionId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto; moved: TlsChangeResult["moved"] }> {
    const auth = await this.#require(req, orgId, siteId, "site.certificates.manage");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = ActivateTlsVersionRequestSchema.parse(raw ?? {});
    const result = await this.certificates.activateVersion({
      scope: { organizationId: orgId, siteId },
      actor: this.#actor(auth),
      certificateId,
      versionId,
      idempotencyKey,
      body,
      audit: this.#audit(auth, req, orgId),
      // Every other site the change reaches needs the same permission: 403 for the organisation's own site, 404 beyond.
      authorizeSite: async (otherSiteId) => void (await this.#require(req, orgId, otherSiteId, "site.certificates.manage")),
    });
    if (result.queued) this.outboxWorker.triggerAsync();
    return { data: result.data, moved: result.moved };
  }

  @Post("domains/:domainId/tls")
  @HttpCode(HttpStatus.ACCEPTED)
  public async setDomainTls(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("domainId") domainId: string,
    @Body() raw: unknown,
  ): Promise<{ data: SiteDomainsDto }> {
    const auth = await this.#require(req, orgId, siteId, "site.certificates.manage");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = SetDomainTlsRequestSchema.parse(raw ?? {});
    const result = await this.certificates.setDomainTls({
      scope: { organizationId: orgId, siteId },
      actor: this.#actor(auth),
      domainId,
      idempotencyKey,
      body,
      audit: this.#audit(auth, req, orgId),
    });
    if (result.queued) this.outboxWorker.triggerAsync();
    return { data: result.data };
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

  #actor(auth: Auth): TlsActor {
    return { userId: auth.user.id, capped: !(auth.principal.globalRoles ?? []).includes("infrastructure_admin") };
  }

  #audit(auth: Auth, req: FastifyRequest, organizationId: string): TlsAuditFn {
    return (event) => this.authzService.recordAudit(auth, req, { organizationId, ...event });
  }
}
