import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import {
  AddAppTemplateVersionInputSchema,
  AdminAppTemplateListQuerySchema,
  ArchiveAppTemplateInputSchema,
  CreateAppTemplateInputSchema,
  ImportComposeInputSchema,
  UpdateAppTemplateInputSchema,
  ValidateAppTemplateInputSchema,
  type AdminAppTemplateDetailDto,
  type AdminAppTemplateSummaryDto,
  type AdminAppTemplateUsageDto,
  type AdminAppTemplateVersionCreatedDto,
  type AdminAppTemplateVersionDto,
  type AppTemplateValidationDto,
  type ComposeImportDto,
  type CursorPage,
  type ReadMeta,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppTemplatesService, type AppTemplateActor } from "../app-templates/app-templates.service.js";
import { ComposeImportService } from "../app-templates/compose-import.service.js";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { parsePaginationQuery, resolveRequestId } from "../common/control-plane.error.js";

const TARGET = "app_template";
/** The admin page reads only the first page, so it holds the whole catalogue in practice. */
const LIST_DEFAULT_LIMIT = 100;

/**
 * Server administrator catalogue of application templates (ADR-0035). `requireServerAdmin` runs before the capability
 * gate and before any body or query is parsed, so a customer sending a malformed body still gets 403. The routes are
 * synchronous: no Idempotency-Key. Each write is audited in its own transaction, never with the source or the spec.
 * `validate` and `import-compose` store nothing and are not audited.
 */
@Controller("v1/admin/app-templates")
export class AdminAppTemplatesController {
  public constructor(
    @Inject(AppTemplatesService) private readonly templates: AppTemplatesService,
    @Inject(ComposeImportService) private readonly imports: ComposeImportService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  @Get()
  public async list(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{ data: AdminAppTemplateSummaryDto[]; meta: ReadMeta; page: CursorPage }> {
    await this.#admin(req, null);
    const query = AdminAppTemplateListQuerySchema.parse(rawQuery ?? {});
    const pagination = parsePaginationQuery({ limit: LIST_DEFAULT_LIMIT, ...rawQuery });
    const { data, total, page } = await this.templates.list(query, pagination);
    return {
      data,
      meta: { total, cursor: pagination.cursor ?? null, requestId: resolveRequestId(req), timestamp: new Date().toISOString() },
      page,
    };
  }

  @Post("validate")
  @HttpCode(HttpStatus.OK)
  public async validate(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: AppTemplateValidationDto }> {
    await this.#admin(req, null);
    return { data: this.templates.validate(ValidateAppTemplateInputSchema.parse(raw ?? {})) };
  }

  /**
   * A Docker Compose file read into a draft template, with the report of what the importer changed, dropped or refused
   * (ADR-0036 §2.8). The only route here that waits for the Docker Engine: it asks the digest of each image the file
   * names without one. The file may carry secrets written in the clear: neither it nor the draft is stored or logged.
   */
  @Post("import-compose")
  @HttpCode(HttpStatus.OK)
  public async importCompose(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: ComposeImportDto }> {
    await this.#admin(req, null);
    return { data: await this.imports.importCompose(ImportComposeInputSchema.parse(raw ?? {})) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: AdminAppTemplateDetailDto }> {
    const actor = await this.#admin(req, null);
    return { data: await this.templates.create(CreateAppTemplateInputSchema.parse(raw ?? {}), actor) };
  }

  @Get(":templateId")
  public async get(@Req() req: FastifyRequest, @Param("templateId") templateId: string): Promise<{ data: AdminAppTemplateDetailDto }> {
    await this.#admin(req, templateId);
    return { data: await this.templates.get(templateId) };
  }

  @Patch(":templateId")
  public async update(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminAppTemplateDetailDto }> {
    const actor = await this.#admin(req, templateId);
    return { data: await this.templates.update(templateId, UpdateAppTemplateInputSchema.parse(raw ?? {}), actor) };
  }

  @Post(":templateId/versions")
  @HttpCode(HttpStatus.CREATED)
  public async addVersion(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminAppTemplateVersionCreatedDto }> {
    const actor = await this.#admin(req, templateId);
    return { data: await this.templates.addVersion(templateId, AddAppTemplateVersionInputSchema.parse(raw ?? {}), actor) };
  }

  @Get(":templateId/versions/:versionId")
  public async getVersion(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
  ): Promise<{ data: AdminAppTemplateVersionDto }> {
    await this.#admin(req, templateId);
    return { data: await this.templates.getVersion(templateId, versionId) };
  }

  /** Archives (never deletes): existing stacks keep their version. */
  @Post(":templateId/archive")
  @HttpCode(HttpStatus.OK)
  public async archive(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminAppTemplateDetailDto }> {
    const actor = await this.#admin(req, templateId);
    ArchiveAppTemplateInputSchema.parse(raw ?? {});
    return { data: await this.templates.archive(templateId, actor) };
  }

  @Get(":templateId/usage")
  public async usage(@Req() req: FastifyRequest, @Param("templateId") templateId: string): Promise<{ data: AdminAppTemplateUsageDto }> {
    await this.#admin(req, templateId);
    return { data: await this.templates.usage(templateId) };
  }

  async #admin(req: FastifyRequest, templateId: string | null): Promise<AppTemplateActor> {
    const auth = await requireServerAdmin(this.authz, req, templateId, TARGET);
    requireAppFeature(this.gate, "applicationTemplatesAvailable");
    return {
      userId: auth.user.id,
      audit: (tx, event) => this.authz.recordAudit(auth, req, { organizationId: null, ...event }, tx),
    };
  }
}
