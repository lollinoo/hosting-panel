import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import {
  AddSiteTemplateVersionInputSchema,
  CreateSiteTemplateInputSchema,
  UpdateSiteTemplateInputSchema,
  ValidateSiteTemplateInputSchema,
  type AdminSiteTemplateDetailDto,
  type AdminSiteTemplatesListDto,
  type AdminSiteTemplateVersionCreatedDto,
  type AdminSiteTemplateVersionDto,
  type SiteTemplateValidationDto,
} from "@hosting-panel/contracts";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import { requireServerAdmin } from "../auth/server-admin.guard.js";
import { SiteTemplatesService, type TemplateActor } from "../site-templates/site-templates.service.js";

const TARGET = "site_template";

/**
 * Platform administrator routes for the site type catalogue. `requireServerAdmin` runs first, before any body is
 * parsed, so a customer sending a malformed body still gets 403. The routes are synchronous: no Idempotency-Key.
 * Each write is audited inside its own transaction; the audit rows never carry the source or the spec.
 */
@Controller("v1/admin/site-templates")
export class AdminSiteTemplatesController {
  public constructor(
    @Inject(SiteTemplatesService) private readonly templates: SiteTemplatesService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
  ) {}

  @Get()
  public async list(@Req() req: FastifyRequest): Promise<{ data: AdminSiteTemplatesListDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: await this.templates.list() };
  }

  @Post("validate")
  @HttpCode(HttpStatus.OK)
  public async validate(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: SiteTemplateValidationDto }> {
    await requireServerAdmin(this.authz, req, null, TARGET);
    return { data: this.templates.validate(ValidateSiteTemplateInputSchema.parse(raw ?? {})) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<{ data: AdminSiteTemplateDetailDto }> {
    const auth = await requireServerAdmin(this.authz, req, null, TARGET);
    const input = CreateSiteTemplateInputSchema.parse(raw ?? {});
    return { data: await this.templates.create(input, this.#actor(auth, req)) };
  }

  @Get(":templateId")
  public async get(@Req() req: FastifyRequest, @Param("templateId") templateId: string): Promise<{ data: AdminSiteTemplateDetailDto }> {
    await requireServerAdmin(this.authz, req, templateId, TARGET);
    return { data: await this.templates.get(templateId) };
  }

  @Get(":templateId/versions/:versionId")
  public async getVersion(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Param("versionId") versionId: string,
  ): Promise<{ data: AdminSiteTemplateVersionDto }> {
    await requireServerAdmin(this.authz, req, templateId, TARGET);
    return { data: await this.templates.getVersion(templateId, versionId) };
  }

  @Post(":templateId/versions")
  @HttpCode(HttpStatus.CREATED)
  public async addVersion(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminSiteTemplateVersionCreatedDto }> {
    const auth = await requireServerAdmin(this.authz, req, templateId, TARGET);
    const input = AddSiteTemplateVersionInputSchema.parse(raw ?? {});
    return { data: await this.templates.addVersion(templateId, input, this.#actor(auth, req)) };
  }

  @Patch(":templateId")
  public async update(
    @Req() req: FastifyRequest,
    @Param("templateId") templateId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AdminSiteTemplateDetailDto }> {
    const auth = await requireServerAdmin(this.authz, req, templateId, TARGET);
    const input = UpdateSiteTemplateInputSchema.parse(raw ?? {});
    return { data: await this.templates.update(templateId, input, this.#actor(auth, req)) };
  }

  /** Archives (never deletes): existing sites keep their version. */
  @Delete(":templateId")
  public async archive(@Req() req: FastifyRequest, @Param("templateId") templateId: string): Promise<{ data: AdminSiteTemplateDetailDto }> {
    const auth = await requireServerAdmin(this.authz, req, templateId, TARGET);
    return { data: await this.templates.archive(templateId, this.#actor(auth, req)) };
  }

  #actor(auth: Awaited<ReturnType<typeof requireServerAdmin>>, req: FastifyRequest): TemplateActor {
    return {
      userId: auth.user.id,
      audit: (tx, event) => this.authz.recordAudit(auth, req, { organizationId: null, ...event }, tx),
    };
  }
}
