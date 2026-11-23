import { BACKUPS_RESULT_SCHEMAS, type BackupsIpcRequest } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryDockerSimulatorAdapter,
  SimulatedBackups,
  type SimulatedAppStackReadiness,
} from "../src/index.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

const OP = (n: number, suffix = ""): string => `op_${n.toString(16).padStart(32, "0")}${suffix}`;
const STACK = "stk_0123456789abcdef01234567";
const OTHER_STACK = "stk_fedcba9876543210fedcba98";
const ORG = "org_1";
const S3 = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKey: "sentinel-sim-secret-value",
} as const;
const LOCAL = { kind: "local", targetId: `bkt_${"a".repeat(32)}` } as const;
const DEAD_LOCAL = { kind: "local", targetId: `bkt_${"a".repeat(28)}dead` } as const;

type CopyRequest = Extract<BackupsIpcRequest, { action: "stackStart" }>;
type RestoreRequest = Extract<BackupsIpcRequest, { action: "stackRestore" }>;

const copyReq = (jobId: string, extra: Partial<CopyRequest> = {}): CopyRequest => ({
  action: "stackStart",
  jobId,
  stackId: STACK,
  organizationId: ORG,
  volumeKeys: ["data", "db"],
  target: S3,
  ...extra,
});
const restoreReq = (jobId: string, snapshotId: string, extra: Partial<RestoreRequest> = {}): RestoreRequest => ({
  action: "stackRestore",
  jobId,
  stackId: STACK,
  organizationId: ORG,
  volumeKeys: ["data", "db"],
  target: S3,
  snapshotId,
  ...extra,
});
const status = (sim: SimulatedBackups, jobId: string) => sim.handle({ action: "status", jobId });

/** A copy that succeeded: its snapshot id. */
async function copied(sim: SimulatedBackups, jobId: string, extra: Partial<CopyRequest> = {}): Promise<string> {
  await sim.handle(copyReq(jobId, extra));
  const done = await status(sim, jobId);
  expect(done.state).toBe("succeeded");
  return done.snapshot?.snapshotId ?? "";
}

describe("simulated jobs of application backups", () => {
  it("copies the volumes of an application into a snapshot of its own repository", async () => {
    const sim = new SimulatedBackups();
    const started = await sim.handle(copyReq(OP(1)));
    expect(started).toEqual({ jobId: OP(1), state: "running", failure: null, snapshot: null });
    expect(() => BACKUPS_RESULT_SCHEMAS.stackStart.parse(started)).not.toThrow();

    const done = await status(sim, OP(1));
    expect(done).toMatchObject({ jobId: OP(1), state: "succeeded", failure: null });
    expect(done.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(sim.appStackSnapshots(STACK)).toEqual([done.snapshot?.snapshotId]);
    expect(sim.appStackSnapshots(STACK, S3)).toEqual([done.snapshot?.snapshotId]);
    // One repository per application and per destination; a site with the same id is another repository.
    expect(sim.appStackSnapshots(STACK, LOCAL)).toEqual([]);
    expect(sim.appStackSnapshots(OTHER_STACK)).toEqual([]);
    expect(sim.snapshots(STACK)).toEqual([]);

    expect(sim.appStackJobs()).toEqual([
      { action: "stackStart", jobId: OP(1), stackId: STACK, organizationId: ORG, volumeKeys: ["data", "db"], snapshotId: null },
    ]);
  });

  it("writes a known snapshot back and fails on one the repository does not hold", async () => {
    const sim = new SimulatedBackups();
    const snapshotId = await copied(sim, OP(1));

    const started = await sim.handle(restoreReq(OP(2, "-apply"), snapshotId, { volumeKeys: ["db"] }));
    expect(started).toEqual({ jobId: OP(2, "-apply"), state: "running", failure: null, snapshot: null });
    expect(() => BACKUPS_RESULT_SCHEMAS.stackRestore.parse(started)).not.toThrow();
    expect(await status(sim, OP(2, "-apply"))).toEqual({
      jobId: OP(2, "-apply"),
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    // A restore neither adds nor removes a snapshot.
    expect(sim.appStackSnapshots(STACK)).toEqual([snapshotId]);

    // The same snapshot id on another destination, or in another application's repository, is not there.
    for (const [n, extra] of [
      [3, { target: LOCAL }],
      [4, { stackId: OTHER_STACK }],
    ] as const) {
      await sim.handle(restoreReq(OP(n, "-apply"), snapshotId, extra));
      expect(await status(sim, OP(n, "-apply"))).toMatchObject({ state: "failed", failure: "other" });
    }
    await sim.handle(restoreReq(OP(5, "-apply"), "f".repeat(64)));
    expect(await status(sim, OP(5, "-apply"))).toMatchObject({ state: "failed", failure: "other" });

    expect(sim.appStackJobs().map((job) => [job.action, job.jobId, job.volumeKeys, job.snapshotId])).toEqual([
      ["stackStart", OP(1), ["data", "db"], null],
      ["stackRestore", OP(2, "-apply"), ["db"], snapshotId],
      ["stackRestore", OP(3, "-apply"), ["data", "db"], snapshotId],
      ["stackRestore", OP(4, "-apply"), ["data", "db"], snapshotId],
      ["stackRestore", OP(5, "-apply"), ["data", "db"], "f".repeat(64)],
    ]);
  });

  it("forgets the listed snapshots of one application on one destination", async () => {
    const sim = new SimulatedBackups();
    const first = await copied(sim, OP(1));
    const second = await copied(sim, OP(2));
    const onLocal = await copied(sim, OP(3), { target: LOCAL });
    const other = await copied(sim, OP(4), { stackId: OTHER_STACK });

    const started = await sim.handle({
      action: "stackForget",
      jobId: OP(5, "-forget"),
      stackId: STACK,
      target: S3,
      snapshotIds: [first, "e".repeat(64)],
    });
    expect(started).toEqual({ jobId: OP(5, "-forget"), state: "running", failure: null, snapshot: null });
    expect(() => BACKUPS_RESULT_SCHEMAS.stackForget.parse(started)).not.toThrow();
    expect(await status(sim, OP(5, "-forget"))).toMatchObject({ state: "succeeded", failure: null });

    expect(sim.appStackSnapshots(STACK, S3)).toEqual([second]);
    expect(sim.appStackSnapshots(STACK, LOCAL)).toEqual([onLocal]);
    expect(sim.appStackSnapshots(OTHER_STACK)).toEqual([other]);
    // A forget is not a copy or a restore: it is not in that log.
    expect(sim.appStackJobs().map((job) => job.jobId)).toEqual([OP(1), OP(2), OP(3), OP(4)]);

    // A repository that does not exist has nothing to remove.
    await sim.handle({ action: "stackForget", jobId: OP(6, "-forget"), stackId: "stk_nothing", target: S3, snapshotIds: [first] });
    expect(await status(sim, OP(6, "-forget"))).toMatchObject({ state: "succeeded" });
  });

  it("fails the next job with failNext(problem) and every job on an unmounted local destination", async () => {
    const sim = new SimulatedBackups();
    sim.failNext("no_space");
    await sim.handle(copyReq(OP(1)));
    expect(await status(sim, OP(1))).toMatchObject({ state: "failed", failure: "no_space", snapshot: null });
    expect(sim.appStackSnapshots(STACK)).toEqual([]);

    const snapshotId = await copied(sim, OP(2));
    sim.failNext("wrong_key");
    await sim.handle(restoreReq(OP(3, "-apply"), snapshotId));
    expect(await status(sim, OP(3, "-apply"))).toMatchObject({ state: "failed", failure: "wrong_key" });

    await sim.handle(copyReq(OP(4), { target: DEAD_LOCAL }));
    expect(await status(sim, OP(4))).toMatchObject({ state: "failed", failure: "local_target_unmounted" });
    expect(sim.appStackSnapshots(STACK, DEAD_LOCAL)).toEqual([]);
  });

  it("runs one job at a time for an application and answers a request sent twice with the same job", async () => {
    const sim = new SimulatedBackups();
    sim.holdJobs();
    const first = await sim.handle(copyReq(OP(1)));
    expect(await sim.handle(copyReq(OP(1)))).toEqual(first);
    await expect(sim.handle(copyReq(OP(2)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(sim.handle(restoreReq(OP(2, "-apply"), "f".repeat(64)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(
      sim.handle({ action: "stackForget", jobId: OP(2, "-forget"), stackId: STACK, target: S3, snapshotIds: ["f".repeat(64)] }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    // Another application has its own lane, and so has a site whose id equals the application's.
    await sim.handle(copyReq(OP(3), { stackId: OTHER_STACK }));
    expect(await status(sim, OP(1))).toMatchObject({ state: "running" });

    sim.finishHeld();
    expect(await status(sim, OP(1))).toMatchObject({ state: "succeeded" });
    expect(await status(sim, OP(3))).toMatchObject({ state: "succeeded" });
    expect(await sim.handle(copyReq(OP(1)))).toMatchObject({ state: "succeeded" });
    // Refused requests left no trace; the accepted ones are logged once each.
    expect(sim.appStackJobs().map((job) => job.jobId)).toEqual([OP(1), OP(3)]);
    await expect(status(sim, OP(2))).resolves.toMatchObject({ state: "unknown" });
  });

  it("forgets every job of an application at a restart, a restore included", async () => {
    const sim = new SimulatedBackups();
    const snapshotId = await copied(sim, OP(1));
    sim.holdJobs();
    await sim.handle(restoreReq(OP(2, "-apply"), snapshotId));
    sim.simulateRestart();
    sim.holdJobs(false);
    // The real runner keeps these jobs in memory only: the panel reads `unknown` and never sends the job again.
    expect(await status(sim, OP(1))).toMatchObject({ state: "unknown" });
    expect(await status(sim, OP(2, "-apply"))).toMatchObject({ state: "unknown" });
    // The repository is on the destination: it outlives the process.
    expect(sim.appStackSnapshots(STACK)).toEqual([snapshotId]);
  });
});

describe("the simulated check before a copy or a restore", () => {
  const refusals: Array<[SimulatedAppStackReadiness, string]> = [
    ["running", "RESOURCE_LOCKED"],
    ["volume_missing", "NOT_FOUND"],
    ["foreign", "HOST_POLICY_DENIED"],
  ];

  it.each(refusals)("refuses an application that is %s with %s, before anything is recorded", async (readiness, code) => {
    const asked: unknown[] = [];
    const sim = new SimulatedBackups({
      appStackReadiness: (...args) => {
        asked.push(args);
        return readiness;
      },
    });
    await expect(sim.handle(copyReq(OP(1)))).rejects.toMatchObject({ code });
    await expect(sim.handle(restoreReq(OP(2, "-apply"), "f".repeat(64)))).rejects.toMatchObject({ code });
    expect(asked).toEqual([
      [STACK, ORG, ["data", "db"]],
      [STACK, ORG, ["data", "db"]],
    ]);
    expect(sim.appStackJobs()).toEqual([]);
    expect(await status(sim, OP(1))).toMatchObject({ state: "unknown" });
    expect(await status(sim, OP(2, "-apply"))).toMatchObject({ state: "unknown" });
    // A refusal does not use up a queued failure.
    sim.failNext("no_space");
    await expect(sim.handle(copyReq(OP(3)))).rejects.toMatchObject({ code });
    const free = new SimulatedBackups();
    free.failNext("no_space");
    await free.handle(copyReq(OP(3)));
    expect(await status(free, OP(3))).toMatchObject({ failure: "no_space" });
  });

  it("checks a new job only: a request sent twice and a forget are not judged", async () => {
    let readiness: SimulatedAppStackReadiness = "ready";
    let calls = 0;
    const sim = new SimulatedBackups({
      appStackReadiness: () => {
        calls += 1;
        return readiness;
      },
    });
    sim.holdJobs();
    await sim.handle(copyReq(OP(1)));
    expect(calls).toBe(1);
    readiness = "running";
    await expect(sim.handle(copyReq(OP(1)))).resolves.toMatchObject({ jobId: OP(1), state: "running" });
    expect(calls).toBe(1);
    sim.finishHeld();
    const snapshotId = (await status(sim, OP(1))).snapshot?.snapshotId ?? "";

    await sim.handle({ action: "stackForget", jobId: OP(2, "-forget"), stackId: STACK, target: S3, snapshotIds: [snapshotId] });
    expect(await status(sim, OP(2, "-forget"))).toMatchObject({ state: "succeeded" });
    expect(calls).toBe(1);
    expect(sim.appStackSnapshots(STACK)).toEqual([]);
  });
});

describe("the simulated executor: backups of a simulated application", () => {
  const plan = appStackTestPlan();
  const [web] = plan.components;
  const ref = { stackId: plan.stackId, organizationId: plan.organizationId };
  const SECRET = { parameterKey: "shared_key", version: 1, content: "s3cr3t-content" };

  async function deployed(): Promise<InMemoryDockerSimulatorAdapter> {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await sim.pullAppStackImage({ plan, image: web?.image ?? "" });
    await sim.prepareAppStack({ plan });
    await sim.createAppStackComponents({ plan });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] });
    return sim;
  }
  const copy = (jobId: string, extra: Partial<CopyRequest> = {}): CopyRequest =>
    copyReq(jobId, { ...ref, volumeKeys: ["data"], ...extra });

  it("says what a job would find", async () => {
    const sim = await deployed();
    expect(sim.appStacks.backupReadiness(ref.stackId, ref.organizationId, ["data"])).toBe("running");
    await sim.stopAppStack(ref);
    expect(sim.appStacks.backupReadiness(ref.stackId, ref.organizationId, ["data"])).toBe("ready");
    expect(sim.appStacks.backupReadiness(ref.stackId, ref.organizationId, ["data", "uploads"])).toBe("volume_missing");
    expect(sim.appStacks.backupReadiness(ref.stackId, "org_other", ["data"])).toBe("foreign");
    expect(sim.appStacks.backupReadiness("stk_unknown", ref.organizationId, ["data"])).toBe("volume_missing");
  });

  it("refuses the copy of a running application and accepts it once stopped", async () => {
    const sim = await deployed();
    await expect(sim.backups(copy(OP(1)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    expect(sim.backupState.appStackJobs()).toEqual([]);

    await sim.stopAppStack(ref);
    await expect(sim.backups(copy(OP(1)))).resolves.toMatchObject({ jobId: OP(1), state: "running" });
    const done = await sim.backups({ action: "status", jobId: OP(1) });
    expect(done).toMatchObject({ state: "succeeded" });
    const snapshotId = done.snapshot?.snapshotId ?? "";
    expect(sim.backupState.appStackSnapshots(ref.stackId)).toEqual([snapshotId]);

    // The job never touched the application: it is still stopped, with its volume.
    const snapshot = sim.appStacks.getAppStackSnapshot(ref.stackId);
    expect(Object.keys(snapshot?.containers ?? {}).sort()).toEqual(["web", "worker"]);
    expect(Object.values(snapshot?.containers ?? {}).map((c) => c.state)).toEqual(["exited", "exited"]);
    expect(Object.keys(snapshot?.volumes ?? {})).toEqual(["data"]);
    expect(sim.appStacks.backupReadiness(ref.stackId, ref.organizationId, ["data"])).toBe("ready");

    await expect(sim.backups(restoreReq(OP(2, "-apply"), snapshotId, { ...ref, volumeKeys: ["data"] }))).resolves.toMatchObject({
      state: "running",
    });
    await expect(sim.backups({ action: "status", jobId: OP(2, "-apply") })).resolves.toMatchObject({ state: "succeeded" });
  });

  it("refuses another customer's application, a volume the application does not have and an unknown application", async () => {
    const sim = await deployed();
    await sim.stopAppStack(ref);
    await expect(sim.backups(copy(OP(1), { organizationId: "org_other" }))).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    await expect(sim.backups(copy(OP(1), { volumeKeys: ["data", "uploads"] }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sim.backups(copy(OP(1), { stackId: "stk_unknown" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      sim.backups(restoreReq(OP(1, "-apply"), "f".repeat(64), { ...ref, organizationId: "org_other", volumeKeys: ["data"] })),
    ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(sim.backupState.appStackJobs()).toEqual([]);
  });

  it("refuses a malformed request like the real executor", async () => {
    const sim = await deployed();
    await sim.stopAppStack(ref);
    const bad: unknown[] = [
      copy(OP(1, "-apply")),
      copy(OP(1), { volumeKeys: [] }),
      copy(OP(1), { volumeKeys: ["data", "data"] }),
      { ...copy(OP(1)), hostPath: "/etc" },
      restoreReq(OP(1), "f".repeat(64), ref),
      restoreReq(OP(1, "-apply"), "latest", ref),
    ];
    for (const req of bad) {
      await expect(sim.backups(req as BackupsIpcRequest)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(sim.backupState.appStackJobs()).toEqual([]);
  });
});
