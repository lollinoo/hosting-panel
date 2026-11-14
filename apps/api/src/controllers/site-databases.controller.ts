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
  Put,
  Req,
} from "@nestjs/common";
import {
  CreateSiteDatabaseRequestSchema,
  CreateSiteDatabaseUserRequestSchema,
  type ManagedSiteDto,
  type SiteDatabaseCreatedDto,
  type SiteDatabasePasswordResetDto,
  type SiteDatabasesDto,
  type SiteDatabaseSignOnDto,
  type SiteDatabaseUserCreatedDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { SiteDatabasesService } from "../sites/site-databases.service.js";

type Auth = Awaited<ReturnType<AuthzContextService["authenticateRequest"]>>;

/** Customer database, database user, grant, and phpMyAdmin sign-on routes scoped to a managed site. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId")
export class SiteDatabasesController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteDatabasesService) private readonly databasesService: SiteDatabasesService,
  ) {}

  /** GET /v1/organizations/:orgId/managed-sites/:siteId/databases */
  @Get("databases")
  @HttpCode(HttpStatus.OK)
  public async listDatabases(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ readonly data: SiteDatabasesDto }> {
    const { site } = await this.#authorize(req, orgId, siteId);
    const data = await this.databasesService.list(site);
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/databases */
  @Post("databases")
  @HttpCode(HttpStatus.CREATED)
  public async createDatabase(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteDatabaseCreatedDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const body = CreateSiteDatabaseRequestSchema.parse(rawBody ?? {});
    const data = await this.databasesService.createDatabase(site, { auth, req }, body.name);
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/databases/phpmyadmin */
  @Post("databases/phpmyadmin")
  @HttpCode(HttpStatus.OK)
  public async openPhpMyAdmin(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<{ readonly data: SiteDatabaseSignOnDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const data = await this.databasesService.phpMyAdminSignOn(site, { auth, req });
    return { data };
  }

  /** GET /v1/organizations/:orgId/managed-sites/:siteId/databases/phpmyadmin */
  @Get("databases/phpmyadmin")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async checkPhpMyAdminAccess(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<void> {
    const { site } = await this.#authorize(req, orgId, siteId);
    await this.databasesService.assertPhpMyAdminAccess(site);
  }

  /** DELETE /v1/organizations/:orgId/managed-sites/:siteId/databases/:name */
  @Delete("databases/:name")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteDatabase(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("name") name: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    await this.databasesService.deleteDatabase(site, { auth, req }, name);
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/database-users */
  @Post("database-users")
  @HttpCode(HttpStatus.CREATED)
  public async createUser(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteDatabaseUserCreatedDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const body = CreateSiteDatabaseUserRequestSchema.parse(rawBody ?? {});
    const data = await this.databasesService.createUser(site, { auth, req }, body.name);
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/database-users/:name/reset-password */
  @Post("database-users/:name/reset-password")
  @HttpCode(HttpStatus.OK)
  public async resetUserPassword(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("name") name: string,
  ): Promise<{ readonly data: SiteDatabasePasswordResetDto }> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const data = await this.databasesService.resetUserPassword(site, { auth, req }, name);
    return { data };
  }

  /** DELETE /v1/organizations/:orgId/managed-sites/:siteId/database-users/:name */
  @Delete("database-users/:name")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteUser(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("name") name: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    await this.databasesService.deleteUser(site, { auth, req }, name);
  }

  /** PUT /v1/organizations/:orgId/managed-sites/:siteId/database-users/:name/grants/:database */
  @Put("database-users/:name/grants/:database")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async grantAccess(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("name") name: string,
    @Param("database") database: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    await this.databasesService.grant(site, { auth, req }, name, database);
  }

  /** DELETE /v1/organizations/:orgId/managed-sites/:siteId/database-users/:name/grants/:database */
  @Delete("database-users/:name/grants/:database")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async revokeAccess(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("name") name: string,
    @Param("database") database: string,
  ): Promise<void> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    await this.databasesService.revoke(site, { auth, req }, name, database);
  }

  /** Resolves site before permission check so foreign sites answer 404 without leaking existence. */
  async #authorize(
    req: FastifyRequest,
    orgId: string,
    siteId: string,
  ): Promise<{ readonly auth: Auth; readonly site: ManagedSiteDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.databases.manage",
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return { auth, site };
  }
}
