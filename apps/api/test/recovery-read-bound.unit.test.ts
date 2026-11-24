import { randomBytes } from "node:crypto";
import {
  DEMO_IDS,
  and,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  seedPhase1Dataset,
  transitionOperation,
  unlockOperationBreakGlassTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  RECOVERY_READ_GIVE_UP_MS,
  RECOVERY_UNCONFIRMED_AUDIT_ACTION,
  RECOVERY_UNCONFIRMED_TEXT,
  RecoveryReadBound,
  closeUnconfirmedOperation,
  isHonestRecoveryWait,
  recoveryReadFailure,
} from "../src/runtime/recovery-read-bound.js";

// Issue #183: a recovery read that keeps failing for a reason waiting does not cure must not hold an operation in
// `unknown`, and its lock, for ever. The bound counts only failures that are not an honest wait, in memory, per
// operation; the closing fails the operation once, with a fixed text, and sends nothing to the executor.

const coded = (code: string) => Object.assign(new Error(`executor said ${code}`), { code });
const schemaError = (): unknown => {
  try {
    z.object({ state: z.enum(["running", "finished"]) }).parse({ state: "lost-in-translation" });
  } catch (err) {
    return err;
  }
  throw new Error("the schema accepted a bad answer");
};

describe("isHonestRecoveryWait (issue #183)", () => {
  it("waits for an executor it cannot reach, an answer that did not come back, and a busy resource", () => {
    expect(isHonestRecoveryWait(coded("DOCKER_ENGINE_UNAVAILABLE"))).toBe(true);
    expect(isHonestRecoveryWait(Object.assign(coded("OPERATION_AMBIGUOUS"), { ambiguousOutcome: true }))).toBe(true);
    expect(isHonestRecoveryWait(coded("RESOURCE_LOCKED"))).toBe(true);
  });

  it("counts an answer that cannot be read, a refusal of any other kind and any other error", () => {
    // An answer that fails the schema the panel holds; a body that is not JSON (the client calls it INTERNAL_ERROR);
    // a 4xx/5xx without the envelope (the client's fallback codes); any other coded refusal; anything else thrown.
    for (const err of [
      schemaError(),
      coded("INTERNAL_ERROR"),
      coded("UNAUTHENTICATED"),
      coded("HOST_POLICY_DENIED"),
      coded("NOT_FOUND"),
      coded("IDEMPOTENCY_CONFLICT"),
      coded("VALIDATION_ERROR"),
      coded("STACK_BUSY"),
      new SyntaxError("Unexpected token < in JSON"),
      new TypeError("Cannot read properties of undefined"),
      "a string",
      null,
      undefined,
    ]) {
      expect(isHonestRecoveryWait(err), String(err)).toBe(false);
    }
  });

  it("names the class of a counted failure with a fixed word, never with the error's text", () => {
    expect(recoveryReadFailure(schemaError())).toBe("unreadable_answer");
    expect(recoveryReadFailure(coded("INTERNAL_ERROR"))).toBe("error_code");
    expect(recoveryReadFailure(coded("NOT_FOUND"))).toBe("error_code");
    expect(recoveryReadFailure(coded("not-a-code-of-the-panel"))).toBe("unexpected_error");
    expect(recoveryReadFailure(new TypeError("boom"))).toBe("unexpected_error");
    expect(recoveryReadFailure(undefined)).toBe("unexpected_error");
  });
});

describe("RecoveryReadBound (issue #183)", () => {
  const MINUTE = 60_000;
  function bound() {
    const clock = { t: Date.UTC(2026, 10, 24, 9) };
    return { clock, reads: new RecoveryReadBound(() => clock.t) };
  }

  it("is thirty minutes, above the fifteen of the operation_unknown alert", () => {
    expect(RECOVERY_READ_GIVE_UP_MS).toBe(30 * MINUTE);
  });

  it("gives up only once counted failures have lasted the whole bound", () => {
    const { clock, reads } = bound();
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toBeNull();
    clock.t += RECOVERY_READ_GIVE_UP_MS - 1;
    expect(reads.failed("op_a", schemaError())).toBeNull();
    clock.t += 1;
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toEqual({ minutesWaited: 30, failure: "error_code" });
    // Each operation has its own count.
    expect(reads.failed("op_b", coded("INTERNAL_ERROR"))).toBeNull();
    expect(reads.size).toBe(2);
  });

  it("never gives up on an honest wait, and an honest wait or a readable answer starts the count again", () => {
    const { clock, reads } = bound();
    for (let hour = 0; hour < 24; hour += 1) {
      expect(reads.failed("op_down", coded("DOCKER_ENGINE_UNAVAILABLE"))).toBeNull();
      clock.t += 60 * MINUTE;
    }
    expect(reads.size).toBe(0);

    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toBeNull();
    clock.t += 20 * MINUTE;
    expect(reads.failed("op_a", coded("RESOURCE_LOCKED"))).toBeNull();
    clock.t += 20 * MINUTE;
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toBeNull();
    clock.t += 20 * MINUTE;
    reads.answered("op_a");
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toBeNull();
    clock.t += 29 * MINUTE;
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toBeNull();
    clock.t += MINUTE;
    expect(reads.failed("op_a", coded("INTERNAL_ERROR"))).toMatchObject({ minutesWaited: 30 });
  });

  it("keeps only the operations still unknown: one unlocked or settled meanwhile is dropped", () => {
    const { clock, reads } = bound();
    reads.failed("op_kept", coded("INTERNAL_ERROR"));
    reads.failed("op_unlocked", coded("INTERNAL_ERROR"));
    reads.retain(["op_kept", "op_other"]);
    expect(reads.size).toBe(1);
    clock.t += RECOVERY_READ_GIVE_UP_MS;
    // Unlocked, then unknown again under the same id would be a new count, not the old one.
    expect(reads.failed("op_unlocked", coded("INTERNAL_ERROR"))).toBeNull();
    expect(reads.failed("op_kept", coded("INTERNAL_ERROR"))).toMatchObject({ minutesWaited: 30 });
    reads.forget("op_kept");
    expect(reads.size).toBe(1);
  });
});

describe("closeUnconfirmedOperation (issue #183)", () => {
  let dbClient: DatabaseClient;
  let n = 0;
  const svcId = DEMO_IDS.services.acmeShopWp;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db, randomBytes(32));
  });

  afterAll(async () => {
    await dbClient.close();
  });

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const audits = async (id: string, action: string) =>
    dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, action)));

  async function unknownOp(): Promise<string> {
    n += 1;
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: svcId,
      lockKey: `service:${svcId}`,
      idempotencyKey: `bound-${String(n)}`,
      outboxPayload: {},
      steps: [{ key: "dispatch_ipc", label: "Apply the change" }],
    });
    await transitionOperation(dbClient.db, operation.id, "processing");
    await transitionOperation(dbClient.db, operation.id, "unknown");
    return operation.id;
  }

  it("fails an unknown operation once, with a fixed text, the resource rows written with it and one audit row", async () => {
    const id = await unknownOp();
    const writes: string[] = [];
    const closed = await closeUnconfirmedOperation(dbClient.db, id, { minutesWaited: 31, failure: "unreadable_answer" }, async (tx) => {
      expect((await tx.select().from(operations).where(eq(operations.id, id)))[0]!.status).toBe("unknown");
      writes.push("rows");
    });
    expect(closed).toBe(true);
    expect(writes).toEqual(["rows"]);
    expect(await opRow(id)).toMatchObject({
      status: "failed",
      errorCode: "OPERATION_AMBIGUOUS",
      errorMessage: RECOVERY_UNCONFIRMED_TEXT,
    });
    const rows = await audits(id, RECOVERY_UNCONFIRMED_AUDIT_ACTION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "system", organizationId: DEMO_IDS.organizations.acme, targetType: "operation" });
    expect(rows[0]!.details).toEqual({
      operationId: id,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: svcId,
      minutesWaited: 31,
      failure: "unreadable_answer",
    });

    // A second closing finds it ended: nothing is written again.
    expect(await closeUnconfirmedOperation(dbClient.db, id, { minutesWaited: 40, failure: "error_code" }, async () => {
      writes.push("again");
    })).toBe(false);
    expect(writes).toEqual(["rows"]);
    expect(await audits(id, RECOVERY_UNCONFIRMED_AUDIT_ACTION)).toHaveLength(1);
  });

  it("does nothing to an operation the administrator unlocked between the last failed read and the closing", async () => {
    const id = await unknownOp();
    await unlockOperationBreakGlassTransactional(dbClient.db, { operationId: id, reason: "checked by hand" });
    const before = await opRow(id);
    let wrote = false;
    expect(await closeUnconfirmedOperation(dbClient.db, id, { minutesWaited: 30, failure: "error_code" }, async () => {
      wrote = true;
    })).toBe(false);
    expect(wrote).toBe(false);
    expect(await opRow(id)).toEqual(before);
    expect(before).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect(await audits(id, RECOVERY_UNCONFIRMED_AUDIT_ACTION)).toHaveLength(0);
  });

  it("leaves alone an operation that is not unknown, even one still running", async () => {
    n += 1;
    const { operation } = await enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: svcId,
      lockKey: `service:${svcId}`,
      idempotencyKey: `bound-${String(n)}`,
      outboxPayload: {},
      steps: [{ key: "dispatch_ipc", label: "Apply the change" }],
    });
    await transitionOperation(dbClient.db, operation.id, "processing");
    expect(await closeUnconfirmedOperation(dbClient.db, operation.id, { minutesWaited: 30, failure: "error_code" })).toBe(false);
    expect((await opRow(operation.id)).status).toBe("processing");
    await transitionOperation(dbClient.db, operation.id, "failed", { errorCode: "INTERNAL_ERROR", errorMessage: "done" });
    expect(await closeUnconfirmedOperation(dbClient.db, "op_missing", { minutesWaited: 30, failure: "error_code" })).toBe(false);
  });
});
