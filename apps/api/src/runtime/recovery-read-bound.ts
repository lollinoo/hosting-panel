import { ErrorCodeSchema, type ErrorCode } from "@hosting-panel/contracts";
import { appendAuditEvent, eq, operations, transitionOperation, type HostingPanelDatabase } from "@hosting-panel/database";

/**
 * How long the recovery of an `unknown` operation may keep failing to read the executor's answer before the panel
 * gives up and closes it (issue #183). It is above the 15 minutes of the `operation_unknown` alert on purpose: the
 * administrator is told first, and can still close the operation by hand (`hp-break-glass unlock`) before the panel
 * does.
 */
export const RECOVERY_READ_GIVE_UP_MS = 30 * 60_000;

/** What an operation closed this way says: the panel does not know how it ended, and it did not try it again. */
export const RECOVERY_UNCONFIRMED_TEXT =
  "The outcome of this action could not be confirmed. Check the state before you try again.";

/** Named after the other ends of a recovery (`operation.recovered.succeeded` / `.failed`). */
export const RECOVERY_UNCONFIRMED_AUDIT_ACTION = "operation.recovered.unconfirmed";

/**
 * Failures that waiting can cure, so they never count towards the bound: the executor cannot be reached or Docker is
 * down; the request left and no answer came back (for a read, the client gives OPERATION_AMBIGUOUS only when the
 * connection died or timed out after the request was written, never for an answer that arrived); the executor says
 * the resource is busy.
 */
const HONEST_WAITS: ReadonlySet<string> = new Set<ErrorCode>(["DOCKER_ENGINE_UNAVAILABLE", "OPERATION_AMBIGUOUS", "RESOURCE_LOCKED"]);

function codeOf(err: unknown): unknown {
  return typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
}

/** True when a failed recovery read is an honest wait; every other failure counts towards the bound. */
export function isHonestRecoveryWait(err: unknown): boolean {
  const code = codeOf(err);
  return typeof code === "string" && HONEST_WAITS.has(code);
}

/** The class of a counted failure as a fixed word, for the audit row: never the error's text or the executor's body. */
export type RecoveryReadFailure = "unreadable_answer" | "error_code" | "unexpected_error";

export function recoveryReadFailure(err: unknown): RecoveryReadFailure {
  if (err instanceof Error && err.name === "ZodError") return "unreadable_answer";
  if (ErrorCodeSchema.safeParse(codeOf(err)).success) return "error_code";
  return "unexpected_error";
}

/** Why a recovery gives up: what the audit row of the closing records. */
export interface RecoveryGiveUp {
  readonly minutesWaited: number;
  readonly failure: RecoveryReadFailure;
}

/**
 * The time of the first counted failure of each operation's recovery read, in memory: a restart of the API starts
 * every count again (a known limit, written in the runbook). The bound is over consecutive counted failures: a pass
 * that reads an answer, or fails with an honest wait, clears the entry. The worker calls `retain` with the operations
 * still `unknown` on every pass, so an operation that was settled, unlocked by hand or deleted leaves the map there.
 */
export class RecoveryReadBound {
  readonly #firstFailureAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The read returned an answer the recovery could use. */
  answered(operationId: string): void {
    this.#firstFailureAt.delete(operationId);
  }

  /** The operation was closed: its count goes. */
  forget(operationId: string): void {
    this.#firstFailureAt.delete(operationId);
  }

  /** A failed read: null while the recovery keeps waiting, the reason to give up once counted failures last the bound. */
  failed(operationId: string, err: unknown): RecoveryGiveUp | null {
    if (isHonestRecoveryWait(err)) {
      this.#firstFailureAt.delete(operationId);
      return null;
    }
    const now = this.now();
    const first = this.#firstFailureAt.get(operationId);
    if (first === undefined) {
      this.#firstFailureAt.set(operationId, now);
      return null;
    }
    const waited = now - first;
    if (waited < RECOVERY_READ_GIVE_UP_MS) return null;
    return { minutesWaited: Math.floor(waited / 60_000), failure: recoveryReadFailure(err) };
  }

  /** Drops every operation not in `operationIds` (the ones still unknown). */
  retain(operationIds: Iterable<string>): void {
    const keep = new Set(operationIds);
    for (const id of this.#firstFailureAt.keys()) if (!keep.has(id)) this.#firstFailureAt.delete(id);
  }

  get size(): number {
    return this.#firstFailureAt.size;
  }
}

/** What a recovery did on one pass: still waiting, settled from an answer, or closed by the bound. */
export type RecoveryOutcome = "pending" | "settled" | "unconfirmed";

/**
 * Closes an operation whose recovery could not read the executor's answer for the whole bound: `unknown → failed`
 * with OPERATION_AMBIGUOUS and a fixed text, the caller's resource rows written in the same transaction, one audit row.
 * Nothing is sent to the executor. False, and nothing written, when the operation is no longer `unknown` (settled
 * meanwhile, or unlocked by hand with `hp-break-glass unlock`): the row is locked and checked first.
 */
export async function closeUnconfirmedOperation(
  db: HostingPanelDatabase,
  operationId: string,
  giveUp: RecoveryGiveUp,
  write?: (tx: HostingPanelDatabase) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as HostingPanelDatabase;
    const [row] = await tx.select().from(operations).where(eq(operations.id, operationId)).for("update");
    if (row?.status !== "unknown") return false;
    await write?.(t);
    await transitionOperation(t, operationId, "failed", {
      errorCode: "OPERATION_AMBIGUOUS",
      errorMessage: RECOVERY_UNCONFIRMED_TEXT,
    });
    await appendAuditEvent(t, {
      actorId: null,
      actorType: "system",
      organizationId: row.organizationId,
      action: RECOVERY_UNCONFIRMED_AUDIT_ACTION,
      targetType: "operation",
      targetId: operationId,
      details: {
        operationId,
        kind: row.kind,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        minutesWaited: giveUp.minutesWaited,
        failure: giveUp.failure,
      },
    });
    return true;
  });
}
