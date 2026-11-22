import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  APP_STACK_HEALTH_STALE_AFTER_MS,
  AppTemplateSpecSchema,
  ApprovedStackPlanSchema,
  appStackLockKey,
  effectiveComponentHealth,
  redactSensitiveString,
  resolveAppTemplateParameters,
  type AppStackComponentHealthDto,
  type AppStackComponentLogsDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackOperationKind,
  type AppStackSecretStateDto,
  type AppStackSummaryDto,
  type AppTemplateSpec,
  type ApprovedStackPlan,
  type CreateAppStackInput,
  type CursorPage,
  type DeleteAppStackInput,
  type DeployAppStackInput,
  type SetAppStackSecretInput,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  addAppStackDomainsTransactional,
  and,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appTemplates,
  appTemplateVersions,
  countAppStacksByOrganization,
  createAppStackTransactional,
  enqueueAppStackOperationTransactional,
  eq,
  findAppStackAllocation,
  getAppStack,
  getAppStackDeployment,
  getAppStackRevision,
  getAppTemplateVersion,
  getPublishedAppTemplateVersion,
  inArray,
  listAppStackComponents,
  listAppStackDeployments,
  listAppStackDomains,
  listAppStackParameters,
  listAppStackRevisions,
  listAppStacks,
  listAppStackSecretMetadata,
  listAppStackVolumes,
  newAppEntityId,
  operations,
  setAppStackSecretTransactional,
  sql,
  type AppStackRevisionRow,
  type AppStackRow,
  type AppStackWriteResult,
  type AppTemplateVersionRow,
  type DatabaseClient,
  type DatabaseExecutor,
  type HostingPanelDatabase,
  type NewAppStackRevision,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appNotFound, appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { ControlPlaneError, type PaginationParams } from "../common/control-plane.error.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { LogReadGate } from "../sites/log-read-gate.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import {
  compileRevision,
  domainTargetsMissing,
  entriesOf,
  parameterValuesOf,
  sameEntries,
  secretVersionsOf,
  validatedSpec,
} from "./app-stack-compile.js";
import { appStackDeploymentDto, appStackDetailDto, appStackSummaryDto } from "./app-stack-dto.js";
import { customerIssuesError, mapAppStackError } from "./app-stack-errors.js";
import { readAppStackComponentLogs } from "./app-stack-logs.js";

export interface AppStackRequestContext {
  readonly organizationId: string;
  readonly userId: string;
  /** "" for routes that queue nothing. */
  readonly idempotencyKey: string;
  readonly audit: (
    tx: DatabaseExecutor,
    event: { readonly action: string; readonly targetType: "app_stack"; readonly targetId: string; readonly details: Record<string, unknown> },
  ) => Promise<void>;
}

type Paged<T> = { data: T[]; total: number; page: CursorPage };
const EMPTY_PAGE: CursorPage = { nextCursor: null, hasMore: false };
const ACTIONS: Readonly<Record<AppStackOperationKind, string>> = {
  "stack.deploy": APP_AUDIT_ACTIONS.stackDeploy,
  "stack.start": APP_AUDIT_ACTIONS.stackStart,
  "stack.stop": APP_AUDIT_ACTIONS.stackStop,
  "stack.restart": APP_AUDIT_ACTIONS.stackRestart,
  "stack.upgrade": APP_AUDIT_ACTIONS.stackUpgrade,
  "stack.rollback": APP_AUDIT_ACTIONS.stackRollback,
  "stack.delete": APP_AUDIT_ACTIONS.stackDelete,
};

const damaged = (message: string) => new ControlPlaneError("INTERNAL_ERROR", message);
function refusal(field: string, reason: string, message: string): ControlPlaneError {
  return appRefusal("VALIDATION_ERROR", message, { field, message, reason });
}
function statusLocked(status: string): ControlPlaneError {
  const message = `This action is not possible while the application is ${status}.`;
  return appRefusal("RESOURCE_LOCKED", message, { field: "status", message, reason: status }, false);
}

/** Customer application stacks (ADR-0035): validation and compile before the request transaction, never Docker in it. */
@Injectable()
export class AppStacksService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN) private readonly validation: AppTemplateValidationOptions,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly executor: DockerExecutorPort,
    @Inject(LogReadGate) private readonly logReads: LogReadGate,
  ) {}

  public async require(organizationId: string, stackId: string): Promise<AppStackRow> {
    const stack = await getAppStack(this.dbClient.db, { organizationId, stackId });
    if (!stack) throw appNotFound();
    return stack;
  }

  public async create(ctx: AppStackRequestContext, input: CreateAppStackInput): Promise<AppStackWriteResult> {
    const { organizationId } = ctx;
    const db = this.dbClient.db;
    const requestHash = canonicalRequestHash({ route: APP_AUDIT_ACTIONS.stackCreate, organizationId, stackId: null, body: input });
    const allocation = await findAppStackAllocation(db, organizationId);
    if (!allocation) {
      const message = "Applications need a dedicated server. Ask your administrator.";
      throw appRefusal("NOT_SUPPORTED", message, { message, reason: "STACK_UNSUPPORTED_FEATURE" });
    }
    const published = await getPublishedAppTemplateVersion(db, { templateVersionId: input.templateVersionId, lock: false });
    if (!published) {
      throw refusal("templateVersionId", "STACK_TEMPLATE_UNPUBLISHED", "This version can no longer be installed. Choose the current version.");
    }
    const { source } = published.version;
    const spec = validatedSpec(source, this.validation);
    input.domains.forEach((d, i) => {
      if (!spec.ingress.some((route) => route.service === d.componentKey && route.port === d.port)) {
        throw refusal(`domains.${String(i)}.componentKey`, "unknown_ingress", "This web address cannot point at that part of the application.");
      }
    });
    const stackId = newAppEntityId("stk");
    const ids = { stackId, organizationId, hostAllocationId: allocation.id, templateVersionId: input.templateVersionId };
    let revision: NewAppStackRevision | null = null;
    if (input.deploy) {
      revision = compileRevision(
        { source, parameters: input.parameters, secretVersions: new Map(), ids: { ...ids, revisionId: newAppEntityId("srev") } },
        this.validation,
      ).revision;
    } else {
      const resolved = resolveAppTemplateParameters(spec, input.parameters);
      if (!resolved.ok) throw customerIssuesError(resolved.issues);
    }
    const common = { ...ids, name: input.name, createdBy: ctx.userId, idempotencyKey: ctx.idempotencyKey, requestHash };

    return this.#write(async (tx) => {
      const r = await createAppStackTransactional(
        tx,
        revision
          ? { ...common, deploy: revision }
          : { ...common, deploy: null, parameters: parameterValuesOf(input.parameters), componentKeys: spec.services.map((s) => s.key) },
      );
      if (r.idempotentReplay) return r;
      if (input.domains.length > 0) {
        const entries = input.domains.map((d) => ({ hostname: d.hostname, componentKey: d.componentKey, internalPort: d.port }));
        for (const row of await addAppStackDomainsTransactional(tx, { organizationId, stackId, entries })) {
          await ctx.audit(tx, {
            action: APP_AUDIT_ACTIONS.domainAssign,
            targetType: "app_stack",
            targetId: stackId,
            details: { domainId: row.id, hostname: row.hostname, componentKey: row.componentKey, internalPort: row.internalPort },
          });
        }
      }
      await ctx.audit(tx, {
        action: APP_AUDIT_ACTIONS.stackCreate,
        targetType: "app_stack",
        targetId: stackId,
        details: {
          templateVersionId: r.stack.templateVersionId,
          revisionId: r.revision?.id ?? null,
          operationId: r.operation?.id ?? null,
          status: r.stack.status,
        },
      });
      return r;
    });
  }

  public async list(organizationId: string, page: PaginationParams): Promise<Paged<AppStackSummaryDto>> {
    const db = this.dbClient.db;
    const total = (await countAppStacksByOrganization(db, [organizationId])).get(organizationId) ?? 0;
    const after = page.cursor === undefined ? undefined : await getAppStack(db, { organizationId, stackId: page.cursor });
    if (after === null) return { data: [], total, page: EMPTY_PAGE };
    const rows = await listAppStacks(db, { organizationId, limit: page.limit + 1, after });
    const kept = rows.slice(0, page.limit);
    if (kept.length === 0) return { data: [], total, page: EMPTY_PAGE };
    const stackIds = kept.map((s) => s.id);
    const [templates, versions, components, domains] = await Promise.all([
      db
        .select({ id: appTemplates.id, name: appTemplates.name })
        .from(appTemplates)
        .where(inArray(appTemplates.id, [...new Set(kept.map((s) => s.templateId))])),
      db
        .select({ id: appTemplateVersions.id, versionNumber: appTemplateVersions.versionNumber })
        .from(appTemplateVersions)
        .where(inArray(appTemplateVersions.id, [...new Set(kept.map((s) => s.templateVersionId))])),
      db
        .select()
        .from(appStackComponents)
        .where(and(eq(appStackComponents.organizationId, organizationId), inArray(appStackComponents.stackId, stackIds))),
      db
        .select()
        .from(appStackDomains)
        .where(and(eq(appStackDomains.organizationId, organizationId), inArray(appStackDomains.stackId, stackIds))),
    ]);
    const names = new Map(templates.map((t) => [t.id, t.name]));
    const numbers = new Map(versions.map((v) => [v.id, v.versionNumber]));
    const now = new Date();
    const data = kept.map((stack) =>
      appStackSummaryDto({
        stack,
        templateName: names.get(stack.templateId) ?? "",
        templateVersionNumber: numbers.get(stack.templateVersionId) ?? 1,
        components: components.filter((c) => c.stackId === stack.id),
        domains: domains.filter((d) => d.stackId === stack.id),
        now,
      }),
    );
    const hasMore = rows.length > page.limit;
    return { data, total, page: { nextCursor: hasMore ? kept[kept.length - 1]!.id : null, hasMore } };
  }

  public async detail(stack: AppStackRow): Promise<AppStackDetailDto> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const version = await this.#version(stack);
    const [template] = await db.select().from(appTemplates).where(eq(appTemplates.id, stack.templateId));
    if (!template) throw damaged("The stored application is damaged.");
    const [desired, components, volumes, domains, parameters, secrets, revisions, [active]] = await Promise.all([
      this.#desired(stack),
      listAppStackComponents(db, scope),
      listAppStackVolumes(db, scope),
      listAppStackDomains(db, scope),
      listAppStackParameters(db, scope),
      listAppStackSecretMetadata(db, scope),
      listAppStackRevisions(db, scope),
      db
        .select({ id: operations.id })
        .from(operations)
        .where(
          and(
            eq(operations.organizationId, stack.organizationId),
            eq(operations.lockKey, appStackLockKey(stack.id)),
            inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES]),
          ),
        )
        .limit(1),
    ]);
    const { defaultVersionId } = template;
    const latest =
      template.enabled && template.archivedAt === null && defaultVersionId !== null && defaultVersionId !== stack.templateVersionId
        ? await getAppTemplateVersion(db, { templateId: template.id, versionId: defaultVersionId })
        : null;
    const previous = desired ? revisions.find((r) => r.revisionNumber < desired.revision.revisionNumber) : undefined;
    const previousVersion = previous ? await this.#version(stack, previous.templateVersionId) : null;
    return appStackDetailDto({
      stack,
      templateName: template.name,
      templateVersionNumber: version.versionNumber,
      spec: this.#displaySpec(version),
      desired,
      components,
      volumes,
      domains,
      parameters,
      secrets,
      activeOperationId: active?.id ?? null,
      upgrade:
        latest && latest.versionNumber > version.versionNumber ? { templateVersionId: latest.id, versionNumber: latest.versionNumber } : null,
      rollback:
        previous && previousVersion
          ? { revisionId: previous.id, revisionNumber: previous.revisionNumber, templateVersionNumber: previousVersion.versionNumber }
          : null,
      now: new Date(),
    });
  }

  /** "Make it match the current inputs": a new revision only when the plan or the given parameters changed. */
  public async deploy(ctx: AppStackRequestContext, stack: AppStackRow, input: DeployAppStackInput): Promise<AppStackWriteResult> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const version = await this.#version(stack);
    const stored = entriesOf(await listAppStackParameters(db, scope));
    const c = compileRevision(
      {
        source: version.source,
        parameters: input.parameters ?? stored,
        secretVersions: secretVersionsOf(await listAppStackSecretMetadata(db, scope)),
        ids: {
          stackId: stack.id,
          organizationId: stack.organizationId,
          hostAllocationId: stack.hostAllocationId,
          templateVersionId: stack.templateVersionId,
          revisionId: newAppEntityId("srev"),
        },
      },
      this.validation,
    );
    const desired = await this.#desired(stack);
    const needsRevision =
      desired === null || desired.revision.planHash !== c.plan.planHash || (input.parameters !== undefined && !sameEntries(c.entries, stored));
    if (needsRevision) {
      if (!(await getPublishedAppTemplateVersion(db, { templateVersionId: stack.templateVersionId, lock: false }))) {
        throw refusal("templateVersionId", "STACK_TEMPLATE_UNPUBLISHED", "Install the current version with an upgrade first.");
      }
      if (domainTargetsMissing(await listAppStackDomains(db, scope), c.plan.ingress).length > 0) {
        throw refusal("domains", "domain_target_removed", "A web address still points at a part this version removes. Remove the address first.");
      }
    }
    return this.#enqueue(ctx, stack, "stack.deploy", input, needsRevision ? c.revision : null);
  }

  public act(ctx: AppStackRequestContext, stack: AppStackRow, kind: "stack.start" | "stack.stop" | "stack.restart"): Promise<AppStackWriteResult> {
    return this.#enqueue(ctx, stack, kind, {}, null);
  }

  public async remove(ctx: AppStackRequestContext, stack: AppStackRow, input: DeleteAppStackInput): Promise<AppStackWriteResult> {
    if (input.confirmName !== stack.name) throw refusal("confirmName", "confirmation_mismatch", "Type the name of the application to confirm.");
    return this.#enqueue(ctx, stack, "stack.delete", input, null, input.destroyData);
  }

  public async deployments(stack: AppStackRow, page: PaginationParams): Promise<Paged<AppStackDeploymentDto>> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(appStackDeployments)
      .where(and(eq(appStackDeployments.organizationId, stack.organizationId), eq(appStackDeployments.stackId, stack.id)));
    const total = counted?.n ?? 0;
    let after: { startedAt: Date; id: string } | undefined;
    if (page.cursor !== undefined) {
      const cursor = await getAppStackDeployment(db, { organizationId: stack.organizationId, deploymentId: page.cursor });
      if (!cursor || cursor.stackId !== stack.id) return { data: [], total, page: EMPTY_PAGE };
      after = { startedAt: cursor.startedAt, id: cursor.id };
    }
    const rows = await listAppStackDeployments(db, { ...scope, limit: page.limit + 1, after });
    const kept = rows.slice(0, page.limit);
    if (kept.length === 0) return { data: [], total, page: EMPTY_PAGE };
    const kinds = new Map(
      (
        await db
          .select({ id: operations.id, kind: operations.kind })
          .from(operations)
          .where(and(eq(operations.organizationId, stack.organizationId), inArray(operations.id, kept.map((d) => d.operationId))))
      ).map((op) => [op.id, op.kind as AppStackOperationKind]),
    );
    const numbers = new Map((await listAppStackRevisions(db, scope)).map((r) => [r.id, r.revisionNumber]));
    const data = kept.flatMap((row) => {
      const kind = kinds.get(row.operationId);
      return kind ? [appStackDeploymentDto(row, kind, row.revisionId === null ? null : (numbers.get(row.revisionId) ?? null))] : [];
    });
    const hasMore = rows.length > page.limit;
    return { data, total, page: { nextCursor: hasMore ? kept[kept.length - 1]!.id : null, hasMore } };
  }

  public async logs(stack: AppStackRow, componentKey: string, tail: number): Promise<AppStackComponentLogsDto> {
    const lines = await readAppStackComponentLogs(
      { db: this.dbClient.db, executor: this.executor, config: this.config, gate: this.logReads },
      { organizationId: stack.organizationId, stackId: stack.id, componentKey, tail },
    );
    return { componentKey, lines: lines.map((l) => ({ at: l.at ?? null, stream: l.stream, text: redactSensitiveString(l.text) })) };
  }

  /** The last stored observation; no executor call (the runtime records observations). */
  public async health(stack: AppStackRow, componentKey: string): Promise<AppStackComponentHealthDto> {
    const desired = await this.#desired(stack);
    const probes = desired
      ? desired.plan.components.map((c) => ({ key: c.key, healthcheck: c.healthcheck }))
      : this.#displaySpec(await this.#version(stack)).services;
    const probe = probes.find((c) => c.key === componentKey);
    if (!probe) throw appNotFound();
    const row = (await listAppStackComponents(this.dbClient.db, { organizationId: stack.organizationId, stackId: stack.id })).find(
      (c) => c.componentKey === componentKey,
    );
    const now = new Date();
    const observedAt = row?.healthObservedAt ?? null;
    return {
      componentKey,
      health: effectiveComponentHealth(row?.health ?? "unknown", observedAt, now),
      observedAt: observedAt?.toISOString() ?? null,
      stale: observedAt === null || now.getTime() - observedAt.getTime() > APP_STACK_HEALTH_STALE_AFTER_MS,
      source: probe.healthcheck?.kind ?? "running_state",
    };
  }

  /** Write-only: a new immutable version, used from the next deploy. The value reaches only app_stack_secrets. */
  public async setSecret(ctx: AppStackRequestContext, stack: AppStackRow, input: SetAppStackSecretInput): Promise<AppStackSecretStateDto> {
    if (stack.status === "deleting" || stack.status === "delete_failed") throw statusLocked(stack.status);
    const spec = validatedSpec((await this.#version(stack)).source, this.validation);
    if (!spec.parameters.some((p) => p.key === input.parameterKey && p.type === "secret")) {
      throw refusal("parameterKey", "STACK_PARAMETER_INVALID", "This setting is not a secret of this application.");
    }
    const meta = await this.#write(async (tx) => {
      const stored = await setAppStackSecretTransactional(tx, {
        organizationId: stack.organizationId,
        stackId: stack.id,
        parameterKey: input.parameterKey,
        value: input.value,
        masterKey: this.config.secretsMasterKey,
      });
      await ctx.audit(tx, {
        action: APP_AUDIT_ACTIONS.secretRotate,
        targetType: "app_stack",
        targetId: stack.id,
        details: { parameterKey: stored.parameterKey, version: stored.version },
      });
      return stored;
    });
    return { key: meta.parameterKey, isSet: true, version: meta.version, setAt: meta.rotatedAt.toISOString() };
  }

  #enqueue(
    ctx: AppStackRequestContext,
    stack: AppStackRow,
    kind: AppStackOperationKind,
    body: unknown,
    revision: NewAppStackRevision | null,
    destroyData = false,
  ): Promise<AppStackWriteResult> {
    const action = ACTIONS[kind];
    const requestHash = canonicalRequestHash({ route: action, organizationId: ctx.organizationId, stackId: stack.id, body });
    return this.#write(async (tx) => {
      const r = await enqueueAppStackOperationTransactional(tx, {
        organizationId: ctx.organizationId,
        stackId: stack.id,
        kind,
        requestedByUserId: ctx.userId,
        idempotencyKey: ctx.idempotencyKey,
        requestHash,
        revision,
        destroyData,
      });
      if (!r.idempotentReplay) {
        await ctx.audit(tx, {
          action,
          targetType: "app_stack",
          targetId: stack.id,
          details: {
            operationId: r.operation?.id ?? null,
            deploymentId: r.deployment?.id ?? null,
            revisionId: r.revision?.id ?? null,
            templateVersionId: r.stack.templateVersionId,
            status: r.stack.status,
            ...(kind === "stack.delete" ? { destroyData } : {}),
          },
        });
      }
      return r;
    });
  }

  #write<T>(work: (tx: HostingPanelDatabase) => Promise<T>): Promise<T> {
    return guardedApp(mapAppStackError, () => this.dbClient.db.transaction((tx) => work(tx as unknown as HostingPanelDatabase)));
  }

  async #version(stack: AppStackRow, versionId = stack.templateVersionId): Promise<AppTemplateVersionRow> {
    const version = await getAppTemplateVersion(this.dbClient.db, { templateId: stack.templateId, versionId });
    if (!version) throw damaged("The stored application is damaged.");
    return version;
  }

  /** Display figures and labels only (H10): every use re-validates the source instead. */
  #displaySpec(version: AppTemplateVersionRow): AppTemplateSpec {
    const parsed = AppTemplateSpecSchema.safeParse(version.compiledSchema);
    if (!parsed.success) throw damaged("The stored application is damaged.");
    return parsed.data;
  }

  async #desired(stack: AppStackRow): Promise<{ revision: AppStackRevisionRow; plan: ApprovedStackPlan } | null> {
    if (stack.desiredRevisionId === null) return null;
    const revision = await getAppStackRevision(this.dbClient.db, {
      organizationId: stack.organizationId,
      stackId: stack.id,
      revisionId: stack.desiredRevisionId,
    });
    const plan = revision ? ApprovedStackPlanSchema.safeParse(revision.plan) : null;
    if (!revision || !plan?.success) throw damaged("The stored revision is damaged.");
    return { revision, plan: plan.data };
  }
}
