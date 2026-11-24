import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_IDS,
  appendAuditEvent,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  seedPhase1Dataset,
  settleOperation,
  sql,
  transitionOperation,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "../src/index.js";

describe("settleOperation (D15)", () => {
  let client: DatabaseClient;
  let n = 0;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await seedPhase1Dataset(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  async function processingOp(): Promise<string> {
    n += 1;
    const { operation } = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: DEMO_IDS.services.acmeShopWp,
      lockKey: `test:settle:${String(n)}`,
    });
    await transitionOperation(client.db, operation.id, "processing");
    return operation.id;
  }

  const write = (marker: string) => async (tx: Parameters<NonNullable<Parameters<typeof settleOperation>[3]>>[0]) => {
    await appendAuditEvent(tx, { action: marker, targetType: "operation", actorType: "system" });
  };

  async function audits(marker: string): Promise<number> {
    return (await client.db.select().from(auditEvents).where(eq(auditEvents.action, marker))).length;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    return (await client.db.select().from(operations).where(eq(operations.id, id)))[0]?.status;
  }

  it("settles succeeded with the caller write in one transaction", async () => {
    const id = await processingOp();
    await expect(settleOperation(client.db, id, { status: "succeeded" }, write("test.settle.ok"))).resolves.toBe(true);
    const [row] = await client.db.select().from(operations).where(eq(operations.id, id));
    expect(row).toMatchObject({ status: "succeeded", errorCode: null, leaseExpiresAt: null });
    expect(await audits("test.settle.ok")).toBe(1);
  });

  it("rolls back the write and the reconciling move when the succeeded update fails, and marks the error ambiguousOutcome", async () => {
    const id = await processingOp();
    await client.db.execute(
      sql.raw("CREATE FUNCTION test_fail_succeeded() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"),
    );
    await client.db.execute(
      sql.raw(
        "CREATE TRIGGER test_fail_succeeded BEFORE UPDATE ON operations FOR EACH ROW WHEN (NEW.status = 'succeeded') EXECUTE FUNCTION test_fail_succeeded()",
      ),
    );
    try {
      const err = await settleOperation(client.db, id, { status: "succeeded" }, write("test.settle.inject")).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ ambiguousOutcome: true });
    } finally {
      await client.db.execute(sql.raw("DROP TRIGGER test_fail_succeeded ON operations"));
      await client.db.execute(sql.raw("DROP FUNCTION test_fail_succeeded()"));
    }
    expect(await statusOf(id)).toBe("processing");
    expect(await audits("test.settle.inject")).toBe(0);
  });

  it("rolls back when write throws, without the ambiguous mark on failed", async () => {
    const id = await processingOp();
    const err = await settleOperation(
      client.db,
      id,
      { status: "failed", errorCode: "INTERNAL_ERROR", errorMessage: "Could not finish" },
      async (tx) => {
        await write("test.settle.throw")(tx);
        throw new Error("write broke");
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { ambiguousOutcome?: unknown }).ambiguousOutcome).toBeUndefined();
    expect(await statusOf(id)).toBe("processing");
    expect(await audits("test.settle.throw")).toBe(0);
  });

  it("returns false on a terminal or missing operation and runs no write", async () => {
    const id = await processingOp();
    await settleOperation(client.db, id, { status: "failed", errorCode: "INTERNAL_ERROR", errorMessage: "Could not finish" });
    expect(await statusOf(id)).toBe("failed");
    await expect(settleOperation(client.db, id, { status: "succeeded" }, write("test.settle.ended"))).resolves.toBe(false);
    await expect(settleOperation(client.db, "op_missing", { status: "succeeded" }, write("test.settle.ended"))).resolves.toBe(
      false,
    );
    expect(await statusOf(id)).toBe("failed");
    expect(await audits("test.settle.ended")).toBe(0);
  });

  describe("the after hook", () => {
    const lockOf = async (id: string) => (await client.db.select().from(operations).where(eq(operations.id, id)))[0]!.lockKey!;
    const next = (lockKey: string) => (tx: HostingPanelDatabase) =>
      enqueueOperationTransactional(tx, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "service.deploy",
        resourceType: "service",
        resourceId: DEMO_IDS.services.acmeShopWp,
        lockKey,
      });

    it("runs once the operation is terminal: the next operation on the same lock can be queued there, not in write", async () => {
      const id = await processingOp();
      const lockKey = await lockOf(id);
      // While the operation is active its lock is held: `write` is too early.
      const early = await settleOperation(client.db, id, { status: "succeeded" }, async (tx) => {
        await next(lockKey)(tx);
      }).catch((e: unknown) => e);
      expect(early).toMatchObject({ code: "RESOURCE_LOCKED" });
      expect(await statusOf(id)).toBe("processing");

      let queued = "";
      await expect(
        settleOperation(client.db, id, { status: "succeeded" }, write("test.settle.after"), async (tx) => {
          queued = (await next(lockKey)(tx)).operation.id;
        }),
      ).resolves.toBe(true);
      expect(await statusOf(id)).toBe("succeeded");
      expect(await statusOf(queued)).toBe("queued");
      expect(await lockOf(queued)).toBe(lockKey);
      expect(await audits("test.settle.after")).toBe(1);
    });

    it("runs after a failed outcome too", async () => {
      const id = await processingOp();
      const lockKey = await lockOf(id);
      let queued = "";
      await settleOperation(
        client.db,
        id,
        { status: "failed", errorCode: "INTERNAL_ERROR", errorMessage: "Could not finish" },
        undefined,
        async (tx) => {
          queued = (await next(lockKey)(tx)).operation.id;
        },
      );
      expect(await statusOf(id)).toBe("failed");
      expect(await statusOf(queued)).toBe("queued");
    });

    it("does not run for an operation that already ended, and a throw in it undoes the whole settle", async () => {
      const ended = await processingOp();
      await settleOperation(client.db, ended, { status: "succeeded" });
      let ran = false;
      await expect(
        settleOperation(client.db, ended, { status: "succeeded" }, undefined, async () => {
          ran = true;
        }),
      ).resolves.toBe(false);
      expect(ran).toBe(false);

      const id = await processingOp();
      const lockKey = await lockOf(id);
      const err = await settleOperation(client.db, id, { status: "succeeded" }, write("test.settle.after.throw"), async (tx) => {
        await next(lockKey)(tx);
        throw new Error("after broke");
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ message: "after broke", ambiguousOutcome: true });
      expect(await statusOf(id)).toBe("processing");
      expect(await audits("test.settle.after.throw")).toBe(0);
      const onLock = await client.db.select().from(operations).where(eq(operations.lockKey, lockKey));
      expect(onLock.map((o) => o.id)).toEqual([id]);
    });
  });
});
