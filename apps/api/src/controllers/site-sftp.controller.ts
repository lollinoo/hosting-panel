import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import {
  CreateSiteSftpUserRequestSchema,
  type ManagedSiteDto,
  type SiteSftpDto,
  type SiteSftpPasswordResetDto,
  type SiteSftpUserCreatedDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { SiteSftpService } from "../sites/site-sftp.service.js";

type Auth = Awaited<ReturnType<AuthzContextService["authenticateRequest"]>>;

/** Customer SFTP account management endpoints scoped to a managed site. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId")
export class SiteSftpController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteSftpService) private readonly sftpService: SiteSftpService,
  ) {}

  /** GET /v1/organizations/:orgId/managed-sites/:siteId/sftp */
  @Get("sftp")
  @HttpCode(HttpStatus.OK)
  public async getSftp(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ readonly data: SiteSftpDto }> {
    const { site } = await this.#authorize(req, orgId, siteId);
    const data = await this.sftpService.get(site);
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/sftp/users */
  @Post("sftp/users")
  @HttpCode(HttpStatus.CREATED)
  public async createUser(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteSftpUserCreatedDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const body = CreateSiteSftpUserRequestSchema.parse(rawBody ?? {});
    const data = await this.sftpService.createUser(site, body.name);
    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: "site.sftp.user.create",
      targetType: "site",
      targetId: site.id,
      details: { userId: data.user.id, username: data.user.username },
    });
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/sftp/users/:userId/reset-password */
  @Post("sftp/users/:userId/reset-password")
  @HttpCode(HttpStatus.OK)
  public async resetPassword(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("userId") userId: string,
  ): Promise<{ readonly data: SiteSftpPasswordResetDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const { temporaryPassword, username } = await this.sftpService.resetPassword(site, userId);
    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: "site.sftp.user.password_reset",
      targetType: "site",
      targetId: site.id,
      details: { userId, username },
    });
    return { data: { temporaryPassword } };
  }

  /** DELETE /v1/organizations/:orgId/managed-sites/:siteId/sftp/users/:userId */
  @Delete("sftp/users/:userId")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteUser(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("userId") userId: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const { username } = await this.sftpService.deleteUser(site, userId);
    await this.authzService.recordAudit(auth, req, {
      organizationId: orgId,
      action: "site.sftp.user.delete",
      targetType: "site",
      targetId: site.id,
      details: { userId, username },
    });
  }

  /** Resolves site before permission check so foreign sites return 404 without leaking existence. */
  async #authorize(
    req: FastifyRequest,
    orgId: string,
    siteId: string,
  ): Promise<{ readonly auth: Auth; readonly site: ManagedSiteDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.sftp.manage",
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return { auth, site };
  }
}
