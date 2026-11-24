import { APP_STACK_REVISION_KINDS, APP_STACK_TERMINAL_DEPLOYMENT_STATUSES, ApprovedStackPlanSchema, type AppStackOperationKind } from "@hosting-panel/contracts";
import {
  and,
  appStackDeployments,
  appStacks,
  eq,
  getAppStackRevision,
  listAppStackDomains,
  listAppStackVolumes,
  operationSteps,
  settleOperation,
  type operations,
} from "@hosting-panel/database";
import { appStackPort, type AppStackRuntimeDeps } from "./app-stack-runtime.js";
import {
  APP_STACK_FAILURE,
  appStackAggregate,
  appStackHealthRows,
  appStackRecoveryVerdict,
  appStackRoutePlan,
  appStackRoutesHash,
  appStackRoutesRefresh,
  type ObservedAppStack,
} from "./app-stack-runtime-policy.js";
import { closeUnconfirmedOperation, type RecoveryOutcome, type RecoveryReadBound } from "../runtime/recovery-read-bound.js";
import { parkAppStackOperationUnknown, settleAppStackOperation, writeAppStackSettlement } from "./app-stack-settle.js";

// Spec §10.1, A17: an operation in doubt is settled from what the executor shows, never by continuing or replaying it.
// A failed read keeps it unknown (lock and quota held) for the next pass; the read is a GET, never in doubt itself.
// A read that keeps failing in a way waiting does not cure is given up after RECOVERY_READ_GIVE_UP_MS (issue #183).

const INTERRUPTED = APP_STACK_FAILURE.OPERATION_INTERRUPTED;
// No route set hashes to this (an empty one is null): the observer's next pass rewrites routes of unconfirmed content.
const ROUTES_UNCONFIRMED = appStackRoutesHash([]);

/** Read-only: one getAppStackStatus, a pure verdict, one settle transaction. Never a mutating StackExecutorPort call. */
export async function recoverAppStackOperation(
  deps: AppStackRuntimeDeps,
  op: typeof operations.$inferSelect,
  reads?: RecoveryReadBound,
): Promise<RecoveryOutcome> {
  const { db } = deps;
  const kind = op.kind as AppStackOperationKind;
  const scope = { organizationId: op.organizationId, stackId: op.resourceId };
  const [deployment] = await db
    .select()
    .from(appStackDeployments)
    .where(and(eq(appStackDeployments.operationId, op.id), eq(appStackDeployments.organizationId, op.organizationId)));
  const [stack] = await db
    .select()
    .from(appStacks)
    .where(and(eq(appStacks.id, op.resourceId), eq(appStacks.organizationId, op.organizationId)));

  if (!stack || !deployment || (stack.deletedAt !== null && kind !== "stack.delete")) {
    await settleOperation(db, op.id, { status: "failed", errorCode: INTERRUPTED.code, errorMessage: INTERRUPTED.text });
    return "settled";
  }
  if (stack.deletedAt !== null) {
    // The delete's finalise already committed.
    const open = !(APP_STACK_TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(deployment.status);
    await settleAppStackOperation(db, op, open ? deployment.id : null, { outcome: "succeeded", problem: null, stackStatus: "deleted" });
    return "settled";
  }

  const port = appStackPort(deps);
  if (!port) {
    // Nothing can be read: fail closed so the customer can act again.
    await settleAppStackOperation(db, op, deployment.id, {
      outcome: "failed",
      problem: "OPERATION_INTERRUPTED",
      stackStatus: kind === "stack.delete" ? "delete_failed" : "failed",
      failedStep: null,
    });
    return "settled";
  }

  const planOf = async (revisionId: string | null) => {
    const revision = revisionId === null ? null : await getAppStackRevision(db, { ...scope, revisionId });
    const parsed = ApprovedStackPlanSchema.safeParse(revision?.plan);
    return parsed.success ? parsed.data : null;
  };
  // A route refresh judges the applied revision, as its handler does.
  const refresh = appStackRoutesRefresh(op);
  const deploys = !refresh && (APP_STACK_REVISION_KINDS as readonly string[]).includes(kind);
  const plan = await planOf(deploys ? deployment.revisionId : (stack.appliedRevisionId ?? stack.desiredRevisionId));
  const previous = deploys ? await planOf(stack.appliedRevisionId) : null;

  let observed: ObservedAppStack;
  try {
    observed = await port.getAppStackStatus(scope);
  } catch (err) {
    await parkAppStackOperationUnknown(db, op, deployment.id);
    const giveUp = reads?.failed(op.id, err) ?? null;
    if (giveUp === null) return "pending";
    // The deployment fails with OPERATION_AMBIGUOUS. Nothing is sent: what the action did is not known, so nothing is
    // undone or repeated. The application is left `unknown` (to be checked; every action is offered again); a delete
    // leaves it `delete_failed`, as when nothing can be read, whose only action is Delete again, and the executor's
    // removal passes over what the first one already removed.
    const closed = await closeUnconfirmedOperation(db, op.id, giveUp, (tx) =>
      writeAppStackSettlement(tx, op, deployment.id, {
        outcome: "failed",
        problem: "OPERATION_AMBIGUOUS",
        stackStatus: kind === "stack.delete" ? "delete_failed" : "unknown",
        failedStep: null,
      }),
    );
    return closed ? "unconfirmed" : "pending";
  }
  reads?.answered(op.id);

  const domains = await listAppStackDomains(db, scope);
  const now = new Date(deps.clock.now());
  if (refresh) {
    // Settled as the refresh would have: done when the routes seen are today's addresses of the ready targets (the
    // hostnames do not depend on ACME); a route change judges no component, so the stack stays one the observer refreshes.
    const health = plan ? appStackHealthRows(plan, observed, "final") : [];
    const ready = new Set(health.filter((h) => h.health === "healthy").map((h) => h.componentKey));
    const wanted = plan
      ? appStackRoutePlan({ plan, domains, include: ready, now, acmeEnabled: false }).entries.flatMap((e) => e.hosts.map((h) => h.hostname))
      : [];
    const { published, hostnames } = observed.routes;
    const done =
      plan !== null && published === wanted.length > 0 && hostnames.length === wanted.length && wanted.every((h) => hostnames.includes(h));
    const aggregate =
      plan &&
      appStackAggregate({ plan, health: new Map(health.map((h) => [h.componentKey, h.health])), domainCount: domains.length, routesPublished: true });
    await settleAppStackOperation(db, op, deployment.id, {
      outcome: done ? "succeeded" : "failed",
      problem: done ? null : "OPERATION_INTERRUPTED",
      stackStatus: done && aggregate === "running" ? "running" : "degraded",
      appliedRoutesHash: published ? ROUTES_UNCONFIRMED : null,
      ...(health.length > 0 ? { health: { observedAt: now, components: health } } : {}),
      failedStep: null,
    });
    return "settled";
  }

  const v = appStackRecoveryVerdict({
    kind,
    plan,
    previous,
    observed,
    domainCount: domains.length,
    destroyVolumes: (await listAppStackVolumes(db, scope)).some((volume) => volume.retentionPolicy === "destroy"),
  });
  // A create step still pending was never called: an upgrade or a rollback in doubt before it changed nothing, so what
  // its request wrote is taken back, and an application that was stopped stays stopped once a revision of it was
  // applied (one never applied has no installed version a start could use). Once create has started, the executor may
  // have replaced components.
  const [create] = deploys
    ? await db
        .select({ status: operationSteps.status })
        .from(operationSteps)
        .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "create")))
    : [];
  const untouched = create?.status === "pending";
  // Routes seen published keep the stored hash; else none is published. The observer republishes a stale route set
  // through a tracked operation.
  await settleAppStackOperation(db, op, deployment.id, {
    outcome: v.outcome,
    problem: v.problem,
    // A redeploy's plan matches the stopped containers, so the verdict reads them as applied and failed.
    stackStatus:
      untouched && v.outcome === "failed" && deployment.replacedStatus === "stopped" && stack.appliedRevisionId !== null ? "stopped" : v.stackStatus,
    ...(v.applied && plan ? { appliedRevisionId: plan.revisionId } : {}),
    ...(untouched && !v.applied && (kind === "stack.upgrade" || kind === "stack.rollback") ? { restoreReplaced: true } : {}),
    ...(kind === "stack.delete" || observed.routes.published ? {} : { appliedRoutesHash: null }),
    ...(v.health.length > 0 ? { health: { observedAt: now, components: v.health } } : {}),
    failedStep: null,
  });
  return "settled";
}
