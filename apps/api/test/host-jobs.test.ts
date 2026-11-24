import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_JOB_KIND, HOST_JOB_LOCK_KEY, PLATFORM_OPS_ORG_ID, SITE_TYPES } from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  inArray,
  operationSteps,
  outboxEvents,
  operations,
  seedPhase1Dataset,
  sql,
  transitionOperation,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { HostAgentPort, HostJob, HostJobState } from "@hosting-panel/host-agent-contracts";
import {
  enqueueHostJob,
  executeHostJob,
  HOST_JOB_LEASE_MS,
  HOST_JOB_POLL_MS,
  HOST_JOB_START_DEADLINE_MS,
  HOST_JOB_WATCH_MAX_MS,
  hostJobResult,
  recoverHostJob,
  settleHostJob,
  SITE_WORK_BLOCKED_JOBS,
  SITE_WORK_KINDS,
} from "../src/host/host-jobs.js";
import { installedPanelVersion } from "../src/updates/release-version.js";

vi.mock("../src/updates/release-version.js", () => ({ installedPanelVersion: vi.fn(() => null) }));

describe("enqueueHostJob", () => {
  let dbClient: DatabaseClient;
  const actorId = DEMO_IDS.users.infra;

  const input = (job: Parameters<typeof enqueueHostJob>[1]["job"], idempotencyKey = randomUUID()) => ({
    job,
    actorId,
    idempotencyKey,
    audit: {
      action: "admin.os_packages.refresh",
      targetType: "host",
      targetId: null,
      details: { outcome: "succeeded", requestId: "req_sentinel" },
      ipAddress: "192.0.2.10",
      userAgent: "sentinel-agent",
    },
  });

  const requestRows = async (operationId: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.os_packages.refresh"))).filter(
      (r) => (r.details as Record<string, unknown>).operationId === operationId,
    );

  async function refusal(promise: Promise<unknown>): Promise<{ code?: string; details?: Array<{ reason?: string }> }> {
    try {
      await promise;
    } catch (err) {
      return err as { code?: string; details?: Array<{ reason?: string }> };
    }
    throw new Error("expected a refusal");
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db, randomBytes(32));
  });

  beforeEach(async () => {
    // Each case starts with no active host job and no site work.
    await dbClient.db.execute(sql.raw("UPDATE operations SET status = 'succeeded' WHERE status IN ('queued','processing','accepted','reconciling','unknown')"));
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("queues one host.job operation under the host lock and writes its request row", async () => {
    const { operationId } = await enqueueHostJob(dbClient.db, input("os_refresh"));
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    expect(op).toMatchObject({
      kind: HOST_JOB_KIND,
      status: "queued",
      organizationId: PLATFORM_OPS_ORG_ID,
      resourceType: "host",
      resourceId: "os_refresh",
      lockKey: HOST_JOB_LOCK_KEY,
      requestedByUserId: actorId,
    });
    expect(op!.leaseExpiresAt!.getTime() - op!.submittedAt.getTime()).toBe(HOST_JOB_LEASE_MS);
    const rows = await requestRows(operationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId, actorType: "user", organizationId: PLATFORM_OPS_ORG_ID, targetType: "host", ipAddress: "192.0.2.10" });
    expect(rows[0]!.details).toMatchObject({ outcome: "succeeded", operationId });
  });

  it("a second job while one is active is refused with host_job_running", async () => {
    await enqueueHostJob(dbClient.db, input("os_refresh"));
    const before = (await dbClient.db.select().from(operations)).length;
    const err = await refusal(enqueueHostJob(dbClient.db, input("restart_hp_web")));
    expect(err.code).toBe("RESOURCE_LOCKED");
    expect(err.details?.[0]?.reason).toBe("host_job_running");
    expect((await dbClient.db.select().from(operations)).length).toBe(before);
  });

  it("a blocked job waits for site work, a job outside the list does not", async () => {
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.backups.create",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeShop,
      requestedByUserId: actorId,
      steps: [{ key: "run", label: "Run" }],
    });
    for (const job of SITE_WORK_BLOCKED_JOBS) {
      const err = await refusal(enqueueHostJob(dbClient.db, input(job)));
      expect(err.code).toBe("RESOURCE_LOCKED");
      expect(err.details?.[0]?.reason).toBe("site_work_running");
    }
    const hostOps = await dbClient.db
      .select()
      .from(operations)
      .where(inArray(operations.status, ["queued", "processing", "accepted", "reconciling", "unknown"]));
    expect(hostOps.filter((o) => o.kind === HOST_JOB_KIND)).toEqual([]);
    const { operationId } = await enqueueHostJob(dbClient.db, input("restart_hp_web"));
    expect(operationId).toMatch(/^op_/);
  });

  it("an active stack operation blocks the panel update like site work", async () => {
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "stack.deploy",
      resourceType: "stack",
      resourceId: "stk_sentinel",
      requestedByUserId: actorId,
      steps: [{ key: "run", label: "Run" }],
    });
    const err = await refusal(enqueueHostJob(dbClient.db, input("panel_update")));
    expect([err.code, err.details?.[0]?.reason]).toEqual(["RESOURCE_LOCKED", "site_work_running"]);
  });

  it("the same idempotency key gives back the same operation and no second request row", async () => {
    const key = randomUUID();
    const first = await enqueueHostJob(dbClient.db, input("os_refresh", key));
    const again = await enqueueHostJob(dbClient.db, input("os_refresh", key));
    expect(again.operationId).toBe(first.operationId);
    expect(await requestRows(first.operationId)).toHaveLength(1);
  });

  it("R201 1.2: once site work runs, a replayed key answers its operation; a new key is refused and leaves no row", async () => {
    const key = randomUUID();
    const first = await enqueueHostJob(dbClient.db, input("panel_update", key));
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.backups.create",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeShop,
      requestedByUserId: actorId,
      steps: [{ key: "run", label: "Run" }],
    });
    expect((await enqueueHostJob(dbClient.db, input("panel_update", key))).operationId).toBe(first.operationId);
    await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, first.operationId));
    const count = async () =>
      Promise.all([operations, outboxEvents, auditEvents].map(async (t) => (await dbClient.db.select().from(t)).length));
    const before = await count();
    const err = await refusal(enqueueHostJob(dbClient.db, input("panel_update")));
    expect([err.code, err.details?.[0]?.reason]).toEqual(["RESOURCE_LOCKED", "site_work_running"]);
    expect(await count()).toEqual(before);
  });
});

describe("SITE_WORK_KINDS", () => {
  it("R206 A3: holds every heavy operation of every site type and every stack operation", () => {
    for (const kind of Object.values(SITE_TYPES).flatMap((t) => t.heavyOperationKinds)) {
      expect(SITE_WORK_KINDS).toContain(kind);
    }
    expect([...SITE_WORK_KINDS].sort()).toEqual([
      "panel.backups.create", "site.backups.create", "site.backups.download", "site.backups.prune",
      "site.backups.restore", "site.wordpress.import", "site.wordpress.update",
      "stack.backup", "stack.delete", "stack.deploy", "stack.prune", "stack.restart", "stack.restore", "stack.rollback",
      "stack.start", "stack.stop", "stack.upgrade",
    ]);
  });
});

describe("hostJobResult", () => {
  it("maps exit 0, 1, 6 and 7 for a restart and for the panel update, with and without a new version", () => {
    for (const changed of [false, true]) {
      expect([0, 1, 6, 7].map((n) => hostJobResult("restart_hp_web", n, changed))).toEqual(["succeeded", "failed", "failed", "failed"]);
      expect([0, 1, 6, 7].map((n) => hostJobResult("os_upgrade", n, changed))).toEqual(["succeeded", "failed", "failed", "failed"]);
    }
    expect([0, 1, 6, 7].map((n) => hostJobResult("panel_update", n, true))).toEqual(["updated", "failed", "rolled_back", "rollback_unhealthy"]);
    expect([0, 1, 6, 7].map((n) => hostJobResult("panel_update", n, false))).toEqual(["already_current", "failed", "rolled_back", "rollback_unhealthy"]);
  });
});

describe("executeHostJob, recoverHostJob and settleHostJob", () => {
  let dbClient: DatabaseClient;
  const actorId = DEMO_IDS.users.infra;
  type Op = typeof operations.$inferSelect;

  /** A fake agent: requestHostJob answers or throws, readHostJob returns the queued states in turn. */
  function fakeAgent(opts: { request?: () => HostJobState; reads?: Array<HostJobState | Error> } = {}) {
    const calls: string[] = [];
    const reads = [...(opts.reads ?? [])];
    const agent = {
      isRuntimeAvailable: true,
      async requestHostJob(job: HostJob) {
        calls.push("requestHostJob");
        return opts.request ? opts.request() : { job, state: "running", exitStatus: null, startedAt: null, endedAt: null };
      },
      async readHostJob() {
        calls.push("readHostJob");
        const next = reads.length > 1 ? reads.shift()! : reads[0]!;
        if (next instanceof Error) throw next;
        return next;
      },
    } as unknown as HostAgentPort;
    return { agent, calls };
  }
  const coded = (code: string) => Object.assign(new Error("sentinel agent text"), { code });
  const state = (job: HostJob, s: HostJobState["state"], startedAt: string | null, exitStatus: number | null = null): HostJobState =>
    ({ job, state: s, exitStatus, startedAt, endedAt: s === "succeeded" || s === "failed" ? startedAt : null });

  /** A queued job taken into processing, its submission moved back so the start delay is over. */
  async function processing(job: HostJob, action = "admin.host_service.restart", details: Record<string, unknown> = {}): Promise<Op> {
    const { operationId } = await enqueueHostJob(dbClient.db, {
      job,
      actorId,
      idempotencyKey: randomUUID(),
      audit: { action, targetType: "host", targetId: null, details: { outcome: "succeeded", ...details }, ipAddress: null, userAgent: null },
    });
    await dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - 3_000) }).where(eq(operations.id, operationId));
    await transitionOperation(dbClient.db, operationId, "processing");
    return (await dbClient.db.select().from(operations).where(eq(operations.id, operationId)))[0]!;
  }
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const endRows = async (operationId: string) =>
    (await dbClient.db.select().from(auditEvents).where(inArray(auditEvents.action, ["admin.host_service.restart.end", "admin.update.panel.end", "admin.os_packages.upgrade.end"]))).filter(
      (r) => (r.details as Record<string, unknown>).operationId === operationId,
    );
  const sec = (op: Op, deltaMs = 0) => new Date(Math.floor(op.startedAt!.getTime() / 1000) * 1000 + deltaMs).toISOString();

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db, randomBytes(32));
  });

  beforeEach(async () => {
    vi.mocked(installedPanelVersion).mockReturnValue(null);
    await dbClient.db.execute(sql.raw("UPDATE operations SET status = 'succeeded' WHERE status IN ('queued','processing','accepted','reconciling','unknown')"));
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("a run that has ended settles succeeded with one end row from the system", async () => {
    const op = await processing("restart_hp_web");
    const { agent, calls } = fakeAgent({ reads: [state("restart_hp_web", "succeeded", sec(op), 0)] });
    await executeHostJob(dbClient.db, agent, op);
    expect(calls).toEqual(["requestHostJob", "readHostJob"]);
    expect(await opOf(op.id)).toMatchObject({ status: "succeeded", errorCode: null });
    const rows = await endRows(op.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: null, actorType: "system", action: "admin.host_service.restart.end" });
    expect(rows[0]!.details).toEqual({ operationId: op.id, outcome: "succeeded", result: "succeeded", exitStatus: 0 });
  });

  it("exit 1 fails with HOST_JOB_FAILED and a fixed sentence, never the agent's text", async () => {
    const op = await processing("restart_hp_web");
    const { agent } = fakeAgent({ reads: [state("restart_hp_web", "failed", sec(op), 1)] });
    await executeHostJob(dbClient.db, agent, op);
    const after = await opOf(op.id);
    expect(after).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED" });
    expect(after.errorMessage).not.toContain("sentinel");
    expect((await endRows(op.id))[0]!.details).toEqual({ operationId: op.id, outcome: "failed", result: "failed", exitStatus: 1 });
  });

  it("R198 2.5: a job started in the same whole second as its operation belongs to it", async () => {
    const op = await processing("restart_hp_web");
    const at900 = new Date(Math.floor(op.startedAt!.getTime() / 1000) * 1000 + 900);
    await dbClient.db.update(operations).set({ startedAt: at900 }).where(eq(operations.id, op.id));
    const moved = await opOf(op.id);
    const { agent } = fakeAgent({ reads: [state("restart_hp_web", "succeeded", sec(moved), 0)] });
    await executeHostJob(dbClient.db, agent, moved);
    expect((await opOf(op.id)).status).toBe("succeeded");
  });

  it("a request older than the age limit ends OPERATION_INTERRUPTED, not_started, and asks for nothing", async () => {
    const op = await processing("restart_hp_web");
    const { agent, calls } = fakeAgent();
    await executeHostJob(dbClient.db, agent, op, () => op.submittedAt.getTime() + 61_000);
    expect(calls).toEqual([]);
    expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect((await endRows(op.id))[0]!.details).toMatchObject({ outcome: "failed", result: "not_started", exitStatus: null });
  });

  it("RESOURCE_LOCKED and HOST_AGENT_UNAVAILABLE from the request end not_started without polling", async () => {
    for (const code of ["RESOURCE_LOCKED", "HOST_AGENT_UNAVAILABLE"]) {
      const op = await processing("restart_hp_web");
      const { agent, calls } = fakeAgent({ request: () => { throw coded(code); } });
      await executeHostJob(dbClient.db, agent, op);
      expect(calls).toEqual(["requestHostJob"]);
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: code });
      expect((await endRows(op.id))[0]!.details).toMatchObject({ result: "not_started" });
    }
  });

  it("OPERATION_AMBIGUOUS polls; an older run, a running job of no start and never_run past the deadline end not_started", async () => {
    for (const read of [
      (op: Op) => state("restart_hp_web", "succeeded", sec(op, -5_000), 0),
      () => state("restart_hp_web", "running", null),
      () => state("restart_hp_web", "never_run", null),
    ]) {
      const op = await processing("restart_hp_web");
      let shift = 0; // the clock jumps past the deadline once the request is sent
      const request = () => { shift = HOST_JOB_START_DEADLINE_MS + 1_000; throw coded("OPERATION_AMBIGUOUS"); };
      const { agent, calls } = fakeAgent({ request, reads: [read(op)] });
      await executeHostJob(dbClient.db, agent, op, () => Date.now() + shift);
      expect(calls).toEqual(["requestHostJob", "readHostJob"]);
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect((await endRows(op.id))[0]!.details).toMatchObject({ result: "not_started" });
    }
  });

  it("an agent that cannot be reached during the polling is not an end: the polling goes on", async () => {
    const op = await processing("restart_hp_web");
    const { agent, calls } = fakeAgent({ reads: [coded("HOST_AGENT_UNAVAILABLE"), state("restart_hp_web", "succeeded", sec(op), 0)] });
    await executeHostJob(dbClient.db, agent, op);
    expect(calls).toEqual(["requestHostJob", "readHostJob", "readHostJob"]);
    expect((await opOf(op.id)).status).toBe("succeeded");
  });

  it("R202 2.1: a request refused with NOT_SUPPORTED ends not_started with that code and reads nothing", async () => {
    const op = await processing("restart_hp_web");
    const { agent, calls } = fakeAgent({ request: () => { throw coded("NOT_SUPPORTED"); } });
    await executeHostJob(dbClient.db, agent, op);
    expect(calls).toEqual(["requestHostJob"]);
    expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "NOT_SUPPORTED" });
    expect((await endRows(op.id))[0]!.details).toMatchObject({ result: "not_started" });
  });

  it("R202 2.1: a NOT_SUPPORTED read keeps polling inside the start deadline and ends not_started past it", async () => {
    const op = await processing("restart_hp_web");
    let shift = 0;
    const request = () => { throw coded("OPERATION_AMBIGUOUS"); };
    const { agent, calls } = fakeAgent({ request, reads: [coded("NOT_SUPPORTED")] });
    const now = () => Date.now() + shift;
    const follow = executeHostJob(dbClient.db, agent, op, now);
    await vi.waitFor(() => expect(calls).toEqual(["requestHostJob", "readHostJob"]));
    expect((await opOf(op.id)).status).toBe("processing");
    shift = HOST_JOB_START_DEADLINE_MS + 1_000;
    await follow;
    expect(calls).toEqual(["requestHostJob", "readHostJob", "readHostJob"]);
    expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "NOT_SUPPORTED" });
    expect((await endRows(op.id))[0]!.details).toMatchObject({ result: "not_started" });
  });

  it("R202 2.1: an agent out of reach past the start deadline is still not an end", async () => {
    const op = await processing("panel_update", "admin.update.panel");
    let shift = 0;
    const request = () => { shift = HOST_JOB_START_DEADLINE_MS + 1_000; throw coded("OPERATION_AMBIGUOUS"); };
    const { agent, calls } = fakeAgent({ request, reads: [coded("HOST_AGENT_UNAVAILABLE"), state("panel_update", "succeeded", sec(op), 0)] });
    await executeHostJob(dbClient.db, agent, op, () => Date.now() + shift);
    expect(calls).toEqual(["requestHostJob", "readHostJob", "readHostJob"]);
    expect((await opOf(op.id)).status).toBe("succeeded");
  });

  it("R202 2.1: recovery settles a NOT_SUPPORTED read only past the start deadline, never an agent out of reach", async () => {
    const fresh = await processing("restart_hp_web");
    await transitionOperation(dbClient.db, fresh.id, "unknown");
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [coded("NOT_SUPPORTED")] }).agent, await opOf(fresh.id))).toBe("pending");
    const past = new Date(Date.now() - HOST_JOB_START_DEADLINE_MS - 60_000);
    await dbClient.db.update(operations).set({ startedAt: past, submittedAt: past }).where(eq(operations.id, fresh.id));
    const old = await opOf(fresh.id);
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [coded("HOST_AGENT_UNAVAILABLE")] }).agent, old)).toBe("pending");
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [coded("NOT_SUPPORTED")] }).agent, old)).toBe("settled");
    expect(await opOf(old.id)).toMatchObject({ status: "failed", errorCode: "NOT_SUPPORTED" });
    expect((await endRows(old.id))[0]!.details).toMatchObject({ result: "not_started" });
  });

  it("past the watch limit the worker returns and leaves the operation to recovery", async () => {
    const op = await processing("os_upgrade", "admin.os_packages.upgrade");
    let shift = 0;
    const request = () => { shift = HOST_JOB_WATCH_MAX_MS + 1_000; return state("os_upgrade", "running", sec(op)); };
    const { agent } = fakeAgent({ request, reads: [state("os_upgrade", "running", sec(op))] });
    await executeHostJob(dbClient.db, agent, op, () => Date.now() + shift);
    expect((await opOf(op.id)).status).toBe("processing");
    expect(await endRows(op.id)).toEqual([]);
  });

  /** The operation row and its steps: what a stopped follow must leave untouched. */
  const snapshot = async (id: string) => ({
    op: await opOf(id),
    steps: await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id)),
  });

  it("R201 1.1: a stop during the start delay ends the wait at once, sends no request and writes nothing", async () => {
    const op = await processing("restart_hp_web");
    await dbClient.db.update(operations).set({ submittedAt: new Date() }).where(eq(operations.id, op.id));
    const fresh = await opOf(op.id);
    const { agent, calls } = fakeAgent();
    const stop = new AbortController();
    const started = Date.now();
    const follow = executeHostJob(dbClient.db, agent, fresh, Date.now, stop.signal);
    await new Promise((r) => setTimeout(r, 200));
    stop.abort();
    const before = await snapshot(op.id);
    await follow;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(calls).toEqual([]);
    expect(await snapshot(op.id)).toEqual(before);
    expect(before.op.status).toBe("processing");
  });

  it("R201 1.1: a stop during a read ends the follow after that read: no settle, no renewal", async () => {
    const op = await processing("restart_hp_web");
    const stop = new AbortController();
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    let reads = 0;
    const agent = {
      async requestHostJob(job: HostJob) { return state(job, "running", sec(op)); },
      async readHostJob(job: HostJob) {
        reads += 1;
        stop.abort();
        before = await snapshot(op.id);
        return state(job, "succeeded", sec(op), 0); // an end read after the stop is still not written
      },
    } as unknown as HostAgentPort;
    await executeHostJob(dbClient.db, agent, op, Date.now, stop.signal);
    expect(reads).toBe(1);
    expect(await snapshot(op.id)).toEqual(before);
    expect(await endRows(op.id)).toEqual([]);
  });

  it("R201 1.1: a stop between two reads ends the wait at once, with no renewal after it", async () => {
    const op = await processing("os_upgrade", "admin.os_packages.upgrade");
    const { agent, calls } = fakeAgent({ reads: [state("os_upgrade", "running", sec(op))] });
    const stop = new AbortController();
    const follow = executeHostJob(dbClient.db, agent, op, Date.now, stop.signal);
    await vi.waitFor(() => expect(calls).toEqual(["requestHostJob", "readHostJob"]));
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    stop.abort();
    const before = await snapshot(op.id);
    await follow;
    expect(Date.now() - started).toBeLessThan(HOST_JOB_POLL_MS / 2);
    expect(calls).toEqual(["requestHostJob", "readHostJob"]);
    expect(await snapshot(op.id)).toEqual(before);
    expect(await endRows(op.id)).toEqual([]);
  });

  it("R201 1.1: a signal that is never raised changes nothing", async () => {
    const op = await processing("restart_hp_web");
    const { agent, calls } = fakeAgent({ reads: [state("restart_hp_web", "running", sec(op)), state("restart_hp_web", "succeeded", sec(op), 0)] });
    await executeHostJob(dbClient.db, agent, op, Date.now, new AbortController().signal);
    expect(calls).toEqual(["requestHostJob", "readHostJob", "readHostJob"]);
    expect((await opOf(op.id)).status).toBe("succeeded");
    expect(await endRows(op.id)).toHaveLength(1);
  });

  it("recovery is pending while the job runs or the agent is away, and settles once its run has ended", async () => {
    const op = await processing("restart_hp_web");
    await transitionOperation(dbClient.db, op.id, "unknown");
    const unknown = await opOf(op.id);
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [state("restart_hp_web", "running", sec(op))] }).agent, unknown)).toBe("pending");
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [coded("HOST_AGENT_UNAVAILABLE")] }).agent, unknown)).toBe("pending");
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [state("restart_hp_web", "never_run", null)] }).agent, unknown)).toBe("pending");
    expect(await recoverHostJob(dbClient.db, fakeAgent({ reads: [state("restart_hp_web", "succeeded", sec(op), 0)] }).agent, unknown)).toBe("settled");
    expect((await opOf(op.id)).status).toBe("succeeded");
    expect(await endRows(op.id)).toHaveLength(1);
  });

  it("settleHostJob twice writes one end row: whichever path comes second writes nothing", async () => {
    const op = await processing("restart_hp_web");
    const both = await Promise.all([settleHostJob(dbClient.db, op, { exitStatus: 0 }), settleHostJob(dbClient.db, op, { exitStatus: 0 })]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await endRows(op.id)).toHaveLength(1);
  });

  it("the panel update's end carries fromVersion from its request row and toVersion from this process", async () => {
    const cases: Array<[string | null, string | null, number, string]> = [
      ["1.2.0", "1.3.0", 0, "updated"],
      ["1.2.0", "1.2.0", 0, "already_current"],
      [null, null, 0, "already_current"],
      ["1.2.0", "1.2.0", 6, "rolled_back"],
      ["1.2.0", "1.2.0", 7, "rollback_unhealthy"],
    ];
    for (const [fromVersion, toVersion, exitStatus, result] of cases) {
      const op = await processing("panel_update", "admin.update.panel", { fromVersion });
      vi.mocked(installedPanelVersion).mockReturnValue(toVersion);
      await settleHostJob(dbClient.db, op, { exitStatus });
      expect((await endRows(op.id))[0]!.details).toEqual({
        operationId: op.id, outcome: exitStatus === 0 ? "succeeded" : "failed", result, exitStatus, fromVersion, toVersion,
      });
    }
  });
});
