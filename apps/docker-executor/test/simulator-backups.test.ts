import {
  BACKUP_FAILURE_CLASSES,
  BACKUPS_RESULT_SCHEMAS,
  BackupJobStatusSchema,
  BackupTestResultSchema,
  type BackupsIpcRequest,
} from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import {
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
  SimulatedBackups,
} from "../src/index.js";

const JOB_1 = `op_${"1".repeat(32)}`;
const JOB_2 = `op_${"2".repeat(32)}`;
const JOB_3 = `op_${"3".repeat(32)}`;
const JOB_4 = `op_${"4".repeat(32)}`;
const FORGET_1 = `${JOB_1}-forget`;
const FORGET_2 = `${JOB_2}-forget`;
const SNAP_MISSING = "f".repeat(64);

const VALID_TARGET = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKey: "sentinel-sim-secret-value",
} as const;

describe("SimulatedBackups", () => {
  it("answers ok for test by default and consumes failNext(problem) once", async () => {
    const sim = new SimulatedBackups();

    const okResult = await sim.handle({ action: "test", target: VALID_TARGET });
    expect(okResult).toEqual({ outcome: "ok", problem: null });
    expect(() => BACKUPS_RESULT_SCHEMAS.test.parse(okResult)).not.toThrow();

    for (const problem of BACKUP_FAILURE_CLASSES) {
      sim.failNext(problem);
      const failedResult = await sim.handle({ action: "test", target: VALID_TARGET });
      expect(failedResult).toEqual({ outcome: "failed", problem });
      expect(() => BackupTestResultSchema.parse(failedResult)).not.toThrow();
    }

    // Subsequent test returns ok once queued failures are drained.
    expect(await sim.handle({ action: "test", target: VALID_TARGET })).toEqual({
      outcome: "ok",
      problem: null,
    });
  });

  it("starts a backup, settles on status with a 64-hex snapshot, and isolates snapshots by site", async () => {
    const sim = new SimulatedBackups();

    const started = await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect(started).toEqual({
      jobId: JOB_1,
      state: "running",
      failure: null,
      snapshot: null,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.start.parse(started)).not.toThrow();
    expect(sim.snapshots("site_a")).toEqual([]);

    const polled = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(() => BackupJobStatusSchema.parse(polled)).not.toThrow();
    expect(polled.jobId).toBe(JOB_1);
    expect(polled.state).toBe("succeeded");
    expect(polled.failure).toBeNull();
    expect(polled.snapshot).not.toBeNull();
    expect(polled.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(polled.snapshot?.bytesAdded).toBeGreaterThanOrEqual(0);
    expect(polled.snapshot?.totalBytes).toBeGreaterThan(0);
    expect(polled.snapshot?.fileCount).toBeGreaterThan(0);
    expect(polled.snapshot?.durationMs).toBeGreaterThan(0);

    const snap1 = polled.snapshot!.snapshotId;
    const listed = sim.snapshots("site_a");
    expect(listed).toEqual([snap1]);
    expect(sim.snapshots("site_b")).toEqual([]);

    // Mutating returned array does not mutate simulator state.
    (listed as string[]).push("0".repeat(64));
    expect(sim.snapshots("site_a")).toEqual([snap1]);

    // A second backup for the same site succeeds once the first has settled.
    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const polled2 = await sim.handle({ action: "status", jobId: JOB_2 });
    expect(polled2.state).toBe("succeeded");
    const snap2 = polled2.snapshot!.snapshotId;
    expect(snap2).not.toBe(snap1);
    expect(sim.snapshots("site_a")).toEqual([snap1, snap2]);
  });

  it("treats repeated start and forget with an already-known jobId as idempotent", async () => {
    const sim = new SimulatedBackups();

    const first = await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect(first.state).toBe("running");

    // Repeated start while running returns current status without RESOURCE_LOCKED or consuming failNext.
    sim.failNext("auth_failed");
    const retryRunning = await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect(retryRunning).toEqual(first);

    const settled = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(settled.state).toBe("succeeded");

    // Repeated start after completion returns the same snapshot and creates nothing new.
    const retrySettled = await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect(retrySettled).toEqual(settled);
    expect(sim.snapshots("site_a")).toEqual([settled.snapshot!.snapshotId]);

    // The queued failNext was preserved for the next genuinely new test/job.
    expect(await sim.handle({ action: "test", target: VALID_TARGET })).toEqual({
      outcome: "failed",
      problem: "auth_failed",
    });

    // Repeated forget with known jobId returns current status.
    const forgetStart = await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [settled.snapshot!.snapshotId],
    });
    expect(await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [settled.snapshot!.snapshotId],
    })).toEqual(forgetStart);
    const forgetDone = await sim.handle({ action: "status", jobId: FORGET_1 });
    expect(forgetDone.state).toBe("succeeded");
    expect(await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [settled.snapshot!.snapshotId],
    })).toEqual(forgetDone);
  });

  it("throws RESOURCE_LOCKED for a second running job on the same site or a third running job overall", async () => {
    const sim = new SimulatedBackups();

    await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });

    // Same site busy -> RESOURCE_LOCKED (and does not consume failNext).
    sim.failNext("no_space");
    const sameSiteErr = await sim
      .handle({
        action: "start",
        jobId: JOB_2,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
      })
      .catch((e: unknown) => e);
    expect(sameSiteErr).toBeInstanceOf(ExecutorCodedError);
    expect((sameSiteErr as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");

    const sameSiteForgetErr = await sim
      .handle({
        action: "forget",
        jobId: FORGET_1,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotIds: [SNAP_MISSING],
      })
      .catch((e: unknown) => e);
    expect(sameSiteForgetErr).toBeInstanceOf(ExecutorCodedError);
    expect((sameSiteForgetErr as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");

    // Second site can start concurrently (2 running overall).
    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
      target: VALID_TARGET,
    });

    // Third running job overall -> RESOURCE_LOCKED.
    const thirdSiteErr = await sim
      .handle({
        action: "start",
        jobId: JOB_3,
        siteId: "site_c",
        serviceInstanceId: "svc_c",
        target: VALID_TARGET,
      })
      .catch((e: unknown) => e);
    expect(thirdSiteErr).toBeInstanceOf(ExecutorCodedError);
    expect((thirdSiteErr as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");

    // Settle site_a (started before failNext) -> slot opens for site_c.
    const doneA = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(doneA.state).toBe("succeeded");
    expect(sim.snapshots("site_a")).toHaveLength(1);

    const startedC = await sim.handle({
      action: "start",
      jobId: JOB_3,
      siteId: "site_c",
      serviceInstanceId: "svc_c",
      target: VALID_TARGET,
    });
    expect(startedC.state).toBe("running");

    // site_b was the first job started after failNext("no_space"), proving RESOURCE_LOCKED did not consume it.
    expect(await sim.handle({ action: "status", jobId: JOB_2 })).toEqual({
      jobId: JOB_2,
      state: "failed",
      failure: "no_space",
      snapshot: null,
    });
    expect(sim.snapshots("site_b")).toEqual([]);
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("succeeded");
  });

  it("makes the next started start or forget job fail with failNext(problem) and creates no snapshot", async () => {
    const sim = new SimulatedBackups();

    // Seed one good snapshot first.
    await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const okStatus = await sim.handle({ action: "status", jobId: JOB_1 });
    const snap1 = okStatus.snapshot!.snapshotId;

    // status calls before start do not consume failNext.
    sim.failNext("files_unreadable");
    expect(await sim.handle({ action: "status", jobId: JOB_4 })).toEqual({
      jobId: JOB_4,
      state: "unknown",
      failure: null,
      snapshot: null,
    });

    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const failedStart = await sim.handle({ action: "status", jobId: JOB_2 });
    expect(failedStart).toEqual({
      jobId: JOB_2,
      state: "failed",
      failure: "files_unreadable",
      snapshot: null,
    });
    expect(sim.snapshots("site_a")).toEqual([snap1]);

    // failNext on forget preserves existing snapshots.
    sim.failNext("write_denied");
    await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [snap1],
    });
    const failedForget = await sim.handle({ action: "status", jobId: FORGET_1 });
    expect(failedForget).toEqual({
      jobId: FORGET_1,
      state: "failed",
      failure: "write_denied",
      snapshot: null,
    });
    expect(sim.snapshots("site_a")).toEqual([snap1]);
  });

  it("holdJobs() keeps started jobs running across polls until finishHeld()", async () => {
    const sim = new SimulatedBackups();
    sim.holdJobs();

    await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });

    for (let i = 0; i < 3; i += 1) {
      expect(await sim.handle({ action: "status", jobId: JOB_1 })).toEqual({
        jobId: JOB_1,
        state: "running",
        failure: null,
        snapshot: null,
      });
    }
    expect(sim.snapshots("site_a")).toEqual([]);

    sim.finishHeld();

    const finished = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(finished.state).toBe("succeeded");
    expect(finished.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    const snap1 = finished.snapshot!.snapshotId;
    expect(sim.snapshots("site_a")).toEqual([snap1]);

    // finishHeld cleared the hold so subsequent jobs settle on first status poll.
    await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [snap1],
    });
    expect((await sim.handle({ action: "status", jobId: FORGET_1 })).state).toBe("succeeded");
    expect(sim.snapshots("site_a")).toEqual([]);

    // holdJobs(false) also releases holding for subsequent status polls.
    sim.holdJobs(true);
    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect((await sim.handle({ action: "status", jobId: JOB_2 })).state).toBe("running");
    sim.holdJobs(false);
    expect((await sim.handle({ action: "status", jobId: JOB_2 })).state).toBe("succeeded");
  });

  it("simulateRestart() makes all known jobs answer unknown and releases running locks", async () => {
    const sim = new SimulatedBackups();

    // Job 1 completes before restart.
    await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const done1 = await sim.handle({ action: "status", jobId: JOB_1 });
    const snap1 = done1.snapshot!.snapshotId;

    // Job 2 is still running when restart hits.
    sim.holdJobs(true);
    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    await sim.handle({
      action: "start",
      jobId: JOB_3,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
      target: VALID_TARGET,
    });

    sim.simulateRestart();
    sim.holdJobs(false);

    // Every previously known job now answers unknown.
    for (const id of [JOB_1, JOB_2, JOB_3]) {
      expect(await sim.handle({ action: "status", jobId: id })).toEqual({
        jobId: id,
        state: "unknown",
        failure: null,
        snapshot: null,
      });
    }

    // Completed snapshot remains; interrupted jobs produced nothing and no longer lock the site.
    expect(sim.snapshots("site_a")).toEqual([snap1]);
    expect(sim.snapshots("site_b")).toEqual([]);

    // Old jobId can be started fresh after restart and gets a new snapshot.
    const restarted = await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    expect(restarted.state).toBe("running");
    const settled = await sim.handle({ action: "status", jobId: JOB_2 });
    expect(settled.state).toBe("succeeded");
    expect(sim.snapshots("site_a")).toEqual([snap1, settled.snapshot!.snapshotId]);
  });

  it("forget removes named snapshots idempotently and ignores missing ids", async () => {
    const sim = new SimulatedBackups();

    await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const snap1 = (await sim.handle({ action: "status", jobId: JOB_1 })).snapshot!.snapshotId;

    await sim.handle({
      action: "start",
      jobId: JOB_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    const snap2 = (await sim.handle({ action: "status", jobId: JOB_2 })).snapshot!.snapshotId;

    await sim.handle({
      action: "start",
      jobId: JOB_3,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
      target: VALID_TARGET,
    });
    const snapB = (await sim.handle({ action: "status", jobId: JOB_3 })).snapshot!.snapshotId;

    const forgetStart = await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [snap1, SNAP_MISSING, snapB],
    });
    expect(forgetStart).toEqual({
      jobId: FORGET_1,
      state: "running",
      failure: null,
      snapshot: null,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.forget.parse(forgetStart)).not.toThrow();

    const forgetDone = await sim.handle({ action: "status", jobId: FORGET_1 });
    expect(forgetDone).toEqual({
      jobId: FORGET_1,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(forgetDone)).not.toThrow();
    expect(sim.snapshots("site_a")).toEqual([snap2]);
    expect(sim.snapshots("site_b")).toEqual([snapB]);

    // Repeating forget for already-removed ids succeeds without error.
    await sim.handle({
      action: "forget",
      jobId: FORGET_2,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotIds: [snap1, SNAP_MISSING],
    });
    expect((await sim.handle({ action: "status", jobId: FORGET_2 })).state).toBe("succeeded");
  });

  it("answers unknown for unseen job ids", async () => {
    const sim = new SimulatedBackups();

    for (const jobId of [JOB_1, FORGET_1]) {
      const res = await sim.handle({ action: "status", jobId });
      expect(res).toEqual({
        jobId,
        state: "unknown",
        failure: null,
        snapshot: null,
      });
      expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(res)).not.toThrow();
    }
  });

  it("refuses invalid requests with VALIDATION_ERROR and integrates with InMemoryDockerSimulatorAdapter", async () => {
    const sim = new SimulatedBackups();
    const invalidPayloads: unknown[] = [
      { action: "test", target: VALID_TARGET, extra: true },
      { action: "test", target: { ...VALID_TARGET, extra: true } },
      { action: "test", target: { ...VALID_TARGET, endpoint: "http://localhost:9000" } },
      { action: "test", target: { ...VALID_TARGET, endpoint: "http://127.0.0.1:9000" } },
      { action: "test", target: { ...VALID_TARGET, endpoint: "http://[::1]:9000" } },
      { action: "test", target: { ...VALID_TARGET, region: "US-EAST-1" } },
      { action: "status", jobId: "bad-job-id" },
      {
        action: "start",
        jobId: FORGET_1,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
      },
      {
        action: "forget",
        jobId: FORGET_1,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotIds: Array.from({ length: 101 }, () => SNAP_MISSING),
      },
      { action: "test", target: { ...VALID_TARGET, secretAccessKey: "has space" } },
    ];

    for (const payload of invalidPayloads) {
      const err = await sim.handle(payload as BackupsIpcRequest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExecutorCodedError);
      expect((err as ExecutorCodedError).code).toBe("VALIDATION_ERROR");
    }

    // Adapter delegation and engine-unreachable gate
    const adapter = new InMemoryDockerSimulatorAdapter();
    expect(await adapter.backups({ action: "test", target: VALID_TARGET })).toEqual({
      outcome: "ok",
      problem: null,
    });
    adapter.backupState.holdJobs(true);
    await adapter.backups({
      action: "start",
      jobId: JOB_1,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
    });
    adapter.backupState.finishHeld();
    expect((await adapter.backups({ action: "status", jobId: JOB_1 })).state).toBe("succeeded");
    expect(adapter.backupState.snapshots("site_a")).toHaveLength(1);

    adapter.setEngineReachable(false);
    await expect(adapter.backups({ action: "test", target: VALID_TARGET })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });

  it("throws RESOURCE_LOCKED for a second concurrent test and releases the lock once done", async () => {
    const sim = new SimulatedBackups();
    sim.failNext("auth_failed");

    const [first, second] = await Promise.allSettled([
      sim.handle({ action: "test", target: VALID_TARGET }),
      sim.handle({ action: "test", target: VALID_TARGET }),
    ]);

    expect(first).toEqual({
      status: "fulfilled",
      value: { outcome: "failed", problem: "auth_failed" },
    });
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toBeInstanceOf(ExecutorCodedError);
      expect((second.reason as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");
    }

    expect(await sim.handle({ action: "test", target: VALID_TARGET })).toEqual({
      outcome: "ok",
      problem: null,
    });
  });
});
