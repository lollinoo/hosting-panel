import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  AppStackTaskRunsDtoSchema,
  AppStackTasksDtoSchema,
  type AppImageAllowlistEntry,
} from "@hosting-panel/contracts";
import {
  and,
  appStackDeployments,
  appStacks,
  appStackTaskRuns,
  appStackTaskSchedules,
  auditEvents,
  eq,
  operations,
  outboxEvents,
  resourceQuotas,
  rolePermissions,
  roles,
  sql,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppStackTaskSchedulerService } from "../src/app-stacks/app-stack-task-scheduler.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

// ADR-0042 over HTTP, the worker and the scheduler, with the simulated executor. Guards the HARNESS rule: a request
// names a task and never a command; the command comes from the template version of the installed revision; a run whose
// outcome is unknown is never started again; what a run printed lives only in the row of the run.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** The built-in worker with its store (images on the code allowlist, so the simulator runs it), plus two tasks. */
const PLAIN_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;
const TASKS_SOURCE = `${PLAIN_SOURCE.trimEnd()}
x-hp-tasks:
  - key: save
    label: Salva i dati adesso
    description: Scrive subito i dati su disco.
    service: storage
    command: ["valkey-cli", "BGSAVE"]
  - key: count
    label: Leggi il contatore
    service: worker
    command: ["valkey-cli", "-h", "storage", "GET", "worker:ticks"]
    timeoutSeconds: 30
`;
const CANARY = "PRINTED-canary-41c7";
/** The question `hp-update` asks before it goes back to a release without tasks, as infra/linux/lib/common.sh writes it. */
const IN_USE_QUERY = /"(select 'app-tasks' where exists \([^"]+\))"/.exec(
  readFileSync(new URL("../../../infra/linux/lib/common.sh", import.meta.url), "utf8"),
)![1]!;
const HOUR = 3_600_000;

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("tasks of an application (ADR-0042)", () => {
  let h: AppStackHarness;
  let withTasks: string;
  let plain: string;
  let sim: InMemoryDockerSimulatorAdapter;
  let worker: OutboxWorkerService;
  let scheduler: AppStackTaskSchedulerService;
  let inUseBefore: unknown[];
  const inUse = async (): Promise<unknown[]> => (await h.dbClient.db.execute(sql.raw(IN_USE_QUERY))).rows.map((row) => Object.values(row)[0]);
  const allowlist: AppImageAllowlistEntry[] = [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    plain = (await h.publish(PLAIN_SOURCE)).versionId;
    inUseBefore = await inUse();
    withTasks = (await h.publish(TASKS_SOURCE)).versionId;
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    worker = h.app.nestApp.get(OutboxWorkerService);
    scheduler = h.app.nestApp.get(AppStackTaskSchedulerService);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (stackId: string, c: HarnessCustomer = h.a) => `/v1/organizations/${c.orgId}/app-stacks/${stackId}`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const list = (stackId: string, c: HarnessCustomer = h.a) => h.call(c.token, "GET", `${base(stackId)}/tasks`);
  const runs = (stackId: string, taskKey: string, c: HarnessCustomer = h.a) => h.call(c.token, "GET", `${base(stackId)}/tasks/${taskKey}/runs`);
  const run = (stackId: string, taskKey: string, key?: string, body: unknown = {}, c: HarnessCustomer = h.a) =>
    h.call(c.token, "POST", `${base(stackId)}/tasks/${taskKey}/runs`, body, idem(key));
  const setSchedule = (stackId: string, taskKey: string, body: unknown, c: HarnessCustomer = h.a) =>
    h.call(c.token, "PUT", `${base(stackId)}/tasks/${taskKey}/schedule`, body);
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const runRows = (stackId: string) => h.dbClient.db.select().from(appStackTaskRuns).where(eq(appStackTaskRuns.stackId, stackId));
  const opRow = async (id: string) => (await h.dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const audits = (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));
  const taskCalls = (stackId: string) => sim.appStackTasks.appStackTaskCalls.filter((c) => c.stackId === stackId && c.method === "runAppStackTask");

  async function create(versionId: string, deploy: boolean): Promise<string> {
    const res = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy },
      idem(),
    );
    expect(res.status, res.raw).toBe(deploy ? 202 : 201);
    return res.body.data.stackId as string;
  }

  /** An application installed and running through the simulator. */
  async function running(versionId: string = withTasks): Promise<string> {
    const stackId = await create(versionId, true);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();
    expect((await stackRow(stackId)).status).toBe("running");
    return stackId;
  }

  /** Queues a run and lets the worker take it. */
  async function ran(stackId: string, taskKey: string): Promise<{ runId: string; operationId: string }> {
    const res = await run(stackId, taskKey);
    expect(res.status, res.raw).toBe(202);
    await worker.processPendingOnce();
    return res.body.data as { runId: string; operationId: string };
  }

  it("the release feature app-tasks is in use as soon as a template version declares a task, and not before", async () => {
    expect(IN_USE_QUERY).toContain("app_template_versions");
    expect(inUseBefore).toEqual([]);
    expect(await inUse()).toEqual(["app-tasks"]);
  });

  it("lists the tasks of the installed version in the order of the template, and none before an install", async () => {
    const stackId = await running();
    const res = await list(stackId);
    expect(res.status, res.raw).toBe(200);
    expect(AppStackTasksDtoSchema.safeParse(res.body.data).success).toBe(true);
    expect(res.body.data.tasks).toEqual([
      {
        key: "save",
        label: "Salva i dati adesso",
        description: "Scrive subito i dati su disco.",
        componentKey: "storage",
        schedule: { frequency: "never" },
        nextRunAt: null,
        skipped: null,
        lastRun: null,
      },
      { key: "count", label: "Leggi il contatore", description: "", componentKey: "worker", schedule: { frequency: "never" }, nextRunAt: null, skipped: null, lastRun: null },
    ]);
    // No command, no argument and no time limit reaches a customer.
    expect(res.raw).not.toMatch(/valkey-cli|BGSAVE|command|argv|timeoutSeconds/);

    expect((await list(await running(plain))).body.data).toEqual({ tasks: [] });
    const draft = await create(withTasks, false);
    expect((await list(draft)).body.data).toEqual({ tasks: [] });
    // Nothing is installed: there is no task to run or to schedule yet.
    expectRefusal(await run(draft, "save"), 409, "RESOURCE_LOCKED", { reason: "draft" });
    expectRefusal(await setSchedule(draft, "save", { frequency: "hourly" }), 409, "RESOURCE_LOCKED");
    expectRefusal(await runs(draft, "save"), 409, "RESOURCE_LOCKED");
  });

  it("runs a task: the command comes from the template, the status of the application stays, the run is kept", async () => {
    const stackId = await running();
    const deployments = (await h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId))).length;
    sim.appStackTasks.setNextAppStackTaskRun({ lines: ["Background saving started", CANARY] });
    const key = randomUUID();
    const accepted = await run(stackId, "save", key);
    expect(accepted.status, accepted.raw).toBe(202);
    const { runId, operationId } = accepted.body.data as { runId: string; operationId: string };
    expect(accepted.body).toEqual({
      data: { runId, operationId, status: "queued" },
      links: { runs: `${base(stackId)}/tasks/save/runs`, operation: `/v1/organizations/${h.a.orgId}/operations/${operationId}` },
    });
    expect(runId).toMatch(/^srun_[0-9a-f]{24}$/);
    expect(await opRow(operationId)).toMatchObject({ kind: "stack.task", status: "queued", resourceId: stackId, lockKey: `stack:${stackId}:task` });
    // The operation and its outbox row carry the application and the run, never the command.
    const payloads = (await h.dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, stackId))).map((e) => e.payload as Json);
    expect(payloads.find((p) => p.runId === runId)).toEqual({
      stackId,
      runId,
      operationId,
      organizationId: h.a.orgId,
      kind: "stack.task",
      resourceType: "stack",
      resourceId: stackId,
    });
    expect((await list(stackId)).body.data.tasks[0].lastRun).toMatchObject({ id: runId, status: "queued", trigger: "manual" });

    await worker.processPendingOnce();
    expect(taskCalls(stackId)).toEqual([
      { method: "runAppStackTask", stackId, runId, componentKey: "storage", argv: ["valkey-cli", "BGSAVE"], timeoutSeconds: 60 },
    ]);
    expect(await opRow(operationId)).toMatchObject({ status: "succeeded", errorCode: null, errorMessage: null });
    expect((await stackRow(stackId)).status).toBe("running");
    expect(await h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId))).toHaveLength(deployments);

    const shown = await runs(stackId, "save");
    expect(shown.status, shown.raw).toBe(200);
    expect(AppStackTaskRunsDtoSchema.safeParse(shown.body.data).success).toBe(true);
    expect(shown.body.data.runs).toEqual([
      {
        id: runId,
        taskKey: "save",
        trigger: "manual",
        status: "succeeded",
        problem: null,
        requestedAt: expect.any(String) as string,
        startedAt: expect.any(String) as string,
        endedAt: expect.any(String) as string,
        output: `Background saving started\n${CANARY}`,
        outputTruncated: false,
      },
    ]);
    expect(shown.raw).not.toMatch(/exitCode|exit_code/);
    expect((await list(stackId)).body.data.tasks[0].lastRun).toMatchObject({ id: runId, status: "succeeded" });

    // A retry with the same key answers the same run and starts nothing.
    const replay = await run(stackId, "save", key);
    expect(replay.status, replay.raw).toBe(202);
    expect(replay.body.data).toEqual({ runId, operationId, status: "succeeded" });
    await worker.processPendingOnce();
    expect(taskCalls(stackId)).toHaveLength(1);
    expectRefusal(await run(stackId, "count", key), 409, "IDEMPOTENCY_CONFLICT");

    // Audited once, with the task and the run; what the run printed is in the row of the run and nowhere else.
    const audit = await audits("app.task.run", stackId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ taskKey: "save", runId, operationId });
    const elsewhere = JSON.stringify([
      await h.dbClient.db.select().from(auditEvents),
      await h.dbClient.db.select().from(outboxEvents),
      await h.dbClient.db.select().from(operations),
    ]);
    expect(elsewhere).not.toContain(CANARY);
    expect(elsewhere).not.toContain("BGSAVE");
  });

  it("takes no command: the body is empty and the task is a key of the installed version", async () => {
    const stackId = await running();
    for (const body of [{ command: ["rm", "-rf", "/"] }, { argv: ["id"] }, { taskKey: "count" }, { timeoutSeconds: 600 }, "{not json"]) {
      expectRefusal(await run(stackId, "save", undefined, body), 400, "VALIDATION_ERROR");
    }
    expectRefusal(await h.call(h.a.token, "POST", `${base(stackId)}/tasks/save/runs`, {}), 400, "VALIDATION_ERROR");
    expectRefusal(await run(stackId, "nope"), 404, "NOT_FOUND");
    expectRefusal(await run(stackId, "Bad_Key"), 400, "VALIDATION_ERROR");
    expectRefusal(await runs(stackId, "nope"), 404, "NOT_FOUND");
    expectRefusal(await setSchedule(stackId, "nope", { frequency: "hourly" }), 404, "NOT_FOUND");
    expect(await runRows(stackId)).toEqual([]);
    expect(taskCalls(stackId)).toEqual([]);
  });

  it("lets app.read see and only app.control run and schedule; another customer finds nothing", async () => {
    const stackId = await running();
    await ran(stackId, "save");
    await h.dbClient.db.insert(roles).values({ id: "role_task_reader", name: "task_reader" as never, description: "Read only", isPreset: false });
    await h.dbClient.db.insert(rolePermissions).values({ roleId: "role_task_reader", permissionKey: "app.read" });
    const reader = await h.addMember(h.a.orgId, "role_task_reader" as "role_customer_collaborator");
    expect((await list(stackId, reader)).status).toBe(200);
    expect((await runs(stackId, "save", reader)).status).toBe(200);
    expectRefusal(await run(stackId, "save", undefined, {}, reader), 403, "PERMISSION_DENIED");
    expectRefusal(await setSchedule(stackId, "save", { frequency: "hourly" }, reader), 403, "PERMISSION_DENIED");

    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    expectRefusal(await list(stackId, collaborator), 403, "PERMISSION_DENIED");
    expectRefusal(await runs(stackId, "save", collaborator), 403, "PERMISSION_DENIED");
    expectRefusal(await run(stackId, "save", undefined, {}, collaborator), 403, "PERMISSION_DENIED");

    // Customer B, with every permission in its own organisation: under its own path and under A's.
    for (const path of [base(stackId, h.b), base(stackId)]) {
      expectRefusal(await h.call(h.b.token, "GET", `${path}/tasks`), 404, "NOT_FOUND");
      expectRefusal(await h.call(h.b.token, "GET", `${path}/tasks/save/runs`), 404, "NOT_FOUND");
      expectRefusal(await h.call(h.b.token, "POST", `${path}/tasks/save/runs`, {}, idem()), 404, "NOT_FOUND");
      expectRefusal(await h.call(h.b.token, "PUT", `${path}/tasks/save/schedule`, { frequency: "hourly" }), 404, "NOT_FOUND");
    }
    expectRefusal(await h.call(null, "GET", `${base(stackId)}/tasks`), 401, "UNAUTHENTICATED");
    expect(await runRows(stackId)).toHaveLength(1);
    expect(await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId))).toEqual([]);
  });

  it("tells a run that ended badly, at its time limit or did not start, and leaves the application as it is", async () => {
    const stackId = await running();
    sim.appStackTasks.setNextAppStackTaskRun({ exitCode: 2, lines: ["ERR something"] });
    const failed = await ran(stackId, "save");
    expect(await opRow(failed.operationId)).toMatchObject({
      status: "failed",
      errorCode: "HOST_JOB_FAILED",
      errorMessage: "The task ended with an error. See what it printed.",
    });
    sim.appStackTasks.setNextAppStackTaskRun({ timedOut: true, lines: ["still going"] });
    const slow = await ran(stackId, "save");
    expect(await opRow(slow.operationId)).toMatchObject({ status: "failed", errorMessage: "The task took too long and was stopped." });
    sim.appStackTasks.setNextAppStackTaskRun({ noShell: true });
    const never = await ran(stackId, "save");
    expect(await opRow(never.operationId)).toMatchObject({ status: "failed", errorCode: "NOT_SUPPORTED" });
    // The component of the task is not running: the executor refuses and nothing ran.
    sim.appStacks.crashAppStackComponent(stackId, "worker");
    const down = await ran(stackId, "count");
    expect(await opRow(down.operationId)).toMatchObject({ status: "failed", errorCode: "RESOURCE_LOCKED" });

    const shown = (await runs(stackId, "save")).body.data.runs as Json[];
    expect(shown.map((r) => [r.status, r.problem, r.output])).toEqual([
      ["not_started", "cannot_run_tasks", ""],
      ["timed_out", null, "still going"],
      ["failed", null, "ERR something"],
    ]);
    expect(shown[0]!.startedAt).toBeNull();
    expect(((await runs(stackId, "count")).body.data.runs as Json[]).map((r) => [r.status, r.problem, r.startedAt])).toEqual([
      ["not_started", "component_not_running", null],
    ]);
    // The exit code is kept in the row (the runbook reads it) and is not shown.
    expect((await runRows(stackId)).find((r) => r.id === failed.runId)).toMatchObject({ exitCode: 2, status: "failed" });
    expect((await stackRow(stackId)).status).toBe("running");
  });

  it("refuses a run while the application is being changed, while another task is queued and while it is stopped", async () => {
    const stackId = await running();
    // One task at a time: while the first is queued, a second one is refused. (A run that waits does not hold the
    // application itself; one that runs does: see the two cases below and the lost answers.)
    const first = await run(stackId, "save");
    expect(first.status, first.raw).toBe(202);
    expectRefusal(await run(stackId, "count"), 409, "RESOURCE_LOCKED");
    await worker.processPendingOnce();

    const restart = await h.call(h.a.token, "POST", `${base(stackId)}/restart`, {}, idem());
    expect(restart.status, restart.raw).toBe(202);
    const busy = await run(stackId, "save");
    expectRefusal(busy, 409, "RESOURCE_LOCKED");
    expect(busy.body.error.retryable).toBe(true);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();

    const stop = await h.call(h.a.token, "POST", `${base(stackId)}/stop`, {}, idem());
    expect(stop.status, stop.raw).toBe(202);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "stopped"; round += 1) await worker.processPendingOnce();
    expectRefusal(await run(stackId, "save"), 409, "RESOURCE_LOCKED", { field: "status", reason: "stopped" });
    expect(await runRows(stackId)).toHaveLength(1);
    expect(taskCalls(stackId)).toHaveLength(1);
  });

  it("a run that waits behind other applications' runs does not hold its application: a stop is accepted", async () => {
    // A, B and C each run a task; the lane of tasks takes them one after the other, so C's run waits.
    const [a, b, c] = [await running(), await running(), await running()];
    for (const stackId of [a, b, c]) expect((await run(stackId, "save")).status).toBe(202);
    // One run waiting or running per application stays the rule.
    expectRefusal(await run(c, "count"), 409, "RESOURCE_LOCKED");
    // The customer stops C while its run has not started.
    const stop = await h.call(h.a.token, "POST", `${base(c)}/stop`, {}, idem());
    expect(stop.status, stop.raw).toBe(202);
    for (let round = 0; round < 10 && (await stackRow(c)).status !== "stopped"; round += 1) await worker.processPendingOnce();
    expect((await stackRow(c)).status).toBe("stopped");
    // C's run found its application busy (the stop in flight) or stopped: it did not start and nothing was sent.
    const [left] = await runRows(c);
    expect(left).toMatchObject({ status: "not_started", startedAt: null, exitCode: null });
    expect(["busy", "component_not_running"]).toContain(left!.problem);
    expect(taskCalls(c)).toEqual([]);
    expect(await opRow(left!.operationId)).toMatchObject({ status: "failed", errorCode: "RESOURCE_LOCKED" });
    for (const stackId of [a, b]) {
      expect((await runRows(stackId)).map((r) => r.status)).toEqual(["succeeded"]);
      expect((await stackRow(stackId)).status).toBe("running");
    }
  });

  it("stores the schedule a customer chooses and refuses anything that is not one of the four choices", async () => {
    const stackId = await running();
    const now = Date.now();
    const hourly = await setSchedule(stackId, "save", { frequency: "hourly" });
    expect(hourly.status, hourly.raw).toBe(200);
    const task = hourly.body.data.tasks[0] as Json;
    expect(task.schedule).toEqual({ frequency: "hourly" });
    expect(new Date(task.nextRunAt as string).getTime()).toBe((Math.floor(now / HOUR) + 1) * HOUR);
    expect(hourly.body.data.tasks[1].schedule).toEqual({ frequency: "never" });

    const weekly = await setSchedule(stackId, "save", { frequency: "weekly", weekday: 7, hourUtc: 3 });
    expect(weekly.body.data.tasks[0].schedule).toEqual({ frequency: "weekly", weekday: 7, hourUtc: 3 });
    const next = new Date(weekly.body.data.tasks[0].nextRunAt as string);
    expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([0, 3, 0]);
    expect((await setSchedule(stackId, "count", { frequency: "daily", hourUtc: 23 })).body.data.tasks[1].schedule).toEqual({ frequency: "daily", hourUtc: 23 });

    for (const body of [
      { frequency: "hourly", hourUtc: 3 },
      { frequency: "daily" },
      { frequency: "daily", hourUtc: 24 },
      { frequency: "daily", hourUtc: 3, minute: 30 },
      { frequency: "weekly", hourUtc: 3 },
      { frequency: "weekly", weekday: 0, hourUtc: 3 },
      { frequency: "cron", expression: "*/5 * * * *" },
      { cron: "0 3 * * *" },
      { frequency: "hourly", command: ["id"] },
      {},
    ]) {
      expectRefusal(await setSchedule(stackId, "save", body), 400, "VALIDATION_ERROR");
    }
    const rows = await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId));
    expect(rows.map((r) => [r.taskKey, r.frequency, r.hourUtc, r.weekday, r.changedBy]).sort()).toEqual([
      ["count", "daily", 23, null, h.a.userId],
      ["save", "weekly", 3, 7, h.a.userId],
    ]);
    const audit = await audits("app.task.schedule", stackId);
    expect(audit.map((a) => a.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskKey: "save", frequency: "hourly" }),
        expect.objectContaining({ taskKey: "save", frequency: "weekly", weekday: 7, hourUtc: 3 }),
        expect.objectContaining({ taskKey: "count", frequency: "daily", hourUtc: 23 }),
      ]),
    );
    expect(audit).toHaveLength(3);

    const never = await setSchedule(stackId, "save", { frequency: "never" });
    expect(never.body.data.tasks[0]).toMatchObject({ schedule: { frequency: "never" }, nextRunAt: null });
    expect(await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId))).toHaveLength(1);
    // No schedule is left behind for the passes of the cases below.
    expect((await setSchedule(stackId, "count", { frequency: "never" })).status).toBe(200);
    expect(await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId))).toEqual([]);
  });

  it("queues a scheduled task at its time, once, and never while the application is stopped or being changed", async () => {
    const stackId = await running();
    expect((await setSchedule(stackId, "save", { frequency: "hourly" })).status).toBe(200);
    const slot = (Math.floor(Date.now() / HOUR) + 1) * HOUR;
    const at = (minutes: number, hours = 0) => new Date(slot + hours * HOUR + minutes * 60_000);

    // Before the time: nothing. At the time: one run, whoever asks and however often.
    expect(await scheduler.tick(new Date(slot - 60_000))).toEqual({ queued: 0, refused: 0, skipped: 0 });
    expect(await scheduler.tick(at(0))).toEqual({ queued: 1, refused: 0, skipped: 0 });
    expect(await scheduler.tick(at(1))).toEqual({ queued: 0, refused: 0, skipped: 0 });
    await worker.processPendingOnce();
    expect(await scheduler.tick(at(2))).toEqual({ queued: 0, refused: 0, skipped: 0 });
    const first = await runRows(stackId);
    expect(first.map((r) => [r.trigger, r.status, r.requestedBy, r.slotAt?.getTime()])).toEqual([["schedule", "succeeded", null, slot]]);
    expect(taskCalls(stackId)).toHaveLength(1);
    // What the schedule does by itself is not a person's action: no audit row.
    expect(await audits("app.task.run", stackId)).toEqual([]);

    // The next hour the application is being changed: the time is tried again, then queued when it is free.
    const restart = await h.call(h.a.token, "POST", `${base(stackId)}/restart`, {}, idem());
    expect(restart.status, restart.raw).toBe(202);
    expect(await scheduler.tick(at(0, 1))).toEqual({ queued: 0, refused: 1, skipped: 0 });
    // Still owed: the page says it is waiting, not that it was skipped.
    expect((await list(stackId)).body.data.tasks[0].skipped).toEqual({ at: at(0, 1).toISOString(), reason: "busy", pending: true });
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();
    expect(await scheduler.tick(at(5, 1))).toEqual({ queued: 1, refused: 0, skipped: 0 });
    await worker.processPendingOnce();
    expect((await list(stackId)).body.data.tasks[0].skipped).toBeNull();
    expect(await runRows(stackId)).toHaveLength(2);

    // Stopped: tried for 30 minutes, then given up with its reason; the time is not caught up later.
    const stop = await h.call(h.a.token, "POST", `${base(stackId)}/stop`, {}, idem());
    expect(stop.status, stop.raw).toBe(202);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "stopped"; round += 1) await worker.processPendingOnce();
    expect(await scheduler.tick(at(0, 2))).toEqual({ queued: 0, refused: 1, skipped: 0 });
    expect(await scheduler.tick(at(29, 2))).toEqual({ queued: 0, refused: 1, skipped: 0 });
    expect((await list(stackId)).body.data.tasks[0].skipped).toEqual({ at: at(0, 2).toISOString(), reason: "not_running", pending: true });
    expect(await scheduler.tick(at(31, 2))).toEqual({ queued: 0, refused: 0, skipped: 1 });
    expect(await scheduler.tick(at(32, 2))).toEqual({ queued: 0, refused: 0, skipped: 0 });
    // Given up: the same reason, and the page tells it apart from a time still tried.
    expect((await list(stackId)).body.data.tasks[0].skipped).toEqual({ at: at(0, 2).toISOString(), reason: "not_running", pending: false });

    const start = await h.call(h.a.token, "POST", `${base(stackId)}/start`, {}, idem());
    expect(start.status, start.raw).toBe(202);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();
    // The panel was off for hours: only the latest time counts, and it is too old to be queued.
    expect(await scheduler.tick(at(45, 6))).toEqual({ queued: 0, refused: 0, skipped: 1 });
    expect((await list(stackId)).body.data.tasks[0].skipped).toEqual({ at: at(0, 6).toISOString(), reason: "missed", pending: false });
    expect(await scheduler.tick(at(0, 7))).toEqual({ queued: 1, refused: 0, skipped: 0 });
    await worker.processPendingOnce();
    expect(await runRows(stackId)).toHaveLength(3);
    expect(taskCalls(stackId)).toHaveLength(3);
  });

  describe("after the clock of the server ran ahead", () => {
    // The passes below count what they queue: no other schedule is left, before or after.
    const noSchedules = (): Promise<unknown> => h.dbClient.db.delete(appStackTaskSchedules);
    afterEach(noSchedules);
    const alone = async (): Promise<string> => {
      await noSchedules();
      const stackId = await running();
      expect((await setSchedule(stackId, "save", { frequency: "hourly" })).status).toBe(200);
      return stackId;
    };
    const scheduleRow = async (stackId: string) =>
      (await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId)))[0]!;
    const NONE = { queued: 0, refused: 0, skipped: 0 };

    it("owes a schedule its next time again when the time it stored lies ahead of the clock", async () => {
      const stackId = await alone();
      const now = new Date();
      const nextHour = new Date((Math.floor(now.getTime() / HOUR) + 1) * HOUR);
      // The clock was two days ahead when the schedule was set and a time was served.
      const ahead = new Date(now.getTime() + 48 * HOUR);
      await h.dbClient.db
        .update(appStackTaskSchedules)
        .set({ servedSlotAt: ahead, changedAt: ahead })
        .where(eq(appStackTaskSchedules.stackId, stackId));

      expect(await scheduler.tick(now)).toEqual(NONE);
      expect(await scheduler.tick(nextHour)).toEqual({ ...NONE, queued: 1 });
      await worker.processPendingOnce();
      expect(await scheduler.tick(new Date(nextHour.getTime() + 60_000))).toEqual(NONE);
      expect(await scheduler.tick(new Date(nextHour.getTime() + 31 * 60_000))).toEqual(NONE);
      expect((await runRows(stackId)).map((r) => [r.trigger, r.status, r.slotAt?.getTime()])).toEqual([["schedule", "succeeded", nextHour.getTime()]]);
      expect(taskCalls(stackId)).toHaveLength(1);
      // The time was never written as skipped, and the stored times are the clock's again.
      expect((await list(stackId)).body.data.tasks[0].skipped).toBeNull();
      expect(await scheduleRow(stackId)).toMatchObject({ servedSlotAt: nextHour, changedAt: now, skippedSlotAt: null });
    });

    it("does not run again, nor write as skipped, a time that ran while the clock was ahead", async () => {
      const stackId = await alone();
      const now = new Date();
      const slot = new Date((Math.floor(now.getTime() / HOUR) + 3) * HOUR);
      const at = (minutes: number) => new Date(slot.getTime() + minutes * 60_000);

      // The clock is three hours ahead: the time is queued and the run ends.
      expect(await scheduler.tick(at(5))).toEqual({ ...NONE, queued: 1 });
      await worker.processPendingOnce();
      expect(await scheduleRow(stackId)).toMatchObject({ servedSlotAt: slot });
      // The clock is set right: the served time lies ahead and is not trusted.
      expect(await scheduler.tick(now)).toEqual(NONE);
      expect(await scheduleRow(stackId)).toMatchObject({ servedSlotAt: null, changedAt: now });
      // Real time reaches the time. Its run exists: the time is served, no second run, no note, not even after its window.
      expect(await scheduler.tick(at(1))).toEqual(NONE);
      expect(await scheduleRow(stackId)).toMatchObject({ servedSlotAt: slot, skippedSlotAt: null, skipReason: null });
      expect(await scheduler.tick(at(31))).toEqual(NONE);
      expect((await runRows(stackId)).map((r) => [r.status, r.slotAt?.getTime()])).toEqual([["succeeded", slot.getTime()]]);
      expect(taskCalls(stackId)).toHaveLength(1);
      expect((await list(stackId)).body.data.tasks[0].skipped).toBeNull();
    });
  });

  it("never starts again a run whose answer was lost: it asks the executor how it went", async () => {
    const stackId = await running();
    const settle = async (expected: string, operationId: string): Promise<void> => {
      await worker.recoverUnknownOperations();
      expect((await opRow(operationId)).status).toBe(expected);
    };

    // The run finished and only its answer was lost: the executor still knows it.
    sim.appStackTasks.failNextAppStackTaskStep("run", "ambiguous_after");
    sim.appStackTasks.setNextAppStackTaskRun({ lines: ["saved"] });
    const finished = await ran(stackId, "save");
    expect((await opRow(finished.operationId)).status).toBe("unknown");
    expect((await runRows(stackId)).find((r) => r.id === finished.runId)!.status).toBe("running");
    await settle("succeeded", finished.operationId);
    expect((await runRows(stackId)).find((r) => r.id === finished.runId)).toMatchObject({ status: "succeeded", output: "saved" });

    // The run is still going when the answer is lost: the application stays held until the executor tells.
    sim.appStackTasks.failNextAppStackTaskStep("run", "ambiguous_running");
    const going = await ran(stackId, "save");
    await settle("unknown", going.operationId);
    expectRefusal(await run(stackId, "count"), 409, "RESOURCE_LOCKED");
    expectRefusal(await h.call(h.a.token, "POST", `${base(stackId)}/restart`, {}, idem()), 409, "RESOURCE_LOCKED");
    sim.appStackTasks.settleAppStackTaskRun(going.runId);
    await settle("succeeded", going.operationId);

    // The executor never got the run, or it started again since: nobody knows, and the run is not sent again.
    sim.appStackTasks.failNextAppStackTaskStep("run", "ambiguous_before");
    const lost = await ran(stackId, "save");
    expect((await opRow(lost.operationId)).status).toBe("unknown");
    await settle("failed", lost.operationId);
    expect(await opRow(lost.operationId)).toMatchObject({
      errorCode: "OPERATION_AMBIGUOUS",
      errorMessage: "It is not known how the task ended. It was not started again.",
    });
    expect((await runRows(stackId)).find((r) => r.id === lost.runId)).toMatchObject({ status: "unknown", problem: "outcome_lost" });
    await worker.processPendingOnce();
    await worker.recoverUnknownOperations();
    // One call per run, never a second one.
    expect(taskCalls(stackId).map((c) => c.runId)).toEqual([finished.runId, going.runId, lost.runId]);
    expect((await stackRow(stackId)).status).toBe("running");
    // The application is free again.
    expect((await run(stackId, "count")).status).toBe(202);
    await worker.processPendingOnce();
  });

  it("an executor that cannot be reached leaves the run not started, and it can be asked again", async () => {
    const stackId = await running();
    sim.appStackTasks.failNextAppStackTaskStep("run", "engine_unavailable");
    const refused = await ran(stackId, "save");
    expect(await opRow(refused.operationId)).toMatchObject({ status: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE" });
    expect((await runRows(stackId))[0]).toMatchObject({ status: "not_started", problem: "unavailable", startedAt: null });
    const again = await ran(stackId, "save");
    expect((await opRow(again.operationId)).status).toBe("succeeded");
  });

  it("forgets the runs and the schedules of an application that is deleted", async () => {
    const stackId = await running();
    await ran(stackId, "save");
    expect((await setSchedule(stackId, "save", { frequency: "hourly" })).status).toBe(200);
    const name = (await stackRow(stackId)).name;
    const removed = await h.call(h.a.token, "DELETE", base(stackId), { confirmName: name, destroyData: true }, idem());
    expect(removed.status, removed.raw).toBe(202);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "deleted"; round += 1) await worker.processPendingOnce();
    expect((await stackRow(stackId)).status).toBe("deleted");
    expect(await runRows(stackId)).toEqual([]);
    expect(await h.dbClient.db.select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId))).toEqual([]);
    expectRefusal(await list(stackId), 404, "NOT_FOUND");
    expect(await scheduler.tick(new Date(Date.now() + 2 * HOUR))).toMatchObject({ queued: 0 });
  });
});
