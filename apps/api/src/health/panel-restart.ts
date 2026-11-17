import { setTimeout as sleep } from "node:timers/promises";
import { ERROR_CODES, type ErrorCode, type PanelContainer } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  renewOperationLease,
  settleOperation,
  updateOperationStepTransactional,
  type HostingPanelDatabase,
  type operations,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";

type OperationRow = typeof operations.$inferSelect;

export const PANEL_RESTART_STEPS = [{ key: "restart", label: "Restart the container" }] as const;
export const PANEL_RESTART_START_DELAY_MS = 2_000; // the 202 leaves before the proxy restarts
export const PANEL_RESTART_MAX_AGE_MS = 60_000; // older requests fail, nobody is watching
// The executor client's PANEL_RESTART_TIMEOUT_MS (35 s) plus a minute of margin.
export const PANEL_RESTART_LEASE_MS = 95_000;

const FAILED_MESSAGE = "The container did not restart. Check Health, then try again.";
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
      action: "admin.panel_container.restart.end",
      targetType: "panel_container",
      targetId: op.resourceId,
      details: { operationId: op.id, component: op.resourceId, outcome: errorCode === null ? "succeeded" : "failed", errorCode },
    }).then(() => undefined),
  );
}

/** Runs one panel.container.restart; settles succeeded or failed with the end row, never unknown. */
export async function executePanelContainerRestart(
  db: HostingPanelDatabase,
  executor: DockerExecutorPort,
  op: OperationRow,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const age = now() - op.submittedAt.getTime();
    if (age > PANEL_RESTART_MAX_AGE_MS) throw Object.assign(new Error("Too old"), { code: "OPERATION_INTERRUPTED" });
    await renewOperationLease(db, op.id, PANEL_RESTART_LEASE_MS);
    if (age < PANEL_RESTART_START_DELAY_MS) await sleep(PANEL_RESTART_START_DELAY_MS - age);
    await updateOperationStepTransactional(db, op.id, "restart", "running", "Restarting the container");
    await executor.restartPanelContainer({ component: op.resourceId as PanelContainer });
    await updateOperationStepTransactional(db, op.id, "restart", "succeeded", "Container restarted");
    await settle(db, op, null);
  } catch (err) {
    await updateOperationStepTransactional(db, op.id, "restart", "failed", FAILED_MESSAGE).catch(() => undefined);
    await settle(db, op, codeOf(err));
  }
}

/** Settles a restart left unknown by a dead API as failed (OPERATION_INTERRUPTED) with the end row. */
export async function recoverPanelContainerRestart(db: HostingPanelDatabase, op: OperationRow): Promise<void> {
  await settle(db, op, "OPERATION_INTERRUPTED");
}
