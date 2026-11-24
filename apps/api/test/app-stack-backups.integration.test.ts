import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  APP_STACK_BACKUP_ACTIONS_PER_HOUR,
  APP_STACK_STATUSES,
  AppStackBackupsDtoSchema,
  MANUAL_BACKUPS_KEPT,
  PLATFORM_OPS_ORG_ID,
  isTerminalOperationStatus,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import {
  and,
  appStackBackupCopies,
  appStackBackups,
  appStackComponents,
  appStacks,
  auditEvents,
  backupTargets,
  eq,
  getPolicy,
  hostingAdminScopes,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  resourceQuotas,
  rolePermissions,
  roles,
  setPolicyTargets,
  users,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enqueueAppStackPrune } from "../src/app-stacks/app-stack-backup-retention.js";
import { BackupSchedulerService, ensurePlatformOpsOrg } from "../src/backups/backup-scheduler.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

// ADR-0038 through HTTP, on the backend where backups exist: the three routes, the real worker and the executor
// simulator. What each step of the worker does is in app-stack-backup-runtime.unit.test.ts.

/** The next `failures` renewals of an operation's lease throw, as a lost database connection would. */
const lease = vi.hoisted(() => ({ failures: 0 }));
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    renewOperationLease: async (...args: Parameters<typeof actual.renewOperationLease>) => {
      if (lease.failures > 0) {
        lease.failures -= 1;
        throw new Error("connection terminated");
      }
      return actual.renewOperationLease(...args);
    },
  };
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** One data volume, no secret, images on the code allowlist. */
const STORAGE_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;
/** No volume: nothing to save. */
const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;
const LOCAL = `bkt_${"7".repeat(32)}`;
const TARGET_NAME = "Deposito-Riservato";
const DAY = 86_400_000;

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application backups HTTP API (ADR-0038)", () => {
  let h: AppStackHarness;
  let storage: string;
  let web: string;
  let policyId: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ runtimeBackend: "linux-systemd", allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    storage = (await h.publish(STORAGE_SOURCE)).versionId;
    web = (await h.publish(WEB_SOURCE)).versionId;
    await h.dbClient.db.insert(backupTargets).values({ id: LOCAL, kind: "local", name: TARGET_NAME });
    policyId = (await getPolicy(h.dbClient.db, "default_site")).id;
    await setPolicyTargets(h.dbClient.db, policyId, [LOCAL]);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const db = () => h.dbClient.db;
  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const act = (token: string, stackId: string, verb: string, body: unknown = {}, key?: string) =>
    h.call(token, "POST", `${base(h.a)}/${stackId}/${verb}`, body, idem(key));
  const backup = (stackId: string, token = h.a.token, key?: string) => act(token, stackId, "backups", {}, key);
  const restore = (stackId: string, backupId: string, confirmName: string, token = h.a.token, key?: string) =>
    act(token, stackId, `backups/${backupId}/restore`, { confirmName }, key);
  const list = async (stackId: string, token = h.a.token) => h.call(token, "GET", `${base(h.a)}/${stackId}/backups`);
  const stackRow = async (stackId: string) => (await db().select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => db().select().from(operations).where(eq(operations.resourceId, stackId));
  const rowsOf = (stackId: string) => db().select().from(appStackBackups).where(eq(appStackBackups.stackId, stackId));
  const audits = (action: string, stackId: string) =>
    db().select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, stackId)));

  /** Runs the worker until nothing of this application is open: a backup queues the start that follows it. */
  async function settle(stackId: string): Promise<string> {
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 12; round += 1) {
      await worker.processPendingOnce();
      if ((await opsOf(stackId)).every((op) => isTerminalOperationStatus(op.status))) break;
    }
    expect((await opsOf(stackId)).filter((op) => !isTerminalOperationStatus(op.status))).toEqual([]);
    return (await stackRow(stackId)).status;
  }

  async function running(name = `app-${randomUUID().slice(0, 8)}`, versionId = storage): Promise<string> {
    const res = await h.call(h.a.token, "POST", base(h.a), { templateVersionId: versionId, name, deploy: true }, idem());
    expect(res.status, res.raw).toBe(202);
    const stackId = res.body.data.stackId as string;
    expect(await settle(stackId)).toBe("running");
    return stackId;
  }

  async function stopped(name?: string): Promise<string> {
    const stackId = await running(name);
    expect((await act(h.a.token, stackId, "stop")).status).toBe(202);
    expect(await settle(stackId)).toBe("stopped");
    return stackId;
  }

  /** A finished backup of the application; returns its id. */
  async function saved(stackId: string, token = h.a.token): Promise<string> {
    const before = await stackRow(stackId);
    const res = await backup(stackId, token);
    expect(res.status, res.raw).toBe(202);
    expect(await settle(stackId)).toBe(before.status);
    const listed = await list(stackId);
    expect(listed.body.data.backups[0].status).toBe("succeeded");
    return listed.body.data.backups[0].id as string;
  }

  it("says why a backup cannot be made: no data, then no destination; both refuse the request and write nothing", async () => {
    const noData = await running("senza-dati", web);
    const withData = await stopped("con-dati");
    await setPolicyTargets(db(), policyId, []);
    try {
      expect((await list(noData)).body.data).toEqual({ backups: [], unavailableReason: "no_data", goBackTo: null });
      expect((await list(withData)).body.data).toEqual({ backups: [], unavailableReason: "no_destination", goBackTo: null });
      const before = await h.counts();
      expectRefusal(await backup(noData), 400, "VALIDATION_ERROR", { field: "backup", reason: "no_data" });
      expectRefusal(await backup(withData), 400, "VALIDATION_ERROR", { field: "backup", reason: "no_destination" });
      expect(await h.counts()).toEqual(before);
      expect((await stackRow(noData)).status).toBe("running");
      expect((await stackRow(withData)).status).toBe("stopped");
    } finally {
      await setPolicyTargets(db(), policyId, [LOCAL]);
    }
    expect((await list(withData)).body.data).toEqual({ backups: [], unavailableReason: null, goBackTo: null });
    // Without data the destination does not matter.
    expect((await list(noData)).body.data.unavailableReason).toBe("no_data");
  });

  it("a running application is stopped, saved and started again; the list follows it and names no destination", async () => {
    const stackId = await running("diario");
    const usage = async () =>
      ((await h.call(h.adminToken, "GET", "/v1/admin/backup-targets")).body.data.targets as Json[]).find((t) => t.id === LOCAL)!.usage as Json;
    const copiesBefore = (await usage()).copies as number;

    const res = await backup(stackId);
    expect(res.status, res.raw).toBe(202);
    const operationId = res.body.data.operationId as string;
    expect(res.body).toEqual({
      data: { stackId, operationId, deploymentId: null, status: "stopping" },
      links: { stack: `${base(h.a)}/${stackId}`, operation: `/v1/organizations/${h.a.orgId}/operations/${operationId}` },
    });
    expect((await stackRow(stackId)).status).toBe("stopping");

    const queued = await list(stackId);
    expect(queued.status, queued.raw).toBe(200);
    AppStackBackupsDtoSchema.parse(queued.body.data);
    expect(queued.body.data.unavailableReason).toBeNull();
    expect(queued.body.data.backups).toHaveLength(1);
    const backupId = queued.body.data.backups[0].id as string;
    expect(queued.body.data.backups[0]).toMatchObject({
      kind: "manual",
      status: "running",
      problem: null,
      volumeKeys: ["data"],
      copies: [{ priority: 1, status: "running", problem: null }],
      finishedAt: null,
      restore: null,
      restorable: false,
      incompleteData: false,
    });
    expect(queued.body.data.goBackTo).toBeNull();

    expect(await settle(stackId)).toBe("running");
    const done = await list(stackId);
    AppStackBackupsDtoSchema.parse(done.body.data);
    expect(done.body.data.backups).toHaveLength(1);
    expect(done.body.data.backups[0]).toMatchObject({
      id: backupId,
      status: "succeeded",
      problem: null,
      copies: [{ priority: 1, status: "succeeded", problem: null }],
      restore: null,
      restorable: true,
    });
    expect(done.body.data.backups[0].finishedAt).not.toBeNull();
    expect(h.sim.backupState.appStackJobs().filter((job) => job.stackId === stackId)).toHaveLength(1);
    expect((await usage()).copies).toBe(copiesBefore + 1);

    const [audit] = await audits("app.stack.backup.create", stackId);
    // The panel's own ids and nothing else (outcome and requestId are on every audit row).
    expect(audit!.details).toMatchObject({ operationId, backupId, status: "stopping" });
    expect(Object.keys(audit!.details as Json).sort()).toEqual(["backupId", "operationId", "outcome", "requestId", "status"]);
    expect(audit!.actorId).toBe(h.a.userId);

    // Nothing the customer or the journal reads names where the copy went or how to reach it.
    const snapshots = h.sim.backupState.appStackSnapshots(stackId);
    expect(snapshots.length).toBeGreaterThan(0);
    const ops = await opsOf(stackId);
    const steps = (await db().select().from(operationSteps)).filter((s) => ops.some((op) => op.id === s.operationId));
    const outbox = (await db().select().from(outboxEvents)).filter((row) => JSON.stringify(row).includes(stackId));
    const journal = (await db().select().from(auditEvents)).filter((row) => row.targetId === stackId);
    expect(steps.length).toBeGreaterThan(0);
    expect(outbox.length).toBeGreaterThan(0);
    const readable = JSON.stringify([queued.body, done.body, res.body, ops, steps, outbox, journal]);
    for (const hidden of [LOCAL, TARGET_NAME, ...snapshots, "restic", "hp_appvol", "/var/", "snapshot"]) {
      expect(readable.includes(hidden), hidden).toBe(false);
    }
  });

  it("a stopped application is saved and stays stopped", async () => {
    const stackId = await stopped("fermo");
    const res = await backup(stackId);
    expect(res.status, res.raw).toBe(202);
    expect(res.body.data.status).toBe("stopped");
    expect(await settle(stackId)).toBe("stopped");
    expect((await list(stackId)).body.data.backups[0]).toMatchObject({ status: "succeeded", restorable: true });
    // The backup alone: nothing was queued to start an application that was not running.
    expect((await opsOf(stackId)).filter((op) => op.kind === "stack.backup" || op.idempotencyKey?.startsWith("resume:"))).toHaveLength(1);
  });

  it("a backup that fails is listed as failed, cannot be restored, and the application runs again", async () => {
    const stackId = await running("sfortunato");
    h.sim.backupState.failNext("other");
    expect((await backup(stackId)).status).toBe(202);
    expect(await settle(stackId)).toBe("running");
    const [failed] = (await list(stackId)).body.data.backups as Json[];
    expect(failed).toMatchObject({ status: "failed", restorable: false, copies: [{ priority: 1, status: "failed" }] });
    expect(failed!.problem).not.toBeNull();

    const before = await h.counts();
    expectRefusal(await restore(stackId, failed!.id as string, "sfortunato"), 400, "VALIDATION_ERROR", {
      field: "backupId",
      reason: "not_restorable",
    });
    expect(await h.counts()).toEqual(before);
    expect((await stackRow(stackId)).status).toBe("running");
  });

  it("restore: the name is typed again, the data as they are get a safety backup, the chosen one is written back", async () => {
    const stackId = await running("ricette");
    const other = await stopped("altra");
    const backupId = await saved(stackId);
    const otherBackupId = await saved(other);
    const before = await h.counts();

    expectRefusal(await restore(stackId, backupId, "Ricette"), 400, "VALIDATION_ERROR", {
      field: "confirmName",
      reason: "confirmation_mismatch",
    });
    expectRefusal(await act(h.a.token, stackId, `backups/${backupId}/restore`, {}), 400, "VALIDATION_ERROR");
    expectRefusal(await act(h.a.token, stackId, `backups/${backupId}/restore`, { confirmName: "ricette", into: "x" }), 400, "VALIDATION_ERROR");
    // A backup that does not exist, and one of another application of the same customer.
    expectRefusal(await restore(stackId, `sbak_${"0".repeat(24)}`, "ricette"), 404, "NOT_FOUND");
    expectRefusal(await restore(stackId, otherBackupId, "ricette"), 404, "NOT_FOUND");
    // Another customer never learns the application exists.
    expectRefusal(await h.call(h.b.token, "POST", `${base(h.b)}/${stackId}/backups/${backupId}/restore`, { confirmName: "ricette" }, idem()), 404, "NOT_FOUND");
    expect(await h.counts()).toEqual(before);
    expect((await stackRow(stackId)).status).toBe("running");

    const res = await restore(stackId, backupId, "ricette");
    expect(res.status, res.raw).toBe(202);
    expect(res.body.data).toMatchObject({ stackId, deploymentId: null, status: "stopping" });
    const queued = (await list(stackId)).body.data.backups as Json[];
    expect(queued.map((b) => [b.kind, b.status])).toEqual([
      ["pre_restore", "running"],
      ["manual", "succeeded"],
    ]);
    expect(queued[1]!.restore).toEqual({ status: "running", problem: null, at: null });

    expect(await settle(stackId)).toBe("running");
    const done = (await list(stackId)).body.data.backups as Json[];
    AppStackBackupsDtoSchema.parse({ backups: done, unavailableReason: null, goBackTo: null });
    expect(done.map((b) => [b.kind, b.status, b.restorable])).toEqual([
      ["pre_restore", "succeeded", true],
      ["manual", "succeeded", true],
    ]);
    expect(done[1]!.restore).toMatchObject({ status: "succeeded", problem: null });
    expect(done[1]!.restore.at).not.toBeNull();
    expect(done[0]!.restore).toBeNull();
    // Copy, safety copy, then the write-back: three jobs, the last one a restore.
    const jobs = h.sim.backupState.appStackJobs().filter((job) => job.stackId === stackId);
    expect(jobs.map((job) => job.action)).toEqual(["stackStart", "stackStart", "stackRestore"]);

    const [audit] = await audits("app.stack.backup.restore", stackId);
    expect(audit!.details).toMatchObject({
      operationId: res.body.data.operationId,
      backupId: done[0]!.id,
      sourceBackupId: backupId,
      status: "stopping",
    });
    expect(Object.keys(audit!.details as Json).sort()).toEqual(["backupId", "operationId", "outcome", "requestId", "sourceBackupId", "status"]);
  });

  it("a restore whose lease renewal fails while its job writes holds the application until the job's end is read: no start in the panel or in the executor", async () => {
    const starts = vi.spyOn(h.sim.appStacks, "startAppStackComponent");
    const stackId = await running("in-sospeso");
    const startReq = starts.mock.calls.map(([req]) => req).find((req) => req.plan.stackId === stackId)!;
    starts.mockRestore();
    const backupId = await saved(stackId);
    const opRow = async (id: string) => (await db().select().from(operations).where(eq(operations.id, id)))[0]!;
    const runningNow = () => Object.values(h.sim.appStacks.getAppStackSnapshot(stackId)?.containers ?? {}).filter((c) => c.state === "running");
    const worker = h.app.nestApp.get(OutboxWorkerService);

    // The executor accepts the write-back and goes on writing; the next renewal of the lease, while the worker follows
    // the job, meets a lost database connection.
    const real = h.sim.backups;
    h.sim.backups = (async (req: Parameters<typeof real>[0]) => {
      if (req.action !== "stackRestore") return real.call(h.sim, req);
      h.sim.backupState.holdJobs();
      const started = await real.call(h.sim, req);
      lease.failures = 1;
      return started;
    }) as typeof real;
    try {
      const res = await restore(stackId, backupId, "in-sospeso");
      expect(res.status, res.raw).toBe(202);
      const operationId = res.body.data.operationId as string;
      for (let round = 0; round < 6 && (await opRow(operationId)).status !== "unknown"; round += 1) await worker.processPendingOnce();
      expect(await opRow(operationId)).toMatchObject({ status: "unknown", errorCode: "OPERATION_AMBIGUOUS" });

      // The panel's lock refuses the customer's start, and the executor would refuse one that reached it.
      expectRefusal(await act(h.a.token, stackId, "start"), 409, "RESOURCE_LOCKED");
      await expect(h.sim.startAppStackComponent(startReq)).rejects.toMatchObject({ code: "RESOURCE_LOCKED", reason: "STACK_BUSY" });
      expect(runningNow()).toEqual([]);

      // Recovery only reads: while the job writes, the restore stays to be verified.
      expect((await worker.recoverUnknownOperations()).recoveryErrors).toBeUndefined();
      expect((await opRow(operationId)).status).toBe("unknown");
      expectRefusal(await act(h.a.token, stackId, "start"), 409, "RESOURCE_LOCKED");

      h.sim.backupState.finishHeld();
      expect((await worker.recoverUnknownOperations()).recoveryErrors).toBeUndefined();
      expect((await opRow(operationId)).status).toBe("succeeded");
      expect(await settle(stackId)).toBe("running");
      expect(runningNow()).not.toEqual([]);
      const writes = h.sim.backupState.appStackJobs().filter((job) => job.stackId === stackId && job.action === "stackRestore");
      expect(writes).toHaveLength(1);
      const source = ((await list(stackId)).body.data.backups as Json[]).find((b) => b.id === backupId)!;
      expect(source.restore).toMatchObject({ status: "succeeded", problem: null });
      expect(lease.failures).toBe(0);
    } finally {
      lease.failures = 0;
      h.sim.backups = real;
      h.sim.backupState.finishHeld();
    }
  });

  it("the Idempotency-Key is required; a replay answers the same action once; a second request waits its turn", async () => {
    const stackId = await running("ripetuto");
    const before = await h.counts();
    expectRefusal(await h.call(h.a.token, "POST", `${base(h.a)}/${stackId}/backups`, {}), 400, "VALIDATION_ERROR");
    expectRefusal(await act(h.a.token, stackId, "backups", { anything: true }), 400, "VALIDATION_ERROR");
    expect(await h.counts()).toEqual(before);

    const key = randomUUID();
    const first = await backup(stackId, h.a.token, key);
    expect(first.status, first.raw).toBe(202);
    const again = await backup(stackId, h.a.token, key);
    expect(again.status, again.raw).toBe(202);
    expect(again.body.data.operationId).toBe(first.body.data.operationId);
    expect(await rowsOf(stackId)).toHaveLength(1);
    expect(await audits("app.stack.backup.create", stackId)).toHaveLength(1);

    const [row] = await rowsOf(stackId);
    expectRefusal(await restore(stackId, row!.id, "ripetuto", h.a.token, key), 409, "IDEMPOTENCY_CONFLICT");
    const busy = await backup(stackId);
    expectRefusal(busy, 409, "RESOURCE_LOCKED");
    expect(busy.body.error.retryable).toBe(true);
    expect(await rowsOf(stackId)).toHaveLength(1);
    expect(await settle(stackId)).toBe("running");
  });

  it("an application that was never deployed has nothing to save: 409 with its status", async () => {
    const created = await h.call(h.a.token, "POST", base(h.a), { templateVersionId: storage, name: "bozza", deploy: false }, idem());
    expect(created.status, created.raw).toBe(201);
    const stackId = created.body.data.stackId as string;
    const res = await backup(stackId);
    expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: "draft" });
    expect(res.body.error.retryable).toBe(false);
    expect(await rowsOf(stackId)).toHaveLength(0);
  });

  it("a customer starts six backups an hour per application; a server administrator is not counted", async () => {
    const stackId = await stopped("frequente");
    const first = Date.now();
    for (let n = 0; n < APP_STACK_BACKUP_ACTIONS_PER_HOUR; n += 1) await saved(stackId);
    // Nothing is removed while the customer works: the night does it (K7).
    expect((await list(stackId)).body.data.backups).toHaveLength(APP_STACK_BACKUP_ACTIONS_PER_HOUR);

    const before = await h.counts();
    const refused = await backup(stackId);
    expectRefusal(refused, 409, "QUOTA_EXCEEDED", { field: "retryAt", reason: "too_many_requests" });
    const retryAt = Date.parse((refused.body.error.details as Json[])[0]!.message as string);
    expect(retryAt).toBeGreaterThanOrEqual(first + 3_600_000 - 1_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(await h.counts()).toEqual(before);
    expect((await stackRow(stackId)).status).toBe("stopped");
    // Another application of the same customer has its own count.
    await saved(await stopped("tranquillo"));

    const [admin] = await db().select().from(users).where(eq(users.email, "admin@x.it"));
    const [installation] = await db().select().from(platformInstallations).limit(1);
    await db()
      .insert(hostingAdminScopes)
      .values({ id: `has_${randomUUID()}`, userId: admin!.id, organizationId: h.a.orgId, installationId: installation!.id });
    await saved(stackId, h.adminToken);
    // The administrator's action took no slot and freed none.
    expectRefusal(await backup(stackId), 409, "QUOTA_EXCEEDED", { reason: "too_many_requests" });
  });

  it("while the platform cleans up an application's backups, its page learns that it is busy and with what, and nothing else", async () => {
    const stackId = await stopped("pulizia");
    await saved(stackId);
    await ensurePlatformOpsOrg(db());
    expect(await enqueueAppStackPrune(db(), stackId)).toBe(true);
    const [prune] = (await opsOf(stackId)).filter((op) => op.kind === "stack.prune");
    expect(prune).toMatchObject({ organizationId: PLATFORM_OPS_ORG_ID, status: "queued" });

    const detail = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body.data).toMatchObject({ activeOperationId: null, platformWork: "backups_cleanup" });
    expect(detail.raw).not.toContain(prune!.id);
    // The operation stays the platform's: the customer cannot read it, and an action waits for its end.
    expect((await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/operations/${prune!.id}`)).status).toBe(404);
    const listed = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/operations`);
    expect(listed.status, listed.raw).toBe(200);
    expect(listed.raw).not.toContain(prune!.id);
    expectRefusal(await act(h.a.token, stackId, "start"), 409, "RESOURCE_LOCKED");

    expect(await settle(stackId)).toBe("stopped");
    expect((await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`)).body.data).toMatchObject({ activeOperationId: null, platformWork: null });
    // The customer's own action is followed by its id, and is not the platform's work.
    expect((await act(h.a.token, stackId, "start")).status).toBe(202);
    const own = (await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`)).body.data;
    expect(own.activeOperationId).not.toBeNull();
    expect(own.platformWork).toBeNull();
    await settle(stackId);
  });

  it("issue #106: the detail offers a backup and a restore exactly when the routes accept them: every stored status, the lock, the caller", async () => {
    const offered = async (stackId: string, who: HarnessCustomer = h.a): Promise<Json> => {
      const res = await h.call(who.token, "GET", `${base(h.a)}/${stackId}`);
      expect(res.status, res.raw).toBe(200);
      return res.body.data as Json;
    };
    const backupKinds = (detail: Json) => (detail.allowedActions as string[]).filter((k) => k === "stack.backup" || k === "stack.restore");
    const store = (stackId: string, status: AppStackStatus) => db().update(appStacks).set({ status }).where(eq(appStacks.id, stackId));
    // One application per kind: the hourly limit counts the accepted actions of each application.
    const forBackup = await stopped("offerta-copia");
    const forRestore = await stopped("offerta-ripristino");
    const source = await saved(forRestore);
    const target = { "stack.backup": forBackup, "stack.restore": forRestore } as const;
    const ask = (kind: keyof typeof target, who: HarnessCustomer = h.a) =>
      kind === "stack.backup" ? backup(forBackup, who.token) : restore(forRestore, source, "offerta-ripristino", who.token);

    for (const kind of ["stack.backup", "stack.restore"] as const) {
      const stackId = target[kind];
      // A deleted application is not found by the detail nor by the routes.
      for (const status of APP_STACK_STATUSES.filter((s) => s !== "deleted")) {
        await store(stackId, status);
        const listed = (await offered(stackId)).allowedActions.includes(kind);
        const res = await ask(kind);
        expect(res.status === 202, `${kind} from a stored ${status}: ${res.raw}`).toBe(listed);
        if (!listed) {
          expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: status });
          continue;
        }
        // Its operation now holds the application: neither is offered, and the route refuses, until it ends.
        expect(backupKinds(await offered(stackId))).toEqual([]);
        expectRefusal(await ask(kind), 409, "RESOURCE_LOCKED");
        await settle(stackId);
      }
      await store(stackId, "stopped");
    }

    // A stale reading shows unknown while the stored status stays running: both are offered, and the route accepts.
    await store(forBackup, "running");
    await db()
      .update(appStackComponents)
      .set({ healthObservedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(appStackComponents.stackId, forBackup));
    const stale = await offered(forBackup);
    expect([stale.status, stale.outcomeUnknown, backupKinds(stale)]).toEqual(["unknown", false, ["stack.backup", "stack.restore"]]);
    expect((await ask("stack.backup")).status).toBe(202);
    await settle(forBackup);

    // The platform's clean-up holds the lock with a status that accepts: nothing is offered, both are refused.
    await ensurePlatformOpsOrg(db());
    expect(await enqueueAppStackPrune(db(), forRestore)).toBe(true);
    expect(backupKinds(await offered(forRestore))).toEqual([]);
    expectRefusal(await backup(forRestore), 409, "RESOURCE_LOCKED");
    expectRefusal(await ask("stack.restore"), 409, "RESOURCE_LOCKED");
    expect(await settle(forRestore)).toBe("stopped");
    expect(backupKinds(await offered(forRestore))).toEqual(["stack.backup", "stack.restore"]);

    // The caller's: a reader and an editor (app.update, not app.control) are offered neither, and the routes refuse them.
    await db().insert(roles).values([
      { id: "role_app_reader_bk106", name: "app_reader_bk106" as never, description: "Read only", isPreset: false },
      { id: "role_app_editor_bk106", name: "app_editor_bk106" as never, description: "Read and change", isPreset: false },
    ]);
    await db().insert(rolePermissions).values([
      { roleId: "role_app_reader_bk106", permissionKey: "app.read" },
      { roleId: "role_app_editor_bk106", permissionKey: "app.read" },
      { roleId: "role_app_editor_bk106", permissionKey: "app.update" },
    ]);
    for (const role of ["role_app_reader_bk106", "role_app_editor_bk106"]) {
      const who = await h.addMember(h.a.orgId, role as "role_customer_collaborator");
      expect(backupKinds(await offered(forRestore, who)), role).toEqual([]);
      expect((await ask("stack.backup", who)).status, role).toBe(403);
      expect((await ask("stack.restore", who)).status, role).toBe(403);
    }
    // A suspended organisation still reads its application and is offered neither: every change is refused.
    await db().update(organizations).set({ status: "suspended" }).where(eq(organizations.id, h.a.orgId));
    try {
      expect(backupKinds(await offered(forRestore))).toEqual([]);
      expect((await ask("stack.backup")).body.error?.code).toBe("ORGANIZATION_SUSPENDED");
      expect((await ask("stack.restore")).body.error?.code).toBe("ORGANIZATION_SUSPENDED");
    } finally {
      await db().update(organizations).set({ status: "active" }).where(eq(organizations.id, h.a.orgId));
    }
  });

  it("the nightly run keeps the three newest manual backups, and removes those of a deleted application after the retention period", async () => {
    const live = await stopped("ordinato");
    const made: string[] = [];
    for (let n = 0; n <= MANUAL_BACKUPS_KEPT; n += 1) made.push(await saved(live));
    const gone = await stopped("addio");
    const goneBackupId = await saved(gone);
    const removed = await h.call(h.a.token, "DELETE", `${base(h.a)}/${gone}`, { confirmName: "addio", destroyData: true }, idem());
    expect(removed.status, removed.raw).toBe(202);
    await settle(gone);
    expect((await stackRow(gone)).deletedAt).not.toBeNull();
    expect(h.sim.backupState.appStackSnapshots(gone)).toHaveLength(1);

    const scheduler = h.app.nestApp.get(BackupSchedulerService);
    const pruneOps = async (stackId: string) => (await opsOf(stackId)).filter((op) => op.kind === "stack.prune");
    const night = (days: number) => new Date(Math.floor(Date.now() / DAY) * DAY + days * DAY + 23 * 3_600_000);
    const runs = () => db().select().from(auditEvents).where(eq(auditEvents.action, "backups.nightly_run"));

    await scheduler.tick(night(0));
    const [run] = await runs();
    // The run's record keeps its four keys: applications add none.
    expect(Object.keys(run!.details as Json).sort()).toEqual(["busy", "date", "enqueued", "pruned"]);
    expect(run!.details).toMatchObject({ enqueued: 0, busy: 0, pruned: 0 });
    // The application that exists: the oldest of its four manual backups goes, at the destination and in the list.
    const [prune] = await pruneOps(live);
    expect(prune).toMatchObject({ organizationId: PLATFORM_OPS_ORG_ID, status: "queued", requestedByUserId: null });
    await settle(live);
    expect((await pruneOps(live))[0]!.status).toBe("succeeded");
    expect(((await list(live)).body.data.backups as Json[]).map((b) => b.id)).toEqual(made.slice(1).reverse());
    expect(h.sim.backupState.appStackSnapshots(live)).toHaveLength(MANUAL_BACKUPS_KEPT);
    expect((await stackRow(live)).status).toBe("stopped");
    // The deleted one keeps its backup for the retention period.
    expect(await pruneOps(gone)).toHaveLength(0);
    expect(await rowsOf(gone)).toHaveLength(1);

    // Twenty days later (the row is moved back: the worker reads the real clock).
    const old = new Date(Date.now() - 20 * DAY);
    await db().update(appStackBackups).set({ startedAt: old, finishedAt: old }).where(eq(appStackBackups.id, goneBackupId));
    await scheduler.tick(night(1));
    expect(await runs()).toHaveLength(2);
    expect(await pruneOps(gone)).toHaveLength(1);
    await settle(gone);
    expect((await pruneOps(gone))[0]!.status).toBe("succeeded");
    expect(await rowsOf(gone)).toHaveLength(0);
    expect(await db().select().from(appStackBackupCopies).where(eq(appStackBackupCopies.backupId, goneBackupId))).toHaveLength(0);
    expect(h.sim.backupState.appStackSnapshots(gone)).toHaveLength(0);
  });
});
