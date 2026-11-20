import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcSigningKey, IpcVerificationKey } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-phase2-ipc-key";
const HMAC_SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const HMAC_VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const SERVICE_ID = "svc_restart_1";

describe("service restart secrets over IPC (#7)", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  async function startIpc(simulator: InMemoryDockerSimulatorAdapter): Promise<SignedDockerExecutorIpcClient> {
    const socketPath = `/tmp/hp-exec-test-${randomBytes(5).toString("hex")}.sock`;
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "local-simulator",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();
    return new SignedDockerExecutorIpcClient({ signingKey: HMAC_SIGNING_KEY, transport: "uds", socketPath });
  }

  async function deploy(client: SignedDockerExecutorIpcClient): Promise<void> {
    const spec = createApprovedServiceSpec({
      serviceInstanceId: SERVICE_ID,
      siteId: "site_restart_1",
      organizationId: "org_1",
      image: "nginx:1.27-alpine",
      containerName: "hp-svc-restart-1",
      env: { APP_ENV: "production" },
      revisionNumber: 1,
      specHash: "sha256_rev1_hash",
      domains: ["restart.example.test"],
      exposeHttp: true,
      internalPort: 80,
      resolvedSecrets: { DB_PASSWORD: "pw" },
    });
    expect((await client.deployService(spec)).status).toBe("succeeded");
  }

  it("a restart over IPC carries the secrets and the simulator writes them again after a stop", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-restart-secrets-"));
    cleanupTasks.push(() => rm(tmpDir, { recursive: true, force: true }));
    const secretsRootDir = path.join(tmpDir, "secrets");
    const client = await startIpc(new InMemoryDockerSimulatorAdapter({ secretsRootDir }));
    const secretFile = path.join(secretsRootDir, SERVICE_ID, "DB_PASSWORD");

    await deploy(client);
    await client.stopService(SERVICE_ID);
    await expect(lstat(secretFile)).rejects.toThrow();

    const res = await client.restartService(SERVICE_ID, { DB_PASSWORD: "pw" });
    expect(res.containerStatus).toBe("running");
    const st = await lstat(secretFile);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o444);
    expect(await readFile(secretFile, "utf8")).toBe("pw");
  });

  it("a restart over IPC without secrets passes none to the executor", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const client = await startIpc(simulator);
    await deploy(client);
    const spy = vi.spyOn(simulator, "restartService");

    await client.restartService(SERVICE_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("the in-memory simulator knows the secret names again after stop and restart", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const client = await startIpc(simulator);
    await deploy(client);

    await client.stopService(SERVICE_ID);
    expect(simulator.hasActiveVirtualSecret(SERVICE_ID)).toBe(false);

    await client.restartService(SERVICE_ID, { DB_PASSWORD: "pw" });
    expect(simulator.hasActiveVirtualSecret(SERVICE_ID, "DB_PASSWORD")).toBe(true);
  });
});
