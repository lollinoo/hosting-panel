import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SFTP_PORT,
  SFTP_IMAGE,
  SFTP_MAX_USERS,
  SFTP_USERNAME_PATTERN,
  SHA512_CRYPT_HASH_PATTERN,
  SftpStatusReportWireSchema,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
  type SftpAccessApplyRequest,
  type SftpAccessUser,
} from "@hosting-panel/contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  SFTP_APPLY_TIMEOUT_MS,
  SFTP_STATUS_TIMEOUT_MS,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-sftp-ipc-test-key";
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

// Published Drepper test vector hashes matching SHA512_CRYPT_HASH_PATTERN.
const VALID_HASH_1 =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const VALID_HASH_ROUNDS =
  "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.";

function makeUser(overrides: Partial<SftpAccessUser> = {}): SftpAccessUser {
  return {
    username: "s1a2b3c4d_web",
    passwordHash: VALID_HASH_1,
    siteId: "site_1",
    serviceInstanceId: "svc_1",
    ...overrides,
  };
}

function rawUnixPost(options: {
  readonly socketPath: string;
  readonly pathWithQuery: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Promise<{ readonly statusCode: number; readonly json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(options.body, "utf8");
    const req = http.request(
      {
        socketPath: options.socketPath,
        method: "POST",
        path: options.pathWithQuery,
        headers: {
          ...options.headers,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(bodyBuf.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function expectIpcValidationError(
  fn: () => Promise<unknown>,
  forbiddenSubstrings: readonly string[] = [],
): Promise<ExecutorIpcClientError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err: unknown) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ExecutorIpcClientError);
  const err = caught as ExecutorIpcClientError;
  expect(err.code).toBe("VALIDATION_ERROR");
  expect(err.statusCode).toBe(400);
  for (const forbidden of forbiddenSubstrings) {
    expect(err.message).not.toContain(forbidden);
  }
  return err;
}

describe("SFTP contracts, IPC routes, client, simulator, and stubs", () => {
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

  async function createHarness() {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const socketPath = path.join(os.tmpdir(), `hp-sftp-ipc-${randomBytes(6).toString("hex")}.sock`);
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "local-simulator",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    return { simulator, server, client, socketPath };
  }

  it("exports expected SFTP runtime constants and client timeouts", () => {
    expect(SFTP_IMAGE).toBe(
      "linuxserver/openssh-server@sha256:161e0b670b31d9539ca1718bc5943e981779331b4e1c9d32e8929d7652a1f22f",
    );
    expect(DEFAULT_SFTP_PORT).toBe(2222);
    expect(SFTP_MAX_USERS).toBe(2000);
    expect(SFTP_APPLY_TIMEOUT_MS).toBe(120_000);
    expect(SFTP_STATUS_TIMEOUT_MS).toBe(10_000);
    expect(SFTP_USERNAME_PATTERN.test("s1a2b3c4d_web")).toBe(true);
    expect(SHA512_CRYPT_HASH_PATTERN.test(VALID_HASH_1)).toBe(true);
    expect(SHA512_CRYPT_HASH_PATTERN.test(VALID_HASH_ROUNDS)).toBe(true);
  });

  it("round-trips applySftpAccess and getSftpStatus over signed UDS IPC", async () => {
    const { simulator, client, socketPath } = await createHarness();

    const initialStatus = await client.getSftpStatus();
    expect(initialStatus).toEqual({
      running: false,
      port: DEFAULT_SFTP_PORT,
      hostKeyFingerprint: null,
    });
    expect(() => SftpStatusReportWireSchema.parse(initialStatus)).not.toThrow();

    const input: SftpAccessApplyRequest = {
      users: [
        makeUser({ username: "s1a2b3c4d_web", passwordHash: VALID_HASH_1 }),
        makeUser({
          username: "s1a2b3c4d_ci",
          passwordHash: VALID_HASH_ROUNDS,
          siteId: "site_1",
          serviceInstanceId: "svc_1",
        }),
        makeUser({
          username: "s9f8e7d6c_admin",
          passwordHash: VALID_HASH_1,
          siteId: "site_2",
          serviceInstanceId: "svc_2",
        }),
      ],
    };

    const applyRes = await client.applySftpAccess(input);
    expect(applyRes).toEqual({ applied: 3 });

    // Mutate caller input and verify simulator stored an independent deep copy.
    input.users[0]!.username = "mutated_user";
    input.users.push(makeUser({ username: "s1a2b3c4d_extra" }));

    expect(simulator.sftpUsers).toHaveLength(3);
    expect(simulator.sftpUsers[0]?.username).toBe("s1a2b3c4d_web");
    expect(simulator.sftpApplies).toHaveLength(1);
    expect(simulator.sftpApplies[0]?.users).toHaveLength(3);
    expect(simulator.sftpApplies[0]?.users[0]?.username).toBe("s1a2b3c4d_web");

    // Empty list is allowed (clears users and returns applied: 0).
    const clearRes = await client.applySftpAccess({ users: [] });
    expect(clearRes).toEqual({ applied: 0 });
    expect(simulator.sftpUsers).toEqual([]);
    expect(simulator.sftpApplies).toHaveLength(2);
    expect(simulator.sftpApplies[1]).toEqual({ users: [] });

    // Verify wire response envelopes directly over signed raw POST.
    const statusBody = "{}";
    const statusHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/sftp/status",
      body: statusBody,
      key: SIGNING_KEY,
    });
    const rawStatus = await rawUnixPost({
      socketPath,
      pathWithQuery: "/v1/sftp/status",
      headers: { ...statusHeaders },
      body: statusBody,
    });
    expect(rawStatus.statusCode).toBe(200);
    expect(rawStatus.json).toEqual({
      data: { running: false, port: DEFAULT_SFTP_PORT, hostKeyFingerprint: null },
    });
  });

  it("deep-copies request inside simulator even on direct adapter calls", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const user = makeUser({ username: "s1a2b3c4d_direct" });
    const req: SftpAccessApplyRequest = { users: [user] };

    const res = await simulator.applySftpAccess(req);
    expect(res).toEqual({ applied: 1 });

    user.username = "mutated_after_call";
    req.users.length = 0;

    expect(simulator.sftpUsers).toHaveLength(1);
    expect(simulator.sftpUsers[0]?.username).toBe("s1a2b3c4d_direct");
    expect(simulator.sftpApplies[0]?.users).toHaveLength(1);
    expect(simulator.sftpApplies[0]?.users[0]?.username).toBe("s1a2b3c4d_direct");
  });

  it("refuses invalid SFTP apply payloads with VALIDATION_ERROR and never logs hashes or bodies", async () => {
    const { simulator, client, socketPath } = await createHarness();
    const applySpy = vi.spyOn(simulator, "applySftpAccess");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // 1. Valid call should not log body or hash.
    await client.applySftpAccess({ users: [makeUser()] });

    // 2. Bad username
    for (const badName of ["Bad_user", "a_x", "s1234567890123456_web", "s1_"]) {
      await expectIpcValidationError(() =>
        client.applySftpAccess({ users: [makeUser({ username: badName })] }),
      );
    }

    // 3. Hash that does not start with $6$ (and malformed $6$ hashes)
    const canarySecret = "CANARY_SECRET_HASH_VALUE_NEVER_LOG";
    const badHashes = [
      `$1$saltstring$${canarySecret}`,
      `$2b$10$${canarySecret}`,
      canarySecret,
      `$6$salt:bad$${"a".repeat(86)}`,
      `$6$saltstring$${"a".repeat(85)}`,
    ];
    for (const badHash of badHashes) {
      await expectIpcValidationError(
        () => client.applySftpAccess({ users: [makeUser({ passwordHash: badHash })] }),
        [canarySecret, "$1$", "$2b$", "$6$"],
      );
    }

    // 4. Duplicate username
    await expectIpcValidationError(() =>
      client.applySftpAccess({
        users: [
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_1", serviceInstanceId: "svc_1" }),
          makeUser({ username: "s1a2b3c4d_dup", siteId: "site_1", serviceInstanceId: "svc_1" }),
        ],
      }),
    );

    // 5. One site with two services
    await expectIpcValidationError(() =>
      client.applySftpAccess({
        users: [
          makeUser({ username: "s1a2b3c4d_one", siteId: "site_1", serviceInstanceId: "svc_1" }),
          makeUser({ username: "s1a2b3c4d_two", siteId: "site_1", serviceInstanceId: "svc_2" }),
        ],
      }),
    );

    // 6. 2001 users (exceeds SFTP_MAX_USERS = 2000), while 2000 users succeeds
    const maxUsers: SftpAccessUser[] = Array.from({ length: SFTP_MAX_USERS }, (_, i) =>
      makeUser({
        username: `s1000000_u${String(i)}`,
        siteId: `site_${String(i)}`,
        serviceInstanceId: `svc_${String(i)}`,
      }),
    );
    await expect(client.applySftpAccess({ users: maxUsers })).resolves.toEqual({
      applied: SFTP_MAX_USERS,
    });

    const tooManyUsers: SftpAccessUser[] = [
      ...maxUsers,
      makeUser({
        username: "s1000000_extra",
        siteId: "site_extra",
        serviceInstanceId: "svc_extra",
      }),
    ];
    await expectIpcValidationError(() => client.applySftpAccess({ users: tooManyUsers }));

    // 6b. Unknown keys on user or request are refused over IPC
    await expectIpcValidationError(() =>
      client.applySftpAccess({
        users: [{ ...makeUser(), password: "secret" } as unknown as SftpAccessUser],
      }),
    );
    await expectIpcValidationError(() =>
      client.applySftpAccess({
        users: [makeUser()],
        extraField: true,
      } as unknown as SftpAccessApplyRequest),
    );

    // 7. /v1/sftp/status rejects non-empty body
    const badStatusBody = JSON.stringify({ unexpected: true });
    const badStatusHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/sftp/status",
      body: badStatusBody,
      key: SIGNING_KEY,
    });
    const rawBadStatus = await rawUnixPost({
      socketPath,
      pathWithQuery: "/v1/sftp/status",
      headers: { ...badStatusHeaders },
      body: badStatusBody,
    });
    expect(rawBadStatus.statusCode).toBe(400);
    expect((rawBadStatus.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");

    // 8. Only the two valid applies reached the simulator.
    expect(applySpy).toHaveBeenCalledTimes(2);

    // 9. Simulator direct calls also validate strictly against SftpAccessApplyIpcRequestSchema.
    await expect(
      simulator.applySftpAccess({
        users: [{ ...makeUser(), extraKey: true } as unknown as SftpAccessUser],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      simulator.applySftpAccess({
        users: [makeUser()],
        extraKey: true,
      } as unknown as SftpAccessApplyRequest),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      simulator.applySftpAccess({
        users: [makeUser({ siteId: "_bad_site" })],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // 10. Server never logged any request body or hash.
    for (const spy of [logSpy, infoSpy, warnSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        const rendered = call.map((a) => String(a)).join(" ");
        expect(rendered).not.toContain(canarySecret);
        expect(rendered).not.toContain(VALID_HASH_1);
        expect(rendered).not.toContain("$6$");
      }
    }
  });

  it("refuses unsigned or bad-signature requests before reaching simulator", async () => {
    const { simulator, socketPath } = await createHarness();
    const applySpy = vi.spyOn(simulator, "applySftpAccess");
    const statusSpy = vi.spyOn(simulator, "getSftpStatus");

    const badClient = new SignedDockerExecutorIpcClient({
      signingKey: {
        keyId: "hmac-v1",
        algorithm: "hmac-sha256",
        secret: "wrong-secret-0123456789abcdef0123456789abcdef",
      },
      transport: "uds",
      socketPath,
    });

    await expect(badClient.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
    await expect(badClient.getSftpStatus()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });

    const rawBody = JSON.stringify({ users: [] });
    const headers = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/sftp/apply",
      body: rawBody,
      key: SIGNING_KEY,
    });
    const tampered = await rawUnixPost({
      socketPath,
      pathWithQuery: "/v1/sftp/apply",
      headers: { ...headers },
      body: JSON.stringify({ users: [makeUser()] }),
    });
    expect(tampered.statusCode).toBe(401);
    expect(applySpy).not.toHaveBeenCalled();
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it("failNextSftpApply fails one apply with DOCKER_ENGINE_UNAVAILABLE then recovers", async () => {
    const { simulator, client } = await createHarness();

    simulator.failNextSftpApply();

    await expect(client.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(simulator.sftpUsers).toEqual([]);
    expect(simulator.sftpApplies).toEqual([]);

    const ok = await client.applySftpAccess({ users: [makeUser()] });
    expect(ok).toEqual({ applied: 1 });
    expect(simulator.sftpUsers).toHaveLength(1);
    expect(simulator.sftpApplies).toHaveLength(1);
  });

  it("never replays mutating SFTP apply on timeout and reports OPERATION_AMBIGUOUS", async () => {
    let seenRequests = 0;
    const socketPath = path.join(
      os.tmpdir(),
      `hp-sftp-timeout-${randomBytes(6).toString("hex")}.sock`,
    );
    const hangingServer = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seenRequests += 1;
        // Intentionally never respond so client times out.
        void res;
      });
    });
    await new Promise<void>((resolve) => hangingServer.listen(socketPath, resolve));
    cleanupTasks.push(
      () =>
        new Promise<void>((resolve) => {
          hangingServer.close(() => resolve());
        }),
    );

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
      timeoutMs: 80,
    });

    let caught: unknown;
    try {
      await client.applySftpAccess({ users: [makeUser()] });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutorIpcClientError);
    expect((caught as ExecutorIpcClientError).code).toBe("OPERATION_AMBIGUOUS");
    expect((caught as ExecutorIpcClientError).ambiguousOutcome).toBe(true);
    expect(seenRequests).toBe(1);
  });

  it("refuses applySftpAccess and getSftpStatus with NOT_SUPPORTED in Phase1DisabledDockerExecutor", async () => {
    const phase1 = new Phase1DisabledDockerExecutor();
    await expect(phase1.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
    await expect(phase1.getSftpStatus()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });

    const socketPath = path.join(os.tmpdir(), `hp-sftp-p1-${randomBytes(6).toString("hex")}.sock`);
    const server = new DockerExecutorIpcServer({
      executor: phase1,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "disabled",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    await expect(client.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      statusCode: 422,
    });
    await expect(client.getSftpStatus()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      statusCode: 422,
    });
  });

  it("reports HOST_POLICY_DENIED or DOCKER_ENGINE_UNAVAILABLE on DockerEngineSocketAdapter when unready", async () => {
    const missingDirAdapter = new DockerEngineSocketAdapter({
      dockerSocketPath: "/tmp/nonexistent-sftp-stub.sock",
      sftpStateDir: `/tmp/nonexistent-sftp-dir-${randomBytes(6).toString("hex")}`,
    });
    await expect(missingDirAdapter.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });

    const tmpStateDir = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-ipc-state-"));
    await chmod(tmpStateDir, 0o700);
    cleanupTasks.push(() => rm(tmpStateDir, { recursive: true, force: true }));
    const unreachableEngineAdapter = new DockerEngineSocketAdapter({
      dockerSocketPath: "/tmp/nonexistent-sftp-stub.sock",
      sftpStateDir: tmpStateDir,
    });
    await expect(unreachableEngineAdapter.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    await expect(unreachableEngineAdapter.getSftpStatus()).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });
});
