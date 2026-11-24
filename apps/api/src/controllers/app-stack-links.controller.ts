import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import { AppStackActionInputSchema, CreateAppStackLinkInputSchema, type AppStackLinksDto, type PermissionKey } from "@hosting-panel/contracts";
import type { AppStackRow } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppStackLinksService } from "../app-stacks/app-stack-links.service.js";
import { AppStacksService, type AppStackRequestContext } from "../app-stacks/app-stacks.service.js";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";

/**
 * Private links between a database and an application of the same customer (ADR-0039). Synchronous like the web
 * addresses: no Idempotency-Key, no operation. A link is created from the application; either side can remove it.
 * Order: authentication → organisation permission → capability gate → stack lookup (foreign or missing: 404) → body.
 */
@Controller("v1/organizations/:orgId/app-stacks/:stackId/links")
export class AppStackLinksController {
  public constructor(
    @Inject(AppStackLinksService) private readonly links: AppStackLinksService,
    @Inject(AppStacksService) private readonly stacks: AppStacksService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  @Get()
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
  ): Promise<{ data: AppStackLinksDto }> {
    const { stack } = await this.#require(req, orgId, stackId, "app.read");
    return { data: await this.links.list(stack) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async create(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackLinksDto }> {
    const { auth, stack } = await this.#require(req, orgId, stackId, "app.update");
    const input = CreateAppStackLinkInputSchema.parse(raw ?? {});
    return { data: await this.links.create(this.#context(auth, req, orgId), stack, input) };
  }

  @Delete(":linkId")
  public async remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("linkId") linkId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackLinksDto }> {
    const { auth, stack } = await this.#require(req, orgId, stackId, "app.update");
    AppStackActionInputSchema.parse(raw ?? {});
    return { data: await this.links.remove(this.#context(auth, req, orgId), stack, linkId) };
  }

  async #require(
    req: FastifyRequest,
    orgId: string,
    stackId: string,
    permission: PermissionKey,
  ): Promise<{ auth: AuthenticatedRequestContext; stack: AppStackRow }> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, { organizationId: orgId, permission, targetType: "app_stack", targetId: stackId });
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return { auth, stack: await this.stacks.require(orgId, stackId) };
  }

  #context(auth: AuthenticatedRequestContext, req: FastifyRequest, orgId: string): AppStackRequestContext {
    return {
      organizationId: orgId,
      userId: auth.user.id,
      idempotencyKey: "",
      audit: (tx, event) => this.authz.recordAudit(auth, req, { organizationId: orgId, ...event }, tx),
    };
  }
}
