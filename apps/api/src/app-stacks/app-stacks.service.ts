import { Inject, Injectable } from "@nestjs/common";
import {
  APP_AUDIT_ACTIONS,
  APP_IMAGE_ALLOWLIST,
  APP_STACK_HEALTH_STALE_AFTER_MS,
  APP_STACK_REVISION_KINDS,
  APP_STACK_SECRET_ENV_LIMITS,
  AppTemplateSpecSchema,
  PLATFORM_OPS_ORG_ID,
  ApprovedStackPlanSchema,
  appStackLockKey,
  appStackPlanImageProblems,
  appTemplateHiddenSecretKeys,
  effectiveComponentHealth,
  redactSensitiveString,
  resolveAppTemplateParameters,
  type AppStackComponentHealthDto,
  type AppStackComponentLogsDto,
  type AppStackDeploymentDto,
  type AppStackDetailDto,
  type AppStackOperationKind,
  type AppStackPlanDiffDto,
  type AppStackSecretStateDto,
  type AppStackSummaryDto,
  type AppTemplateParameterEntry,
  type AppTemplateSpec,
  type ApprovedStackPlan,
  type CreateAppStackInput,
  type CursorPage,
  type DeleteAppStackInput,
  type DeployAppStackInput,
  type PlanAppStackInput,
  type RollbackAppStackInput,
  type SetAppStackSecretInput,
  type UpgradeAppStackInput,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  addAppStackDomainsTransactional,
  and,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackRevisions,
  appStacks,
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
  insertGeneratedAppStackSecrets,
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
  operationSteps,
  or,
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
import { verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { appTemplateEnvironmentSecretKeys, type AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { appNotFound, appRefusal, guardedApp } from "../app-templates/app-template-errors.js";
import { APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN } from "../app-templates/app-template-validation-options.js";
import { ControlPlaneError, type PaginationParams } from "../common/control-plane.error.js";
import { canonicalRequestHash } from "../common/request-hash.js";
import { LogReadGate } from "../sites/log-read-gate.js";
import { appSecretsToGenerate, generateAppSecretValues, type AppSecretToGenerate } from "./app-secret-generate.js";
import { CONTROL_PLANE_CONFIG_TOKEN, DATABASE_CLIENT_TOKEN, DOCKER_EXECUTOR_TOKEN, type ControlPlaneRuntimeConfig } from "../tokens.js";
import {
  carryOverParameters,
  compileRevision,
  domainTargetsMissing,
  entriesOf,
  parameterValuesOf,
  pathTargetsMissing,
  revisionFromPlan,
  sameEntries,
  secretVersionsOf,
  validatedSpec,
} from "./app-stack-compile.js";
import { diffAppStackPlans } from "./app-stack-diff.js";
import { appStackDeploymentDto, appStackDetailDto, appStackSummaryDto, assignedAddressDetails } from "./app-stack-dto.js";
import { customerIssuesError, mapAppStackError } from "./app-stack-errors.js";
import { readAppStackComponentLogs } from "./app-stack-logs.js";

export interface AppStackRequestContext {
  readonly organizationId: string;
  readonly userId: string;
  /** "" for routes that queue nothing. */
  readonly idempotencyKey: string;
  readonly audit: (
    tx: DatabaseExecutor,
    event: {
      readonly action: string;
      readonly targetType: "app_stack" | "app_stack_link";
      readonly targetId: string;
      readonly details: Record<string, unknown>;
    },
  ) => Promise<void>;
}

type Paged<T> = { data: T[]; total: number; page: CursorPage };
/** What deploy, upgrade or rollback would install, after its preflight. */
type Candidate = {
  readonly version: AppTemplateVersionRow;
  readonly plan: ApprovedStackPlan;
  readonly revision: NewAppStackRevision;
  readonly entries: readonly AppTemplateParameterEntry[];
  readonly newRevision: boolean;
  /** Generated secrets this revision is the first to need (ADR-0036): its plan pins their version 1, stored when it is queued. */
  readonly generate?: readonly AppSecretToGenerate[];
};
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
function assertReviewed(candidate: Candidate, planHash: string): void {
  if (candidate.plan.planHash !== planHash) {
    throw refusal("planHash", "plan_changed", "The changes are not the ones you reviewed. Review them again.");
  }
}
/** A draft (no revision yet) is never upgraded: it reaches the current version by being installed again. */
const draftOutdated = () =>
  refusal(
    "templateVersionId",
    "STACK_TEMPLATE_UNPUBLISHED",
    "This version can no longer be installed. Remove this draft and install the application again: a draft has no data, so nothing is lost.",
  );
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
    // A retry goes straight to the repository's replay or conflict (it reads only the key and the hash): the preflight
    // may now refuse what it accepted then.
    const [prior] = await db
      .select({ stackId: appStacks.id, hostAllocationId: appStacks.hostAllocationId })
      .from(appStacks)
      .where(and(eq(appStacks.organizationId, organizationId), eq(appStacks.idempotencyKey, ctx.idempotencyKey)))
      .limit(1);
    if (prior) {
      return this.#write((tx) =>
        createAppStackTransactional(tx, {
          ...prior,
          organizationId,
          templateVersionId: input.templateVersionId,
          name: input.name,
          createdBy: ctx.userId,
          idempotencyKey: ctx.idempotencyKey,
          requestHash,
          deploy: null,
          parameters: [],
          componentKeys: [],
        }),
      );
    }
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
    // The secrets the template asks the platform to generate get their version 1 with the stack, draft or not.
    const generate = appSecretsToGenerate(spec, new Map());
    let revision: NewAppStackRevision | null = null;
    if (input.deploy) {
      revision = compileRevision(
        {
          source,
          parameters: input.parameters,
          secretVersions: new Map(generate.map(({ parameterKey }) => [parameterKey, 1])),
          ids: { ...ids, revisionId: newAppEntityId("srev") },
        },
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
      const generated = await this.#storeGenerated(tx, { organizationId, stackId }, generate);
      if (input.domains.length > 0) {
        const entries = input.domains.map((d) => ({
          hostname: d.hostname,
          componentKey: d.componentKey,
          internalPort: d.port,
          compression: d.compression,
        }));
        for (const row of await addAppStackDomainsTransactional(tx, { organizationId, stackId, entries })) {
          await ctx.audit(tx, {
            action: APP_AUDIT_ACTIONS.domainAssign,
            targetType: "app_stack",
            targetId: stackId,
            details: assignedAddressDetails(row),
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
          ...(generated.length > 0 ? { generatedParameterKeys: generated } : {}),
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
    // What runs, where it is not the desired revision: the list names that version, as the detail does.
    const appliedIds = kept.flatMap((s) => (s.appliedRevisionId !== null && s.appliedRevisionId !== s.desiredRevisionId ? [s.appliedRevisionId] : []));
    const applied =
      appliedIds.length === 0
        ? []
        : await db
            .select({ id: appStackRevisions.id, revisionNumber: appStackRevisions.revisionNumber, templateVersionId: appStackRevisions.templateVersionId })
            .from(appStackRevisions)
            .where(and(eq(appStackRevisions.organizationId, organizationId), inArray(appStackRevisions.id, appliedIds)));
    const [templates, versions, components, domains] = await Promise.all([
      db
        .select({ id: appTemplates.id, name: appTemplates.name })
        .from(appTemplates)
        .where(inArray(appTemplates.id, [...new Set(kept.map((s) => s.templateId))])),
      db
        .select({ id: appTemplateVersions.id, versionNumber: appTemplateVersions.versionNumber })
        .from(appTemplateVersions)
        .where(inArray(appTemplateVersions.id, [...new Set([...kept.map((s) => s.templateVersionId), ...applied.map((r) => r.templateVersionId)])])),
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
    const appliedById = new Map(applied.map((r) => [r.id, r]));
    const now = new Date();
    const data = kept.map((stack) => {
      const running = stack.appliedRevisionId === null ? undefined : appliedById.get(stack.appliedRevisionId);
      return appStackSummaryDto({
        stack,
        templateName: names.get(stack.templateId) ?? "",
        templateVersionNumber: numbers.get(stack.templateVersionId) ?? 1,
        installed: running ? { revisionNumber: running.revisionNumber, templateVersionNumber: numbers.get(running.templateVersionId) ?? 1 } : null,
        components: components.filter((c) => c.stackId === stack.id),
        domains: domains.filter((d) => d.stackId === stack.id),
        now,
      });
    });
    const hasMore = rows.length > page.limit;
    return { data, total, page: { nextCursor: hasMore ? kept[kept.length - 1]!.id : null, hasMore } };
  }

  public async detail(stack: AppStackRow): Promise<AppStackDetailDto> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const version = await this.#version(stack);
    const [template] = await db.select().from(appTemplates).where(eq(appTemplates.id, stack.templateId));
    if (!template) throw damaged("The stored application is damaged.");
    const [desired, components, volumes, domains, parameters, secrets, revisions, [active], ran] = await Promise.all([
      this.#desired(stack),
      listAppStackComponents(db, scope),
      listAppStackVolumes(db, scope),
      listAppStackDomains(db, scope),
      listAppStackParameters(db, scope),
      listAppStackSecretMetadata(db, scope),
      listAppStackRevisions(db, scope),
      // Whoever holds the lock: the nightly clean-up of its backups runs for the platform (ADR-0038 K7).
      db
        .select({ id: operations.id, organizationId: operations.organizationId, kind: operations.kind })
        .from(operations)
        .where(and(eq(operations.lockKey, appStackLockKey(stack.id)), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])))
        .limit(1),
      // Revisions that ran: a deploy, an upgrade or a rollback of them succeeded, or failed after its health step succeeded
      // (only the routes were refused, and that revision was applied).
      db
        .selectDistinct({ revisionId: appStackDeployments.revisionId })
        .from(appStackDeployments)
        .innerJoin(operations, eq(operations.id, appStackDeployments.operationId))
        .leftJoin(operationSteps, and(eq(operationSteps.operationId, operations.id), eq(operationSteps.key, "health")))
        .where(
          and(
            eq(appStackDeployments.organizationId, stack.organizationId),
            eq(appStackDeployments.stackId, stack.id),
            or(eq(appStackDeployments.status, "succeeded"), eq(operationSteps.status, "succeeded")),
            inArray(operations.kind, [...APP_STACK_REVISION_KINDS]),
          ),
        ),
    ]);
    const own = active?.organizationId === stack.organizationId ? active : undefined;
    // Of an operation of the platform the customer learns the kind of work, never the operation.
    const platformWork = active?.organizationId === PLATFORM_OPS_ORG_ID && active.kind === "stack.prune" ? "backups_cleanup" : null;
    const { defaultVersionId } = template;
    const latest =
      desired !== null &&
      template.enabled &&
      template.archivedAt === null &&
      defaultVersionId !== null &&
      defaultVersionId !== stack.templateVersionId
        ? await getAppTemplateVersion(db, { templateId: template.id, versionId: defaultVersionId })
        : null;
    // The way back is an earlier revision that ran (never an attempt that failed) and whose plan is not the current one.
    const ranIds = new Set(ran.map((d) => d.revisionId));
    const previous = desired
      ? revisions.find(
          (r) => r.revisionNumber < desired.revision.revisionNumber && r.planHash !== desired.revision.planHash && ranIds.has(r.id),
        )
      : undefined;
    const previousVersion = previous ? await this.#version(stack, previous.templateVersionId) : null;
    // What runs is the applied revision: after a change that failed once create had started, not the desired one.
    const applied = stack.appliedRevisionId !== stack.desiredRevisionId ? revisions.find((r) => r.id === stack.appliedRevisionId) : undefined;
    const installed = applied
      ? { revisionNumber: applied.revisionNumber, templateVersionNumber: (await this.#version(stack, applied.templateVersionId)).versionNumber }
      : null;
    return appStackDetailDto({
      stack,
      templateName: template.name,
      templateVersionNumber: version.versionNumber,
      spec: this.#displaySpec(version),
      desired,
      appliedPlan: await this.#appliedPlan(stack, desired),
      components,
      volumes,
      domains,
      parameters,
      secrets,
      activeOperationId: own?.id ?? null,
      installed,
      platformWork,
      upgrade:
        latest && latest.versionNumber > version.versionNumber ? { templateVersionId: latest.id, versionNumber: latest.versionNumber } : null,
      rollback:
        previous && previousVersion
          ? { revisionId: previous.id, revisionNumber: previous.revisionNumber, templateVersionNumber: previousVersion.versionNumber }
          : null,
      now: new Date(),
    });
  }

  /** Diff and preflight of a deploy, upgrade (another version) or rollback (a revision), without any write or lock. */
  public async plan(stack: AppStackRow, input: PlanAppStackInput): Promise<AppStackPlanDiffDto> {
    const candidate =
      input.revisionId !== undefined
        ? await this.#rollbackCandidate(stack, input.revisionId)
        : input.templateVersionId !== undefined && input.templateVersionId !== stack.templateVersionId
          ? await this.#upgradeCandidate(stack, input.templateVersionId, input.parameters)
          : await this.#deployCandidate(stack, input.parameters);
    if (candidate.newRevision) await this.#assertDomainTargets(stack, candidate.plan);
    const desired = await this.#desired(stack);
    const fromVersion = desired ? await this.#version(stack, desired.revision.templateVersionId) : null;
    const hidden = new Set(
      [candidate.version, ...(fromVersion ? [fromVersion] : [])].flatMap((version) => [
        ...appTemplateHiddenSecretKeys(this.#displaySpec(version).parameters),
      ]),
    );
    return {
      planHash: candidate.plan.planHash,
      fromRevisionId: desired?.revision.id ?? null,
      fromVersionNumber: fromVersion?.versionNumber ?? null,
      toTemplateVersionId: candidate.version.id,
      toVersionNumber: candidate.version.versionNumber,
      newRevision: candidate.newRevision,
      ...diffAppStackPlans({
        from: desired?.plan ?? null,
        to: candidate.plan,
        fromParameters: desired?.revision.parameters ?? [],
        toParameters: candidate.entries,
        hidden,
      }),
    };
  }

  /** "Make it match the current inputs": a new revision only when the plan or the given parameters changed. */
  public async deploy(ctx: AppStackRequestContext, stack: AppStackRow, input: DeployAppStackInput): Promise<AppStackWriteResult> {
    if (await this.#keyUsed(ctx)) return this.#enqueue(ctx, stack, "stack.deploy", input, null);
    const candidate = await this.#deployCandidate(stack, input.parameters);
    if (candidate.newRevision) await this.#assertDomainTargets(stack, candidate.plan);
    return this.#enqueue(ctx, stack, "stack.deploy", input, candidate.newRevision ? candidate.revision : null);
  }

  public act(ctx: AppStackRequestContext, stack: AppStackRow, kind: "stack.start" | "stack.stop" | "stack.restart"): Promise<AppStackWriteResult> {
    return this.#enqueue(ctx, stack, kind, {}, null);
  }

  /** To the newer default version of the same template, as reviewed: `planHash` is the one the plan route returned. */
  public async upgrade(ctx: AppStackRequestContext, stack: AppStackRow, input: UpgradeAppStackInput): Promise<AppStackWriteResult> {
    // The upgrade a retry replays has already moved the stack to that version, so the preflight would refuse it as not newer.
    if (await this.#keyUsed(ctx)) return this.#enqueue(ctx, stack, "stack.upgrade", input, null);
    const candidate = await this.#upgradeCandidate(stack, input.templateVersionId, input.parameters);
    assertReviewed(candidate, input.planHash);
    await this.#assertDomainTargets(stack, candidate.plan);
    return this.#enqueue(ctx, stack, "stack.upgrade", input, candidate.revision, false, candidate.generate);
  }

  /** A new revision with the plan and public parameters of an earlier one; volumes and their data are left as they are. */
  public async rollback(ctx: AppStackRequestContext, stack: AppStackRow, input: RollbackAppStackInput): Promise<AppStackWriteResult> {
    const candidate = await this.#rollbackCandidate(stack, input.revisionId);
    assertReviewed(candidate, input.planHash);
    await this.#assertDomainTargets(stack, candidate.plan);
    return this.#enqueue(ctx, stack, "stack.rollback", input, candidate.revision);
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
    // A secret the customer may not replace (generated, `customer: false`) answers like a key that does not exist.
    if (!spec.parameters.some((p) => p.key === input.parameterKey && p.type === "secret" && p.customer)) {
      throw refusal("parameterKey", "STACK_PARAMETER_INVALID", "This setting is not a secret of this application.");
    }
    // A value the application reads from its environment is bounded, so no expanded variable outgrows the executor's limit.
    const { secretBytes } = APP_STACK_SECRET_ENV_LIMITS;
    if (appTemplateEnvironmentSecretKeys(spec).has(input.parameterKey) && Buffer.byteLength(input.value, "utf8") > secretBytes) {
      throw refusal("value", "value_too_long", `This value is too long for this application: at most ${String(secretBytes)} bytes.`);
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
    generate: readonly AppSecretToGenerate[] = [],
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
        // After the queue accepted the request: a locked or replayed one stores nothing.
        const generated = await this.#storeGenerated(tx, { organizationId: ctx.organizationId, stackId: stack.id }, generate);
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
            ...(generated.length > 0 ? { generatedParameterKeys: generated } : {}),
          },
        });
      }
      return r;
    });
  }

  async #deployCandidate(stack: AppStackRow, parameters: DeployAppStackInput["parameters"]): Promise<Candidate> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const version = await this.#version(stack);
    const stored = entriesOf(await listAppStackParameters(db, scope));
    const c = compileRevision(
      {
        source: version.source,
        parameters: parameters ?? stored,
        secretVersions: secretVersionsOf(await listAppStackSecretMetadata(db, scope)),
        ids: this.#ids(stack, stack.templateVersionId),
      },
      this.validation,
    );
    const desired = await this.#desired(stack);
    const newRevision =
      desired === null || desired.revision.planHash !== c.plan.planHash || (parameters !== undefined && !sameEntries(c.entries, stored));
    if (newRevision && !(await getPublishedAppTemplateVersion(db, { templateVersionId: stack.templateVersionId, lock: false }))) {
      throw desired === null
        ? draftOutdated()
        : refusal("templateVersionId", "STACK_TEMPLATE_UNPUBLISHED", "Install the current version with an upgrade first.");
    }
    return { version, ...c, newRevision };
  }

  async #upgradeCandidate(
    stack: AppStackRow,
    templateVersionId: string,
    parameters: UpgradeAppStackInput["parameters"],
  ): Promise<Candidate> {
    const db = this.dbClient.db;
    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const version = await getAppTemplateVersion(db, { templateId: stack.templateId, versionId: templateVersionId });
    if (!version) throw refusal("templateVersionId", "unknown_version", "Choose a version of this application.");
    if (version.versionNumber <= (await this.#version(stack)).versionNumber) {
      throw refusal("templateVersionId", "not_newer", "Choose a newer version.");
    }
    if (!(await getPublishedAppTemplateVersion(db, { templateVersionId: version.id, lock: false }))) {
      throw refusal("templateVersionId", "STACK_TEMPLATE_UNPUBLISHED", "This version can no longer be installed. Choose the current version.");
    }
    if (stack.desiredRevisionId === null) throw draftOutdated();
    const spec = validatedSpec(version.source, this.validation);
    // A generated secret this version brings and the stack never had: version 1, stored when the upgrade is queued.
    const secretVersions = secretVersionsOf(await listAppStackSecretMetadata(db, scope));
    const generate = appSecretsToGenerate(spec, secretVersions);
    for (const { parameterKey } of generate) secretVersions.set(parameterKey, 1);
    const c = compileRevision(
      {
        source: version.source,
        parameters: parameters ?? carryOverParameters(spec, entriesOf(await listAppStackParameters(db, scope))),
        secretVersions,
        ids: this.#ids(stack, version.id),
      },
      this.validation,
    );
    return { version, ...c, newRevision: true, generate };
  }

  /** Today's checks must still accept the earlier revision (spec §10.3); its plan is reused under a new revision id. */
  async #rollbackCandidate(stack: AppStackRow, revisionId: string): Promise<Candidate> {
    const revision = await getAppStackRevision(this.dbClient.db, { organizationId: stack.organizationId, stackId: stack.id, revisionId });
    if (!revision) throw refusal("revisionId", "unknown_revision", "Choose an earlier version of this application.");
    if (revision.id === stack.desiredRevisionId) throw refusal("revisionId", "already_current", "This is the current version.");
    const version = await this.#version(stack, revision.templateVersionId);
    validatedSpec(version.source, this.validation);
    const old = ApprovedStackPlanSchema.safeParse(revision.plan);
    if (!old.success || !verifyAppStackPlanHash(old.data)) throw damaged("The stored revision is damaged.");
    if (appStackPlanImageProblems(old.data, this.validation.allowlist ?? APP_IMAGE_ALLOWLIST).length > 0) {
      throw refusal("revisionId", "STACK_IMAGE_NOT_ALLOWED", "A component of that revision uses software that is no longer allowed.");
    }
    const plan = { ...old.data, revisionId: newAppEntityId("srev") };
    return { version, plan, revision: revisionFromPlan(plan, revision.parameters), entries: revision.parameters, newRevision: true };
  }

  async #assertDomainTargets(stack: AppStackRow, plan: ApprovedStackPlan): Promise<void> {
    const domains = await listAppStackDomains(this.dbClient.db, { organizationId: stack.organizationId, stackId: stack.id });
    if (domainTargetsMissing(domains, plan.ingress).length > 0) {
      throw refusal("domains", "domain_target_removed", "A web address still points at a part this version removes. Remove the address first.");
    }
    // A path rule to a removed part would stop routing unseen, and every later save of its options would be refused.
    if (pathTargetsMissing(domains, plan.ingress).length > 0) {
      throw refusal("domains", "path_target_removed", "A path of a web address still points at a part this version removes. Remove the path first.");
    }
  }

  async #keyUsed(ctx: AppStackRequestContext): Promise<boolean> {
    const [prior] = await this.dbClient.db
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.organizationId, ctx.organizationId), eq(operations.idempotencyKey, ctx.idempotencyKey)))
      .limit(1);
    return prior !== undefined;
  }

  #ids(stack: AppStackRow, templateVersionId: string) {
    return {
      stackId: stack.id,
      organizationId: stack.organizationId,
      hostAllocationId: stack.hostAllocationId,
      templateVersionId,
      revisionId: newAppEntityId("srev"),
    };
  }

  /** Fresh values for `wanted`, stored as version 1 in the caller's transaction; the parameter keys it stored, sorted. */
  async #storeGenerated(
    tx: DatabaseExecutor,
    scope: { readonly organizationId: string; readonly stackId: string },
    wanted: readonly AppSecretToGenerate[],
  ): Promise<string[]> {
    if (wanted.length === 0) return [];
    const stored = await insertGeneratedAppStackSecrets(tx, {
      ...scope,
      masterKey: this.config.secretsMasterKey,
      values: generateAppSecretValues(wanted),
    });
    return stored.map((row) => row.parameterKey).sort();
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

  /** The plan of the revision that runs, whose routes are published (ADR-0037); null when none was applied. */
  async #appliedPlan(stack: AppStackRow, desired: { revision: AppStackRevisionRow; plan: ApprovedStackPlan } | null): Promise<ApprovedStackPlan | null> {
    if (stack.appliedRevisionId === null) return null;
    if (desired?.revision.id === stack.appliedRevisionId) return desired.plan;
    const revision = await getAppStackRevision(this.dbClient.db, {
      organizationId: stack.organizationId,
      stackId: stack.id,
      revisionId: stack.appliedRevisionId,
    });
    const plan = revision ? ApprovedStackPlanSchema.safeParse(revision.plan) : null;
    if (!plan?.success) throw damaged("The stored revision is damaged.");
    return plan.data;
  }
}
