import { canTransitionAppStack, type AppStackComponentHealth, type AppStackStatus, type AppStackStepKey } from "@hosting-panel/contracts";
import {
  and,
  appStacks,
  eq,
  operationSteps,
  recordAppStackComponentHealthTransactional,
  settleOperation,
  transitionAppStackTransactional,
  updateAppStackDeploymentTransactional,
  updateOperationStepTransactional,
  type DatabaseExecutor,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import {
  APP_STACK_FAILURE,
  APP_STACK_STEP_DONE_TEXT,
  APP_STACK_STEP_FAILED_TEXT,
  APP_STACK_STEP_SKIPPED_TEXT,
  appStackSettleTarget,
  type AppStackRuntimeProblem,
} from "./app-stack-runtime-policy.js";

// The database end of a stack operation: one transaction moves its steps, the stack status, the deployment and the
// component health together, so a crash leaves either the whole outcome or none of it.

type OperationRow = typeof operations.$inferSelect;
const OPEN_STEP = new Set(["pending", "running", "unknown"]);

export interface AppStackSettlement {
  readonly outcome: "succeeded" | "failed";
  /** null only with outcome succeeded and no health problem. */
  readonly problem: AppStackRuntimeProblem | null;
  /** Wanted target, filtered by appStackSettleTarget. */
  readonly stackStatus: AppStackStatus;
  /** Absent = unchanged. */
  readonly appliedRevisionId?: string;
  /** Absent = unchanged. */
  readonly appliedRoutesHash?: string | null;
  /** An upgrade or a rollback that changed nothing on the executor: what its request wrote goes back to the applied revision. */
  readonly restoreApplied?: boolean;
  readonly health?: {
    readonly observedAt: Date;
    readonly components: readonly { componentKey: string; health: AppStackComponentHealth }[];
  };
  /** Outcome failed: that step "failed"; null = every open step "failed". */
  readonly failedStep?: AppStackStepKey | null;
}

async function lockedStatus(tx: DatabaseExecutor, op: OperationRow): Promise<AppStackStatus | null> {
  const [row] = await tx
    .select({ status: appStacks.status })
    .from(appStacks)
    .where(and(eq(appStacks.id, op.resourceId), eq(appStacks.organizationId, op.organizationId)))
    .for("update");
  return row?.status ?? null;
}

/**
 * One settleOperation transaction: steps, stack status, deployment, component health. With `deploymentId` null (a
 * payload that names no deployment of this stack) only the stack moves. Returns settleOperation's result.
 */
export function settleAppStackOperation(
  db: HostingPanelDatabase,
  op: OperationRow,
  deploymentId: string | null,
  s: AppStackSettlement,
): Promise<boolean> {
  const problem = s.outcome === "failed" ? (s.problem ?? "DOCKER_ENGINE_UNAVAILABLE") : s.problem;
  const outcome =
    s.outcome === "succeeded"
      ? ({ status: "succeeded" } as const)
      : ({ status: "failed", errorCode: APP_STACK_FAILURE[problem!].code, errorMessage: APP_STACK_FAILURE[problem!].text } as const);
  return settleOperation(db, op.id, outcome, async (tx) => {
    const steps = await tx
      .select({ key: operationSteps.key, status: operationSteps.status })
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op.id));
    for (const step of steps) {
      if (!OPEN_STEP.has(step.status)) continue;
      const key = step.key as AppStackStepKey;
      if (s.outcome === "succeeded") {
        await updateOperationStepTransactional(tx, op.id, key, "succeeded", APP_STACK_STEP_DONE_TEXT[key]);
      } else if (s.failedStep == null || key === s.failedStep) {
        await updateOperationStepTransactional(tx, op.id, key, "failed", APP_STACK_STEP_FAILED_TEXT);
      } else if (step.status === "pending") {
        await updateOperationStepTransactional(tx, op.id, key, "skipped", APP_STACK_STEP_SKIPPED_TEXT);
      }
    }

    const current = await lockedStatus(tx, op);
    const target = current === null ? null : appStackSettleTarget(current, s.stackStatus);
    const scope = { organizationId: op.organizationId, stackId: op.resourceId };
    if (deploymentId === null) {
      if (target !== null && target !== current && target !== "deleted") await transitionAppStackTransactional(tx, { ...scope, to: target });
    } else {
      await updateAppStackDeploymentTransactional(tx, {
        ...scope,
        deploymentId,
        deploymentStatus: s.outcome,
        problem,
        stackStatus: target === current ? null : target,
        ...(s.appliedRevisionId === undefined ? {} : { appliedRevisionId: s.appliedRevisionId }),
        ...(s.appliedRoutesHash === undefined ? {} : { appliedRoutesHash: s.appliedRoutesHash }),
        ...(s.restoreApplied === true ? { restoreApplied: true } : {}),
      });
    }
    if (s.health && target !== "deleted") {
      await recordAppStackComponentHealthTransactional(tx, { ...scope, ...s.health });
    }
  });
}

/** Ambiguity: deployment unknown (problem OPERATION_AMBIGUOUS) and stack unknown (deleting stays deleting), one tx. Never throws. */
export async function parkAppStackOperationUnknown(
  db: HostingPanelDatabase,
  op: OperationRow,
  deploymentId: string | null,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const current = await lockedStatus(tx, op);
      if (current === null) return;
      const stackStatus = current !== "deleting" && canTransitionAppStack(current, "unknown") ? "unknown" : null;
      const scope = { organizationId: op.organizationId, stackId: op.resourceId };
      if (deploymentId === null) {
        if (stackStatus !== null) await transitionAppStackTransactional(tx, { ...scope, to: stackStatus });
        return;
      }
      await updateAppStackDeploymentTransactional(tx, {
        ...scope,
        deploymentId,
        deploymentStatus: "unknown",
        problem: "OPERATION_AMBIGUOUS",
        stackStatus,
      });
    });
  } catch {
    // Lease expiry moves the operation to unknown anyway; recovery repeats this move.
  }
}
