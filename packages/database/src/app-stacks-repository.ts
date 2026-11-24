// Application stacks (ADR-0035): create, enqueue a lifecycle operation, deployments, revisions and boot repair.
// Lock order of every stack writer: organizations row FOR NO KEY UPDATE → app_templates row FOR SHARE → app_stacks row
// FOR UPDATE → resource_quotas row FOR UPDATE → tls_publish_state → hostname advisory lock (0025 triggers).

import { createHash, randomUUID } from "node:crypto";
import {
  APP_STACK_BUSY_STATUSES,
  APP_STACK_KEY_PATTERN,
  APP_STACK_RESOURCE_TYPE,
  APP_STACK_REVISION_KINDS,
  APP_STACK_TERMINAL_DEPLOYMENT_STATUSES,
  APP_TEMPLATE_LIMITS,
  appStackEnqueueTarget,
  appStackLockKey,
  appStackOperationSteps,
  canTransitionAppStack,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
  type AppIdPrefix,
  type AppStackComponentHealth,
  type AppStackDeploymentStatus,
  type AppStackOperationKind,
  type AppStackStatus,
  type AppStackVolumeStatus,
  type ErrorCode,
} from "@hosting-panel/contracts";
import { and, asc, desc, eq, exists, inArray, isNull, lt, max, notInArray, or, sql, type SQL } from "drizzle-orm";
import { AppStackQuotaError, chargeAppStackQuota, lockAppStackLimitUsage } from "./app-stack-limit.js";
import { getAppTemplateVersion, getPublishedAppTemplateVersion } from "./app-templates-repository.js";
import type { DatabaseExecutor, HostingPanelDatabase } from "./client.js";
import { ACTIVE_OPERATION_LOCK_STATUSES, enqueueOperationTransactional } from "./operations-repository.js";
import {
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  hostAllocations,
  operations,
} from "./schema.js";

export type AppStackRow = typeof appStacks.$inferSelect;
export type AppStackRevisionRow = typeof appStackRevisions.$inferSelect;
export type AppStackParameterRow = typeof appStackParameters.$inferSelect;
export type AppStackComponentRow = typeof appStackComponents.$inferSelect;
export type AppStackVolumeRow = typeof appStackVolumes.$inferSelect;
export type AppStackDeploymentRow = typeof appStackDeployments.$inferSelect;

export type AppStackRepositoryErrorCode =
  | "NOT_FOUND"
  | "NAME_TAKEN"
  | "TEMPLATE_UNPUBLISHED"
  | "TEMPLATE_MISMATCH"
  | "INVALID_TRANSITION"
  | "NO_REVISION"
  | "COMPONENT_IN_USE"
  | "PATH_IN_USE";

export class AppStackRepositoryError extends Error {
  constructor(
    readonly code: AppStackRepositoryErrorCode,
    message: string,
    readonly status?: AppStackStatus,
  ) {
    super(message);
    this.name = "AppStackRepositoryError";
  }
}

export interface AppStackParameterValue {
  readonly parameterKey: string;
  readonly value: string | number | boolean;
}
export interface NewAppStackRevision {
  readonly revisionId: string;
  readonly templateVersionId: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly planHash: string;
  readonly componentKeys: readonly string[];
  readonly volumeKeys: readonly string[];
  readonly cpuMilli: number;
  readonly memoryBytes: number;
  /** The public parameters the plan was compiled from (stored sorted as `[{ key, value }]`). */
  readonly parameters: readonly AppStackParameterValue[];
}

/** Ids are minted by the caller because the plan carries them. */
export function newAppEntityId(prefix: AppIdPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

type OperationRow = typeof operations.$inferSelect;
export interface AppStackWriteResult {
  readonly stack: AppStackRow;
  readonly revision: AppStackRevisionRow | null;
  readonly deployment: AppStackDeploymentRow | null;
  readonly operation: OperationRow | null;
  readonly idempotentReplay: boolean;
}

interface CreateAppStackCommon {
  readonly stackId: string;
  readonly organizationId: string;
  readonly hostAllocationId: string;
  readonly templateVersionId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}
export type CreateAppStackInput = CreateAppStackCommon &
  (
    | {
        /** Revision 1, deployed at once; its parameters are the stored set. */
        readonly deploy: NewAppStackRevision;
      }
    | {
        /** Stays `draft` (secrets must be set before the first deploy). */
        readonly deploy: null;
        readonly parameters: readonly AppStackParameterValue[];
        /** The template's service keys (1..8, distinct, APP_STACK_KEY_PATTERN): one component row each, so domains can attach. */
        readonly componentKeys: readonly string[];
      }
  );

export interface EnqueueAppStackOperationInput {
  readonly organizationId: string;
  readonly stackId: string;
  readonly kind: AppStackOperationKind;
  readonly requestedByUserId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  /** upgrade/rollback: required; deploy: optional (null = redeploy the desired revision); start/stop/restart/delete: null. */
  readonly revision: NewAppStackRevision | null;
  /**
   * stack.deploy without a revision: the observer's route refresh, which installs nothing. Its deployment names the
   * applied revision, the one whose routes it publishes, also when a newer one is desired.
   */
  readonly routesOnly?: boolean;
  /** stack.delete: sets retention_policy of every volume of the stack (true → 'destroy', false → 'retain'); ignored otherwise. */
  readonly destroyData: boolean;
}

interface StackScope {
  readonly organizationId: string;
  readonly stackId: string;
}

function codedError(message: string, code: ErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

function hasPgError(err: unknown, code: string, name: string): boolean {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (e.code === code && (e.constraint === name || (typeof e.message === "string" && e.message.includes(name)))) return true;
    current = e.cause;
  }
  return false;
}

function assertNoSecretMaterial(value: unknown, field: string): void {
  if (findPlaintextSecretKeys(value).length > 0 || findForbiddenPublicDtoKeys(value).length > 0 || findPemValues(value).length > 0) {
    throw codedError(`${field} carries secret material`, "VALIDATION_ERROR");
  }
}

const planList = (plan: Readonly<Record<string, unknown>>, field: string): readonly Record<string, unknown>[] =>
  Array.isArray(plan[field]) ? (plan[field] as Record<string, unknown>[]) : [];
const sameKeys = (items: readonly Record<string, unknown>[], keys: readonly string[]) =>
  items.length === keys.length && items.every((item, i) => item.key === keys[i]);

/** Before every revision insert: the plan names this stack and revision, and the keys are the plan's keys. */
function assertRevision(
  revision: NewAppStackRevision,
  row: { organizationId: string; stackId: string; hostAllocationId: string; templateVersionId: string },
): void {
  const { plan } = revision;
  if (
    revision.templateVersionId !== row.templateVersionId ||
    plan.stackId !== row.stackId ||
    plan.organizationId !== row.organizationId ||
    plan.hostAllocationId !== row.hostAllocationId ||
    plan.templateVersionId !== row.templateVersionId ||
    plan.revisionId !== revision.revisionId ||
    plan.planHash !== revision.planHash ||
    !sameKeys(planList(plan, "components"), revision.componentKeys) ||
    !sameKeys(planList(plan, "volumes"), revision.volumeKeys)
  ) {
    throw codedError("The revision does not match its plan.", "VALIDATION_ERROR");
  }
  assertNoSecretMaterial(plan, "plan");
  assertNoSecretMaterial(revision.parameters, "parameters");
}

const sortedParameters = (values: readonly AppStackParameterValue[]) =>
  [...values].sort((a, b) => (a.parameterKey < b.parameterKey ? -1 : a.parameterKey > b.parameterKey ? 1 : 0));

async function insertParameters(tx: DatabaseExecutor, scope: StackScope, values: readonly AppStackParameterValue[]): Promise<void> {
  assertNoSecretMaterial(values, "parameters");
  if (values.length === 0) return;
  await tx.insert(appStackParameters).values(
    values.map((p) => ({ stackId: scope.stackId, organizationId: scope.organizationId, parameterKey: p.parameterKey, publicValue: p.value })),
  );
}

async function insertRevision(
  tx: DatabaseExecutor,
  scope: StackScope,
  revision: NewAppStackRevision,
  revisionNumber: number,
): Promise<AppStackRevisionRow> {
  const [row] = await tx
    .insert(appStackRevisions)
    .values({
      id: revision.revisionId,
      stackId: scope.stackId,
      organizationId: scope.organizationId,
      revisionNumber,
      templateVersionId: revision.templateVersionId,
      plan: revision.plan,
      planHash: revision.planHash,
      parameters: sortedParameters(revision.parameters).map((p) => ({ key: p.parameterKey, value: p.value })),
      componentCount: revision.componentKeys.length,
      cpuMilli: revision.cpuMilli,
      memoryBytes: revision.memoryBytes,
    })
    .returning();
  return row!;
}

/** Inserts the plan's new components and volumes; drops components the plan no longer has (volumes are never dropped). */
async function syncComponentsAndVolumes(
  tx: DatabaseExecutor,
  scope: StackScope,
  revision: Pick<NewAppStackRevision, "componentKeys" | "volumeKeys">,
): Promise<void> {
  const owner = { stackId: scope.stackId, organizationId: scope.organizationId };
  try {
    await tx
      .delete(appStackComponents)
      .where(and(eq(appStackComponents.stackId, scope.stackId), notInArray(appStackComponents.componentKey, [...revision.componentKeys])));
  } catch (err) {
    if (hasPgError(err, "23503", "fk_app_stack_domains_component")) {
      throw new AppStackRepositoryError("COMPONENT_IN_USE", "A web address still points at a part this version removes.");
    }
    throw err;
  }
  await tx
    .insert(appStackComponents)
    .values(revision.componentKeys.map((componentKey) => ({ ...owner, componentKey })))
    .onConflictDoNothing();
  if (revision.volumeKeys.length > 0) {
    await tx
      .insert(appStackVolumes)
      .values(revision.volumeKeys.map((volumeKey) => ({ ...owner, volumeKey })))
      .onConflictDoNothing();
  }
}

const totals = (revision: AppStackRevisionRow) => ({
  componentCount: revision.componentCount,
  cpuMilli: revision.cpuMilli,
  memoryBytes: revision.memoryBytes,
});

async function revisionOf(db: DatabaseExecutor, stackId: string, revisionId: string | null): Promise<AppStackRevisionRow | null> {
  if (revisionId === null) return null;
  const [row] = await db
    .select()
    .from(appStackRevisions)
    .where(and(eq(appStackRevisions.id, revisionId), eq(appStackRevisions.stackId, stackId)));
  return row ?? null;
}

const planKeys = (plan: Readonly<Record<string, unknown>>) => planList(plan, "components").map((c) => String(c.key));

/**
 * Takes back what enqueueing an upgrade or a rollback wrote, to the desired revision that request replaced: parameters,
 * component rows and quota (the caller writes desired_revision_id and template_version_id). Null, and nothing written,
 * when the deployment replaced no revision, when its revision is no longer the desired one, or when a web address or one
 * of its paths now targets a pair only the desired plan has.
 */
async function restoreReplacedRevision(
  db: DatabaseExecutor,
  stack: AppStackRow,
  deployment: { readonly revisionId: string | null; readonly replacedRevisionId: string | null },
  now: Date,
): Promise<AppStackRevisionRow | null> {
  if (deployment.replacedRevisionId === null || deployment.revisionId !== stack.desiredRevisionId) return null;
  const replaced = await revisionOf(db, stack.id, deployment.replacedRevisionId);
  if (!replaced) return null;
  const ingress = planList(replaced.plan, "ingress");
  const domains = await db
    .select({ componentKey: appStackDomains.componentKey, internalPort: appStackDomains.internalPort, pathRoutes: appStackDomains.pathRoutes })
    .from(appStackDomains)
    .where(eq(appStackDomains.stackId, stack.id));
  const isIngress = (componentKey: string, port: number) => ingress.some((route) => route.componentKey === componentKey && route.port === port);
  // ADR-0037: a path saved while the operation ran was checked against the desired plan only.
  if (domains.some((d) => !isIngress(d.componentKey, d.internalPort) || d.pathRoutes.some((path) => !isIngress(path.componentKey, path.port)))) {
    return null;
  }

  const scope = { organizationId: stack.organizationId, stackId: stack.id };
  await db.delete(appStackParameters).where(eq(appStackParameters.stackId, stack.id));
  await insertParameters(db, scope, replaced.parameters.map((p) => ({ parameterKey: p.key, value: p.value })));
  await syncComponentsAndVolumes(db, scope, { componentKeys: planKeys(replaced.plan), volumeKeys: [] });
  // A row the request dropped comes back as the applied revision left it (none when that revision lacks it); its health
  // is the next observation's.
  const applied = await revisionOf(db, stack.id, stack.appliedRevisionId);
  if (applied) {
    await db
      .update(appStackComponents)
      .set({ appliedRevisionId: applied.id, updatedAt: now })
      .where(and(eq(appStackComponents.stackId, stack.id), inArray(appStackComponents.componentKey, planKeys(applied.plan))));
  }
  const desired = await revisionOf(db, stack.id, stack.desiredRevisionId);
  // The exact reverse of the request's charge; never refused, as another application may have taken a share it freed.
  await chargeAppStackQuota(db, {
    ...scope,
    hostAllocationId: stack.hostAllocationId,
    resourceQuotaId: stack.resourceQuotaId,
    previous: desired && totals(desired),
    next: totals(replaced),
    restore: true,
  });
  return replaced;
}

async function enqueueDeployment(
  tx: DatabaseExecutor,
  input: StackScope & {
    kind: AppStackOperationKind;
    revisionId: string | null;
    /** The desired revision this request replaced with `revisionId`; null when it wrote none. */
    replacedRevisionId: string | null;
    /** The stack status the request replaced; null for the first deploy of a create. */
    replacedStatus: AppStackStatus | null;
    requestedByUserId: string | null;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<{ deployment: AppStackDeploymentRow; operation: OperationRow }> {
  const deploymentId = newAppEntityId("sdep");
  const { operation } = await enqueueOperationTransactional(tx as unknown as HostingPanelDatabase, {
    organizationId: input.organizationId,
    kind: input.kind,
    resourceType: APP_STACK_RESOURCE_TYPE,
    resourceId: input.stackId,
    requestedByUserId: input.requestedByUserId ?? undefined,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    lockKey: appStackLockKey(input.stackId),
    outboxPayload: { stackId: input.stackId, deploymentId, revisionId: input.revisionId },
    steps: appStackOperationSteps(input.kind),
  });
  const [deployment] = await tx
    .insert(appStackDeployments)
    .values({
      id: deploymentId,
      stackId: input.stackId,
      organizationId: input.organizationId,
      operationId: operation.id,
      revisionId: input.revisionId,
      replacedRevisionId: input.replacedRevisionId,
      replacedStatus: input.replacedStatus,
      status: "queued",
      startedAt: new Date(),
    })
    .returning();
  return { deployment: deployment!, operation };
}

/** One transaction: organisation lock, replay, limit, published version, stack, parameters and (deploy) revision 1 + operation. */
export async function createAppStackTransactional(db: HostingPanelDatabase, input: CreateAppStackInput): Promise<AppStackWriteResult> {
  return db.transaction(async (tx) => {
    const usage = await lockAppStackLimitUsage(tx, input.organizationId);
    const [existing] = await tx
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.organizationId, input.organizationId), eq(appStacks.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw codedError(`Idempotency key '${input.idempotencyKey}' was already used for a different request`, "IDEMPOTENCY_CONFLICT");
      }
      const [own] = await tx
        .select({ operation: operations, deployment: appStackDeployments })
        .from(operations)
        .innerJoin(appStackDeployments, eq(appStackDeployments.operationId, operations.id))
        .where(
          and(
            eq(operations.organizationId, input.organizationId),
            eq(operations.idempotencyKey, input.idempotencyKey),
            eq(appStackDeployments.stackId, existing.id),
          ),
        );
      return {
        stack: existing,
        revision: await revisionOf(tx, existing.id, own?.deployment.revisionId ?? null),
        deployment: own?.deployment ?? null,
        operation: own?.operation ?? null,
        idempotentReplay: true,
      };
    }
    if (usage.maxAppStacks !== null && usage.usedAppStacks >= usage.maxAppStacks) {
      throw new AppStackQuotaError("appStacks", usage.usedAppStacks, usage.maxAppStacks);
    }
    const published = await getPublishedAppTemplateVersion(tx, { templateVersionId: input.templateVersionId, lock: true });
    if (!published) {
      throw new AppStackRepositoryError("TEMPLATE_UNPUBLISHED", "This application is not available for installation.");
    }
    const scope = { organizationId: input.organizationId, stackId: input.stackId };
    if (input.deploy) {
      assertRevision(input.deploy, { ...scope, hostAllocationId: input.hostAllocationId, templateVersionId: input.templateVersionId });
    } else {
      const keys = input.componentKeys;
      if (
        keys.length < 1 ||
        keys.length > APP_TEMPLATE_LIMITS.services ||
        new Set(keys).size !== keys.length ||
        !keys.every((k) => APP_STACK_KEY_PATTERN.test(k))
      ) {
        throw codedError("The component keys are invalid.", "VALIDATION_ERROR");
      }
    }

    const now = new Date();
    let stack: AppStackRow;
    try {
      [stack] = (await tx
        .insert(appStacks)
        .values({
          id: input.stackId,
          organizationId: input.organizationId,
          hostAllocationId: input.hostAllocationId,
          templateId: published.template.id,
          templateVersionId: input.templateVersionId,
          name: input.name,
          status: input.deploy ? "queued" : "draft",
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning()) as [AppStackRow];
    } catch (err) {
      if (hasPgError(err, "23505", "uq_app_stacks_name_live")) {
        throw new AppStackRepositoryError("NAME_TAKEN", "An application with this name already exists.");
      }
      throw err;
    }
    if (!input.deploy) {
      await insertParameters(tx, scope, input.parameters);
      await tx.insert(appStackComponents).values(input.componentKeys.map((componentKey) => ({ ...scope, componentKey })));
      return { stack, revision: null, deployment: null, operation: null, idempotentReplay: false };
    }
    await insertParameters(tx, scope, input.deploy.parameters);

    const revision = await insertRevision(tx, scope, input.deploy, 1);
    await syncComponentsAndVolumes(tx, scope, input.deploy);
    await chargeAppStackQuota(tx, {
      ...scope,
      hostAllocationId: input.hostAllocationId,
      resourceQuotaId: null,
      previous: null,
      next: totals(revision),
    });
    const { deployment, operation } = await enqueueDeployment(tx, {
      ...scope,
      kind: "stack.deploy",
      revisionId: revision.id,
      replacedRevisionId: null,
      replacedStatus: null,
      requestedByUserId: input.createdBy,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    });
    [stack] = (await tx
      .update(appStacks)
      .set({ desiredRevisionId: revision.id, updatedAt: now })
      .where(eq(appStacks.id, input.stackId))
      .returning()) as [AppStackRow];
    return { stack, revision, deployment, operation, idempotentReplay: false };
  });
}

/** One transaction: the request side of every stack operation (status, revision, components, volumes, quota, deployment). */
export async function enqueueAppStackOperationTransactional(
  db: HostingPanelDatabase,
  input: EnqueueAppStackOperationInput,
): Promise<AppStackWriteResult> {
  return db.transaction(async (tx) => {
    await lockAppStackLimitUsage(tx, input.organizationId);
    const [prior] = await tx
      .select()
      .from(operations)
      .where(and(eq(operations.organizationId, input.organizationId), eq(operations.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.kind !== input.kind || prior.resourceId !== input.stackId || prior.requestHash !== input.requestHash) {
        throw codedError(`Idempotency key '${input.idempotencyKey}' was already used for a different request`, "IDEMPOTENCY_CONFLICT");
      }
      const [stack] = await tx
        .select()
        .from(appStacks)
        .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId)));
      if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
      const [deployment] = await tx.select().from(appStackDeployments).where(eq(appStackDeployments.operationId, prior.id));
      return {
        stack,
        revision: await revisionOf(tx, stack.id, deployment?.revisionId ?? null),
        deployment: deployment ?? null,
        operation: prior,
        idempotentReplay: true,
      };
    }

    const revisionKind = (APP_STACK_REVISION_KINDS as readonly AppStackOperationKind[]).includes(input.kind);
    const next = revisionKind ? input.revision : null;
    // Header lock order: the template row before the stack row.
    const published =
      next && input.kind !== "stack.rollback"
        ? await getPublishedAppTemplateVersion(tx, { templateVersionId: next.templateVersionId, lock: true })
        : null;
    const [stack] = await tx
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
      .for("update");
    if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
    const lockKey = appStackLockKey(stack.id);
    const [active] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(and(eq(operations.lockKey, lockKey), inArray(operations.status, [...ACTIVE_OPERATION_LOCK_STATUSES])));
    if (active) throw codedError(`Resource lock '${lockKey}' is currently held by active operation '${active.id}'`, "RESOURCE_LOCKED");
    const target = appStackEnqueueTarget(input.kind, stack.status);
    if (target === null) {
      throw new AppStackRepositoryError("INVALID_TRANSITION", `This action is not available while the application is ${stack.status}.`, stack.status);
    }
    const redeployed = input.kind === "stack.deploy" && input.routesOnly === true ? stack.appliedRevisionId : stack.desiredRevisionId;
    if (revisionKind && next === null && (input.kind !== "stack.deploy" || redeployed === null)) {
      throw new AppStackRepositoryError("NO_REVISION", "There is no version of this application to install.");
    }

    const scope = { organizationId: stack.organizationId, stackId: stack.id };
    const now = new Date();
    let revision: AppStackRevisionRow | null = null;
    if (next) {
      if (input.kind === "stack.rollback") {
        if (!(await getAppTemplateVersion(tx, { templateId: stack.templateId, versionId: next.templateVersionId }))) {
          throw new AppStackRepositoryError("TEMPLATE_MISMATCH", "That version belongs to another application.");
        }
      } else if (!published) {
        throw new AppStackRepositoryError("TEMPLATE_UNPUBLISHED", "This version is not available.");
      } else if (published.template.id !== stack.templateId) {
        throw new AppStackRepositoryError("TEMPLATE_MISMATCH", "That version belongs to another application.");
      }
      assertRevision(next, { ...scope, hostAllocationId: stack.hostAllocationId, templateVersionId: next.templateVersionId });
      const ingress = planList(next.plan, "ingress");
      const domains = await tx
        .select({ componentKey: appStackDomains.componentKey, internalPort: appStackDomains.internalPort, pathRoutes: appStackDomains.pathRoutes })
        .from(appStackDomains)
        .where(eq(appStackDomains.stackId, stack.id));
      const isIngress = (componentKey: string, port: number) => ingress.some((route) => route.componentKey === componentKey && route.port === port);
      if (domains.some((d) => !isIngress(d.componentKey, d.internalPort))) {
        throw new AppStackRepositoryError("COMPONENT_IN_USE", "A web address still points at a part this version removes.");
      }
      // ADR-0037: a path committed after the API checked the plan would stop routing unseen.
      if (domains.some((d) => d.pathRoutes.some((path) => !isIngress(path.componentKey, path.port)))) {
        throw new AppStackRepositoryError("PATH_IN_USE", "A path of a web address still points at a part this version removes.");
      }

      const [last] = await tx
        .select({ n: max(appStackRevisions.revisionNumber) })
        .from(appStackRevisions)
        .where(eq(appStackRevisions.stackId, stack.id));
      revision = await insertRevision(tx, scope, next, (last?.n ?? 0) + 1);
      await tx.delete(appStackParameters).where(eq(appStackParameters.stackId, stack.id));
      await insertParameters(tx, scope, next.parameters);
      await syncComponentsAndVolumes(tx, scope, next);
      const previous = await revisionOf(tx, stack.id, stack.desiredRevisionId);
      await chargeAppStackQuota(tx, {
        ...scope,
        hostAllocationId: stack.hostAllocationId,
        resourceQuotaId: stack.resourceQuotaId,
        previous: previous && totals(previous),
        next: totals(revision),
      });
    }
    if (input.kind === "stack.delete") {
      await tx
        .update(appStackVolumes)
        .set({ retentionPolicy: input.destroyData ? "destroy" : "retain", updatedAt: now })
        .where(eq(appStackVolumes.stackId, stack.id));
    }
    const revisionId = revision?.id ?? redeployed;
    const { deployment, operation } = await enqueueDeployment(tx, {
      ...scope,
      kind: input.kind,
      revisionId,
      replacedRevisionId: revision ? stack.desiredRevisionId : null,
      replacedStatus: stack.status,
      requestedByUserId: input.requestedByUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
    });
    const [updated] = await tx
      .update(appStacks)
      .set({
        status: target,
        updatedAt: now,
        ...(revision ? { desiredRevisionId: revision.id, templateVersionId: revision.templateVersionId } : {}),
      })
      .where(eq(appStacks.id, stack.id))
      .returning();
    return {
      stack: updated!,
      revision: revision ?? (await revisionOf(tx, stack.id, revisionId)),
      deployment,
      operation,
      idempotentReplay: false,
    };
  });
}

/**
 * Brings an application back after a backup or a restore (ADR-0038): a normal `stack.start` when it is stopped, a
 * `stack.restart` when the stop left it degraded. Call it from the `after` hook of `settleOperation`, once the source
 * operation is terminal: one active operation per `stack:<id>` lock. Null when there is nothing to start (deleted,
 * never installed, or in a status neither action accepts).
 */
export async function enqueueAppStackResumeTransactional(
  tx: DatabaseExecutor,
  input: StackScope & { readonly requestedByUserId: string | null; readonly sourceOperationId: string },
): Promise<{ deployment: AppStackDeploymentRow; operation: OperationRow; kind: AppStackOperationKind } | null> {
  const [stack] = await tx
    .select()
    .from(appStacks)
    .where(and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt)))
    .for("update");
  if (!stack || stack.desiredRevisionId === null) return null;
  const kind = stack.status === "stopped" ? "stack.start" : stack.status === "degraded" ? "stack.restart" : null;
  const target = kind === null ? null : appStackEnqueueTarget(kind, stack.status);
  if (kind === null || target === null) return null;
  const key = `resume:${input.sourceOperationId}`;
  const queued = await enqueueDeployment(tx, {
    organizationId: stack.organizationId,
    stackId: stack.id,
    kind,
    revisionId: stack.desiredRevisionId,
    replacedRevisionId: null,
    replacedStatus: stack.status,
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: key,
    requestHash: createHash("sha256").update(key).digest("hex"),
  });
  await tx.update(appStacks).set({ status: target, updatedAt: new Date() }).where(eq(appStacks.id, stack.id));
  return { ...queued, kind };
}

async function lockStack(db: DatabaseExecutor, scope: StackScope, liveOnly: boolean): Promise<AppStackRow> {
  const [stack] = await db
    .select()
    .from(appStacks)
    .where(
      and(
        eq(appStacks.id, scope.stackId),
        eq(appStacks.organizationId, scope.organizationId),
        liveOnly ? isNull(appStacks.deletedAt) : undefined,
      ),
    )
    .for("update");
  if (!stack) throw new AppStackRepositoryError("NOT_FOUND", "Application not found.");
  return stack;
}

function assertTransition(from: AppStackStatus, to: AppStackStatus): void {
  if (from !== to && !canTransitionAppStack(from, to)) {
    throw new AppStackRepositoryError("INVALID_TRANSITION", `The application cannot move from ${from} to ${to}.`, from);
  }
}

/** queued → deploying, or any allowed move; same status → no-op. `deleted` is reached only through a deployment settle. */
export async function transitionAppStackTransactional(
  db: DatabaseExecutor,
  input: StackScope & { readonly to: Exclude<AppStackStatus, "deleted"> },
): Promise<AppStackRow> {
  const stack = await lockStack(db, input, true);
  if (stack.status === input.to) return stack;
  assertTransition(stack.status, input.to);
  const [updated] = await db
    .update(appStacks)
    .set({ status: input.to, updatedAt: new Date() })
    .where(eq(appStacks.id, stack.id))
    .returning();
  return updated!;
}

/**
 * Deployment progress/outcome plus the stack status in one call. `ended_at` is set on a terminal deployment status.
 * appliedRevisionId: sets app_stacks.applied_revision_id and applied_revision_id of every component row.
 * restoreReplaced: an upgrade or a rollback that changed nothing on the executor; the desired revision, template version,
 * parameters, component rows and quota become those of the revision its request replaced (see restoreReplacedRevision).
 * stackStatus "deleted" finalises: quota released, domain rows deleted, volumes retain→retained / destroy, pending or missing→removed,
 * component rows deleted, status + deleted_at set, then secret versions purged when no volume is `retained`.
 */
export async function updateAppStackDeploymentTransactional(
  db: DatabaseExecutor,
  input: StackScope & {
    readonly deploymentId: string;
    readonly deploymentStatus: AppStackDeploymentStatus;
    readonly problem: string | null;
    readonly stackStatus: AppStackStatus | null;
    readonly appliedRevisionId?: string;
    readonly appliedRoutesHash?: string | null;
    /** Written with appliedRoutesHash only; a routes hash written without it clears it (not known). */
    readonly appliedAddressesHash?: string;
    readonly restoreReplaced?: boolean;
  },
): Promise<AppStackRow> {
  const stack = await lockStack(db, input, false);
  if (input.stackStatus !== null) assertTransition(stack.status, input.stackStatus);
  const now = new Date();
  const terminal = (APP_STACK_TERMINAL_DEPLOYMENT_STATUSES as readonly AppStackDeploymentStatus[]).includes(input.deploymentStatus);
  const [deployment] = await db
    .update(appStackDeployments)
    .set({ status: input.deploymentStatus, problem: input.problem, ...(terminal ? { endedAt: now } : {}) })
    .where(and(eq(appStackDeployments.id, input.deploymentId), eq(appStackDeployments.stackId, stack.id)))
    .returning({ revisionId: appStackDeployments.revisionId, replacedRevisionId: appStackDeployments.replacedRevisionId });
  if (!deployment) throw new AppStackRepositoryError("NOT_FOUND", "Deployment not found.");
  if (input.appliedRevisionId !== undefined) {
    await db
      .update(appStackComponents)
      .set({ appliedRevisionId: input.appliedRevisionId, updatedAt: now })
      .where(eq(appStackComponents.stackId, stack.id));
  }
  const restored = input.restoreReplaced === true ? await restoreReplacedRevision(db, stack, deployment, now) : null;

  const deleted = input.stackStatus === "deleted" && stack.status !== "deleted";
  if (deleted) {
    const desired = await revisionOf(db, stack.id, stack.desiredRevisionId);
    await chargeAppStackQuota(db, {
      organizationId: stack.organizationId,
      stackId: stack.id,
      hostAllocationId: stack.hostAllocationId,
      resourceQuotaId: stack.resourceQuotaId,
      previous: desired && totals(desired),
      next: null,
    });
    await db.delete(appStackDomains).where(eq(appStackDomains.stackId, stack.id));
    await db
      .update(appStackVolumes)
      .set({
        status: sql`CASE WHEN ${appStackVolumes.retentionPolicy} = 'destroy' OR ${appStackVolumes.status} IN ('pending', 'missing') THEN 'removed' ELSE 'retained' END`,
        updatedAt: now,
      })
      .where(eq(appStackVolumes.stackId, stack.id));
    await db.delete(appStackComponents).where(eq(appStackComponents.stackId, stack.id));
  }
  const [updated] = await db
    .update(appStacks)
    .set({
      updatedAt: now,
      ...(input.stackStatus !== null ? { status: input.stackStatus } : {}),
      ...(deleted ? { deletedAt: now } : {}),
      ...(input.appliedRevisionId !== undefined ? { appliedRevisionId: input.appliedRevisionId } : {}),
      ...(input.appliedRoutesHash !== undefined
        ? { appliedRoutesHash: input.appliedRoutesHash, appliedAddressesHash: input.appliedAddressesHash ?? null }
        : {}),
      ...(restored ? { desiredRevisionId: restored.id, templateVersionId: restored.templateVersionId } : {}),
    })
    .where(eq(appStacks.id, stack.id))
    .returning();
  if (deleted) {
    const [retained] = await db
      .select({ key: appStackVolumes.volumeKey })
      .from(appStackVolumes)
      .where(and(eq(appStackVolumes.stackId, stack.id), eq(appStackVolumes.status, "retained")))
      .limit(1);
    if (!retained) await db.delete(appStackSecrets).where(eq(appStackSecrets.stackId, stack.id));
  }
  return updated!;
}

/** Unknown component keys are ignored. */
export async function recordAppStackComponentHealthTransactional(
  db: DatabaseExecutor,
  input: StackScope & {
    readonly observedAt: Date;
    readonly components: readonly { readonly componentKey: string; readonly health: AppStackComponentHealth }[];
  },
): Promise<void> {
  for (const component of input.components) {
    await db
      .update(appStackComponents)
      .set({ health: component.health, healthObservedAt: input.observedAt, updatedAt: new Date() })
      .where(
        and(
          eq(appStackComponents.stackId, input.stackId),
          eq(appStackComponents.organizationId, input.organizationId),
          eq(appStackComponents.componentKey, component.componentKey),
        ),
      );
  }
}

export async function setAppStackVolumeStatusTransactional(
  db: DatabaseExecutor,
  input: StackScope & { readonly volumeKeys: readonly string[]; readonly status: AppStackVolumeStatus },
): Promise<void> {
  if (input.volumeKeys.length === 0) return;
  await db
    .update(appStackVolumes)
    .set({ status: input.status, updatedAt: new Date() })
    .where(
      and(
        eq(appStackVolumes.stackId, input.stackId),
        eq(appStackVolumes.organizationId, input.organizationId),
        inArray(appStackVolumes.volumeKey, [...input.volumeKeys]),
      ),
    );
}

/**
 * Boot repair: a busy stack with no active operation on its lock key → `failed` (`deleting` → `delete_failed`,
 * `stopping` → `unknown`: only moves the transition table allows); a queued/running deployment whose operation is no
 * longer active → `failed`, problem OPERATION_INTERRUPTED. Returns the number of stacks repaired.
 */
export async function repairOrphanedAppStackStatusesTransactional(db: HostingPanelDatabase): Promise<number> {
  const active = [...ACTIVE_OPERATION_LOCK_STATUSES];
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(appStackDeployments)
      .set({ status: "failed", problem: "OPERATION_INTERRUPTED", endedAt: now })
      .where(
        and(
          inArray(appStackDeployments.status, ["queued", "running"]),
          sql`NOT EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.id} = ${appStackDeployments.operationId} AND ${inArray(operations.status, active)})`,
        ),
      );
    const repaired = await tx
      .update(appStacks)
      .set({
        status: sql`CASE ${appStacks.status} WHEN 'deleting' THEN 'delete_failed' WHEN 'stopping' THEN 'unknown' ELSE 'failed' END`,
        updatedAt: now,
      })
      .where(
        and(
          inArray(appStacks.status, [...APP_STACK_BUSY_STATUSES]),
          sql`NOT EXISTS (SELECT 1 FROM ${operations} WHERE ${operations.lockKey} = 'stack:' || ${appStacks.id} AND ${inArray(operations.status, active)})`,
        ),
      )
      .returning({ id: appStacks.id });
    return repaired.length;
  });
}

/** The organisation's active Dedicated allocation (oldest first). */
export async function findAppStackAllocation(db: DatabaseExecutor, organizationId: string): Promise<{ id: string; hostId: string } | null> {
  const [row] = await db
    .select({ id: hostAllocations.id, hostId: hostAllocations.hostId })
    .from(hostAllocations)
    .where(
      and(
        eq(hostAllocations.organizationId, organizationId),
        eq(hostAllocations.status, "active"),
        eq(hostAllocations.hostingMode, "dedicated"),
        eq(hostAllocations.dedicatedScope, true),
      ),
    )
    .orderBy(asc(hostAllocations.createdAt), asc(hostAllocations.id))
    .limit(1);
  return row ?? null;
}

const liveStackWhere = (input: StackScope) =>
  and(eq(appStacks.id, input.stackId), eq(appStacks.organizationId, input.organizationId), isNull(appStacks.deletedAt));
const liveStack = (db: DatabaseExecutor, input: StackScope): SQL =>
  exists(db.select({ id: appStacks.id }).from(appStacks).where(liveStackWhere(input)));

export async function getAppStack(db: DatabaseExecutor, input: StackScope): Promise<AppStackRow | null> {
  const [row] = await db.select().from(appStacks).where(liveStackWhere(input));
  return row ?? null;
}

/** ORDER BY created_at DESC, id DESC; `after` is the last row of the previous page. */
export function listAppStacks(
  db: DatabaseExecutor,
  input: { organizationId: string; limit: number; after?: { createdAt: Date; id: string } },
): Promise<AppStackRow[]> {
  const { after } = input;
  return db
    .select()
    .from(appStacks)
    .where(
      and(
        eq(appStacks.organizationId, input.organizationId),
        isNull(appStacks.deletedAt),
        after ? or(lt(appStacks.createdAt, after.createdAt), and(eq(appStacks.createdAt, after.createdAt), lt(appStacks.id, after.id))) : undefined,
      ),
    )
    .orderBy(desc(appStacks.createdAt), desc(appStacks.id))
    .limit(input.limit);
}

/** Cross-organization, for the runtime observer and recovery; ORDER BY updated_at, id. */
export async function listAppStacksByStatus(
  db: DatabaseExecutor,
  input: { statuses: readonly AppStackStatus[]; limit: number },
): Promise<AppStackRow[]> {
  if (input.statuses.length === 0) return [];
  return db
    .select()
    .from(appStacks)
    .where(inArray(appStacks.status, [...input.statuses]))
    .orderBy(asc(appStacks.updatedAt), asc(appStacks.id))
    .limit(input.limit);
}

/** Works on a deleted stack too (history is kept). */
export async function getAppStackRevision(
  db: DatabaseExecutor,
  input: StackScope & { revisionId: string },
): Promise<AppStackRevisionRow | null> {
  const [row] = await db
    .select()
    .from(appStackRevisions)
    .where(
      and(
        eq(appStackRevisions.id, input.revisionId),
        eq(appStackRevisions.stackId, input.stackId),
        eq(appStackRevisions.organizationId, input.organizationId),
      ),
    );
  return row ?? null;
}

/** revision_number DESC. */
export function listAppStackRevisions(db: DatabaseExecutor, input: StackScope): Promise<AppStackRevisionRow[]> {
  return db
    .select()
    .from(appStackRevisions)
    .where(and(eq(appStackRevisions.stackId, input.stackId), eq(appStackRevisions.organizationId, input.organizationId), liveStack(db, input)))
    .orderBy(desc(appStackRevisions.revisionNumber));
}

export function listAppStackParameters(db: DatabaseExecutor, input: StackScope): Promise<AppStackParameterRow[]> {
  return db
    .select()
    .from(appStackParameters)
    .where(and(eq(appStackParameters.stackId, input.stackId), eq(appStackParameters.organizationId, input.organizationId), liveStack(db, input)))
    .orderBy(asc(appStackParameters.parameterKey));
}

export function listAppStackComponents(db: DatabaseExecutor, input: StackScope): Promise<AppStackComponentRow[]> {
  return db
    .select()
    .from(appStackComponents)
    .where(and(eq(appStackComponents.stackId, input.stackId), eq(appStackComponents.organizationId, input.organizationId), liveStack(db, input)))
    .orderBy(asc(appStackComponents.componentKey));
}

/** `includeDeleted`: also the volumes of a deleted stack (retained or removed). */
export function listAppStackVolumes(db: DatabaseExecutor, input: StackScope & { includeDeleted?: boolean }): Promise<AppStackVolumeRow[]> {
  return db
    .select()
    .from(appStackVolumes)
    .where(
      and(
        eq(appStackVolumes.stackId, input.stackId),
        eq(appStackVolumes.organizationId, input.organizationId),
        input.includeDeleted === true ? undefined : liveStack(db, input),
      ),
    )
    .orderBy(asc(appStackVolumes.volumeKey));
}

/** Works on a deleted stack too (history is kept). */
export async function getAppStackDeployment(
  db: DatabaseExecutor,
  input: { organizationId: string; deploymentId: string },
): Promise<AppStackDeploymentRow | null> {
  const [row] = await db
    .select()
    .from(appStackDeployments)
    .where(and(eq(appStackDeployments.id, input.deploymentId), eq(appStackDeployments.organizationId, input.organizationId)));
  return row ?? null;
}

/** ORDER BY started_at DESC, id DESC; `after` is the last row of the previous page. */
export function listAppStackDeployments(
  db: DatabaseExecutor,
  input: StackScope & { limit: number; after?: { startedAt: Date; id: string } },
): Promise<AppStackDeploymentRow[]> {
  const { after } = input;
  return db
    .select()
    .from(appStackDeployments)
    .where(
      and(
        eq(appStackDeployments.stackId, input.stackId),
        eq(appStackDeployments.organizationId, input.organizationId),
        liveStack(db, input),
        after
          ? or(
              lt(appStackDeployments.startedAt, after.startedAt),
              and(eq(appStackDeployments.startedAt, after.startedAt), lt(appStackDeployments.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(appStackDeployments.startedAt), desc(appStackDeployments.id))
    .limit(input.limit);
}
