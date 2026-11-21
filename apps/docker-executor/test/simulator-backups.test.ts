import { inspect } from "node:util";
import {
  BACKUP_FAILURE_CLASSES,
  BACKUPS_RESULT_SCHEMAS,
  BackupArchiveChunkSchema,
  BackupJobStatusSchema,
  BackupTestResultSchema,
  SITE_FILE_CHUNK_BYTES,
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

const SIM_ARCHIVE_SIZE_BYTES = 1_048_577;
const EMPTY_ZIP_EOCD = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const JOB_5 = `op_${"5".repeat(32)}`;
const JOB_6 = `op_${"6".repeat(32)}`;

async function createSiteSnapshot(
  sim: SimulatedBackups,
  jobId: string,
  siteId: string,
): Promise<string> {
  await sim.handle({
    action: "start",
    jobId,
    siteId,
    serviceInstanceId: `svc_${siteId}`,
    target: VALID_TARGET,
  });
  const settled = await sim.handle({ action: "status", jobId });
  expect(settled.state).toBe("succeeded");
  if (!settled.snapshot) {
    throw new Error("Expected snapshot from simulated start job");
  }
  return settled.snapshot.snapshotId;
}

describe("SimulatedBackups M3b restore and archive actions", () => {
  it("handles restore lifecycle, idempotency, locking, and unknown snapshot failure", async () => {
    const sim = new SimulatedBackups();
    const snapA = await createSiteSnapshot(sim, JOB_1, "site_a");
    const snapB = await createSiteSnapshot(sim, JOB_2, "site_b");

    const started = await sim.handle({
      action: "restore",
      jobId: JOB_3,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
      snapshotId: snapA,
    });
    expect(started).toEqual({
      jobId: JOB_3,
      state: "running",
      failure: null,
      snapshot: null,
    });
    expect("archive" in started).toBe(false);

    // Same jobId repeats status without failing or starting a second job.
    expect(
      await sim.handle({
        action: "restore",
        jobId: JOB_3,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: snapA,
      }),
    ).toEqual(started);

    // Same-site running lock while restore is still running.
    await expect(
      sim.handle({
        action: "restore",
        jobId: JOB_4,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: snapA,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(
      sim.handle({
        action: "start",
        jobId: JOB_4,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    // Global running job limit (2 across sites).
    await sim.handle({
      action: "restore",
      jobId: JOB_4,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
      target: VALID_TARGET,
      snapshotId: snapB,
    });
    await expect(
      sim.handle({
        action: "restore",
        jobId: JOB_5,
        siteId: "site_c",
        serviceInstanceId: "svc_c",
        target: VALID_TARGET,
        snapshotId: snapA,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    // Settle JOB_3 -> succeeded with no snapshot and no archive.
    const settledRestore = await sim.handle({ action: "status", jobId: JOB_3 });
    expect(settledRestore).toEqual({
      jobId: JOB_3,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect("archive" in settledRestore).toBe(false);
    expect(() => BACKUPS_RESULT_SCHEMAS.restore.parse(settledRestore)).not.toThrow();

    // Idempotent repeat after completion returns settled status even while site_b runs.
    expect(
      await sim.handle({
        action: "restore",
        jobId: JOB_3,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: snapA,
      }),
    ).toEqual(settledRestore);

    // Unknown snapshot on site_a (both SNAP_MISSING and another site's snapB) fails with "other".
    await sim.handle({
      action: "restore",
      jobId: JOB_5,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
      snapshotId: snapB,
    });
    expect(await sim.handle({ action: "status", jobId: JOB_5 })).toEqual({
      jobId: JOB_5,
      state: "failed",
      failure: "other",
      snapshot: null,
    });

    await sim.handle({
      action: "restore",
      jobId: JOB_6,
      siteId: "site_empty",
      serviceInstanceId: "svc_empty",
      target: VALID_TARGET,
      snapshotId: SNAP_MISSING,
    });
    expect(await sim.handle({ action: "status", jobId: JOB_6 })).toEqual({
      jobId: JOB_6,
      state: "failed",
      failure: "other",
      snapshot: null,
    });
  });

  it("handles archive lifecycle, 60-minute expiry metadata, one-per-site replacement, and unknown snapshot failure", async () => {
    const sim = new SimulatedBackups();
    const snapA = await createSiteSnapshot(sim, JOB_1, "site_a");
    const snapB = await createSiteSnapshot(sim, JOB_2, "site_b");

    // Archive on site_a
    const archStart = await sim.handle({
      action: "archive",
      jobId: JOB_3,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotId: snapA,
    });
    expect(archStart).toEqual({
      jobId: JOB_3,
      state: "running",
      failure: null,
      snapshot: null,
    });
    // Reading before settlement throws RESOURCE_LOCKED "archive_preparing".
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED", message: "archive_preparing" });

    // Archive on site_b concurrently within limit of 2.
    await sim.handle({
      action: "archive",
      jobId: JOB_4,
      siteId: "site_b",
      target: VALID_TARGET,
      snapshotId: snapB,
    });

    const archDoneA = await sim.handle({ action: "status", jobId: JOB_3 });
    expect(() => BACKUPS_RESULT_SCHEMAS.archive.parse(archDoneA)).not.toThrow();
    expect(archDoneA.state).toBe("succeeded");
    expect(archDoneA.snapshot).toBeNull();
    expect(archDoneA.archive?.sizeBytes).toBe(SIM_ARCHIVE_SIZE_BYTES);
    const readyMs = Date.parse(archDoneA.archive!.readyAt);
    const expiresMs = Date.parse(archDoneA.archive!.expiresAt);
    expect(Number.isFinite(readyMs)).toBe(true);
    expect(expiresMs - readyMs).toBe(60 * 60 * 1000);

    // Repeat archive with same jobId returns settled status without restarting.
    expect(
      await sim.handle({
        action: "archive",
        jobId: JOB_3,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotId: snapA,
      }),
    ).toEqual(archDoneA);

    const archDoneB = await sim.handle({ action: "status", jobId: JOB_4 });
    expect(archDoneB.state).toBe("succeeded");

    // New archive on site_a replaces JOB_3; JOB_3 reads throw archive_gone, site_b's JOB_4 stays readable.
    await sim.handle({
      action: "archive",
      jobId: JOB_5,
      siteId: "site_a",
      target: VALID_TARGET,
      snapshotId: snapA,
    });
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect(await sim.handle({ action: "discardArchive", jobId: JOB_3 })).toEqual({
      discarded: false,
    });
    await sim.handle({ action: "status", jobId: JOB_5 });
    const chunkA = await sim.handle({
      action: "readArchive",
      jobId: JOB_5,
      offset: 0,
      length: 64,
    });
    const chunkB = await sim.handle({
      action: "readArchive",
      jobId: JOB_4,
      offset: 0,
      length: 64,
    });
    expect(chunkA.size).toBe(SIM_ARCHIVE_SIZE_BYTES);
    expect(chunkB.size).toBe(SIM_ARCHIVE_SIZE_BYTES);
    expect(chunkA.dataBase64).not.toBe(chunkB.dataBase64);

    // Unknown snapshot on archive fails with "other", has no archive metadata, and yields archive_gone on read.
    await sim.handle({
      action: "archive",
      jobId: JOB_6,
      siteId: "site_b",
      target: VALID_TARGET,
      snapshotId: SNAP_MISSING,
    });
    const failedArch = await sim.handle({ action: "status", jobId: JOB_6 });
    expect(failedArch).toEqual({
      jobId: JOB_6,
      state: "failed",
      failure: "other",
      snapshot: null,
    });
    expect("archive" in failedArch).toBe(false);
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_6, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
  });

  it("reads 1,048,577 deterministic bytes across three SITE_FILE_CHUNK_BYTES chunks ending in empty-zip EOCD", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_zip");

    await sim.handle({
      action: "archive",
      jobId: JOB_2,
      siteId: "site_zip",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    const settled = await sim.handle({ action: "status", jobId: JOB_2 });
    expect(settled.state).toBe("succeeded");

    const c1 = await sim.handle({
      action: "readArchive",
      jobId: JOB_2,
      offset: 0,
      length: SITE_FILE_CHUNK_BYTES,
    });
    const c2 = await sim.handle({
      action: "readArchive",
      jobId: JOB_2,
      offset: SITE_FILE_CHUNK_BYTES,
      length: SITE_FILE_CHUNK_BYTES,
    });
    const c3 = await sim.handle({
      action: "readArchive",
      jobId: JOB_2,
      offset: SITE_FILE_CHUNK_BYTES * 2,
      length: SITE_FILE_CHUNK_BYTES,
    });

    for (const chunk of [c1, c2, c3]) {
      expect(() => BackupArchiveChunkSchema.parse(chunk)).not.toThrow();
      expect(chunk.size).toBe(SIM_ARCHIVE_SIZE_BYTES);
    }
    expect(c1.eof).toBe(false);
    expect(c2.eof).toBe(false);
    expect(c3.eof).toBe(true);

    const b1 = Buffer.from(c1.dataBase64, "base64");
    const b2 = Buffer.from(c2.dataBase64, "base64");
    const b3 = Buffer.from(c3.dataBase64, "base64");
    expect(b1.length).toBe(SITE_FILE_CHUNK_BYTES);
    expect(b2.length).toBe(SITE_FILE_CHUNK_BYTES);
    expect(b3.length).toBe(1);

    const full = Buffer.concat([b1, b2, b3]);
    expect(full.length).toBe(SIM_ARCHIVE_SIZE_BYTES);
    expect(full.subarray(full.length - EMPTY_ZIP_EOCD.length).equals(EMPTY_ZIP_EOCD)).toBe(true);

    // Deterministic across repeated reads.
    const c1Again = await sim.handle({
      action: "readArchive",
      jobId: JOB_2,
      offset: 0,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(c1Again).toEqual(c1);

    // Offset at or past size returns empty data with eof: true.
    expect(
      await sim.handle({
        action: "readArchive",
        jobId: JOB_2,
        offset: SIM_ARCHIVE_SIZE_BYTES,
        length: 1024,
      }),
    ).toEqual({
      dataBase64: "",
      size: SIM_ARCHIVE_SIZE_BYTES,
      eof: true,
    });
    expect(
      await sim.handle({
        action: "readArchive",
        jobId: JOB_2,
        offset: SIM_ARCHIVE_SIZE_BYTES + 5000,
        length: 1024,
      }),
    ).toEqual({
      dataBase64: "",
      size: SIM_ARCHIVE_SIZE_BYTES,
      eof: true,
    });

    // Unknown or non-archive jobs fail readArchive with NOT_FOUND archive_gone.
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_6, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_1, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
  });

  it("supports discardArchive, idempotent settle, and hooks (failNext, holdJobs/finishHeld, expireArchives, simulateRestart)", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_hooks");

    // settle on unseen jobId answers unknown and starts nothing.
    expect(await sim.handle({ action: "settle", jobId: JOB_6 })).toEqual({
      jobId: JOB_6,
      state: "unknown",
      failure: null,
      snapshot: null,
    });
    expect(await sim.handle({ action: "status", jobId: JOB_6 })).toEqual({
      jobId: JOB_6,
      state: "unknown",
      failure: null,
      snapshot: null,
    });

    // failNext applies to restore and archive (failed archive has no bytes).
    sim.failNext("restore_prepare_failed");
    await sim.handle({
      action: "restore",
      jobId: JOB_2,
      siteId: "site_hooks",
      serviceInstanceId: "svc_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    const failedRestore = await sim.handle({ action: "settle", jobId: JOB_2 });
    expect(failedRestore).toEqual({
      jobId: JOB_2,
      state: "failed",
      failure: "restore_prepare_failed",
      snapshot: null,
    });
    expect(await sim.handle({ action: "settle", jobId: JOB_2 })).toEqual(failedRestore);

    sim.failNext("no_space");
    await sim.handle({
      action: "archive",
      jobId: JOB_3,
      siteId: "site_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    const failedArch = await sim.handle({ action: "status", jobId: JOB_3 });
    expect(failedArch).toEqual({
      jobId: JOB_3,
      state: "failed",
      failure: "no_space",
      snapshot: null,
    });
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect(await sim.handle({ action: "discardArchive", jobId: JOB_3 })).toEqual({
      discarded: false,
    });

    // holdJobs keeps restore and archive running until finishHeld().
    const snapOther = await createSiteSnapshot(sim, `op_${"c".repeat(32)}`, "site_other");
    const heldArchJob = `op_${"d".repeat(32)}`;
    sim.holdJobs(true);
    await sim.handle({
      action: "restore",
      jobId: JOB_4,
      siteId: "site_hooks",
      serviceInstanceId: "svc_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    await sim.handle({
      action: "archive",
      jobId: heldArchJob,
      siteId: "site_other",
      target: VALID_TARGET,
      snapshotId: snapOther,
    });

    expect((await sim.handle({ action: "status", jobId: JOB_4 })).state).toBe("running");
    expect((await sim.handle({ action: "settle", jobId: JOB_4 })).state).toBe("running");
    expect((await sim.handle({ action: "status", jobId: heldArchJob })).state).toBe("running");
    expect((await sim.handle({ action: "settle", jobId: heldArchJob })).state).toBe("running");
    await expect(
      sim.handle({ action: "readArchive", jobId: heldArchJob, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED", message: "archive_preparing" });
    sim.finishHeld();
    expect((await sim.handle({ action: "status", jobId: JOB_4 })).state).toBe("succeeded");
    const heldArchDone = await sim.handle({ action: "status", jobId: heldArchJob });
    expect(heldArchDone.state).toBe("succeeded");
    expect(heldArchDone.archive?.sizeBytes).toBe(SIM_ARCHIVE_SIZE_BYTES);
    expect(await sim.handle({ action: "discardArchive", jobId: heldArchJob })).toEqual({
      discarded: true,
    });

    // Archive on site_hooks -> finishHeld -> readable -> discardArchive.
    sim.holdJobs(true);
    await sim.handle({
      action: "archive",
      jobId: JOB_5,
      siteId: "site_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    expect((await sim.handle({ action: "status", jobId: JOB_5 })).state).toBe("running");
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_5, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED", message: "archive_preparing" });
    sim.finishHeld();
    const archReady = await sim.handle({ action: "status", jobId: JOB_5 });
    expect(archReady.state).toBe("succeeded");
    expect(archReady.archive?.sizeBytes).toBe(SIM_ARCHIVE_SIZE_BYTES);

    expect(await sim.handle({ action: "discardArchive", jobId: JOB_5 })).toEqual({
      discarded: true,
    });
    expect(await sim.handle({ action: "discardArchive", jobId: JOB_5 })).toEqual({
      discarded: false,
    });
    await expect(
      sim.handle({ action: "readArchive", jobId: JOB_5, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });

    // expireArchives expires every ready archive.
    const snap2 = await createSiteSnapshot(sim, `op_${"7".repeat(32)}`, "site_exp");
    const archJob1 = `op_${"8".repeat(32)}`;
    const archJob2 = `op_${"9".repeat(32)}`;
    await sim.handle({
      action: "archive",
      jobId: archJob1,
      siteId: "site_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    await sim.handle({
      action: "archive",
      jobId: archJob2,
      siteId: "site_exp",
      target: VALID_TARGET,
      snapshotId: snap2,
    });
    await sim.handle({ action: "status", jobId: archJob1 });
    await sim.handle({ action: "status", jobId: archJob2 });
    sim.expireArchives();
    await expect(
      sim.handle({ action: "readArchive", jobId: archJob1, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    await expect(
      sim.handle({ action: "readArchive", jobId: archJob2, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect(await sim.handle({ action: "discardArchive", jobId: archJob1 })).toEqual({
      discarded: false,
    });

    // simulateRestart:
    // - running restore -> failed + interrupted on both status and settle
    // - finished restore (JOB_2 failed, JOB_4 succeeded) keeps its answer
    // - archive jobs -> unknown and reads -> archive_gone
    // - backup jobs -> unknown, snapshots kept
    const runningRestore = `op_${"a".repeat(32)}`;
    const liveArchive = `op_${"b".repeat(32)}`;
    await sim.handle({
      action: "archive",
      jobId: liveArchive,
      siteId: "site_exp",
      target: VALID_TARGET,
      snapshotId: snap2,
    });
    await sim.handle({ action: "status", jobId: liveArchive });

    sim.holdJobs(true);
    await sim.handle({
      action: "restore",
      jobId: runningRestore,
      siteId: "site_hooks",
      serviceInstanceId: "svc_hooks",
      target: VALID_TARGET,
      snapshotId: snap,
    });
    sim.simulateRestart();
    sim.holdJobs(false);

    const interruptedStatus = await sim.handle({ action: "status", jobId: runningRestore });
    expect(interruptedStatus).toEqual({
      jobId: runningRestore,
      state: "failed",
      failure: "interrupted",
      snapshot: null,
    });
    expect(await sim.handle({ action: "settle", jobId: runningRestore })).toEqual(interruptedStatus);
    expect(await sim.handle({ action: "settle", jobId: runningRestore })).toEqual(interruptedStatus);

    // Finished restores preserved across simulateRestart.
    expect(await sim.handle({ action: "status", jobId: JOB_2 })).toEqual(failedRestore);
    expect(await sim.handle({ action: "settle", jobId: JOB_2 })).toEqual(failedRestore);
    expect((await sim.handle({ action: "status", jobId: JOB_4 })).state).toBe("succeeded");
    expect((await sim.handle({ action: "settle", jobId: JOB_4 })).state).toBe("succeeded");

    // Archive and backup jobs cleared to unknown.
    expect((await sim.handle({ action: "status", jobId: liveArchive })).state).toBe("unknown");
    expect((await sim.handle({ action: "settle", jobId: liveArchive })).state).toBe("unknown");
    await expect(
      sim.handle({ action: "readArchive", jobId: liveArchive, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect((await sim.handle({ action: "status", jobId: JOB_1 })).state).toBe("unknown");
    expect(sim.snapshots("site_hooks")).toContain(snap);
  });

  it("never exposes paths, schema names, container names, or secrets in any simulator result or error", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_leak");

    const payloads: unknown[] = [];
    payloads.push(await sim.handle({ action: "test", target: VALID_TARGET }));
    payloads.push(
      await sim.handle({
        action: "restore",
        jobId: JOB_2,
        siteId: "site_leak",
        serviceInstanceId: "svc_leak",
        target: VALID_TARGET,
        snapshotId: snap,
      }),
    );
    payloads.push(await sim.handle({ action: "settle", jobId: JOB_2 }));
    payloads.push(await sim.handle({ action: "status", jobId: JOB_2 }));
    payloads.push(
      await sim.handle({
        action: "archive",
        jobId: JOB_3,
        siteId: "site_leak",
        target: VALID_TARGET,
        snapshotId: snap,
      }),
    );
    try {
      await sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 });
    } catch (err) {
      payloads.push({ error: (err as Error).message });
    }
    payloads.push(await sim.handle({ action: "status", jobId: JOB_3 }));
    payloads.push(await sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 }));
    payloads.push(await sim.handle({ action: "discardArchive", jobId: JOB_3 }));
    try {
      await sim.handle({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 });
    } catch (err) {
      payloads.push({ error: (err as Error).message });
    }

    const serialized = JSON.stringify(payloads);
    for (const forbidden of [
      VALID_TARGET.secretAccessKey,
      "/var/",
      "/etc/",
      "/run/",
      "hp_bk_",
      "hp_rn_",
      "Schema",
      "BACKUPS_",
      "mariadb",
      "docker",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// Sentinel only: 64 lowercase hex digits, never a real key.
const SENTINEL_MASTER_KEY = `9b${"c7".repeat(31)}`;

describe("SimulatedBackups M3c site state, restore that creates the files, panel copy", () => {
  const restoreReq = (jobId: string, snapshotId: string, createVolume?: true) => ({
    action: "restore" as const,
    jobId,
    siteId: "site_m3c",
    serviceInstanceId: "svc_site_m3c",
    target: VALID_TARGET,
    snapshotId,
    ...(createVolume ? { createVolume } : {}),
  });
  const panelReq = (jobId: string) => ({
    action: "panelStart" as const,
    jobId,
    target: VALID_TARGET,
    masterKey: SENTINEL_MASTER_KEY,
    retentionDays: 14,
  });
  const stateOf = (sim: SimulatedBackups) =>
    sim.handle({ action: "siteState", siteId: "site_m3c", serviceInstanceId: "svc_site_m3c" });

  it("answers siteState {true, true} by default and every combination set by setSiteState", async () => {
    const sim = new SimulatedBackups();
    const first = await stateOf(sim);
    expect(first).toEqual({ filesVolume: true, container: true });
    expect(() => BACKUPS_RESULT_SCHEMAS.siteState.parse(first)).not.toThrow();

    for (const filesVolume of [true, false]) {
      for (const container of [true, false]) {
        sim.setSiteState("svc_site_m3c", { filesVolume, container });
        expect(await stateOf(sim)).toEqual({ filesVolume, container });
        // Another service instance keeps the default.
        expect(
          await sim.handle({ action: "siteState", siteId: "site_x", serviceInstanceId: "svc_x" }),
        ).toEqual({ filesVolume: true, container: true });
      }
    }
  });

  it("restores as before when the files volume exists, with or without createVolume", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_m3c");
    sim.setSiteState("svc_site_m3c", { filesVolume: true, container: false });

    await sim.handle(restoreReq(JOB_2, snap));
    expect((await sim.handle({ action: "status", jobId: JOB_2 })).state).toBe("succeeded");
    await sim.handle(restoreReq(JOB_3, snap, true));
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("succeeded");
    expect(await stateOf(sim)).toEqual({ filesVolume: true, container: false });
  });

  it("fails a restore with restore_prepare_failed when the files volume is missing and createVolume is absent", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_m3c");
    sim.setSiteState("svc_site_m3c", { filesVolume: false, container: false });

    await sim.handle(restoreReq(JOB_2, snap));
    expect(await sim.handle({ action: "status", jobId: JOB_2 })).toEqual({
      jobId: JOB_2,
      state: "failed",
      failure: "restore_prepare_failed",
      snapshot: null,
    });
    expect(await stateOf(sim)).toEqual({ filesVolume: false, container: false });
  });

  it("creates the files volume on a successful restore with createVolume and keeps it only on success or undo_incomplete", async () => {
    const sim = new SimulatedBackups();
    const snap = await createSiteSnapshot(sim, JOB_1, "site_m3c");
    sim.setSiteState("svc_site_m3c", { filesVolume: false, container: true });

    // A plain failure leaves the volume missing.
    sim.failNext("switch_undone");
    await sim.handle(restoreReq(JOB_2, snap, true));
    expect((await sim.handle({ action: "status", jobId: JOB_2 })).failure).toBe(
      "switch_undone",
    );
    expect(await stateOf(sim)).toEqual({ filesVolume: false, container: true });

    // A held job leaves the volume missing until it settles.
    sim.holdJobs();
    await sim.handle(restoreReq(JOB_3, snap, true));
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("running");
    expect(await stateOf(sim)).toEqual({ filesVolume: false, container: true });
    sim.finishHeld();
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("succeeded");
    expect(await stateOf(sim)).toEqual({ filesVolume: true, container: true });

    // undo_incomplete keeps what the job created.
    sim.setSiteState("svc_site_m3c", { filesVolume: false, container: false });
    sim.failNext("undo_incomplete");
    await sim.handle(restoreReq(JOB_4, snap, true));
    expect((await sim.handle({ action: "status", jobId: JOB_4 })).failure).toBe("undo_incomplete");
    expect(await stateOf(sim)).toEqual({ filesVolume: true, container: false });
  });

  it("runs a panel copy on lane panel:db with hold, fail, repeat, lock, restart and panelJobIds()", async () => {
    const sim = new SimulatedBackups();
    expect(sim.panelJobIds()).toEqual([]);

    const started = await sim.handle(panelReq(JOB_1));
    expect(started).toEqual({ jobId: JOB_1, state: "running", failure: null, snapshot: null });
    expect(() => BACKUPS_RESULT_SCHEMAS.panelStart.parse(started)).not.toThrow();
    const done = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(() => BackupJobStatusSchema.parse(done)).not.toThrow();
    expect(done.state).toBe("succeeded");
    expect(done.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    // Same id again answers the job and starts nothing.
    expect(await sim.handle(panelReq(JOB_1))).toEqual(done);
    expect(sim.panelJobIds()).toEqual([JOB_1]);

    // failNext applies to the next panel copy.
    sim.failNext("panel_dump_missing");
    await sim.handle(panelReq(JOB_2));
    expect(await sim.handle({ action: "status", jobId: JOB_2 })).toEqual({
      jobId: JOB_2,
      state: "failed",
      failure: "panel_dump_missing",
      snapshot: null,
    });

    // Held: a second panel copy is locked, a site job still runs, a third job hits the limit.
    sim.holdJobs();
    await sim.handle(panelReq(JOB_3));
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("running");
    const locked = await sim.handle(panelReq(JOB_4)).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(ExecutorCodedError);
    expect((locked as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");
    await sim.handle({
      action: "start",
      jobId: JOB_5,
      siteId: "site_m3c",
      serviceInstanceId: "svc_site_m3c",
      target: VALID_TARGET,
    });
    const full = await sim
      .handle({
        action: "start",
        jobId: JOB_6,
        siteId: "site_other",
        serviceInstanceId: "svc_other",
        target: VALID_TARGET,
      })
      .catch((e: unknown) => e);
    expect((full as ExecutorCodedError).code).toBe("RESOURCE_LOCKED");
    sim.finishHeld();
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).state).toBe("succeeded");
    // Panel snapshots are not site snapshots.
    expect(sim.snapshots("site_m3c")).toHaveLength(1);
    expect(sim.snapshots("panel:db")).toEqual([]);

    // After a restart a panel job is unknown, held or not.
    sim.holdJobs();
    await sim.handle(panelReq(JOB_4));
    sim.simulateRestart();
    sim.holdJobs(false);
    for (const jobId of [JOB_1, JOB_4]) {
      expect(await sim.handle({ action: "status", jobId })).toEqual({
        jobId,
        state: "unknown",
        failure: null,
        snapshot: null,
      });
    }
    expect(sim.panelJobIds()).toEqual([JOB_1, JOB_2, JOB_3, JOB_4]);
  });

  it("never keeps the master key: not in answers, panelJobIds(), errors or inspected state", async () => {
    const sim = new SimulatedBackups();
    const seen: unknown[] = [];
    sim.holdJobs();
    seen.push(await sim.handle(panelReq(JOB_1)));
    seen.push(await sim.handle(panelReq(JOB_1)));
    seen.push(await sim.handle(panelReq(JOB_2)).catch((e: unknown) => e));
    seen.push(
      await sim
        .handle({ ...panelReq(JOB_3), masterKey: `${SENTINEL_MASTER_KEY.slice(0, 63)}G` })
        .catch((e: unknown) => e),
    );
    seen.push(
      await sim
        .handle({ ...panelReq(JOB_3), extra: SENTINEL_MASTER_KEY } as unknown as BackupsIpcRequest)
        .catch((e: unknown) => e),
    );
    seen.push(await sim.handle({ action: "status", jobId: JOB_1 }));
    sim.finishHeld();
    seen.push(await sim.handle({ action: "status", jobId: JOB_1 }));
    seen.push(sim.panelJobIds());

    const probe = SENTINEL_MASTER_KEY.slice(0, 63);
    const rendered = seen
      .map((v) =>
        v instanceof Error
          ? `${v.message} ${String(v.stack)} ${inspect(v, { depth: null, showHidden: true })}`
          : JSON.stringify(v),
      )
      .join("\n");
    expect(rendered).not.toContain(probe);
    expect(inspect(sim, { depth: null, showHidden: true })).not.toContain(probe);
  });
});

describe("SimulatedBackups M3 local targets", () => {
  const LOCAL = { kind: "local", targetId: `bkt_${"a".repeat(32)}` } as const;
  const DEAD = { kind: "local", targetId: `bkt_${"0".repeat(28)}dead` } as const;
  const LOCAL_OK = {
    outcome: "ok",
    problem: null,
    availableBytes: 50 * 1024 ** 3,
    totalBytes: 100 * 1024 ** 3,
    localRoot: "/var/lib/hosting-panel/local-repos",
  };

  it("answers localInit and a local test with deterministic bytes and root", async () => {
    const sim = new SimulatedBackups();
    for (const request of [
      { action: "localInit", target: LOCAL },
      { action: "test", target: LOCAL },
    ] as const) {
      const result = await sim.handle(request);
      expect(result).toEqual(LOCAL_OK);
      expect(() => BACKUPS_RESULT_SCHEMAS[request.action].parse(result)).not.toThrow();
    }
  });

  it("keeps the S3 test answer free of local fields", async () => {
    const sim = new SimulatedBackups();
    expect(await sim.handle({ action: "test", target: VALID_TARGET })).toEqual({
      outcome: "ok",
      problem: null,
    });
  });

  it("fails an unmounted target id (…dead) without bytes and without consuming failNext", async () => {
    const sim = new SimulatedBackups();
    sim.failNext("no_space");
    for (const action of ["localInit", "test"] as const) {
      const result = await sim.handle({ action, target: DEAD });
      expect(result).toEqual({ outcome: "failed", problem: "local_target_unmounted" });
      expect(() => BackupTestResultSchema.parse(result)).not.toThrow();
    }
    expect(await sim.handle({ action: "test", target: LOCAL })).toEqual({
      outcome: "failed",
      problem: "no_space",
    });
    expect(await sim.handle({ action: "test", target: LOCAL })).toEqual(LOCAL_OK);
  });

  it("shares the single-test lock between S3 test, local test and localInit", async () => {
    const sim = new SimulatedBackups();
    const first = sim.handle({ action: "localInit", target: LOCAL });
    await expect(sim.handle({ action: "test", target: LOCAL })).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    expect(await first).toEqual(LOCAL_OK);
  });

  it("runs start, forget, restore, archive and panelStart on a local target like on S3", async () => {
    const sim = new SimulatedBackups();
    const started = await sim.handle({
      action: "start",
      jobId: JOB_1,
      siteId: "site_1",
      serviceInstanceId: "svc_1",
      target: LOCAL,
    });
    expect(started.state).toBe("running");
    const done = await sim.handle({ action: "status", jobId: JOB_1 });
    expect(done.state).toBe("succeeded");
    const snapshotId = done.snapshot?.snapshotId as string;
    expect(sim.snapshots("site_1")).toEqual([snapshotId]);

    await sim.handle({
      action: "restore",
      jobId: JOB_2,
      siteId: "site_1",
      serviceInstanceId: "svc_1",
      target: LOCAL,
      snapshotId,
    });
    expect((await sim.handle({ action: "settle", jobId: JOB_2 })).state).toBe("succeeded");

    await sim.handle({
      action: "archive",
      jobId: JOB_3,
      siteId: "site_1",
      target: LOCAL,
      snapshotId,
    });
    expect((await sim.handle({ action: "status", jobId: JOB_3 })).archive?.sizeBytes).toBe(1_048_577);

    await sim.handle({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_1",
      target: LOCAL,
      snapshotIds: [snapshotId],
    });
    expect((await sim.handle({ action: "status", jobId: FORGET_1 })).state).toBe("succeeded");
    expect(sim.snapshots("site_1")).toEqual([]);

    await sim.handle({
      action: "panelStart",
      jobId: JOB_4,
      target: LOCAL,
      masterKey: "b".repeat(64),
      retentionDays: 30,
    });
    expect((await sim.handle({ action: "status", jobId: JOB_4 })).state).toBe("succeeded");
    expect(sim.panelJobIds()).toEqual([JOB_4]);
  });

  it("keys snapshots per (target, site): a restore/archive on another target does not see them, a dead target fails every job", async () => {
    const sim = new SimulatedBackups();
    const OTHER = { kind: "local", targetId: `bkt_${"b".repeat(32)}` } as const;
    await sim.handle({ action: "start", jobId: JOB_1, siteId: "site_1", serviceInstanceId: "svc_1", target: LOCAL });
    const snapshotId = (await sim.handle({ action: "status", jobId: JOB_1 })).snapshot?.snapshotId as string;
    expect(sim.snapshots("site_1", LOCAL)).toEqual([snapshotId]);
    expect(sim.snapshots("site_1", OTHER)).toEqual([]);
    expect(sim.snapshots("site_1")).toEqual([snapshotId]);

    // the snapshot only exists on LOCAL
    await sim.handle({ action: "restore", jobId: JOB_2, siteId: "site_1", serviceInstanceId: "svc_1", target: OTHER, snapshotId });
    expect((await sim.handle({ action: "settle", jobId: JOB_2 })).failure).toBe("other");
    await sim.handle({ action: "restore", jobId: JOB_3, siteId: "site_1", serviceInstanceId: "svc_1", target: LOCAL, snapshotId });
    expect((await sim.handle({ action: "settle", jobId: JOB_3 })).state).toBe("succeeded");

    // forgetting on OTHER leaves LOCAL's snapshot alone
    await sim.handle({ action: "forget", jobId: FORGET_1, siteId: "site_1", target: OTHER, snapshotIds: [snapshotId] });
    await sim.handle({ action: "status", jobId: FORGET_1 });
    expect(sim.snapshots("site_1", LOCAL)).toEqual([snapshotId]);

    // a dead target fails start, restore, archive, forget and panelStart without touching any repository
    const base = { siteId: "site_2", serviceInstanceId: "svc_2", target: DEAD } as const;
    await sim.handle({ action: "start", jobId: JOB_4, ...base });
    expect(await sim.handle({ action: "settle", jobId: JOB_4 })).toMatchObject({ state: "failed", failure: "local_target_unmounted" });
    expect(sim.snapshots("site_2")).toEqual([]);
    await sim.handle({ action: "restore", jobId: `op_${"5".repeat(32)}`, snapshotId, ...base });
    expect((await sim.handle({ action: "settle", jobId: `op_${"5".repeat(32)}` })).failure).toBe("local_target_unmounted");
    await sim.handle({ action: "archive", jobId: `op_${"6".repeat(32)}`, siteId: "site_2", snapshotId, target: DEAD });
    expect((await sim.handle({ action: "settle", jobId: `op_${"6".repeat(32)}` })).failure).toBe("local_target_unmounted");
    await sim.handle({ action: "forget", jobId: FORGET_2, siteId: "site_2", snapshotIds: [snapshotId], target: DEAD });
    expect((await sim.handle({ action: "status", jobId: FORGET_2 })).failure).toBe("local_target_unmounted");
    await sim.handle({ action: "panelStart", jobId: `op_${"8".repeat(32)}`, target: DEAD, masterKey: "b".repeat(64), retentionDays: 30 });
    expect((await sim.handle({ action: "settle", jobId: `op_${"8".repeat(32)}` })).failure).toBe("local_target_unmounted");
  });

  it("accepts the second-copy job id op_x-t2 for start and keeps it separate from op_x", async () => {
    const sim = new SimulatedBackups();
    const base = { action: "start", siteId: "site_1", serviceInstanceId: "svc_1" } as const;
    await sim.handle({ ...base, jobId: JOB_1, target: VALID_TARGET });
    await sim.handle({ action: "status", jobId: JOB_1 });
    const t2 = await sim.handle({ ...base, jobId: `${JOB_1}-t2`, target: LOCAL });
    expect(t2.jobId).toBe(`${JOB_1}-t2`);
    expect((await sim.handle({ action: "status", jobId: `${JOB_1}-t2` })).state).toBe("succeeded");
  });

  it("refuses path-like or malformed local targets with VALIDATION_ERROR", async () => {
    const sim = new SimulatedBackups();
    const bad: unknown[] = [
      { kind: "local", targetId: "../etc" },
      { kind: "local", targetId: "/var/lib/hosting-panel/local-repos/x" },
      { kind: "local", targetId: `bkt_${"a".repeat(31)}/` },
      { kind: "local", targetId: `bkt_${"A".repeat(32)}` },
      { kind: "local", targetId: `bkt_${"a".repeat(33)}` },
      { kind: "local", targetId: "bkt_../../../../etc/passwd" },
      { kind: "local", targetId: `bkt_${"a".repeat(32)}`, root: "/tmp" },
      { kind: "local", targetId: `bkt_${"a".repeat(32)}`, path: "/tmp" },
      { kind: "local" },
      { kind: "s3", targetId: `bkt_${"a".repeat(32)}` },
      { ...VALID_TARGET, kind: "local", targetId: `bkt_${"a".repeat(32)}` },
      { ...VALID_TARGET, targetId: `bkt_${"a".repeat(32)}` },
    ];
    for (const target of bad) {
      for (const action of ["test", "localInit"] as const) {
        await expect(
          sim.handle({ action, target } as unknown as BackupsIpcRequest),
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
      await expect(
        sim.handle({
          action: "start",
          jobId: JOB_1,
          siteId: "site_1",
          serviceInstanceId: "svc_1",
          target,
        } as unknown as BackupsIpcRequest),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    // localInit never takes an S3 target.
    await expect(
      sim.handle({ action: "localInit", target: VALID_TARGET } as unknown as BackupsIpcRequest),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
