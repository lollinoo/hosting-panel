import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  appStackDeployments,
  appStacks,
  auditEvents,
  eq,
  markExpiredOperationsUnknownTransactional,
  operations,
  operationSteps,
  outboxEvents,
  resourceQuotas,
} from "@hosting-panel/database";
import type { AppStackSimFault, AppStackSimStep, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// A17 (arch-runtime §14 Q2): a crash between create and start leaves the operation `unknown` and the stack shown as
// "outcome to be verified"; recovery only reads; the lock holds deploy/start/delete while unknown and is released after.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Sim = InMemoryDockerSimulatorAdapter;

const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;
const READS = new Set(["getAppStackStatus", "getAppStackComponentLogs"]);
/** What recovery may touch on the executor: the two reads and the availability checks. */
const OBSERVING = [...READS, "isRuntimeAvailable", "assertEngineAvailable"];

describe("A17: unknown outcomes and read-only recovery", () => {
  let h: AppStackHarness;
  let web: string;
  let sim: Sim;
  let worker: OutboxWorkerService;
  const extraApps: ControlPlaneAppHandle[] = [];
  const restore: Array<() => void> = [];
  const inFlight: Array<Promise<unknown>> = [];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    web = (await h.publish(WEB_SOURCE)).versionId;
    sim = h.app.nestApp.get<Sim>(DOCKER_EXECUTOR_TOKEN);
    worker = h.app.nestApp.get(OutboxWorkerService);
  }, 120_000);

  // A test's retry deploy is left queued: end it before the next test arms a fault, so no fault lands on it.
  beforeEach(async () => {
    for (let i = 0; i < 20; i += 1) {
      const pending = (await h.dbClient.db.select().from(outboxEvents)).filter((e) => e.status === "pending");
      if (pending.length === 0) return;
      await worker.processPendingOnce();
    }
  }, 60_000);

  afterEach(async () => {
    for (const undo of restore.splice(0).reverse()) undo();
    await Promise.all(inFlight.splice(0));
    for (const app of extraApps.splice(0)) await app.close();
  });

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const path = (stackId = "") => `/v1/organizations/${h.a.orgId}/app-stacks${stackId ? `/${stackId}` : ""}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const act = (stackId: string, verb: string) => h.call(h.a.token, "POST", `${path(stackId)}/${verb}`, {}, idem());
  const del = (stackId: string, name: string) =>
    h.call(h.a.token, "DELETE", path(stackId), { confirmName: name, destroyData: false }, idem());
  const detail = async (stackId: string): Promise<Json> => (await h.call(h.a.token, "GET", path(stackId))).body.data as Json;
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const opRow = async (operationId: string) => (await h.dbClient.db.select().from(operations).where(eq(operations.id, operationId)))[0]!;
  const deploymentOf = async (operationId: string) =>
    (await h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.operationId, operationId)))[0]!;
  const stepsOf = (operationId: string) => h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId));
  const outboxOf = async (operationId: string) =>
    (await h.dbClient.db.select().from(outboxEvents)).filter((e) => (e.payload as Json).operationId === operationId);
  const auditsOf = async (operationId: string, prefix: string) =>
    (await h.dbClient.db.select().from(auditEvents)).filter((r) => r.targetId === operationId && r.action.startsWith(prefix));
  const expireLease = (operationId: string) =>
    h.dbClient.db.update(operations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(operations.id, operationId));

  /** Creates and queues a deploy; returns ids. */
  async function deploy(name = `a17-${randomUUID().slice(0, 8)}`, versionId = web): Promise<{ stackId: string; operationId: string; name: string }> {
    const res = await h.call(h.a.token, "POST", path(), { templateVersionId: versionId, name, deploy: true }, idem());
    expect(res.status, res.raw).toBe(202);
    return { stackId: res.body.data.stackId as string, operationId: res.body.data.operationId as string, name };
  }

  /** Drives the worker until the stack has no queued operation work left or `until` holds. */
  async function drive(until: () => Promise<boolean>, rounds = 12): Promise<void> {
    for (let i = 0; i < rounds && !(await until()); i += 1) await worker.processPendingOnce();
  }

  /** Spies on every function of the executor: records the call, never blocks it (the counters are asserted). */
  function spyAll(target: Sim): { calls: string[]; mutations: () => number; stackCalls: () => readonly string[] } {
    const calls: string[] = [];
    const seen = new Set<string>();
    for (let proto: object | null = target; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor" || seen.has(name)) continue;
        const original = Reflect.get(target, name) as unknown;
        if (typeof original !== "function") continue;
        seen.add(name);
        Object.defineProperty(target, name, {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            calls.push(name);
            return (original as (...a: unknown[]) => unknown).apply(target, args);
          },
        });
        restore.push(() => Reflect.deleteProperty(target, name));
      }
    }
    return {
      calls,
      mutations: () => target.appStacks.appStackMutations.length,
      stackCalls: () => target.appStacks.appStackCalls.map((c) => c.method),
    };
  }

  async function expectLocked(stackId: string, name: string): Promise<void> {
    const before = (await opsOf(stackId)).length;
    const beforeCounts = await h.counts();
    for (const res of [await act(stackId, "deploy"), await act(stackId, "start"), await del(stackId, name)]) {
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("RESOURCE_LOCKED");
    }
    expect((await opsOf(stackId)).length).toBe(before);
    expect(await h.counts()).toEqual(beforeCounts);
  }

  /** The state every case shares once an ambiguous crash parked the operation. */
  async function expectParkedUnknown(stackId: string, operationId: string): Promise<void> {
    const op = await opRow(operationId);
    expect(op.status).toBe("unknown");
    expect(op.errorCode).toBe("OPERATION_AMBIGUOUS");
    expect((await stackRow(stackId)).status).toBe("unknown");
    expect((await deploymentOf(operationId)).status).toBe("unknown");
    const view = await detail(stackId);
    expect(view.status).toBe("unknown");
    expect(view.activeOperationId).toBe(operationId);
    // The outbox event is parked, not left to be replayed.
    for (const e of await outboxOf(operationId)) expect(e.status).not.toBe("pending");
  }

  const FAULTS: ReadonlyArray<{ title: string; step: AppStackSimStep; fault: AppStackSimFault; created: number; running: number }> = [
    { title: "the create call answered nothing after the containers were created", step: "create", fault: "ambiguous_after", created: 2, running: 0 },
    { title: "the create call answered nothing before anything happened", step: "create", fault: "ambiguous_before", created: 0, running: 0 },
    { title: "the first start answered nothing after the container started", step: "start", fault: "ambiguous_after", created: 2, running: 1 },
  ];

  describe.each(FAULTS)("ambiguous outcome: $title", ({ step, fault, created, running }) => {
    it("parks the operation unknown, shows the stack as unknown, refuses deploy/start/delete, then recovers read-only and releases the lock", async () => {
      sim.appStacks.failNextAppStackStep(step, fault);
      const { stackId, operationId, name } = await deploy();
      await drive(async () => (await opRow(operationId)).status === "unknown");
      await expectParkedUnknown(stackId, operationId);
      // The in-flight step is unknown too, never "succeeded".
      expect((await stepsOf(operationId)).filter((s) => s.status === "succeeded").length).toBeLessThan((await stepsOf(operationId)).length);
      const containers = Object.values(sim.appStacks.getAppStackSnapshot(stackId)?.containers ?? {});
      expect(containers).toHaveLength(created);
      expect(containers.filter((c) => c.state === "running")).toHaveLength(running);

      // No worker pass replays it: another pass touches the executor zero times for this stack.
      const callsBefore = sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).length;
      await worker.processPendingOnce();
      expect(sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).length).toBe(callsBefore);
      await expectParkedUnknown(stackId, operationId);

      // Lock: the three mutating actions are refused while the outcome is to be verified.
      await expectLocked(stackId, name);

      // Recovery only reads.
      const spy = spyAll(sim);
      const mutationsBefore = spy.mutations();
      const stackCallsBefore = spy.stackCalls().length;
      const result = await worker.recoverUnknownOperations();
      expect(result.recoveryErrors).toBeUndefined();
      expect(result.convergedFailed).toBeGreaterThanOrEqual(1);
      const names = new Set(spy.calls);
      for (const call of names) expect(OBSERVING, `recovery called ${call}`).toContain(call);
      expect(spy.stackCalls().slice(stackCallsBefore)).toEqual(["getAppStackStatus"]);
      expect(Object.values(sim.appStacks.getAppStackSnapshot(stackId)?.containers ?? {}).filter((c) => c.state === "running")).toHaveLength(running);
      expect(spy.mutations()).toBe(mutationsBefore);

      // Settled from what the executor shows: the deploy did not finish, nothing was started.
      const op = await opRow(operationId);
      expect(op.status).toBe("failed");
      expect(op.errorCode).toBe("OPERATION_INTERRUPTED");
      expect((await deploymentOf(operationId)).status).toBe("failed");
      expect((await stackRow(stackId)).status).toBe("failed");
      // Components that match the revision were applied (design §2.4); with nothing created there is nothing applied.
      if (created === 0) expect((await stackRow(stackId)).appliedRevisionId).toBeNull();
      expect((await detail(stackId)).status).toBe("failed");
      expect((await detail(stackId)).activeOperationId).toBeNull();
      expect(await auditsOf(operationId, "operation.recovered.")).toHaveLength(1);
      expect((await auditsOf(operationId, "operation.recovered."))[0]!.action).toBe("operation.recovered.failed");
      for (const s of await stepsOf(operationId)) expect(["unknown", "pending", "running"]).not.toContain(s.status);

      // A second recovery pass has nothing left to do and writes nothing.
      const again = await worker.recoverUnknownOperations();
      expect(again.convergedFailed + again.convergedSucceeded).toBe(0);
      expect(await auditsOf(operationId, "operation.recovered.")).toHaveLength(1);

      // Lock released: the customer can act again, and the deploy now completes.
      restore.splice(0).reverse().forEach((undo) => undo());
      const retry = await act(stackId, "deploy");
      expect(retry.status, retry.raw).toBe(202);
      await drive(async () => (await stackRow(stackId)).status === "running");
      expect((await stackRow(stackId)).status).toBe("running");
    }, 60_000);
  });

  it("a status read that fails keeps the operation unknown and the lock held; the next pass settles it", async () => {
    sim.appStacks.failNextAppStackStep("create", "ambiguous_after");
    const { stackId, operationId, name } = await deploy();
    await drive(async () => (await opRow(operationId)).status === "unknown");
    await expectParkedUnknown(stackId, operationId);

    sim.appStacks.failNextAppStackStep("status", "engine_unavailable");
    const spy = spyAll(sim);
    const stackCallsBefore = spy.stackCalls().length;
    const first = await worker.recoverUnknownOperations();
    expect(first.convergedFailed + first.convergedSucceeded).toBe(0);
    await expectParkedUnknown(stackId, operationId);
    await expectLocked(stackId, name);
    expect(await auditsOf(operationId, "operation.recovered.")).toHaveLength(0);

    const second = await worker.recoverUnknownOperations();
    expect(second.convergedFailed).toBe(1);
    expect((await opRow(operationId)).status).toBe("failed");
    expect((await stackRow(stackId)).status).toBe("failed");
    expect(spy.stackCalls().slice(stackCallsBefore)).toEqual(["getAppStackStatus", "getAppStackStatus"]);
    const next = await act(stackId, "deploy");
    expect(next.status, next.raw).toBe(202);
  }, 60_000);

  it("a crash after the last component started (answer lost) recovers as succeeded, read-only, without a second start", async () => {
    // The first start goes through; the answer of the second (the last) is lost after the container started.
    let starts = 0;
    const original = sim.startAppStackComponent.bind(sim);
    Object.defineProperty(sim, "startAppStackComponent", {
      configurable: true,
      writable: true,
      value: (req: Parameters<Sim["startAppStackComponent"]>[0]) => {
        starts += 1;
        if (starts === 2) sim.appStacks.failNextAppStackStep("start", "ambiguous_after");
        return original(req);
      },
    });
    restore.push(() => Reflect.deleteProperty(sim, "startAppStackComponent"));
    const { stackId, operationId } = await deploy();
    await drive(async () => (await opRow(operationId)).status === "unknown");
    await expectParkedUnknown(stackId, operationId);
    expect(starts).toBe(2);
    expect(Object.values(sim.appStacks.getAppStackSnapshot(stackId)!.containers).map((c) => c.state)).toEqual(["running", "running"]);

    const spy = spyAll(sim);
    const mutationsBefore = spy.mutations();
    const stackCallsBefore = spy.stackCalls().length;
    const result = await worker.recoverUnknownOperations();
    expect(result.recoveryErrors).toBeUndefined();
    expect(spy.mutations()).toBe(mutationsBefore);
    expect(spy.stackCalls().slice(stackCallsBefore)).toEqual(["getAppStackStatus"]);
    const op = await opRow(operationId);
    expect(op.status).toBe("succeeded");
    expect(["running", "degraded"]).toContain((await stackRow(stackId)).status);
    expect((await stackRow(stackId)).appliedRevisionId).not.toBeNull();
    expect((await auditsOf(operationId, "operation.recovered."))[0]!.action).toBe("operation.recovered.succeeded");
  }, 60_000);

  it("lease expiry across an API restart on the same database: unknown, locked, then settled read-only by the second API", async () => {
    // The first API freezes right where a killed process would stop: the first start call never answers.
    let release!: (error: Error) => void;
    const frozen = new Promise<never>((_resolve, reject) => (release = reject));
    const startHolder = Object.getOwnPropertyDescriptor(sim, "startAppStackComponent");
    Object.defineProperty(sim, "startAppStackComponent", { configurable: true, writable: true, value: () => frozen });
    restore.push(() => {
      if (startHolder) Object.defineProperty(sim, "startAppStackComponent", startHolder);
      else Reflect.deleteProperty(sim, "startAppStackComponent");
    });

    const { stackId, operationId, name } = await deploy();
    const running = worker.processPendingOnce().catch(() => undefined);
    // Whatever happens below, the frozen call ends before the database closes.
    restore.push(() => release(new Error("the test is over")));
    inFlight.push(running);
    for (let i = 0; i < 200 && sim.appStacks.getAppStackSnapshot(stackId) === null; i += 1) await new Promise((r) => setTimeout(r, 25));
    for (let i = 0; i < 200 && (await opRow(operationId)).status !== "processing"; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect((await opRow(operationId)).status).toBe("processing");
    const snapshot = sim.appStacks.getAppStackSnapshot(stackId)!;
    expect(Object.values(snapshot.containers).map((c) => c.state)).toEqual(["created", "created"]);

    // The process dies: its lease lapses; the next pass over the database marks the operation unknown.
    await expireLease(operationId);
    const marked = await markExpiredOperationsUnknownTransactional(h.dbClient.db, new Date());
    expect(marked.map((o) => o.id)).toContain(operationId);
    const op = await opRow(operationId);
    expect(op.status).toBe("unknown");
    // Design §3.1: only an ambiguity or a failed read moves the stack itself; until then it never reads as settled.
    expect(["deploying", "unknown"]).toContain((await detail(stackId)).status);

    // A new API process on the same database, executor reads only.
    const readOnlyCalls: string[] = [];
    const guarded = new Proxy(sim, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== "function") return value;
        const method = String(prop);
        return (...args: unknown[]) => {
          readOnlyCalls.push(method);
          if (!READS.has(method) && method !== "isStackExecutor") throw new Error(`mutating call during recovery: ${method}`);
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as Sim;
    const second = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: h.dbClient,
      secretsMasterKey: Buffer.alloc(32, 7),
      runtimeBackend: "local-simulator",
      dockerExecutor: guarded,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
      appFeatures: { applicationTemplatesAvailable: true, applicationStacksAvailable: true },
      appTemplateValidation: { allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] },
    });
    extraApps.push(second);

    // The second API holds the same lock as the first one while the operation is unknown.
    await expectLocked(stackId, name);

    const mutationsBefore = sim.appStacks.appStackMutations.length;
    const secondWorker = second.nestApp.get(OutboxWorkerService);
    readOnlyCalls.length = 0;
    // Its first look at the executor fails: the outcome stays to be verified, shown as such, still locked.
    sim.appStacks.failNextAppStackStep("status", "engine_unavailable");
    const blind = await secondWorker.recoverUnknownOperations();
    expect(blind.convergedFailed + blind.convergedSucceeded).toBe(0);
    expect((await opRow(operationId)).status).toBe("unknown");
    expect((await stackRow(stackId)).status).toBe("unknown");
    expect((await detail(stackId)).status).toBe("unknown");
    expect((await deploymentOf(operationId)).status).toBe("unknown");
    await expectLocked(stackId, name);

    const result = await secondWorker.recoverUnknownOperations();
    expect(result.recoveryErrors).toBeUndefined();
    expect(result.convergedFailed).toBe(1);
    expect(readOnlyCalls.filter((m) => !READS.has(m))).toEqual([]);
    expect(sim.appStacks.appStackMutations.length).toBe(mutationsBefore);

    const settled = await opRow(operationId);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("OPERATION_INTERRUPTED");
    expect((await stackRow(stackId)).status).toBe("failed");
    expect((await deploymentOf(operationId)).status).toBe("failed");
    expect(await auditsOf(operationId, "operation.recovered.")).toHaveLength(1);
    expect(Object.values(sim.appStacks.getAppStackSnapshot(stackId)!.containers).map((c) => c.state)).toEqual(["created", "created"]);

    // The dead process wakes up late and fails: it cannot rewrite what recovery settled.
    release(new Error("the process was killed"));
    await running;
    expect((await opRow(operationId)).status).toBe("failed");
    expect((await opRow(operationId)).errorCode).toBe("OPERATION_INTERRUPTED");
    expect((await stackRow(stackId)).status).toBe("failed");
    expect(await auditsOf(operationId, "operation.recovered.")).toHaveLength(1);

    // Lock released.
    restore.splice(0).reverse().forEach((undo) => undo());
    const retry = await act(stackId, "deploy");
    expect(retry.status, retry.raw).toBe(202);
  }, 90_000);
});
