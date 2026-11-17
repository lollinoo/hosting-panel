import { setTimeout as sleep } from "node:timers/promises";
import { ERROR_CODES, type ErrorCode } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  renewOperationLease,
  settleOperation,
  updateOperationStepTransactional,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import type { DockerExecutorPort, PinnedPanelContainer } from "@hosting-panel/executor-contracts";
import { PANEL_RESTART_MAX_AGE_MS, PANEL_RESTART_START_DELAY_MS } from "../health/panel-restart.js";

type OperationRow = typeof operations.$inferSelect;

export const PANEL_APPLY_STEPS = [{ key: "apply", label: "Move the container to its pinned image" }] as const;
// The executor client's PANEL_APPLY_TIMEOUT_MS (900 s, an image pull) plus a minute of margin.
export const PANEL_APPLY_LEASE_MS = 960_000;

const FAILED_MESSAGE = "The container was not moved to its pinned image. Check Health, then try again.";
const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

const codeOf = (err: unknown): ErrorCode => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE_SET.has(code) ? (code as ErrorCode) : "INTERNAL_ERROR";
};

/** Settles the operation and writes the end row in the same transaction. */
async function settle(db: HostingPanelDatabase, op: OperationRow, errorCode: ErrorCode | null): Promise<void> {
  await settleOperation(
    db,
    op.id,
    errorCode === null ? { status: "succeeded" } : { status: "failed", errorCode, errorMessage: FAILED_MESSAGE },
    (tx) => appendAuditEvent(tx, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action: "admin.update.component.end",
      targetType: "panel_container",
      targetId: op.resourceId,
      details: { operationId: op.id, component: op.resourceId, outcome: errorCode === null ? "succeeded" : "failed", errorCode },
    }).then(() => undefined),
  );
}

/** Runs one panel.container.apply; settles succeeded or failed with the end row, never unknown. */
export async function executePanelContainerApply(
  db: HostingPanelDatabase,
  executor: DockerExecutorPort,
  op: OperationRow,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const age = now() - op.submittedAt.getTime();
    if (age > PANEL_RESTART_MAX_AGE_MS) throw Object.assign(new Error("Too old"), { code: "OPERATION_INTERRUPTED" });
    await renewOperationLease(db, op.id, PANEL_APPLY_LEASE_MS);
    // The ingress proxy may be recreated: the 202 leaves first.
    if (age < PANEL_RESTART_START_DELAY_MS) await sleep(PANEL_RESTART_START_DELAY_MS - age);
    await updateOperationStepTransactional(db, op.id, "apply", "running", "Moving the container to its pinned image");
    await executor.applyPanelContainerPin(op.resourceId as PinnedPanelContainer);
    await updateOperationStepTransactional(db, op.id, "apply", "succeeded", "Container on its pinned image");
    await settle(db, op, null);
  } catch (err) {
    await updateOperationStepTransactional(db, op.id, "apply", "failed", FAILED_MESSAGE).catch(() => undefined);
    await settle(db, op, codeOf(err));
  }
}

/** Settles an apply left unknown by a dead API as failed (OPERATION_INTERRUPTED) with the end row. */
export async function recoverPanelContainerApply(db: HostingPanelDatabase, op: OperationRow): Promise<void> {
  await settle(db, op, "OPERATION_INTERRUPTED");
}
