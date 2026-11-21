import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import {
  AdminRestoreBackupInputSchema,
  CreateSiteBackupInputSchema,
  isBackupAvailable,
  type AdminSiteBackupStatusDto,
  type BackupSettingsDto,
  type BackupTestResultDto,
  type SiteBackupAcceptedDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { BackupSettingsService } from "../backups/backup-settings.service.js";
import { SiteBackupsService } from "../backups/site-backups.service.js";
import { SiteRestoreService } from "../backups/site-restore.service.js";
import { ControlPlaneError, requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import { ManagedSitesService } from "../sites/managed-sites.service.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";

const TARGET = "backups";

const headersOf = (req: FastifyRequest): Record<string, string | string[] | undefined> =>
  req.headers as Record<string, string | string[] | undefined>;

/** Platform administrator routes for encrypted S3 backup settings and on-demand site backups. */
@Controller("v1/admin/backups")
export class AdminBackupsController {
  public constructor(
    @Inject(BackupSettingsService) private readonly backupSettings: BackupSettingsService,
    @Inject(SiteBackupsService) private readonly siteBackups: SiteBackupsService,
    @Inject(SiteRestoreService) private readonly siteRestore: SiteRestoreService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Returns platform backup configuration and runtime availability. */
  @Get()
  public async get(@Req() req: FastifyRequest): Promise<{ data: BackupSettingsDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.backupSettings.get() };
  }

  /** Saves encrypted backup storage settings and schedule policy. */
  @Patch()
  public async save(
    @Req() req: FastifyRequest,
    @Body() raw: unknown,
  ): Promise<{ data: BackupSettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.backupSettings.save(raw, auth.user.id) };
  }

  /** Clears backup settings and removes stale backup records. */
  @Delete()
  public async clear(@Req() req: FastifyRequest): Promise<{ data: BackupSettingsDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.backupSettings.clear(auth.user.id) };
  }

  /** Runs a connectivity test against the stored backup target. */
  @Post("test")
  @HttpCode(HttpStatus.OK)
  public async test(@Req() req: FastifyRequest): Promise<{ data: BackupTestResultDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.backupSettings.test(auth.user.id) };
  }

  /** Lists per-site backup status across all existing sites. */
  @Get("sites")
  public async listSites(@Req() req: FastifyRequest): Promise<{ data: AdminSiteBackupStatusDto[] }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.backupSettings.listSites() };
  }

  /** Queues an immediate manual backup for an existing site under admin authority. */
  @Post("sites/:siteId/run")
  @HttpCode(HttpStatus.ACCEPTED)
  public async runSiteBackup(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<{ data: SiteBackupAcceptedDto; links: { operation: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Backups are only available on the linux-systemd runtime backend",
      );
    }

    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const input = CreateSiteBackupInputSchema.parse(rawBody === undefined ? {} : rawBody);

    const orgId = await this.sitesService.ownerOf(siteId);
    const site = await this.sitesService.get(siteId, orgId);
    const data = await this.siteBackups.create(
      site,
      { auth, req, actionPrefix: "admin.site.backups" },
      idempotencyKey,
      input,
    );
    this.outboxWorker.triggerAsync();

    return {
      data,
      links: {
        operation: `/v1/organizations/${site.organizationId}/operations/${data.operationId}`,
      },
    };
  }

  /** Queues a restore of a site's named or newest succeeded copy, also where nothing of the site exists. */
  @Post("sites/:siteId/restore")
  @HttpCode(HttpStatus.ACCEPTED)
  public async restoreSiteBackup(
    @Req() req: FastifyRequest,
    @Param("siteId") siteId: string,
    @Body() rawBody?: unknown,
  ): Promise<{ data: SiteBackupAcceptedDto; links: { operation: string } }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Backups are only available on the linux-systemd runtime backend",
      );
    }

    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const input = AdminRestoreBackupInputSchema.parse(rawBody === undefined ? {} : rawBody);

    const orgId = await this.sitesService.ownerOf(siteId);
    const site = await this.sitesService.get(siteId, orgId);
    const data = await this.siteRestore.restoreAsAdmin(
      site,
      { auth, req, actionPrefix: "admin.site.backups" },
      input,
      idempotencyKey,
    );
    this.outboxWorker.triggerAsync();

    return {
      data,
      links: {
        operation: `/v1/organizations/${site.organizationId}/operations/${data.operationId}`,
      },
    };
  }
}
