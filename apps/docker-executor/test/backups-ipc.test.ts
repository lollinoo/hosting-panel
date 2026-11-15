import { randomBytes } from "node:crypto";
import {
  BACKUPS_RESULT_SCHEMAS,
  BackupJobStatusSchema,
  BackupTestResultSchema,
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
