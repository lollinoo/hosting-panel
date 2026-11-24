import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, AppStackTaskReadIpcResultSchema, type AppStackTaskRunIpcResult } from "@hosting-panel/contracts";
import {
  appStacks,
  appStackTaskRuns,
  appStackTaskSchedules,
  auditEvents,
  enqueueAppStackTaskRunTransactional,
  eq,
  newAppEntityId,
  operations,
  operationSteps,
  outboxEvents,
  repairOrphanedAppStackTaskRunsTransactional,
  resourceQuotas,
  setAppStackTaskScheduleTransactional,
  transitionOperation,
} from "@hosting-panel/database";
import { Phase1DisabledDockerExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_STACK_TASK_LEASE_EXTRA_MS, AppStackTaskRuntime, appStackTaskRefusalProblem } from "../src/app-stacks/app-stack-task-runtime.js";
import { AppStackTaskSchedulerService } from "../src/app-stacks/app-stack-task-scheduler.service.js";
import { AppStackTasksService } from "../src/app-stacks/app-stack-tasks.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// ADR-0042, the worker side of one run, called directly with a scripted executor. Guards the HARNESS rule: the command
// is read from the template version of the installed revision when the run begins; a run the executor may have started
// is never sent a second time; what it printed goes to the row of the run and nowhere else.

const TASKS_SOURCE = `${APP_BUILT_IN_TEMPLATES[1]!.source.trimEnd()}
x-hp-tasks:
  - key: save
    label: Save now
    service: storage
    command: ["valkey-cli", "BGSAVE"]
    timeoutSeconds: 45
`;
const CANARY = "PRINTED-canary-9b2e";
const STARTED = "2026-11-23T03:00:00.000Z";
const ENDED = "2026-11-23T03:00:02.000Z";

const result = (runId: string, change: Partial<AppStackTaskRunIpcResult> = {}): AppStackTaskRunIpcResult => ({
  runId,
  outcome: "succeeded",
  problem: null,
  exitCode: 0,
  startedAt: STARTED,
  endedAt: ENDED,
  output: "",
  outputTruncated: false,
  ...change,
});
const refusal = (code: string, reason?: string) => Object.assign(new Error("refused"), { code, ...(reason ? { reason } : {}) });
const lost = () => Object.assign(new Error("the answer was lost"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });

describe("AppStackTaskRuntime (ADR-0042)", () => {
  let h: AppStackHarness;
  let stackId: string;
  const validation: AppTemplateValidationOptions = { allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] };
  const config = { runtimeBackend: "local-simulator" } as ControlPlaneRuntimeConfig;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: validation.allowlist! });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    const { versionId } = await h.publish(TASKS_SOURCE);
    const created = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: "tasks", deploy: true },
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status, created.raw).toBe(202);
    stackId = created.body.data.stackId as string;
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 10 && (await stack()).status !== "running"; round += 1) await worker.processPendingOnce();
    expect((await stack()).status).toBe("running");
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const stack = async () => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const runRow = async (runId: string) => (await h.dbClient.db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.id, runId)))[0]!;
  const opRow = async (id: string) => (await h.dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;

  function executor(script: { run?: (req: unknown) => Promise<unknown>; read?: (req: unknown) => Promise<unknown> } = {}) {
    const run = vi.fn(script.run ?? (async (req: unknown) => result((req as { runId: string }).runId)));
    const read = vi.fn(script.read ?? (async () => ({ state: "unknown" })));
    const port = { isRuntimeAvailable: true, runAppStackTask: run, getAppStackTaskRun: read } as unknown as DockerExecutorPort;
    return { port, run, read };
  }
  const runtime = (port: DockerExecutorPort, options: AppTemplateValidationOptions = validation, cfg = config) =>
    new AppStackTaskRuntime(h.dbClient, port, cfg, options);

  /** A queued run whose operation the worker has just taken. */
  async function taken(taskKey = "save", componentKey = "storage") {
    const queued = await enqueueAppStackTaskRunTransactional(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      taskKey,
      runId: newAppEntityId("srun"),
      componentKey,
      appliedRevisionId: (await stack()).appliedRevisionId!,
      request: { trigger: "manual", requestedByUserId: h.a.userId, idempotencyKey: randomUUID(), requestHash: "a".repeat(64) },
    });
    if (queued.outcome !== "queued") throw new Error(`not queued: ${JSON.stringify(queued)}`);
    await transitionOperation(h.dbClient.db, queued.operationId, "processing");
    return { op: await opRow(queued.operationId), runId: queued.run.id, payload: { stackId, runId: queued.run.id, operationId: queued.operationId } };
  }

  it("sends the command of the template version the application runs, and only when the run begins", async () => {
    const { port, run } = executor();
    // The row of the run names a component; the one the template gives the task is what counts.
    const t = await taken("save", "worker");
    await runtime(port).apply(t.op, t.payload);
    expect(run.mock.calls).toEqual([
      [{ stackId, organizationId: h.a.orgId, componentKey: "storage", runId: t.runId, argv: ["valkey-cli", "BGSAVE"], timeoutSeconds: 45 }],
    ]);
    expect(await runRow(t.runId)).toMatchObject({ status: "succeeded", problem: null, exitCode: 0, output: "", outputTruncated: false });
    expect((await runRow(t.runId)).startedAt?.toISOString()).toBe(STARTED);
    expect((await runRow(t.runId)).endedAt?.toISOString()).toBe(ENDED);
    expect(await opRow(t.op.id)).toMatchObject({ status: "succeeded", errorCode: null });
    const steps = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, t.op.id));
    expect(steps.map((s) => [s.key, s.status, s.message])).toEqual([["run", "succeeded", "The task ended well"]]);
    // The outbox payload and the operation never carried the command.
    const stored = JSON.stringify([await opRow(t.op.id), await h.dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, stackId))]);
    expect(stored).not.toContain("BGSAVE");
  });

  it("writes how the run ended in its row and a fixed text in its operation", async () => {
    const cases: Array<[Partial<AppStackTaskRunIpcResult>, Record<string, unknown>, Record<string, unknown>]> = [
      [
        { outcome: "failed", exitCode: 3, output: `boom ${CANARY}`, outputTruncated: true },
        { status: "failed", problem: null, exitCode: 3, output: `boom ${CANARY}`, outputTruncated: true },
        { status: "failed", errorCode: "HOST_JOB_FAILED", errorMessage: "The task ended with an error. See what it printed." },
      ],
      [
        { outcome: "failed", exitCode: null },
        { status: "failed", exitCode: null },
        { status: "failed", errorCode: "HOST_JOB_FAILED" },
      ],
      [
        { outcome: "timed_out", exitCode: null, output: "slow" },
        { status: "timed_out", exitCode: null, output: "slow" },
        { status: "failed", errorMessage: "The task took too long and was stopped." },
      ],
      [
        { outcome: "not_started", problem: "no_shell", exitCode: null, startedAt: null },
        { status: "not_started", problem: "cannot_run_tasks", startedAt: null },
        { status: "failed", errorCode: "NOT_SUPPORTED", errorMessage: "The task did not start: this part of the application cannot run tasks." },
      ],
    ];
    for (const [answer, row, operation] of cases) {
      const t = await taken();
      await runtime(executor({ run: async () => result(t.runId, answer) }).port).apply(t.op, t.payload);
      expect(await runRow(t.runId)).toMatchObject(row);
      expect(await opRow(t.op.id)).toMatchObject(operation);
      const steps = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, t.op.id));
      expect(steps.map((s) => s.status)).toEqual(["failed"]);
    }
    // What a run printed is in its row only.
    const elsewhere = JSON.stringify([
      await h.dbClient.db.select().from(operations),
      await h.dbClient.db.select().from(operationSteps),
      await h.dbClient.db.select().from(outboxEvents),
      await h.dbClient.db.select().from(auditEvents),
    ]);
    expect(elsewhere).not.toContain(CANARY);
    expect((await stack()).status).toBe("running");
  });

  it("closes a run the executor refused for sure as not started, with why", async () => {
    expect(appStackTaskRefusalProblem(refusal("RESOURCE_LOCKED", "STACK_COMPONENT_NOT_READY"))).toBe("component_not_running");
    expect(appStackTaskRefusalProblem(refusal("RESOURCE_LOCKED", "STACK_BUSY"))).toBe("unavailable");
    expect(appStackTaskRefusalProblem(refusal("HOST_POLICY_DENIED", "STACK_NAMESPACE_CONFLICT"))).toBe("refused");
    expect(appStackTaskRefusalProblem(refusal("VALIDATION_ERROR"))).toBe("refused");
    expect(appStackTaskRefusalProblem(refusal("DOCKER_ENGINE_UNAVAILABLE"))).toBe("unavailable");
    expect(appStackTaskRefusalProblem(refusal("NOT_FOUND"))).toBe("unavailable");
    expect(appStackTaskRefusalProblem(new Error("anything"))).toBe("unavailable");

    const cases: Array<[Error, string, string]> = [
      [refusal("RESOURCE_LOCKED", "STACK_COMPONENT_NOT_READY"), "component_not_running", "RESOURCE_LOCKED"],
      [refusal("HOST_POLICY_DENIED", "STACK_NAMESPACE_CONFLICT"), "refused", "HOST_POLICY_DENIED"],
      [refusal("DOCKER_ENGINE_UNAVAILABLE"), "unavailable", "DOCKER_ENGINE_UNAVAILABLE"],
    ];
    for (const [error, problem, code] of cases) {
      const t = await taken();
      const { port, run, read } = executor({ run: () => Promise.reject(error) });
      await runtime(port).apply(t.op, t.payload);
      expect(await runRow(t.runId)).toMatchObject({ status: "not_started", problem, startedAt: null, exitCode: null, output: "" });
      expect(await opRow(t.op.id)).toMatchObject({ status: "failed", errorCode: code });
      expect(run).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
    }
  });

  it("sends nothing without the task calls of the executor, or when the installed version has no such task", async () => {
    const none = await taken();
    await runtime(new Phase1DisabledDockerExecutor()).apply(none.op, none.payload);
    expect(await runRow(none.runId)).toMatchObject({ status: "not_started", problem: "unavailable", startedAt: null });
    expect(await opRow(none.op.id)).toMatchObject({ status: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE" });

    const off = await taken();
    const disabled = executor();
    await runtime(disabled.port, validation, { runtimeBackend: "disabled" } as ControlPlaneRuntimeConfig).apply(off.op, off.payload);
    expect(await runRow(off.runId)).toMatchObject({ status: "not_started", problem: "unavailable" });

    const ghost = await taken("ghost");
    const forGhost = executor();
    await runtime(forGhost.port).apply(ghost.op, ghost.payload);
    expect(await runRow(ghost.runId)).toMatchObject({ status: "not_started", problem: "task_gone" });
    expect(await opRow(ghost.op.id)).toMatchObject({ status: "failed", errorCode: "NOT_FOUND" });

    // A version today's checks no longer accept has no task: nothing of it is run.
    const stale = await taken();
    const forStale = executor();
    await runtime(forStale.port, { allowlist: [] }).apply(stale.op, stale.payload);
    expect(await runRow(stale.runId)).toMatchObject({ status: "not_started", problem: "task_gone" });
    for (const fake of [disabled, forGhost, forStale]) expect(fake.run).not.toHaveBeenCalled();
  });

  it("does not start a run whose application is busy when it begins, and gives a scheduled time back", async () => {
    const { port, run } = executor();
    const restart = async () => {
      const res = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/restart`, {}, { "Idempotency-Key": randomUUID() });
      expect(res.status, res.raw).toBe(202);
      return res.body.data.operationId as string;
    };
    const free = async (operationId: string) => {
      const worker = h.app.nestApp.get(OutboxWorkerService);
      for (let round = 0; round < 10 && (await opRow(operationId)).status !== "succeeded"; round += 1) await worker.processPendingOnce();
      expect((await stack()).status).toBe("running");
    };

    // A person's run waits; meanwhile the application is restarted: the run does not start and holds nothing.
    const asked = await taken();
    const first = await restart();
    await runtime(port).apply(asked.op, asked.payload);
    expect(await runRow(asked.runId)).toMatchObject({ status: "not_started", problem: "busy", startedAt: null, exitCode: null });
    expect(await opRow(asked.op.id)).toMatchObject({
      status: "failed",
      errorCode: "RESOURCE_LOCKED",
      errorMessage: "The task did not start: another action on the application was in progress.",
      lockKey: `stack:${stackId}:task`,
    });
    await free(first);

    // A time of a schedule in the same case is owed again with its reason, and is queued again inside its window.
    const changedAt = new Date("2026-11-22T12:00:00.000Z");
    const slot = new Date("2026-11-23T03:00:00.000Z");
    const schedule = { organizationId: h.a.orgId, stackId, taskKey: "save" };
    await setAppStackTaskScheduleTransactional(h.dbClient.db, { ...schedule, schedule: { frequency: "daily", hourUtc: 3 }, changedBy: null, now: changedAt });
    const queued = await enqueueAppStackTaskRunTransactional(h.dbClient.db, {
      ...schedule,
      runId: newAppEntityId("srun"),
      componentKey: "storage",
      appliedRevisionId: (await stack()).appliedRevisionId!,
      request: { trigger: "schedule", slot, changedAt },
    });
    if (queued.outcome !== "queued") throw new Error(`not queued: ${JSON.stringify(queued)}`);
    await transitionOperation(h.dbClient.db, queued.operationId, "processing");
    const second = await restart();
    await runtime(port).apply(await opRow(queued.operationId), { stackId, runId: queued.run.id, operationId: queued.operationId });
    expect(await h.dbClient.db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.id, queued.run.id))).toEqual([]);
    const [row] = await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId));
    expect(row).toMatchObject({ servedSlotAt: null, skippedSlotAt: slot, skipReason: "busy" });
    expect(await opRow(queued.operationId)).toMatchObject({ status: "failed", errorCode: "RESOURCE_LOCKED" });
    await free(second);
    const scheduler = h.app.nestApp.get(AppStackTaskSchedulerService);
    expect(await scheduler.tick(new Date(slot.getTime() + 10 * 60_000))).toMatchObject({ queued: 1 });
    const again = await h.dbClient.db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.stackId, stackId));
    expect(again.filter((r) => r.slotAt?.getTime() === slot.getTime()).map((r) => r.status)).toEqual(["queued"]);
    expect(run).not.toHaveBeenCalled();
    await setAppStackTaskScheduleTransactional(h.dbClient.db, { ...schedule, schedule: { frequency: "never" }, changedBy: null });
    await free(again.find((r) => r.status === "queued")!.operationId);
  });

  it("without the task calls of the executor a run is refused with 422 and a schedule queues nothing", async () => {
    const opsOf = async () => (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).length;
    const before = await opsOf();
    const disabled = { runtimeBackend: "disabled" } as ControlPlaneRuntimeConfig;
    for (const [port, cfg] of [[new Phase1DisabledDockerExecutor(), config], [executor().port, disabled]] as const) {
      const service = new AppStackTasksService(h.dbClient, validation, port, cfg);
      const ctx = { organizationId: h.a.orgId, userId: h.a.userId, idempotencyKey: randomUUID(), audit: async () => undefined };
      await expect(service.run(ctx, await stack(), "save")).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        details: [expect.objectContaining({ reason: "STACK_UNSUPPORTED_FEATURE" })],
      });
    }
    expect(await opsOf()).toBe(before);

    // The scheduler queues no operation that could only fail: the time stays owed and is written as missed after its window.
    const changedAt = new Date("2026-11-22T12:00:00.000Z");
    const slot = new Date("2026-11-23T03:00:00.000Z");
    const schedule = { organizationId: h.a.orgId, stackId, taskKey: "save" };
    await setAppStackTaskScheduleTransactional(h.dbClient.db, { ...schedule, schedule: { frequency: "daily", hourUtc: 3 }, changedBy: null, now: changedAt });
    const worker = h.app.nestApp.get(OutboxWorkerService);
    const scheduler = new AppStackTaskSchedulerService(h.dbClient, config, validation, worker, new Phase1DisabledDockerExecutor());
    expect(await scheduler.tick(new Date(slot.getTime() + 60_000))).toEqual({ queued: 0, refused: 0, skipped: 0 });
    expect(await opsOf()).toBe(before);
    expect(await scheduler.tick(new Date(slot.getTime() + 31 * 60_000))).toEqual({ queued: 0, refused: 0, skipped: 1 });
    const [row] = await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId));
    expect(row).toMatchObject({ servedSlotAt: slot, skippedSlotAt: slot, skipReason: "missed" });
    expect(await opsOf()).toBe(before);
    await setAppStackTaskScheduleTransactional(h.dbClient.db, { ...schedule, schedule: { frequency: "never" }, changedBy: null });
  });

  it("fails an operation whose payload is not of one of its runs, and sends nothing", async () => {
    const { port, run } = executor();
    const payloads: Array<(runId: string) => Record<string, unknown>> = [
      () => ({}),
      () => ({ stackId, runId: newAppEntityId("srun") }),
      (runId) => ({ stackId: "stk_other", runId }),
      () => ({ stackId, runId: "nope" }),
    ];
    for (const payloadOf of payloads) {
      const t = await taken();
      await runtime(port).apply(t.op, payloadOf(t.runId));
      expect(await opRow(t.op.id)).toMatchObject({ status: "failed", errorCode: "NOT_FOUND" });
      // The run of that operation was never started; the scheduler's repair closes it.
      expect((await runRow(t.runId)).status).toBe("queued");
    }
    expect(run).not.toHaveBeenCalled();
    expect(await repairOrphanedAppStackTaskRunsTransactional(h.dbClient.db)).toBe(payloads.length);
  });

  it("keeps the lease beyond the time limit, and leaves a run whose answer is lost as it is", async () => {
    const t = await taken();
    const before = Date.now();
    const { port, run } = executor({ run: () => Promise.reject(lost()) });
    await expect(runtime(port).apply(t.op, t.payload)).rejects.toMatchObject({ ambiguousOutcome: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await runRow(t.runId)).toMatchObject({ status: "running", endedAt: null });
    const op = await opRow(t.op.id);
    expect(op.status).toBe("processing");
    expect(op.leaseExpiresAt!.getTime() - before).toBeGreaterThanOrEqual(45_000 + APP_STACK_TASK_LEASE_EXTRA_MS);
    expect(APP_STACK_TASK_LEASE_EXTRA_MS).toBeGreaterThan(120_000);

    // Recovery reads; it never sends the run again.
    const down = executor({ read: () => Promise.reject(refusal("DOCKER_ENGINE_UNAVAILABLE")) });
    expect(await runtime(down.port).recover(op)).toBe("pending");
    const going = executor({ read: async () => ({ state: "running" }) });
    expect(await runtime(going.port).recover(op)).toBe("pending");
    expect(going.read.mock.calls).toEqual([[{ stackId, organizationId: h.a.orgId, runId: t.runId }]]);
    expect(await runRow(t.runId)).toMatchObject({ status: "running" });
    expect((await opRow(t.op.id)).status).toBe("processing");

    const done = executor({ read: async () => ({ state: "finished", result: result(t.runId, { outcome: "failed", exitCode: 9, output: "late" }) }) });
    expect(await runtime(done.port).recover(op)).toBe("settled");
    expect(await runRow(t.runId)).toMatchObject({ status: "failed", exitCode: 9, output: "late" });
    expect(await opRow(t.op.id)).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED" });
    for (const fake of [down, going, done]) expect(fake.run).not.toHaveBeenCalled();
    // Settled once: a second recovery changes nothing.
    expect(await runtime(executor().port).recover(op)).toBe("settled");
    expect(await runRow(t.runId)).toMatchObject({ status: "failed", exitCode: 9 });
  });

  it("calls the outcome unknown when the executor does not know the run, and never starts it again", async () => {
    const t = await taken();
    await expect(runtime(executor({ run: () => Promise.reject(lost()) }).port).apply(t.op, t.payload)).rejects.toBeDefined();
    const forgot = executor({ read: async () => ({ state: "unknown" }) });
    expect(await runtime(forgot.port).recover(t.op)).toBe("settled");
    expect(await runRow(t.runId)).toMatchObject({ status: "unknown", problem: "outcome_lost", exitCode: null, output: "" });
    expect((await runRow(t.runId)).startedAt).not.toBeNull();
    expect(await opRow(t.op.id)).toMatchObject({
      status: "failed",
      errorCode: "OPERATION_AMBIGUOUS",
      errorMessage: "It is not known how the task ended. It was not started again.",
    });
    expect(forgot.run).not.toHaveBeenCalled();

    // An answer about the run that cannot be read now (it fails the schema the panel holds) will not be read later
    // either: the outcome is unknown, and the run is not started again.
    const w = await taken();
    const sent = executor({ run: () => Promise.reject(lost()) });
    await expect(runtime(sent.port).apply(w.op, w.payload)).rejects.toMatchObject({ ambiguousOutcome: true });
    expect(await runRow(w.runId)).toMatchObject({ status: "running" });
    const garbled = executor({ read: async () => AppStackTaskReadIpcResultSchema.parse({ state: "finished", result: { runId: w.runId } }) });
    expect(await runtime(garbled.port).recover(w.op)).toBe("settled");
    expect(await runRow(w.runId)).toMatchObject({ status: "unknown", problem: "outcome_lost", exitCode: null, output: "" });
    expect(await opRow(w.op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
    expect(garbled.read).toHaveBeenCalledTimes(1);
    expect(sent.run).toHaveBeenCalledTimes(1);
    expect(garbled.run).not.toHaveBeenCalled();

    // Without the task calls nobody can tell either.
    const u = await taken();
    await expect(runtime(executor({ run: () => Promise.reject(lost()) }).port).apply(u.op, u.payload)).rejects.toBeDefined();
    expect(await runtime(new Phase1DisabledDockerExecutor()).recover(u.op)).toBe("settled");
    expect(await runRow(u.runId)).toMatchObject({ status: "unknown", problem: "outcome_lost" });

    // The panel stopped before anything was sent: the run did not start.
    const v = await taken();
    const untouched = executor();
    expect(await runtime(untouched.port).recover(v.op)).toBe("settled");
    expect(await runRow(v.runId)).toMatchObject({ status: "not_started", problem: "unavailable" });
    expect(untouched.run).not.toHaveBeenCalled();
    expect(untouched.read).not.toHaveBeenCalled();
    // The application is free again.
    expect((await stack()).status).toBe("running");
    const free = await taken();
    await runtime(executor().port).apply(free.op, free.payload);
    expect((await opRow(free.op.id)).status).toBe("succeeded");
  });
});
