import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  CreateServiceTemplateInputSchema,
  type ReadMeta,
  type ServiceTemplateDto,
} from "@hosting-panel/contracts";
import {
  asc,
  serviceTemplates,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { AuthzContextService } from "../auth/authz-context.service.js";
import {
  paginateItems,
  parsePaginationQuery,
  resolveRequestId,
} from "../common/control-plane.error.js";
import { DATABASE_CLIENT_TOKEN } from "../tokens.js";

function mapTemplateToDto(tpl: typeof serviceTemplates.$inferSelect): ServiceTemplateDto {
  return {
    id: tpl.id,
    name: tpl.name,
    slug: tpl.slug,
    description: tpl.description ?? null,
    category: tpl.category,
    defaultImage: tpl.defaultImage,
    defaultPort: tpl.defaultPort ?? null,
    environmentSchema: (tpl.environmentSchema ?? {}) as Record<string, unknown>,
    defaultConfiguration: (tpl.defaultConfiguration ?? {}) as Record<string, unknown>,
    approvedForDedicated: tpl.approvedForDedicated,
    approvedForShared: tpl.approvedForShared,
    minCpuMilli: tpl.minCpuMilli,
    minMemoryBytes: tpl.minMemoryBytes,
    createdAt: tpl.createdAt instanceof Date ? tpl.createdAt.toISOString() : String(tpl.createdAt),
    updatedAt: tpl.updatedAt instanceof Date ? tpl.updatedAt.toISOString() : String(tpl.updatedAt),
  };
}

@Controller("v1/service-templates")
export class ServiceTemplatesController {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(AuthzContextService) private readonly authzService: AuthzContextService,
  ) {}

  @Get()
  public async getServiceTemplates(
    @Req() req: FastifyRequest,
    @Query() rawQuery?: Record<string, unknown>,
  ): Promise<{
    data: ServiceTemplateDto[];
    meta: ReadMeta;
    page: { nextCursor: string | null; hasMore: boolean };
  }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "template.read", "service_template");

    const pagination = parsePaginationQuery(rawQuery);
    const rows = await this.dbClient.db
      .select()
      .from(serviceTemplates)
      .orderBy(asc(serviceTemplates.name));

    const dtoList = rows.map(mapTemplateToDto);
    const paginated = paginateItems(dtoList, pagination);

    return {
      data: paginated.data,
      meta: {
        total: dtoList.length,
        cursor: pagination.cursor ?? null,
        requestId: resolveRequestId(req),
        timestamp: new Date().toISOString(),
      },
      page: paginated.page,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createServiceTemplate(
    @Req() req: FastifyRequest,
    @Body() rawBody: unknown,
  ): Promise<{ data: ServiceTemplateDto }> {
    const auth = await this.authzService.authenticateRequest(req);
    await this.authzService.requirePlatformPermission(auth, req, "template.manage", "service_template");

    const body = CreateServiceTemplateInputSchema.parse(rawBody ?? {});
    const templateId = `tpl_${body.slug.replace(/[^a-zA-Z0-9]/g, "_")}`;

    const [tpl] = await this.dbClient.db
      .insert(serviceTemplates)
      .values({
        id: templateId,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        category: body.category,
        defaultImage: body.defaultImage,
        defaultPort: body.defaultPort ?? null,
        environmentSchema: body.environmentSchema,
        defaultConfiguration: body.defaultConfiguration,
        approvedForDedicated: body.approvedForDedicated,
        approvedForShared: body.approvedForShared,
        minCpuMilli: body.minCpuMilli,
        minMemoryBytes: body.minMemoryBytes,
      })
      .returning();

    await this.authzService.recordAudit(auth, req, {
      action: "template.create",
      targetType: "service_template",
      targetId: templateId,
      details: { slug: body.slug, name: body.name },
    });

    return { data: mapTemplateToDto(tpl!) };
  }
}
