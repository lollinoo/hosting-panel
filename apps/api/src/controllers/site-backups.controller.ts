import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  RestoreBackupInputSchema,
  SiteFileReadQuerySchema,
  type BackupArchiveChunkDto,
  type ManagedSiteDto,
  type SiteBackupAcceptedDto,
  type SiteBackupsDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { SiteBackupsService } from "../backups/site-backups.service.js";
import { SiteRestoreService } from "../backups/site-restore.service.js";
import { ControlPlaneError, requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";

const EmptyBackupBodySchema = z.object({}).strict();
const BackupArchiveReadQuerySchema = SiteFileReadQuerySchema.omit({ path: true });

const headersOf = (req: FastifyRequest): Record<string, string | string[] | undefined> =>
  req.headers as Record<string, string | string[] | undefined>;

interface SiteBackupsListEnvelope {
  readonly data: SiteBackupsDto;
}

interface SiteBackupAcceptedEnvelope {
  readonly data: SiteBackupAcceptedDto;
  readonly links: { readonly operation: string };
}

interface BackupArchiveChunkEnvelope {
  readonly data: BackupArchiveChunkDto;
}

/** Customer routes for listing, queuing, restoring, and downloading encrypted backups on a managed site. */
@Controller("v1/organizations/:orgId/managed-sites/:siteId")
export class SiteBackupsController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteBackupsService) private readonly backupsService: SiteBackupsService,
    @Inject(SiteRestoreService) private readonly restoreService: SiteRestoreService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get("backups")
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
  ): Promise<SiteBackupsListEnvelope> {
    const { site } = await this.#authorize(req, orgId, siteId);
    const data = await this.backupsService.list(site);
    return { data };
  }

  @Post("backups")
  @HttpCode(202)
  public async create(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<SiteBackupAcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    EmptyBackupBodySchema.parse(rawBody === undefined ? {} : rawBody);

    const data = await this.backupsService.create(site, { auth, req }, idempotencyKey);
    this.outboxWorker.triggerAsync();

    return this.#accepted(orgId, data);
  }

  @Post("backups/:backupId/restore")
  @HttpCode(202)
  public async restore(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("backupId") backupId: string,
    @Body() rawBody?: unknown,
  ): Promise<SiteBackupAcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const input = RestoreBackupInputSchema.parse(rawBody === undefined ? {} : rawBody);

    const data = await this.restoreService.restore(site, { auth, req }, backupId, input, idempotencyKey);
    this.outboxWorker.triggerAsync();

    return this.#accepted(orgId, data);
  }

  @Post("backups/:backupId/download")
  @HttpCode(202)
  public async prepareDownload(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("backupId") backupId: string,
    @Body() rawBody?: unknown,
  ): Promise<SiteBackupAcceptedEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    EmptyBackupBodySchema.parse(rawBody === undefined ? {} : rawBody);

    const data = await this.restoreService.prepareDownload(site, { auth, req }, backupId, idempotencyKey);
    this.outboxWorker.triggerAsync();

    return this.#accepted(orgId, data);
  }

  @Get("backups/:backupId/download")
  @HttpCode(200)
  public async readArchive(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Param("backupId") backupId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<BackupArchiveChunkEnvelope> {
    const { auth, site } = await this.#authorize(req, orgId, siteId);
    const query = BackupArchiveReadQuerySchema.parse(rawQuery ?? {});
    const data = await this.restoreService.readArchive(site, { auth, req }, backupId, query);
    return { data };
  }

  #accepted(orgId: string, data: SiteBackupAcceptedDto): SiteBackupAcceptedEnvelope {
    return {
      data,
      links: {
        operation: `/v1/organizations/${orgId}/operations/${data.operationId}`,
      },
    };
  }

  async #authorize(
    req: FastifyRequest,
    orgId: string,
    siteId: string,
  ): Promise<{ readonly auth: AuthenticatedRequestContext; readonly site: ManagedSiteDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    if (!site.siteType) {
      throw new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.");
    }
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission: "site.backups.manage",
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });
    return { auth, site };
  }
}
