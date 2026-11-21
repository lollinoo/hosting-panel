import { randomBytes } from "node:crypto";
import http from "node:http";
import {
  BACKUPS_RESULT_SCHEMAS,
  BackupJobStatusSchema,
  BackupTestResultSchema,
  SITE_FILE_CHUNK_BYTES,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-backups-ipc-key";
const SIGNING_KEY: IpcSigningKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};

const SENTINEL_SECRET = "SENTINEL_S3_SECRET_KEY_VALUE_DO_NOT_LEAK_98765";
const SENTINEL_SPACE_SECRET = "SENTINEL_SECRET_WITH_SPACE DO_NOT_LEAK";
const JOB_1 = `op_${"a".repeat(32)}`;
const JOB_2 = `op_${"b".repeat(32)}`;
const FORGET_1 = `${JOB_1}-forget`;
const SNAP_DUMMY = "c".repeat(64);
// Sentinel only: 64 lowercase hex digits, never a real key.
const SENTINEL_MASTER_KEY = `5e${"d1".repeat(31)}`;

const VALID_TARGET = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel",
  accessKeyId: "AKIAEXAMPLE123",
  secretAccessKey: SENTINEL_SECRET,
} as const;

describe("Backups over signed loopback IPC (127.0.0.1:0) and simulator", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupTasks.length > 0) {
      const fn = cleanupTasks.pop();
      if (fn) {
        await fn();
      }
    }
  });

  async function createLoopbackHarness() {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "loopback-test",
      runtimeBackend: "local-simulator",
    });
    cleanupTasks.push(() => server.stop());
    const bound = await server.start();
    expect(bound.transport).toBe("loopback-test");
    expect(bound.host).toBe("127.0.0.1");
    expect(typeof bound.port).toBe("number");
    expect(bound.port).toBeGreaterThan(0);

    const port = bound.port!;
    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "loopback-test",
      port,
    });

    const rawPost = async (pathname: string, bodyObj: unknown, key = SIGNING_KEY) => {
      const bodyText = JSON.stringify(bodyObj);
      const headers = signIpcRequest({
        method: "POST",
        pathWithQuery: pathname,
        body: bodyText,
        key,
        nonce: randomBytes(8).toString("hex"),
      });
      const res = await fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: bodyText,
      });
      return {
        status: res.status,
        text: await res.text(),
      };
    };

    return { simulator, server, client, port, rawPost };
  }

  it("round-trips test, start, status, and forget through real server and client and validates result schemas", async () => {
    const { simulator, client } = await createLoopbackHarness();

    // 1. test (ok + simulated failure)
    const testOk = await client.backups({ action: "test", target: VALID_TARGET });
    expect(() => BACKUPS_RESULT_SCHEMAS.test.parse(testOk)).not.toThrow();
    expect(() => BackupTestResultSchema.parse(testOk)).not.toThrow();
    expect(testOk).toEqual({ outcome: "ok", problem: null });

    simulator.backupState.failNext("write_denied");
    const testFailed = await client.backups({ action: "test", target: VALID_TARGET });
    expect(() => BACKUPS_RESULT_SCHEMAS.test.parse(testFailed)).not.toThrow();
    expect(testFailed).toEqual({ outcome: "failed", problem: "write_denied" });

    // 2. start (returns running, held until finishHeld, then settles via status)
    simulator.backupState.holdJobs(true);
    const startRes = await client.backups({
      action: "start",
      jobId: JOB_1,
      siteId: "site_ipc_1",
      serviceInstanceId: "svc_ipc_1",
      target: VALID_TARGET,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.start.parse(startRes)).not.toThrow();
    expect(startRes).toEqual({
      jobId: JOB_1,
      state: "running",
      failure: null,
      snapshot: null,
    });

    // While running, a second start on the same site answers 409 RESOURCE_LOCKED over IPC.
    const lockErr = await client
      .backups({
        action: "start",
        jobId: JOB_2,
        siteId: "site_ipc_1",
        serviceInstanceId: "svc_ipc_1",
        target: VALID_TARGET,
      })
      .catch((e: unknown) => e);
    expect(lockErr).toBeInstanceOf(ExecutorIpcClientError);
    expect((lockErr as ExecutorIpcClientError).code).toBe("RESOURCE_LOCKED");
    expect((lockErr as ExecutorIpcClientError).statusCode).toBe(409);

    // 3. status (running while held, then succeeded after finishHeld)
    const statusRunning = await client.backups({ action: "status", jobId: JOB_1 });
    expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(statusRunning)).not.toThrow();
    expect(statusRunning.state).toBe("running");

    simulator.backupState.finishHeld();

    const statusDone = await client.backups({ action: "status", jobId: JOB_1 });
    expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(statusDone)).not.toThrow();
    expect(() => BackupJobStatusSchema.parse(statusDone)).not.toThrow();
    expect(statusDone.state).toBe("succeeded");
    expect(statusDone.failure).toBeNull();
    expect(statusDone.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    const snapId = statusDone.snapshot!.snapshotId;
    expect(simulator.backupState.snapshots("site_ipc_1")).toEqual([snapId]);

    // 4. forget (removes snapshot + missing id ignored)
    const forgetRes = await client.backups({
      action: "forget",
      jobId: FORGET_1,
      siteId: "site_ipc_1",
      target: VALID_TARGET,
      snapshotIds: [snapId, SNAP_DUMMY],
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.forget.parse(forgetRes)).not.toThrow();
    expect(forgetRes).toEqual({
      jobId: FORGET_1,
      state: "running",
      failure: null,
      snapshot: null,
    });

    const forgetStatus = await client.backups({ action: "status", jobId: FORGET_1 });
    expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(forgetStatus)).not.toThrow();
    expect(forgetStatus).toEqual({
      jobId: FORGET_1,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(simulator.backupState.snapshots("site_ipc_1")).toEqual([]);

    // 5. simulateRestart -> status answers unknown
    simulator.backupState.simulateRestart();
    const afterRestart = await client.backups({ action: "status", jobId: JOB_1 });
    expect(() => BACKUPS_RESULT_SCHEMAS.status.parse(afterRestart)).not.toThrow();
    expect(afterRestart).toEqual({
      jobId: JOB_1,
      state: "unknown",
      failure: null,
      snapshot: null,
    });
  });

  it("refuses extra keys, loopback endpoints, uppercase region, bad jobId, 101 snapshotIds, and secret with space before reaching the adapter", async () => {
    const { simulator, client, rawPost } = await createLoopbackHarness();
    const backupsSpy = vi.spyOn(simulator, "backups");

    const invalidCases: Array<{ readonly label: string; readonly body: Record<string, unknown> }> = [
      {
        label: "extra top-level key",
        body: { action: "test", target: VALID_TARGET, unexpectedKey: "nope" },
      },
      {
        label: "extra target key",
        body: { action: "test", target: { ...VALID_TARGET, extraTargetKey: "nope" } },
      },
      {
        label: "loopback localhost",
        body: { action: "test", target: { ...VALID_TARGET, endpoint: "http://localhost:9000" } },
      },
      {
        label: "loopback 127.0.0.1",
        body: { action: "test", target: { ...VALID_TARGET, endpoint: "http://127.0.0.1:9000" } },
      },
      {
        label: "loopback [::1]",
        body: { action: "test", target: { ...VALID_TARGET, endpoint: "http://[::1]:9000" } },
      },
      {
        label: "uppercase region",
        body: { action: "test", target: { ...VALID_TARGET, region: "US-EAST-1" } },
      },
      {
        label: "bad jobId on status",
        body: { action: "status", jobId: "not-a-job-id" },
      },
      {
        label: "-forget jobId on start",
        body: {
          action: "start",
          jobId: FORGET_1,
          siteId: "site_ipc_1",
          serviceInstanceId: "svc_ipc_1",
          target: VALID_TARGET,
        },
      },
      {
        label: "101 snapshot ids on forget",
        body: {
          action: "forget",
          jobId: FORGET_1,
          siteId: "site_ipc_1",
          target: VALID_TARGET,
          snapshotIds: Array.from({ length: 101 }, () => SNAP_DUMMY),
        },
      },
      {
        label: "secretAccessKey containing whitespace",
        body: {
          action: "test",
          target: { ...VALID_TARGET, secretAccessKey: SENTINEL_SPACE_SECRET },
        },
      },
    ];

    for (const item of invalidCases) {
      const raw = await rawPost("/v1/backups", item.body);
      expect(raw.status, item.label).toBe(400);
      expect((JSON.parse(raw.text) as { error: { code: string } }).error.code, item.label).toBe(
        "VALIDATION_ERROR",
      );

      const clientErr = await client
        .backups(item.body as never)
        .catch((e: unknown) => e);
      expect(clientErr, item.label).toBeInstanceOf(ExecutorIpcClientError);
      expect((clientErr as ExecutorIpcClientError).code, item.label).toBe("VALIDATION_ERROR");
      expect((clientErr as ExecutorIpcClientError).statusCode, item.label).toBe(400);
    }

    expect(backupsSpy).not.toHaveBeenCalled();
  });

  it("refuses hostile local targets, widened job ids and localInit abuse before reaching the adapter", async () => {
    const { simulator, client, rawPost } = await createLoopbackHarness();
    const backupsSpy = vi.spyOn(simulator, "backups");
    const LOCAL = { kind: "local", targetId: `bkt_${"1".repeat(32)}` };
    const start = { action: "start", jobId: JOB_1, siteId: "site_ipc_1", serviceInstanceId: "svc_ipc_1" };

    const invalidCases: Array<{ readonly label: string; readonly body: Record<string, unknown> }> = [
      { label: "local target with a root path", body: { action: "test", target: { ...LOCAL, root: "/etc" } } },
      { label: "local target with a path key", body: { ...start, target: { ...LOCAL, path: "/srv" } } },
      { label: "local target carrying S3 secret", body: { action: "test", target: { ...LOCAL, secretAccessKey: SENTINEL_SECRET } } },
      { label: "S3 object tagged kind local", body: { action: "test", target: { ...VALID_TARGET, kind: "local" } } },
      { label: "local target id traversal", body: { action: "test", target: { kind: "local", targetId: "bkt_../../etc" } } },
      { label: "local target id upper-case hex", body: { action: "test", target: { kind: "local", targetId: `bkt_${"A".repeat(32)}` } } },
      { label: "local target without id", body: { action: "forget", jobId: FORGET_1, siteId: "site_ipc_1", snapshotIds: [SNAP_DUMMY], target: { kind: "local" } } },
      { label: "localInit with an S3 target", body: { action: "localInit", target: VALID_TARGET } },
      { label: "localInit with a root", body: { action: "localInit", target: { ...LOCAL, root: "/etc" } } },
      { label: "localInit without target", body: { action: "localInit" } },
      { label: "localInit extra key", body: { action: "localInit", target: LOCAL, force: true } },
      { label: "-t2-forget job id (wrong order)", body: { action: "status", jobId: `${JOB_1}-t2-forget` } },
      { label: "-t3 job id", body: { action: "status", jobId: `${JOB_1}-t3` } },
      { label: "-forget job id on start", body: { ...start, jobId: FORGET_1, target: LOCAL } },
      { label: "-t2 job id on restore", body: { action: "restore", jobId: `${JOB_1}-t2`, siteId: "site_ipc_1", serviceInstanceId: "svc_ipc_1", target: LOCAL, snapshotId: SNAP_DUMMY } },
      { label: "-t2 job id on archive", body: { action: "archive", jobId: `${JOB_1}-t2`, siteId: "site_ipc_1", target: LOCAL, snapshotId: SNAP_DUMMY } },
    ];
    for (const item of invalidCases) {
      const raw = await rawPost("/v1/backups", item.body);
      expect(raw.status, item.label).toBe(400);
      expect((JSON.parse(raw.text) as { error: { code: string } }).error.code, item.label).toBe("VALIDATION_ERROR");
      expect(raw.text, item.label).not.toContain(SENTINEL_SECRET);
      const err = await client.backups(item.body as never).catch((e: unknown) => e);
      expect(err, item.label).toBeInstanceOf(ExecutorIpcClientError);
      expect((err as ExecutorIpcClientError).code, item.label).toBe("VALIDATION_ERROR");
    }
    expect(backupsSpy).not.toHaveBeenCalled();
  });

  it("gives localInit the same 40 s budget as test and keeps the other actions at 30 s", async () => {
    const { client } = await createLoopbackHarness();
    const budgets = new Map<string, number | undefined>();
    const original = http.request.bind(http);
    let current = "";
    vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, cb: never) => {
      budgets.set(current, options.timeout);
      return original(options, cb);
    }) as typeof http.request);
    const LOCAL = { kind: "local", targetId: `bkt_${"1".repeat(32)}` } as const;
    for (const req of [
      { action: "test", target: VALID_TARGET },
      { action: "localInit", target: LOCAL },
      { action: "status", jobId: JOB_1 },
    ] as const) {
      current = req.action;
      await client.backups(req).catch(() => undefined);
    }
    expect(budgets.get("test")).toBe(40_000);
    expect(budgets.get("localInit")).toBe(40_000);
    expect(budgets.get("status")).toBe(30_000);
  });

  it("never leaks secretAccessKey in any HTTP response or log line across success and failure paths", async () => {
    const { simulator, rawPost } = await createLoopbackHarness();
    const capturedLogs: string[] = [];
    const httpBodies: string[] = [];

    const capture = (...args: unknown[]): boolean => {
      capturedLogs.push(args.map(String).join(" "));
      return true;
    };

    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "debug").mockImplementation(capture),
      vi.spyOn(process.stdout, "write").mockImplementation(capture),
      vi.spyOn(process.stderr, "write").mockImplementation(capture),
    ];

    try {
      const sendAndRecord = async (body: unknown, key = SIGNING_KEY) => {
        const res = await rawPost("/v1/backups", body, key);
        httpBodies.push(res.text);
        return res;
      };

      // Successful test + start + status + forget
      expect((await sendAndRecord({ action: "test", target: VALID_TARGET })).status).toBe(200);
      simulator.backupState.failNext("auth_failed");
      expect((await sendAndRecord({ action: "test", target: VALID_TARGET })).status).toBe(200);

      simulator.backupState.holdJobs(true);
      expect(
        (
          await sendAndRecord({
            action: "start",
            jobId: JOB_1,
            siteId: "site_leak_1",
            serviceInstanceId: "svc_leak_1",
            target: VALID_TARGET,
          })
        ).status,
      ).toBe(200);

      // 409 RESOURCE_LOCKED
      expect(
        (
          await sendAndRecord({
            action: "start",
            jobId: JOB_2,
            siteId: "site_leak_1",
            serviceInstanceId: "svc_leak_1",
            target: VALID_TARGET,
          })
        ).status,
      ).toBe(409);

      simulator.backupState.finishHeld();
      const settled = await sendAndRecord({ action: "status", jobId: JOB_1 });
      expect(settled.status).toBe(200);
      const snapId = (
        JSON.parse(settled.text) as { data: { snapshot: { snapshotId: string } } }
      ).data.snapshot.snapshotId;

      expect(
        (
          await sendAndRecord({
            action: "forget",
            jobId: FORGET_1,
            siteId: "site_leak_1",
            target: VALID_TARGET,
            snapshotIds: [snapId],
          })
        ).status,
      ).toBe(200);
      expect((await sendAndRecord({ action: "status", jobId: FORGET_1 })).status).toBe(200);

      // 400 VALIDATION_ERROR cases with sentinels
      expect(
        (
          await sendAndRecord({
            action: "test",
            target: { ...VALID_TARGET, secretAccessKey: SENTINEL_SPACE_SECRET },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await sendAndRecord({
            action: "test",
            target: { ...VALID_TARGET, endpoint: "http://127.0.0.1:9000" },
          })
        ).status,
      ).toBe(400);

      // 401 bad signature
      expect(
        (
          await sendAndRecord(
            { action: "test", target: VALID_TARGET },
            {
              keyId: "hmac-v1",
              algorithm: "hmac-sha256",
              secret: "wrong-hmac-secret-0123456789abcdef0123456789abcdef",
            },
          )
        ).status,
      ).toBe(401);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    const combinedHttp = httpBodies.join("\n");
    const combinedLogs = capturedLogs.join("\n");
    expect(combinedHttp).not.toContain(SENTINEL_SECRET);
    expect(combinedHttp).not.toContain(SENTINEL_SPACE_SECRET);
    expect(combinedLogs).not.toContain(SENTINEL_SECRET);
    expect(combinedLogs).not.toContain(SENTINEL_SPACE_SECRET);
  });

  it("round-trips restore, archive, readArchive, discardArchive, settle, full SITE_FILE_CHUNK_BYTES chunks, and coded errors", async () => {
    const { simulator, client } = await createLoopbackHarness();
    const JOB_3 = `op_${"c".repeat(32)}`;
    const JOB_4 = `op_${"d".repeat(32)}`;

    // Seed a snapshot via start + status.
    await client.backups({
      action: "start",
      jobId: JOB_1,
      siteId: "site_m3b_1",
      serviceInstanceId: "svc_m3b_1",
      target: VALID_TARGET,
    });
    const startDone = await client.backups({ action: "status", jobId: JOB_1 });
    expect(startDone.state).toBe("succeeded");
    const snapshotId = startDone.snapshot!.snapshotId;

    // 1. restore + settle round trips
    const restoreStarted = await client.backups({
      action: "restore",
      jobId: JOB_2,
      siteId: "site_m3b_1",
      serviceInstanceId: "svc_m3b_1",
      target: VALID_TARGET,
      snapshotId,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.restore.parse(restoreStarted)).not.toThrow();
    expect(restoreStarted.state).toBe("running");

    const restoreSettled = await client.backups({ action: "settle", jobId: JOB_2 });
    expect(() => BACKUPS_RESULT_SCHEMAS.settle.parse(restoreSettled)).not.toThrow();
    expect(restoreSettled).toEqual({
      jobId: JOB_2,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });

    // 2. archive held -> RESOURCE_LOCKED archive_preparing -> finishHeld -> status archive metadata
    simulator.backupState.holdJobs(true);
    const archiveStarted = await client.backups({
      action: "archive",
      jobId: JOB_3,
      siteId: "site_m3b_1",
      target: VALID_TARGET,
      snapshotId,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.archive.parse(archiveStarted)).not.toThrow();
    expect(archiveStarted.state).toBe("running");

    const preparingErr = await client
      .backups({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 })
      .catch((e: unknown) => e);
    expect(preparingErr).toBeInstanceOf(ExecutorIpcClientError);
    expect((preparingErr as ExecutorIpcClientError).code).toBe("RESOURCE_LOCKED");
    expect((preparingErr as ExecutorIpcClientError).statusCode).toBe(409);
    expect((preparingErr as ExecutorIpcClientError).message).toBe("archive_preparing");

    simulator.backupState.finishHeld();
    const archiveReady = await client.backups({ action: "status", jobId: JOB_3 });
    expect(() => BACKUPS_RESULT_SCHEMAS.archive.parse(archiveReady)).not.toThrow();
    expect(archiveReady.state).toBe("succeeded");
    expect(archiveReady.archive?.sizeBytes).toBe(1_048_577);

    // 3. readArchive with full SITE_FILE_CHUNK_BYTES chunks passes server & client size limits
    const c1 = await client.backups({
      action: "readArchive",
      jobId: JOB_3,
      offset: 0,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.readArchive.parse(c1)).not.toThrow();
    expect(Buffer.from(c1.dataBase64, "base64").length).toBe(SITE_FILE_CHUNK_BYTES);
    expect(c1.size).toBe(1_048_577);
    expect(c1.eof).toBe(false);

    const c2 = await client.backups({
      action: "readArchive",
      jobId: JOB_3,
      offset: SITE_FILE_CHUNK_BYTES,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.readArchive.parse(c2)).not.toThrow();
    expect(Buffer.from(c2.dataBase64, "base64").length).toBe(SITE_FILE_CHUNK_BYTES);
    expect(c2.eof).toBe(false);

    const c3 = await client.backups({
      action: "readArchive",
      jobId: JOB_3,
      offset: SITE_FILE_CHUNK_BYTES * 2,
      length: SITE_FILE_CHUNK_BYTES,
    });
    expect(() => BACKUPS_RESULT_SCHEMAS.readArchive.parse(c3)).not.toThrow();
    expect(Buffer.from(c3.dataBase64, "base64").length).toBe(1);
    expect(c3.eof).toBe(true);

    // 4. discardArchive + NOT_FOUND archive_gone
    const discardedFirst = await client.backups({ action: "discardArchive", jobId: JOB_3 });
    expect(() => BACKUPS_RESULT_SCHEMAS.discardArchive.parse(discardedFirst)).not.toThrow();
    expect(discardedFirst).toEqual({ discarded: true });

    const discardedSecond = await client.backups({ action: "discardArchive", jobId: JOB_3 });
    expect(discardedSecond).toEqual({ discarded: false });

    for (const deadJob of [JOB_3, JOB_4]) {
      const goneErr = await client
        .backups({ action: "readArchive", jobId: deadJob, offset: 0, length: 64 })
        .catch((e: unknown) => e);
      expect(goneErr).toBeInstanceOf(ExecutorIpcClientError);
      expect((goneErr as ExecutorIpcClientError).code).toBe("NOT_FOUND");
      expect((goneErr as ExecutorIpcClientError).statusCode).toBe(404);
      expect((goneErr as ExecutorIpcClientError).message).toBe("archive_gone");
    }
  });

  it("rejects malformed M3b requests (extra keys, invalid jobId/snapshotId, invalid readArchive bounds)", async () => {
    const { simulator, rawPost } = await createLoopbackHarness();
    const backupsSpy = vi.spyOn(simulator, "backups");

    const invalidPayloads: unknown[] = [
      // Extra keys
      {
        action: "restore",
        jobId: JOB_1,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: SNAP_DUMMY,
        extra: true,
      },
      {
        action: "archive",
        jobId: JOB_1,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotId: SNAP_DUMMY,
        extra: 1,
      },
      { action: "readArchive", jobId: JOB_1, offset: 0, length: 64, extra: "x" },
      { action: "discardArchive", jobId: JOB_1, extra: "x" },
      { action: "settle", jobId: JOB_1, extra: "x" },
      // Invalid jobIds (not op_ + 32 lowercase hex digits)
      {
        action: "restore",
        jobId: FORGET_1,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: SNAP_DUMMY,
      },
      {
        action: "archive",
        jobId: `${JOB_1}-archive`,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotId: SNAP_DUMMY,
      },
      { action: "readArchive", jobId: `op_${"A".repeat(32)}`, offset: 0, length: 64 },
      { action: "discardArchive", jobId: `op_${"a".repeat(31)}` },
      { action: "settle", jobId: "not-an-op-id" },
      // Invalid snapshotId
      {
        action: "restore",
        jobId: JOB_1,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId: "c".repeat(63),
      },
      {
        action: "archive",
        jobId: JOB_1,
        siteId: "site_a",
        target: VALID_TARGET,
        snapshotId: "C".repeat(64),
      },
      // Invalid readArchive length & offset
      { action: "readArchive", jobId: JOB_1, offset: 0, length: 0 },
      { action: "readArchive", jobId: JOB_1, offset: 0, length: SITE_FILE_CHUNK_BYTES + 1 },
      { action: "readArchive", jobId: JOB_1, offset: -1, length: 64 },
    ];

    for (const payload of invalidPayloads) {
      const res = await rawPost("/v1/backups", payload);
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.text) as { error: { code: string } };
      expect(parsed.error.code).toBe("VALIDATION_ERROR");
    }

    expect(backupsSpy).not.toHaveBeenCalled();
  });

  it("never leaks secretAccessKey in HTTP responses or logs across M3b actions", async () => {
    const { simulator, rawPost } = await createLoopbackHarness();
    const JOB_3 = `op_${"c".repeat(32)}`;
    const JOB_4 = `op_${"d".repeat(32)}`;
    const capturedLogs: string[] = [];
    const httpBodies: string[] = [];

    const capture = (...args: unknown[]): boolean => {
      capturedLogs.push(args.map(String).join(" "));
      return true;
    };

    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "debug").mockImplementation(capture),
      vi.spyOn(process.stdout, "write").mockImplementation(capture),
      vi.spyOn(process.stderr, "write").mockImplementation(capture),
    ];

    try {
      const sendAndRecord = async (body: unknown, key = SIGNING_KEY) => {
        const res = await rawPost("/v1/backups", body, key);
        httpBodies.push(res.text);
        return res;
      };

      expect(
        (
          await sendAndRecord({
            action: "start",
            jobId: JOB_1,
            siteId: "site_m3b_leak",
            serviceInstanceId: "svc_m3b_leak",
            target: VALID_TARGET,
          })
        ).status,
      ).toBe(200);
      const startDone = await sendAndRecord({ action: "status", jobId: JOB_1 });
      const snapId = (
        JSON.parse(startDone.text) as { data: { snapshot: { snapshotId: string } } }
      ).data.snapshot.snapshotId;

      expect(
        (
          await sendAndRecord({
            action: "restore",
            jobId: JOB_2,
            siteId: "site_m3b_leak",
            serviceInstanceId: "svc_m3b_leak",
            target: VALID_TARGET,
            snapshotId: snapId,
          })
        ).status,
      ).toBe(200);
      expect((await sendAndRecord({ action: "settle", jobId: JOB_2 })).status).toBe(200);

      simulator.backupState.holdJobs(true);
      expect(
        (
          await sendAndRecord({
            action: "archive",
            jobId: JOB_3,
            siteId: "site_m3b_leak",
            target: VALID_TARGET,
            snapshotId: snapId,
          })
        ).status,
      ).toBe(200);
      expect(
        (await sendAndRecord({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 })).status,
      ).toBe(409);
      simulator.backupState.finishHeld();
      expect((await sendAndRecord({ action: "status", jobId: JOB_3 })).status).toBe(200);
      expect(
        (await sendAndRecord({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 })).status,
      ).toBe(200);
      expect((await sendAndRecord({ action: "discardArchive", jobId: JOB_3 })).status).toBe(200);
      expect(
        (await sendAndRecord({ action: "readArchive", jobId: JOB_3, offset: 0, length: 64 })).status,
      ).toBe(404);

      expect(
        (
          await sendAndRecord({
            action: "restore",
            jobId: JOB_4,
            siteId: "site_m3b_leak",
            serviceInstanceId: "svc_m3b_leak",
            target: { ...VALID_TARGET, secretAccessKey: SENTINEL_SPACE_SECRET },
            snapshotId: snapId,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await sendAndRecord(
            {
              action: "archive",
              jobId: JOB_4,
              siteId: "site_m3b_leak",
              target: VALID_TARGET,
              snapshotId: snapId,
            },
            {
              keyId: "hmac-v1",
              algorithm: "hmac-sha256",
              secret: "wrong-hmac-secret-0123456789abcdef0123456789abcdef",
            },
          )
        ).status,
      ).toBe(401);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    const combinedHttp = httpBodies.join("\n");
    const combinedLogs = capturedLogs.join("\n");
    expect(combinedHttp).not.toContain(SENTINEL_SECRET);
    expect(combinedHttp).not.toContain(SENTINEL_SPACE_SECRET);
    expect(combinedLogs).not.toContain(SENTINEL_SECRET);
    expect(combinedLogs).not.toContain(SENTINEL_SPACE_SECRET);
  });

  it("round-trips siteState, panelStart and restore with createVolume, refuses a bad master key, and never leaks it", async () => {
    const { simulator, client, rawPost } = await createLoopbackHarness();
    const backupsSpy = vi.spyOn(simulator, "backups");
    const capturedLogs: string[] = [];
    const capture = (...args: unknown[]): boolean => {
      capturedLogs.push(args.map(String).join(" "));
      return true;
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "debug").mockImplementation(capture),
      vi.spyOn(process.stdout, "write").mockImplementation(capture),
      vi.spyOn(process.stderr, "write").mockImplementation(capture),
    ];
    const panelStart = {
      action: "panelStart",
      jobId: JOB_1,
      target: VALID_TARGET,
      masterKey: SENTINEL_MASTER_KEY,
      retentionDays: 14,
    } as const;
    const httpBodies: string[] = [];
    try {
      const raw = await rawPost("/v1/backups", panelStart);
      httpBodies.push(raw.text);
      expect(raw.status).toBe(200);

      const panelDone = await client.backups(panelStart);
      httpBodies.push(JSON.stringify(panelDone));
      expect(BACKUPS_RESULT_SCHEMAS.panelStart.parse(panelDone).jobId).toBe(JOB_1);
      const panelStatus = await client.backups({ action: "status", jobId: JOB_1 });
      httpBodies.push(JSON.stringify(panelStatus));
      expect(panelStatus.state).toBe("succeeded");
      expect(panelStatus.snapshot?.snapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(simulator.backupState.panelJobIds()).toEqual([JOB_1]);

      // A site with no files volume and no container: restore creates the volume.
      await client.backups({
        action: "start",
        jobId: JOB_2,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
      });
      const snapshotId = (await client.backups({ action: "status", jobId: JOB_2 })).snapshot!
        .snapshotId;
      simulator.backupState.setSiteState("svc_a", { filesVolume: false, container: false });
      const before = await client.backups({
        action: "siteState",
        siteId: "site_a",
        serviceInstanceId: "svc_a",
      });
      expect(BACKUPS_RESULT_SCHEMAS.siteState.parse(before)).toEqual({
        filesVolume: false,
        container: false,
      });
      const JOB_3 = `op_${"e".repeat(32)}`;
      const restore = await client.backups({
        action: "restore",
        jobId: JOB_3,
        siteId: "site_a",
        serviceInstanceId: "svc_a",
        target: VALID_TARGET,
        snapshotId,
        createVolume: true,
      });
      expect(BACKUPS_RESULT_SCHEMAS.restore.parse(restore).state).toBe("running");
      expect(backupsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ createVolume: true }));
      expect((await client.backups({ action: "settle", jobId: JOB_3 })).state).toBe("succeeded");
      expect(
        await client.backups({ action: "siteState", siteId: "site_a", serviceInstanceId: "svc_a" }),
      ).toEqual({ filesVolume: true, container: false });
      const callsBeforeRefusal = backupsSpy.mock.calls.length;

      const refused = await rawPost("/v1/backups", {
        ...panelStart,
        jobId: JOB_2,
        masterKey: `${SENTINEL_MASTER_KEY.slice(0, 63)}A`,
      });
      httpBodies.push(refused.text);
      expect(refused.status).toBe(400);
      expect((JSON.parse(refused.text) as { error: { code: string } }).error.code).toBe(
        "VALIDATION_ERROR",
      );
      expect(backupsSpy).toHaveBeenCalledTimes(callsBeforeRefusal);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    const leakProbe = SENTINEL_MASTER_KEY.slice(0, 63);
    expect(httpBodies.join("\n")).not.toContain(leakProbe);
    expect(capturedLogs.join("\n")).not.toContain(leakProbe);
  });

  it("answers NOT_SUPPORTED from Phase1DisabledDockerExecutor over loopback IPC", async () => {
    const server = new DockerExecutorIpcServer({
      executor: new Phase1DisabledDockerExecutor(),
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "loopback-test",
      runtimeBackend: "disabled",
    });
    cleanupTasks.push(() => server.stop());
    const bound = await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "loopback-test",
      port: bound.port!,
    });

    const err = await client
      .backups({ action: "test", target: VALID_TARGET })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    expect((err as ExecutorIpcClientError).code).toBe("NOT_SUPPORTED");
    expect((err as ExecutorIpcClientError).statusCode).toBe(422);
  });
});
