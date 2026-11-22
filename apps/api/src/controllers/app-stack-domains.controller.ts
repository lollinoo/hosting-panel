import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Req } from "@nestjs/common";
import { AddAppStackDomainInputSchema, AppStackActionInputSchema, type AppStackDomainDto, type PermissionKey } from "@hosting-panel/contracts";
import type { AppStackRow } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppStackDomainsService } from "../app-stacks/app-stack-domains.service.js";
import { AppStacksService, type AppStackRequestContext } from "../app-stacks/app-stacks.service.js";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";

/**
 * Web addresses of a customer application stack. Synchronous like site domains: no Idempotency-Key, no operation.
 * Order: authentication → organisation permission → capability gate → stack lookup (foreign or missing: 404) → body.
 */
@Controller("v1/organizations/:orgId/app-stacks/:stackId/domains")
export class AppStackDomainsController {
  public constructor(
    @Inject(AppStackDomainsService) private readonly domains: AppStackDomainsService,
    @Inject(AppStacksService) private readonly stacks: AppStacksService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  @Get()
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
  ): Promise<{ data: AppStackDomainDto[] }> {
    const { stack } = await this.#require(req, orgId, stackId, "app.read");
    return { data: await this.domains.list(stack) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async add(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackDomainDto[] }> {
    const { auth, stack } = await this.#require(req, orgId, stackId, "app.update");
    const input = AddAppStackDomainInputSchema.parse(raw ?? {});
    return { data: await this.domains.add(this.#context(auth, req, orgId), stack, input) };
  }

  @Delete(":domainId")
  public async remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("domainId") domainId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackDomainDto[] }> {
    const { auth, stack } = await this.#require(req, orgId, stackId, "app.update");
    AppStackActionInputSchema.parse(raw ?? {});
    return { data: await this.domains.remove(this.#context(auth, req, orgId), stack, domainId) };
  }

  @Post(":domainId/check")
  @HttpCode(HttpStatus.OK)
  public async check(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("domainId") domainId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackDomainDto[] }> {
    const { stack } = await this.#require(req, orgId, stackId, "app.read");
    AppStackActionInputSchema.parse(raw ?? {});
    return { data: await this.domains.check(stack, domainId) };
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
