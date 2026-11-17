import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { auditEvents, createDatabaseClient, eq, operations, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { enqueueHostJob, settleHostJob } from "../src/host/host-jobs.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 14);
const PW = "sentinel-password-0014";
const SETUP = { installationName: "Restart QA", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };
const FIXED_FAILED = "The job ended with an error. Read its log on the Logs page, then try again.";
const FIXED_NOT_STARTED = "The job did not start. Check Health, then try again.";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** An agent port that can freeze, as a process that is being killed would, and be woken again. */
function freezable(agent: InMemoryHostSimulatorAdapter) {
  const calls: string[] = [];
  let frozen: Promise<void> | null = null;
  let wake: () => void = () => undefined;
  const port = new Proxy(agent, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        calls.push(String(p));
        if (frozen) await frozen;
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  }) as HostAgentPort;
  return {
    port,
    calls,
    freeze: () => void (frozen = new Promise<void>((resolve) => (wake = resolve))),
    thaw: () => {
      frozen = null;
      wake();
    },
  };
}

describe("a host job's end is recorded once, also across an API restart", () => {
  let dbClient: DatabaseClient;
  let agent: InMemoryHostSimulatorAdapter;
  const apps: ControlPlaneAppHandle[] = [];
  let adminId: string;
  let totp: string;

  async function openDb(): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    adminId = admin.userId;
    totp = admin.totpSecretBase32;
    agent = new InMemoryHostSimulatorAdapter();
  }

  async function startApp(hostAgent: HostAgentPort, recoverUnknownOnStart: boolean): Promise<ControlPlaneAppHandle> {
    const app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter() as DockerExecutorPort,
      hostAgent,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart,
    });
    apps.push(app);
    return app;
  }

  async function restartApi(app: ControlPlaneAppHandle): Promise<string> {
    const login = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: PW, totpCode: totpCodeAt(totp, Math.floor(Date.now() / 30_000)) }),
    });
    const token = ((await login.json()) as Json).data.accessToken as string;
    const res = await fetch(`${app.baseUrl!}/v1/admin/host-services/api/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ reason: "Sentinel reason for the restart" }),
    });
    expect(res.status).toBe(202);
    return ((await res.json()) as Json).data.operationId as string;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0)) await app.close();
    await dbClient.close();
  });

  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const endRows = async (operationId: string) =>
    (await dbClient.db.select().from(auditEvents)).filter((r) => r.action.endsWith(".end") && (r.details as Json).operationId === operationId);
  const recoveredRows = async (operationId: string) =>
    (await dbClient.db.select().from(auditEvents)).filter((r) => r.action.startsWith("operation.recovered.") && r.targetId === operationId);
  const age = (id: string, ms: number) => dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - ms) }).where(eq(operations.id, id));
  /** Moves the lease into the past, as the 30 s after a killed process would. */
  const leaseLapses = (id: string) => dbClient.db.update(operations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(operations.id, id));

  /** Queues one job directly and leaves it as a stopped worker would: processing, started at the given time. */
  async function orphan(job: "os_refresh" | "os_upgrade", startedAt: Date): Promise<string> {
    const { operationId } = await enqueueHostJob(dbClient.db, {
      job, actorId: adminId, idempotencyKey: randomUUID(),
      audit: { action: `admin.os_packages.${job === "os_refresh" ? "refresh" : "upgrade"}`, targetType: "host", targetId: job, details: { outcome: "succeeded" }, ipAddress: null, userAgent: null },
    });
    await dbClient.db.update(operations).set({ status: "processing", submittedAt: startedAt, startedAt, leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(operations.id, operationId));
    return operationId;
  }

  it("the first app stops while the job runs; the job ends; the second app settles it in its recovery pass, once, and the first app's late look writes nothing", async () => {
    await openDb();
    const first = freezable(agent);
    const app1 = await startApp(first.port, false);
    agent.holdHostJob("restart_hp_api");
    const opId = await restartApi(app1);
    await age(opId, 3_000);
    const worker1 = app1.outboxWorker.processPendingOnce();
    await vi.waitFor(() => expect(first.calls).toContain("requestHostJob"), { timeout: 5_000 });
    // The first process freezes in its watch, as one being killed does, and its lease lapses.
    first.freeze();
    const closing1 = app1.close();
    await leaseLapses(opId);

    // The second process starts while the job still runs: its recovery pass leaves it pending.
    const second = freezable(agent);
    const app2 = await startApp(second.port, true);
    expect(await opOf(opId)).toMatchObject({ status: "unknown" });
    expect(await endRows(opId)).toEqual([]);

    agent.releaseHostJob("restart_hp_api");
    await vi.waitFor(async () => expect((await agent.readHostJob("restart_hp_api")).state).toBe("succeeded"), { timeout: 5_000 });
    await app2.outboxWorker.recoverUnknownOperations();
    await app2.outboxWorker.recoverUnknownOperations();
    expect(await opOf(opId)).toMatchObject({ status: "succeeded", errorCode: null });
    const ends = await endRows(opId);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ action: "admin.host_service.restart.end", actorType: "system", actorId: null, targetId: "restart_hp_api" });
    expect(ends[0]!.details).toEqual({ operationId: opId, outcome: "succeeded", result: "succeeded", exitStatus: 0 });
    expect((await recoveredRows(opId)).map((r) => r.action)).toEqual(["operation.recovered.succeeded"]);

    // The first process wakes, reads the end and tries to settle: nothing more is written.
    first.thaw();
    await worker1;
    await closing1;
    expect(await endRows(opId)).toHaveLength(1);
    expect(await opOf(opId)).toMatchObject({ status: "succeeded" });
  }, 30_000);

  it("a job that failed while nobody watched settles failed with the fixed sentence, once over two recovery passes", async () => {
    await openDb();
    const opId = await orphan("os_upgrade", new Date(Date.now() - 5_000));
    agent.setHostJobExitStatus("os_upgrade", 2);
    await agent.requestHostJob("os_upgrade");
    await vi.waitFor(async () => expect((await agent.readHostJob("os_upgrade")).state).toBe("failed"), { timeout: 5_000 });
    const app = await startApp(agent, true);
    await app.outboxWorker.recoverUnknownOperations();
    expect(await opOf(opId)).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED", errorMessage: FIXED_FAILED });
    const ends = await endRows(opId);
    expect(ends.map((r) => [r.action, (r.details as Json).result, (r.details as Json).exitStatus])).toEqual([["admin.os_packages.upgrade.end", "failed", 2]]);
    expect((await recoveredRows(opId)).map((r) => [r.action, (r.details as Json).reason])).toEqual([["operation.recovered.failed", FIXED_FAILED]]);
  }, 30_000);

  it("a job that never started: a run that ended before the request is not taken; pending inside the start deadline, not_started past it", async () => {
    await openDb();
    // A job the agent never ran, asked 3 minutes ago: settled by the start pass.
    const stale = await orphan("os_upgrade", new Date(Date.now() - 180_000));
    const app = await startApp(agent, true);
    expect(await opOf(stale)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED", errorMessage: FIXED_NOT_STARTED });
    expect((await endRows(stale)).map((r) => (r.details as Json).result)).toEqual(["not_started"]);
    // An older run of the same job, ended before the next request began, is not taken.
    await agent.requestHostJob("os_refresh");
    await vi.waitFor(async () => expect((await agent.readHostJob("os_refresh")).state).toBe("succeeded"), { timeout: 5_000 });
    await sleep(1_100);
    const fresh = await orphan("os_refresh", new Date());
    await app.outboxWorker.recoverUnknownOperations();
    expect(await opOf(fresh)).toMatchObject({ status: "unknown" });
    expect(await endRows(fresh)).toEqual([]);
  }, 30_000);

  it("an agent away during recovery leaves the job pending; it settles once the agent answers", async () => {
    await openDb();
    const opId = await orphan("os_refresh", new Date(Date.now() - 5_000));
    await agent.requestHostJob("os_refresh");
    await vi.waitFor(async () => expect((await agent.readHostJob("os_refresh")).state).toBe("succeeded"), { timeout: 5_000 });
    agent.setUnavailable(true);
    const app = await startApp(agent, true);
    expect(await opOf(opId)).toMatchObject({ status: "unknown" });
    agent.setUnavailable(false);
    await app.outboxWorker.recoverUnknownOperations();
    expect(await opOf(opId)).toMatchObject({ status: "succeeded" });
    expect(await endRows(opId)).toHaveLength(1);
  }, 30_000);

  it("two concurrent settleHostJob calls write one end row; the operation keeps the winner's result", async () => {
    await openDb();
    for (const ends of [[{ exitStatus: 0 }, { exitStatus: 0 }], [{ exitStatus: 0 }, { exitStatus: 1 }], [{ exitStatus: 1 }, { notStarted: "OPERATION_INTERRUPTED" as const }]]) {
      const opId = await orphan("os_refresh", new Date());
      const op = await opOf(opId);
      const results = await Promise.all(ends.map((end) => settleHostJob(dbClient.db, op, end)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const rows = await endRows(opId);
      expect(rows).toHaveLength(1);
      const settled = await opOf(opId);
      expect(settled.status).toBe((rows[0]!.details as Json).outcome);
    }
  }, 30_000);

  it("(defect probe) the API closes promptly while it watches a host job, so a restart from the panel does not wait for the stop time-out", async () => {
    await openDb();
    const app = await startApp(agent, false);
    agent.holdHostJob("restart_hp_api");
    const opId = await restartApi(app);
    await age(opId, 3_000);
    const worker = app.outboxWorker.processPendingOnce();
    await vi.waitFor(async () => expect((await agent.readHostJob("restart_hp_api")).state).toBe("running"), { timeout: 5_000 });
    let closed = false;
    const closing = app.close().then(() => void (closed = true));
    await Promise.race([closing, sleep(5_000)]);
    const closedInTime = closed;
    agent.releaseHostJob("restart_hp_api");
    await worker;
    await closing;
    expect(closedInTime).toBe(true);
  }, 30_000);
});
