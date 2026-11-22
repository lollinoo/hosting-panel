import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import {
  APP_STACK_LOG_TAIL_DEFAULT,
  AppStackActionInputSchema,
  AppStackListQuerySchema,
  AppStackLogsQuerySchema,
  CreateAppStackInputSchema,
  DeleteAppStackInputSchema,
  DeployAppStackInputSchema,
  SetAppStackSecretInputSchema,
  type AppStackAcceptedEnvelope,
  type AppStackComponentHealthDto,
  type AppStackComponentLogsDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackSecretStateDto,
  type AppStackSummaryDto,
  type CursorPage,
  type PermissionKey,
  type ReadMeta,
} from "@hosting-panel/contracts";
import type { AppStackRow, AppStackWriteResult } from "@hosting-panel/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { appStackAcceptedEnvelope } from "../app-stacks/app-stack-dto.js";
import { AppStacksService, type AppStackRequestContext } from "../app-stacks/app-stacks.service.js";
import { appRefusal } from "../app-templates/app-template-errors.js";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { parsePaginationQuery, requireIdempotencyKey, resolveRequestId, type PaginationParams } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";

type RawQuery = Record<string, unknown> | undefined;
type Listed<T> = { data: T[]; meta: ReadMeta; page: CursorPage };
const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/**
 * Customer application stacks (ADR-0035). Order on every route: authentication → organisation permission (a non-member
 * gets 404, a member without the key 403) → capability gate → Idempotency-Key (routes that queue work) → stack lookup
 * (a foreign, missing or deleted stack is 404) → body. Routes that queue work answer 202 with `links.operation`.
 */
@Controller("v1/organizations/:orgId/app-stacks")
export class AppStacksController {
  public constructor(
    @Inject(AppStacksService) private readonly stacks: AppStacksService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
  ) {}

  /** 202 when the first deploy is queued, 201 for a draft (secrets are set before its first deploy). */
  @Post()
  public async create(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("orgId") orgId: string,
    @Body() raw: unknown,
  ): Promise<FastifyReply> {
    const auth = await this.#guard(req, orgId, "app.create", null);
    const ctx = this.#context(auth, req, orgId, requireIdempotencyKey(headersOf(req)));
    const r = await this.stacks.create(ctx, CreateAppStackInputSchema.parse(raw ?? {}));
    return reply.status(r.operation ? HttpStatus.ACCEPTED : HttpStatus.CREATED).send(this.#accepted(orgId, r));
  }

  @Get()
  public async list(@Req() req: FastifyRequest, @Param("orgId") orgId: string, @Query() rawQuery?: RawQuery): Promise<Listed<AppStackSummaryDto>> {
    await this.#guard(req, orgId, "app.read", null);
    return this.#listed(req, rawQuery, (page) => this.stacks.list(orgId, page));
  }

  @Get(":stackId")
  public async get(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
  ): Promise<{ data: AppStackDetailDto }> {
    const stack = await this.#read(req, orgId, stackId, "app.read");
    return { data: await this.stacks.detail(stack) };
  }

  /** Builds a new revision only when the plan or the given settings changed (a rotated secret changes the plan). */
  @Post(":stackId/deploy")
  @HttpCode(HttpStatus.ACCEPTED)
  public deploy(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Body() raw: unknown,
  ): Promise<AppStackAcceptedEnvelope> {
    return this.#queue(req, orgId, stackId, "app.control", (ctx, stack) =>
      this.stacks.deploy(ctx, stack, DeployAppStackInputSchema.parse(raw ?? {})),
    );
  }

  @Post(":stackId/start")
  @HttpCode(HttpStatus.ACCEPTED)
  public start(@Req() req: FastifyRequest, @Param("orgId") orgId: string, @Param("stackId") stackId: string, @Body() raw: unknown) {
    return this.#act(req, orgId, stackId, raw, "stack.start");
  }

  @Post(":stackId/stop")
  @HttpCode(HttpStatus.ACCEPTED)
  public stop(@Req() req: FastifyRequest, @Param("orgId") orgId: string, @Param("stackId") stackId: string, @Body() raw: unknown) {
    return this.#act(req, orgId, stackId, raw, "stack.stop");
  }

  @Post(":stackId/restart")
  @HttpCode(HttpStatus.ACCEPTED)
  public restart(@Req() req: FastifyRequest, @Param("orgId") orgId: string, @Param("stackId") stackId: string, @Body() raw: unknown) {
    return this.#act(req, orgId, stackId, raw, "stack.restart");
  }

  /** The name must be typed exactly; volumes are kept unless `destroyData` is true. */
  @Delete(":stackId")
  @HttpCode(HttpStatus.ACCEPTED)
  public remove(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Body() raw: unknown,
  ): Promise<AppStackAcceptedEnvelope> {
    return this.#queue(req, orgId, stackId, "app.delete", (ctx, stack) =>
      this.stacks.remove(ctx, stack, DeleteAppStackInputSchema.parse(raw ?? {})),
    );
  }

  @Get(":stackId/deployments")
  public async deployments(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Query() rawQuery?: RawQuery,
  ): Promise<Listed<AppStackDeploymentDto>> {
    const stack = await this.#read(req, orgId, stackId, "app.read");
    return this.#listed(req, rawQuery, (page) => this.stacks.deployments(stack, page));
  }

  @Get(":stackId/components/:componentKey/logs")
  public async logs(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("componentKey") componentKey: string,
    @Query() rawQuery?: RawQuery,
  ): Promise<{ data: AppStackComponentLogsDto }> {
    const stack = await this.#read(req, orgId, stackId, "app.read");
    const { tail } = AppStackLogsQuerySchema.parse(rawQuery ?? {});
    return { data: await this.stacks.logs(stack, componentKey, tail ?? APP_STACK_LOG_TAIL_DEFAULT) };
  }

  @Get(":stackId/components/:componentKey/health")
  public async health(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("componentKey") componentKey: string,
  ): Promise<{ data: AppStackComponentHealthDto }> {
    const stack = await this.#read(req, orgId, stackId, "app.read");
    return { data: await this.stacks.health(stack, componentKey) };
  }

  /** Write-only: the answer says that a value is set, never which. Queues nothing; the next deploy uses it. */
  @Post(":stackId/secrets")
  @HttpCode(HttpStatus.OK)
  public async setSecret(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackSecretStateDto }> {
    const auth = await this.#guard(req, orgId, "app.update", stackId);
    const stack = await this.stacks.require(orgId, stackId);
    const input = SetAppStackSecretInputSchema.parse(raw ?? {});
    return { data: await this.stacks.setSecret(this.#context(auth, req, orgId, ""), stack, input) };
  }

  /** Stack backups are out of scope (spec §19 B4): after the guard and the lookup, so a foreign id is still 404. */
  @Post(":stackId/backups")
  public async backup(@Req() req: FastifyRequest, @Param("orgId") orgId: string, @Param("stackId") stackId: string): Promise<never> {
    await this.#read(req, orgId, stackId, "app.control");
    const message = "Application backups are not available yet.";
    throw appRefusal("NOT_SUPPORTED", message, { message, reason: "STACK_UNSUPPORTED_FEATURE" });
  }

  #act(req: FastifyRequest, orgId: string, stackId: string, raw: unknown, kind: "stack.start" | "stack.stop" | "stack.restart") {
    return this.#queue(req, orgId, stackId, "app.control", (ctx, stack) => {
      AppStackActionInputSchema.parse(raw ?? {});
      return this.stacks.act(ctx, stack, kind);
    });
  }

  async #queue(
    req: FastifyRequest,
    orgId: string,
    stackId: string,
    permission: PermissionKey,
    run: (ctx: AppStackRequestContext, stack: AppStackRow) => Promise<AppStackWriteResult>,
  ): Promise<AppStackAcceptedEnvelope> {
    const auth = await this.#guard(req, orgId, permission, stackId);
    const ctx = this.#context(auth, req, orgId, requireIdempotencyKey(headersOf(req)));
    return this.#accepted(orgId, await run(ctx, await this.stacks.require(orgId, stackId)));
  }

  async #read(req: FastifyRequest, orgId: string, stackId: string, permission: PermissionKey): Promise<AppStackRow> {
    await this.#guard(req, orgId, permission, stackId);
    return this.stacks.require(orgId, stackId);
  }

  async #guard(req: FastifyRequest, orgId: string, permission: PermissionKey, stackId: string | null): Promise<AuthenticatedRequestContext> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, {
      organizationId: orgId,
      permission,
      targetType: "app_stack",
      ...(stackId === null ? {} : { targetId: stackId }),
    });
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return auth;
  }

  #context(auth: AuthenticatedRequestContext, req: FastifyRequest, orgId: string, idempotencyKey: string): AppStackRequestContext {
    return {
      organizationId: orgId,
      userId: auth.user.id,
      idempotencyKey,
      audit: (tx, event) => this.authz.recordAudit(auth, req, { organizationId: orgId, ...event }, tx),
    };
  }

  /** After commit: a replay or a draft queues nothing new. */
  #accepted(orgId: string, r: AppStackWriteResult): AppStackAcceptedEnvelope {
    if (!r.idempotentReplay && r.operation) this.outboxWorker.triggerAsync();
    return appStackAcceptedEnvelope(orgId, r);
  }

  async #listed<T>(
    req: FastifyRequest,
    rawQuery: RawQuery,
    load: (page: PaginationParams) => Promise<{ data: T[]; total: number; page: CursorPage }>,
  ): Promise<Listed<T>> {
    AppStackListQuerySchema.parse(rawQuery ?? {});
    const pagination = parsePaginationQuery(rawQuery);
    const { data, total, page } = await load(pagination);
    return {
      data,
      meta: { total, cursor: pagination.cursor ?? null, requestId: resolveRequestId(req), timestamp: new Date().toISOString() },
      page,
    };
  }
}
