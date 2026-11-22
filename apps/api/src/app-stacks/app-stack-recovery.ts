import { APP_STACK_REVISION_KINDS, APP_STACK_TERMINAL_DEPLOYMENT_STATUSES, ApprovedStackPlanSchema, type AppStackOperationKind } from "@hosting-panel/contracts";
import {
  and,
  appStackDeployments,
  appStacks,
  eq,
  getAppStackRevision,
  listAppStackDomains,
  listAppStackVolumes,
  settleOperation,
  type operations,
} from "@hosting-panel/database";
import { appStackPort, type AppStackRuntimeDeps } from "./app-stack-runtime.js";
import { APP_STACK_FAILURE, appStackRecoveryVerdict, type ObservedAppStack } from "./app-stack-runtime-policy.js";
import { parkAppStackOperationUnknown, settleAppStackOperation } from "./app-stack-settle.js";

// Spec §10.1, A17: an operation in doubt is settled from what the executor shows, never by continuing or replaying it.
// A failed read keeps it unknown (lock and quota held) for the next pass; the read is a GET, never in doubt itself.

const INTERRUPTED = APP_STACK_FAILURE.OPERATION_INTERRUPTED;

/** Read-only: one getAppStackStatus, a pure verdict, one settle transaction. Never a mutating StackExecutorPort call. */
export async function recoverAppStackOperation(
  deps: AppStackRuntimeDeps,
  op: typeof operations.$inferSelect,
): Promise<"pending" | "settled"> {
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

  const revisionId = (APP_STACK_REVISION_KINDS as readonly string[]).includes(kind)
    ? deployment.revisionId
    : (stack.appliedRevisionId ?? stack.desiredRevisionId);
  const revision = revisionId === null ? null : await getAppStackRevision(db, { ...scope, revisionId });
  const parsed = ApprovedStackPlanSchema.safeParse(revision?.plan);
  const plan = parsed.success ? parsed.data : null;

  let observed: ObservedAppStack;
  try {
    observed = await port.getAppStackStatus(scope);
  } catch {
    await parkAppStackOperationUnknown(db, op, deployment.id);
    return "pending";
  }

  const v = appStackRecoveryVerdict({
    kind,
    plan,
    observed,
    domainCount: (await listAppStackDomains(db, scope)).length,
    destroyVolumes: (await listAppStackVolumes(db, scope)).some((volume) => volume.retentionPolicy === "destroy"),
  });
  // The published route content is unknown: the observer republishes a fresh plan through a tracked operation.
  await settleAppStackOperation(db, op, deployment.id, {
    outcome: v.outcome,
    problem: v.problem,
    stackStatus: v.stackStatus,
    ...(v.applied && plan ? { appliedRevisionId: plan.revisionId } : {}),
    ...(kind === "stack.delete" ? {} : { appliedRoutesHash: null }),
    ...(v.health.length > 0 ? { health: { observedAt: new Date(deps.clock.now()), components: v.health } } : {}),
    failedStep: null,
  });
  return "settled";
}
