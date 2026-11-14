import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import {
  SiteFileArchiveRequestSchema,
  SiteFileDeleteRequestSchema,
  SiteFileExtractRequestSchema,
  SiteFileFolderRequestSchema,
  SiteFileListQuerySchema,
  SiteFileMoveRequestSchema,
  SiteFileReadQuerySchema,
  SiteFileWriteRequestSchema,
  type ManagedSiteDto,
  type SiteFileChunkDto,
  type SiteFileListDto,
  type SiteFileWriteResultDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  extractClientIp,
  extractRawHeader,
  requireIdempotencyKey,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";
import {
  ManagedSitesService,
  type ManagedSiteAccepted,
} from "../sites/managed-sites.service.js";
import {
  SiteFilesService,
  type SiteFilesActor,
} from "../sites/site-files.service.js";

interface AcceptedSiteFileEnvelope {
  readonly data: ManagedSiteAccepted;
  readonly links: { readonly operation: string };
}

const headersOf = (req: FastifyRequest) =>
  req.headers as Record<string, string | string[] | undefined>;

/**
 * Customer HTTP routes for browsing, editing, and archiving files in a managed site's webroot.
 * Enforces authentication, org-scoped site lookup, RBAC/ABAC checks, and suspension gates in strict order.
 */
@Controller("v1/organizations/:orgId/managed-sites/:siteId")
export class SiteFilesController {
  public constructor(
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
    @Inject(ManagedSitesService) private readonly sitesService: ManagedSitesService,
    @Inject(SiteFilesService) private readonly filesService: SiteFilesService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  /** GET /v1/organizations/:orgId/managed-sites/:siteId/files */
  @Get("files")
  @HttpCode(HttpStatus.OK)
  public async listFiles(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteFileListDto }> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.read");
    const query = SiteFileListQuerySchema.parse(rawQuery ?? {});
    const data = await this.filesService.list(site, actor, query);
    return { data };
  }

  /** GET /v1/organizations/:orgId/managed-sites/:siteId/files/content */
  @Get("files/content")
  @HttpCode(HttpStatus.OK)
  public async readFileContent(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteFileChunkDto }> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.read");
    const query = SiteFileReadQuerySchema.parse(rawQuery ?? {});
    const data = await this.filesService.read(site, actor, query);
    return { data };
  }

  /** PUT /v1/organizations/:orgId/managed-sites/:siteId/files/content */
  @Put("files/content")
  @HttpCode(HttpStatus.OK)
  public async writeFileContent(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<{ readonly data: SiteFileWriteResultDto }> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const body = SiteFileWriteRequestSchema.parse(rawBody ?? {});
    const data = await this.filesService.write(site, actor, body);
    return { data };
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/files/folders */
  @Post("files/folders")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async createFolder(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<void> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const body = SiteFileFolderRequestSchema.parse(rawBody ?? {});
    await this.filesService.mkdir(site, actor, body);
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/files/move */
  @Post("files/move")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async moveFiles(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<void> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const body = SiteFileMoveRequestSchema.parse(rawBody ?? {});
    await this.filesService.move(site, actor, body);
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/files/delete */
  @Post("files/delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async deleteFiles(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<void> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const body = SiteFileDeleteRequestSchema.parse(rawBody ?? {});
    await this.filesService.remove(site, actor, body);
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/files/archive */
  @Post("files/archive")
  @HttpCode(HttpStatus.ACCEPTED)
  public async archiveFiles(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<AcceptedSiteFileEnvelope> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = SiteFileArchiveRequestSchema.parse(rawBody ?? {});
    const accepted = await this.filesService.enqueueArchive(site, actor, {
      body,
      idempotencyKey,
    });
    return this.#accept(orgId, accepted);
  }

  /** POST /v1/organizations/:orgId/managed-sites/:siteId/files/extract */
  @Post("files/extract")
  @HttpCode(HttpStatus.ACCEPTED)
  public async extractFiles(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("siteId") siteId: string,
    @Body() rawBody?: Record<string, unknown>,
  ): Promise<AcceptedSiteFileEnvelope> {
    const { site, actor } = await this.#authorizeSite(req, orgId, siteId, "site.files.write");
    const idempotencyKey = requireIdempotencyKey(headersOf(req));
    const body = SiteFileExtractRequestSchema.parse(rawBody ?? {});
    const accepted = await this.filesService.enqueueExtract(site, actor, {
      body,
      idempotencyKey,
    });
    return this.#accept(orgId, accepted);
  }

  async #authorizeSite(
    req: FastifyRequest,
    orgId: string,
    siteId: string,
    permission: "site.files.read" | "site.files.write",
  ): Promise<{ readonly site: ManagedSiteDto; readonly actor: SiteFilesActor }> {
    const auth = await this.authzService.authenticateRequest(req);
    const site = await this.sitesService.get(siteId, orgId);
    await this.authzService.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission,
      targetType: "site",
      targetId: site.id,
      resource: { id: site.id, organizationId: site.organizationId },
    });

    const actor: SiteFilesActor = {
      id: auth.user.id,
      ipAddress: extractClientIp(req),
      userAgent: extractRawHeader(headersOf(req), "user-agent") ?? null,
      requestId: resolveRequestId(req),
    };
    return { site, actor };
  }

  #accept(orgId: string, accepted: ManagedSiteAccepted): AcceptedSiteFileEnvelope {
    this.outboxWorker.triggerAsync();
    return {
      data: accepted,
      links: {
        operation: `/v1/organizations/${orgId}/operations/${accepted.operationId}`,
      },
    };
  }
}
