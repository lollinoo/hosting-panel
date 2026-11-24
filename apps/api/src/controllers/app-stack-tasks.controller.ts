import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Req } from "@nestjs/common";
import {
  AppStackKeySchema,
  RunAppStackTaskInputSchema,
  SetAppStackTaskScheduleInputSchema,
  type AppStackTaskRunAcceptedEnvelope,
  type AppStackTaskRunsDto,
  type AppStackTasksDto,
  type PermissionKey,
} from "@hosting-panel/contracts";
import type { AppStackRow } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { APP_FEATURE_GATE_TOKEN, requireAppFeature, type AppFeatureGate } from "../app-stacks/app-feature-gate.js";
import { AppStackTasksService } from "../app-stacks/app-stack-tasks.service.js";
import { AppStacksService, type AppStackRequestContext } from "../app-stacks/app-stacks.service.js";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { requireIdempotencyKey } from "../common/control-plane.error.js";
import { OutboxWorkerService } from "../runtime/outbox-worker.service.js";

const headersOf = (req: FastifyRequest) => req.headers as Record<string, string | string[] | undefined>;

/**
 * Tasks of a customer's application (ADR-0042): `app.read` sees them and their last runs, `app.control` runs one now and
 * chooses when it runs by itself. No route takes a command: a task is named by its key, in the path.
 * Order: authentication → organisation permission → capability gate → Idempotency-Key (the run) → stack lookup (foreign
 * or missing: 404) → body.
 */
@Controller("v1/organizations/:orgId/app-stacks/:stackId/tasks")
export class AppStackTasksController {
  public constructor(
    @Inject(AppStackTasksService) private readonly tasks: AppStackTasksService,
    @Inject(AppStacksService) private readonly stacks: AppStacksService,
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(APP_FEATURE_GATE_TOKEN) private readonly gate: AppFeatureGate,
    @Inject(OutboxWorkerService) private readonly outboxWorker: OutboxWorkerService,
  ) {}

  @Get()
  public async list(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
  ): Promise<{ data: AppStackTasksDto }> {
    const { stack } = await this.#require(req, orgId, stackId, "app.read");
    return { data: await this.tasks.list(stack) };
  }

  @Get(":taskKey/runs")
  public async runs(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("taskKey") taskKey: string,
  ): Promise<{ data: AppStackTaskRunsDto }> {
    const { stack } = await this.#require(req, orgId, stackId, "app.read");
    return { data: await this.tasks.runs(stack, AppStackKeySchema.parse(taskKey)) };
  }

  @Post(":taskKey/runs")
  @HttpCode(HttpStatus.ACCEPTED)
  public async run(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("taskKey") taskKey: string,
    @Body() raw: unknown,
  ): Promise<AppStackTaskRunAcceptedEnvelope> {
    const auth = await this.#guard(req, orgId, stackId, "app.control");
    const ctx = this.#context(auth, req, orgId, requireIdempotencyKey(headersOf(req)));
    const stack = await this.stacks.require(orgId, stackId);
    const key = AppStackKeySchema.parse(taskKey);
    RunAppStackTaskInputSchema.parse(raw ?? {});
    const accepted = await this.tasks.run(ctx, stack, key);
    // After commit: a replay queues nothing new.
    if (!accepted.idempotentReplay) this.outboxWorker.triggerAsync();
    return {
      data: { runId: accepted.run.id, operationId: accepted.operationId, status: accepted.run.status },
      links: {
        runs: `/v1/organizations/${orgId}/app-stacks/${stack.id}/tasks/${key}/runs`,
        operation: `/v1/organizations/${orgId}/operations/${accepted.operationId}`,
      },
    };
  }

  @Put(":taskKey/schedule")
  public async schedule(
    @Req() req: FastifyRequest,
    @Param("orgId") orgId: string,
    @Param("stackId") stackId: string,
    @Param("taskKey") taskKey: string,
    @Body() raw: unknown,
  ): Promise<{ data: AppStackTasksDto }> {
    const { auth, stack } = await this.#require(req, orgId, stackId, "app.control");
    const key = AppStackKeySchema.parse(taskKey);
    const input = SetAppStackTaskScheduleInputSchema.parse(raw ?? {});
    return { data: await this.tasks.setSchedule(this.#context(auth, req, orgId, ""), stack, key, input) };
  }

  async #guard(req: FastifyRequest, orgId: string, stackId: string, permission: PermissionKey): Promise<AuthenticatedRequestContext> {
    const auth = await this.authz.authenticateRequest(req);
    await this.authz.requireOrgPermission(auth, req, { organizationId: orgId, permission, targetType: "app_stack", targetId: stackId });
    requireAppFeature(this.gate, "applicationStacksAvailable");
    return auth;
  }

  async #require(
    req: FastifyRequest,
    orgId: string,
    stackId: string,
    permission: PermissionKey,
  ): Promise<{ auth: AuthenticatedRequestContext; stack: AppStackRow }> {
    const auth = await this.#guard(req, orgId, stackId, permission);
    return { auth, stack: await this.stacks.require(orgId, stackId) };
  }

  #context(auth: AuthenticatedRequestContext, req: FastifyRequest, orgId: string, idempotencyKey: string): AppStackRequestContext {
    return {
      organizationId: orgId,
      userId: auth.user.id,
      idempotencyKey,
      audit: (tx, event) => this.authz.recordAudit(auth, req, { organizationId: orgId, ...event }, tx),
    };
  }
}
