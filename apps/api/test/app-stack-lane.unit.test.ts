import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_STACK_BACKUP_OPERATION_KINDS, APP_STACK_OPERATION_KINDS, type OperationKind } from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  and,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  seedPhase1Dataset,
  settleOperation,
  sql,
  updateOperationStepTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import type { AppStackRuntime } from "../src/app-stacks/app-stack-runtime.js";
import type { AppStackTaskRuntime } from "../src/app-stacks/app-stack-task-runtime.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import type { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import type { SiteDomainsApplier } from "../src/sites/site-domains-applier.js";
import type { SiteFilesApplier } from "../src/sites/site-files-applier.js";

// Records which lane filter claimed which operation.
const claims = vi.hoisted(() => [] as { filter: unknown; operationIds: string[] }[]);
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    claimPendingOutboxEvents: async (...args: Parameters<typeof actual.claimPendingOutboxEvents>) => {
      const rows = await actual.claimPendingOutboxEvents(...args);
      claims.push({
        filter: args[3],
        operationIds: rows.map((r) => (r.payload as { operationId: string }).operationId),
      });
      return rows;
    },
  };
});

const FIXED_TEXT = "This action did not finish. Try again in a few minutes.";

describe("outbox stack lane (RT5)", () => {
  let dbClient: DatabaseClient;
  let config: ControlPlaneRuntimeConfig;
  let worker: OutboxWorkerService;
  const runtime = { apply: vi.fn(), recover: vi.fn() };
  const taskRuntime = { apply: vi.fn(), recover: vi.fn() };
  const siteDomains = { apply: vi.fn() };
  const org = DEMO_IDS.organizations.acme;

  function enqueue(kind: OperationKind, lockKey: string, resourceId = randomUUID()) {
    return enqueueOperationTransactional(dbClient.db, {
      organizationId: org,
      kind,
      resourceType: kind.startsWith("stack.") ? "stack" : "site",
      resourceId,
      lockKey,
      idempotencyKey: `lane-${randomUUID()}`,
      outboxPayload: { stackId: resourceId },
      steps: [
        { key: "validate", label: "Check the request" },
        { key: "pull", label: "Download" },
      ],
    });
  }
  const enqueueStack = (kind: OperationKind = "stack.deploy") => {
    const id = randomUUID();
    return enqueue(kind, `stack:${id}`, id);
  };

  async function opRow(id: string) {
    const [row] = await dbClient.db.select().from(operations).where(eq(operations.id, id));
    return row!;
  }

  async function audits(id: string, action: string): Promise<number> {
    const rows = await dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, action)));
    return rows.length;
  }

  const succeed = async (op: { id: string }) => {
    await settleOperation(dbClient.db, op.id, { status: "succeeded" });
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    config = {
      oidcIssuer: "https://issuer.local",
      oidcAudience: "hosting-panel-api",
      enableDevOidc: true,
      runtimeBackend: "local-simulator",
      secretsMasterKey: randomBytes(32),
      jwtSigningKeyPem: null,
      autoProcessOutbox: false,
    };
    await seedPhase1Dataset(dbClient.db, config.secretsMasterKey);
    worker = new OutboxWorkerService(
      dbClient,
      new InMemoryDockerSimulatorAdapter(),
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      siteDomains as unknown as SiteDomainsApplier,
      {} as unknown as SiteFilesApplier,
      undefined,
      undefined,
      undefined,
      runtime as unknown as AppStackRuntime,
      taskRuntime as unknown as AppStackTaskRuntime,
    );
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("claims a stack operation only through the stack lane and dispatches it to AppStackRuntime.apply", async () => {
    runtime.apply.mockImplementationOnce(succeed);
    const { operation } = await enqueueStack();
    claims.length = 0;

    await worker.processPendingOnce();

    const takers = claims.filter((c) => c.operationIds.includes(operation.id));
    expect(takers.map((c) => c.filter)).toEqual([{ includeKinds: APP_STACK_OPERATION_KINDS }]);
    const main = claims.find((c) => (c.filter as { excludeKinds?: string[] }).excludeKinds !== undefined);
    expect((main!.filter as { excludeKinds: string[] }).excludeKinds).toEqual(
      expect.arrayContaining([...APP_STACK_OPERATION_KINDS, ...APP_STACK_BACKUP_OPERATION_KINDS]),
    );
    expect(runtime.apply).toHaveBeenCalledTimes(1);
    expect(runtime.apply.mock.calls[0]![0].id).toBe(operation.id);
    expect(runtime.apply.mock.calls[0]![1]).toMatchObject({ operationId: operation.id, stackId: operation.resourceId });
    expect((await opRow(operation.id)).status).toBe("succeeded");
    runtime.apply.mockReset();
  });

  it("claims a backup and a restore through a lane of their own, a clean-up through another, and runs them with AppStackRuntime", async () => {
    runtime.apply.mockImplementation(succeed);
    const backup = await enqueueStack("stack.backup");
    const restore = await enqueueStack("stack.restore");
    const prune = await enqueueStack("stack.prune");
    claims.length = 0;

    await worker.processPendingOnce();

    const taker = (id: string) => claims.filter((c) => c.operationIds.includes(id)).map((c) => c.filter);
    expect(taker(backup.operation.id)).toEqual([{ includeKinds: ["stack.backup", "stack.restore"] }]);
    expect(taker(restore.operation.id)).toEqual([{ includeKinds: ["stack.backup", "stack.restore"] }]);
    expect(taker(prune.operation.id)).toEqual([{ includeKinds: ["stack.prune"] }]);
    expect(runtime.apply.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual(
      [backup.operation.id, restore.operation.id, prune.operation.id].sort(),
    );
    runtime.apply.mockReset();
  });

  it("a long stack deploy does not delay site work in the same processPendingOnce", async () => {
    const order: string[] = [];
    let siteApplied!: () => void;
    const siteDone = new Promise<void>((resolve) => (siteApplied = resolve));
    runtime.apply.mockImplementationOnce(async (op: { id: string }) => {
      // Stands in for a deploy waiting on health: it lets go once the site work ran, or after 2 s.
      const by = await Promise.race([
        siteDone.then(() => "site"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      order.push(`stack released by ${String(by)}`);
      await succeed(op);
    });
    siteDomains.apply.mockImplementationOnce(async (op: { id: string }) => {
      order.push("site applied");
      siteApplied();
      await succeed(op);
    });
    const stack = await enqueueStack();
    const siteId = randomUUID();
    const site = await enqueue("site.domains", `site:${siteId}`, siteId);

    const result = await worker.processPendingOnce();

    expect(order).toEqual(["site applied", "stack released by site"]);
    expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
    expect((await opRow(stack.operation.id)).status).toBe("succeeded");
    expect((await opRow(site.operation.id)).status).toBe("succeeded");
    runtime.apply.mockReset();
    siteDomains.apply.mockReset();
  });

  it("the run of a task has a lane of its own: a long stack deploy does not hold it and no other lane takes it (ADR-0042)", async () => {
    const order: string[] = [];
    let taskApplied!: () => void;
    const taskDone = new Promise<void>((resolve) => (taskApplied = resolve));
    runtime.apply.mockImplementationOnce(async (op: { id: string }) => {
      const by = await Promise.race([
        taskDone.then(() => "task"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000)),
      ]);
      order.push(`stack released by ${String(by)}`);
      await succeed(op);
    });
    taskRuntime.apply.mockImplementationOnce(async (op: { id: string }) => {
      order.push("task applied");
      taskApplied();
      await succeed(op);
    });
    const stack = await enqueueStack();
    const task = await enqueueStack("stack.task");
    claims.length = 0;

    const result = await worker.processPendingOnce();

    expect(order).toEqual(["task applied", "stack released by task"]);
    expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
    expect(claims.filter((c) => c.operationIds.includes(task.operation.id)).map((c) => c.filter)).toEqual([{ includeKinds: ["stack.task"] }]);
    const main = claims.find((c) => (c.filter as { excludeKinds?: string[] }).excludeKinds !== undefined);
    expect((main!.filter as { excludeKinds: string[] }).excludeKinds).toContain("stack.task");
    expect(APP_STACK_OPERATION_KINDS).not.toContain("stack.task");
    expect(taskRuntime.apply).toHaveBeenCalledTimes(1);
    expect(taskRuntime.apply.mock.calls[0]![0].id).toBe(task.operation.id);
    expect(runtime.apply).toHaveBeenCalledTimes(1);
    expect(runtime.apply.mock.calls[0]![0].id).toBe(stack.operation.id);
    expect((await opRow(task.operation.id)).status).toBe("succeeded");
    runtime.apply.mockReset();
    taskRuntime.apply.mockReset();
  });

  it("recoverUnknownOperations hands an unknown run of a task to the task runtime, which only reads (ADR-0042)", async () => {
    const task = await enqueueStack("stack.task");
    await dbClient.db.update(operations).set({ status: "unknown", leaseExpiresAt: null }).where(eq(operations.id, task.operation.id));
    await dbClient.db
      .update(outboxEvents)
      .set({ status: "processing" })
      .where(sql`${outboxEvents.payload}->>'operationId' = ${task.operation.id}`);

    taskRuntime.recover.mockResolvedValueOnce("pending");
    await worker.recoverUnknownOperations();
    expect((await opRow(task.operation.id)).status).toBe("unknown");

    taskRuntime.recover.mockImplementationOnce(async (op: { id: string }) => {
      await settleOperation(dbClient.db, op.id, { status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: FIXED_TEXT });
      return "settled";
    });
    await worker.recoverUnknownOperations();
    expect(taskRuntime.recover.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([task.operation.id, task.operation.id]);
    expect(await opRow(task.operation.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
    expect(await audits(task.operation.id, "operation.recovered.failed")).toBe(1);
    // The run is never dispatched again, and the application runtime is not asked about it.
    expect(taskRuntime.apply).not.toHaveBeenCalled();
    expect(runtime.recover.mock.calls.map((c) => (c[0] as { id: string }).id)).not.toContain(task.operation.id);
    taskRuntime.recover.mockReset();
    runtime.recover.mockReset();
  });

  it("a failed stack step stores only the fixed customer text", async () => {
    runtime.apply.mockImplementationOnce(async (op: { id: string }) => {
      await updateOperationStepTransactional(dbClient.db, op.id, "pull", "running", "Downloading");
      throw new Error("container web: image pull of volume data failed");
    });
    const { operation } = await enqueueStack();

    await worker.processPendingOnce();

    expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorMessage: FIXED_TEXT });
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operation.id));
    expect(steps.find((s) => s.key === "pull")).toMatchObject({ status: "failed", message: FIXED_TEXT });
    runtime.apply.mockReset();
  });

  it("recoverUnknownOperations hands an unknown stack operation to recover and writes operation.recovered.*", async () => {
    const parkUnknown = async (id: string) => {
      await dbClient.db.update(operations).set({ status: "unknown", leaseExpiresAt: null }).where(eq(operations.id, id));
      await dbClient.db
        .update(outboxEvents)
        .set({ status: "processing" })
        .where(sql`${outboxEvents.payload}->>'operationId' = ${id}`);
    };
    const ok = await enqueueStack("stack.restart");
    const bad = await enqueueStack("stack.delete");
    await parkUnknown(ok.operation.id);
    await parkUnknown(bad.operation.id);

    // First pass: the read failed, both stay unknown and nothing is recorded.
    runtime.recover.mockResolvedValue("pending");
    await worker.recoverUnknownOperations();
    expect(runtime.recover.mock.calls.map((c) => (c[0] as { id: string }).id).sort()).toEqual(
      [ok.operation.id, bad.operation.id].sort(),
    );
    expect((await opRow(ok.operation.id)).status).toBe("unknown");
    expect(await audits(ok.operation.id, "operation.recovered.succeeded")).toBe(0);

    runtime.recover.mockReset();
    runtime.recover.mockImplementation(async (op: { id: string }) => {
      if (op.id === ok.operation.id) await succeed(op);
      else await settleOperation(dbClient.db, op.id, { status: "failed", errorCode: "OPERATION_INTERRUPTED", errorMessage: FIXED_TEXT });
      return "settled";
    });
    const result = await worker.recoverUnknownOperations();

    expect(result).toMatchObject({ convergedSucceeded: 1, convergedFailed: 1 });
    expect(result.recoveryErrors).toBeUndefined();
    expect((await opRow(ok.operation.id)).status).toBe("succeeded");
    expect((await opRow(bad.operation.id)).status).toBe("failed");
    expect(await audits(ok.operation.id, "operation.recovered.succeeded")).toBe(1);
    expect(await audits(bad.operation.id, "operation.recovered.failed")).toBe(1);
    const events = await dbClient.db
      .select({ status: outboxEvents.status })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' in (${ok.operation.id}, ${bad.operation.id})`);
    expect(events.map((e) => e.status).sort()).toEqual(["failed", "published"]);
    runtime.recover.mockReset();
  });

  it("the worker built positionally with seven arguments runs stack operations with its own AppStackRuntime", async () => {
    const seven = new OutboxWorkerService(
      dbClient,
      new InMemoryDockerSimulatorAdapter(),
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      {} as unknown as SiteFilesApplier,
    );
    // Not the payload of a stack operation: the default runtime refuses it as invalid, not as an unknown kind.
    const { operation } = await enqueueStack();
    await dbClient.db
      .update(outboxEvents)
      .set({ payload: { operationId: operation.id } })
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);

    await seven.processPendingOnce();

    expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorCode: "VALIDATION_ERROR" });
    expect(runtime.apply).not.toHaveBeenCalled();
    await seven.stop();
  });
});
