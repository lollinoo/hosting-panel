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
});
