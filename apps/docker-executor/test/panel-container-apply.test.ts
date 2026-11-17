import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAIL_RELAY_IMAGE,
  PHPMYADMIN_IMAGE,
  PINNED_PANEL_CONTAINERS,
  SHARED_MARIADB_IMAGE,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import type { DockerExecutorPort, PinnedPanelContainer } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  PHPMYADMIN_CONFIG_SHA256_LABEL,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";
import { type MockDockerContainerRecord, startMockDockerDaemon } from "./mock-docker-daemon.js";

const KEY = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "0123456789abcdef0123456789abcdef-m5d-apply" } as const;
const TRAEFIK = "example/proxy:9.9.9";
const OLD = "example/older:0.0.1";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0).reverse()) await task();
});

function record(name: string, image: string, extra?: Partial<MockDockerContainerRecord>): MockDockerContainerRecord {
  return {
    id: `${name}_id`, name, image, env: [], labels: {}, running: true, status: "running",
    restartCount: 0, hostConfig: {}, networks: {}, ...extra,
  };
}

async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-m5d-apply-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon();
  cleanup.push(() => mockDaemon.close());
  await mkdir(path.join(tmp, "db"), { recursive: true });
  await writeFile(path.join(tmp, "db.key"), "k".repeat(64));
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    mailRelaySecretDir: path.join(tmp, "mail"),
    sftpStateDir: path.join(tmp, "sftp"),
    sharedDbDataDir: path.join(tmp, "db"),
    sharedDbRootKeyFile: path.join(tmp, "db.key"),
    phpMyAdminConfigDir: path.join(tmp, "pma"),
    executorUid: (process.getuid?.() ?? 1000) + 1,
    pullMissingImages: false,
    traefikImage: TRAEFIK,
  });
  const byName = (name: string) => [...mockDaemon.containers.values()].find((c) => c.name === name);
  return { adapter, mockDaemon, byName };
}

async function ipc(executor: DockerExecutorPort) {
  const server = new DockerExecutorIpcServer({ executor, keyring: { [KEY.keyId]: KEY as IpcVerificationKey }, transport: "loopback-test" });
  cleanup.push(() => server.stop());
  const { port } = await server.start();
  const client = new SignedDockerExecutorIpcClient({ signingKey: KEY as IpcSigningKey, transport: "loopback-test", port });
  const raw = async (body: unknown) => {
    const text = JSON.stringify(body);
    const headers = signIpcRequest({ method: "POST", pathWithQuery: "/v1/panel/apply", body: text, key: KEY as IpcSigningKey });
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/panel/apply`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: text,
    });
    return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
  };
  return { client, raw };
}

describe("imageCurrent in getPanelContainers", () => {
  it("compares the image each container was created from with its pin; a missing one is null", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.containers.set("i", record("hp_ingress_proxy", TRAEFIK));
    mockDaemon.containers.set("d", record("hp_mariadb", SHARED_MARIADB_IMAGE));
    mockDaemon.containers.set("s", record("hp_sftp", OLD));
    mockDaemon.containers.set("m", record("hp_mail_relay", MAIL_RELAY_IMAGE));
    const rows = await adapter.getPanelContainers();
    expect(rows.map((r) => [r.component, r.imageCurrent])).toEqual([
      ["ingress_proxy", true],
      ["shared_database", true],
      ["phpmyadmin", null],
      ["sftp", false],
      ["mail_relay", true],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/example\/|mariadb:|sha256/);
  });
});

describe("applyPanelContainerPin on the fake daemon", () => {
  it("recreates the shared database and phpMyAdmin created from an older image and answers imageCurrent true", async () => {
    const { adapter, byName } = await setup();
    await adapter.ensureSharedDatabase();
    await adapter.ensurePhpMyAdmin();
    for (const [name, label, component] of [
      ["hp_mariadb", SHARED_DB_CONFIG_SHA256_LABEL, "shared_database"],
      ["hp_phpmyadmin", PHPMYADMIN_CONFIG_SHA256_LABEL, "phpmyadmin"],
    ] as const) {
      const before = byName(name)!;
      // What an executor of an older release left: another image, and the hash of that older payload.
      before.image = OLD;
      before.labels[label] = "0".repeat(64);
      expect((await adapter.getPanelContainers()).find((r) => r.component === component)?.imageCurrent).toBe(false);
      const answer = await adapter.applyPanelContainerPin(component);
      expect(answer).toMatchObject({ component, state: "running", imageCurrent: true });
      expect(byName(name)?.id).not.toBe(before.id);
      expect(byName(name)?.image).toBe(component === "phpmyadmin" ? PHPMYADMIN_IMAGE : SHARED_MARIADB_IMAGE);
      expect(JSON.stringify(answer)).not.toMatch(/example\/|sha256|_id/);
    }
  });

  it("maps each pinned name to its shipped ensure, and a missing container is NOT_FOUND with nothing ensured", async () => {
    const { adapter, mockDaemon } = await setup();
    const ensures = {
      ingress_proxy: vi.spyOn(adapter, "ensureIngressProxy").mockResolvedValue({} as never),
      shared_database: vi.spyOn(adapter, "ensureSharedDatabase").mockResolvedValue({} as never),
      phpmyadmin: vi.spyOn(adapter, "ensurePhpMyAdmin").mockResolvedValue(undefined),
      sftp: vi.spyOn(adapter, "ensureSftpFromState").mockResolvedValue(null),
    };
    for (const c of PINNED_PANEL_CONTAINERS) {
      await expect(adapter.applyPanelContainerPin(c)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    for (const spy of Object.values(ensures)) expect(spy).not.toHaveBeenCalled();
    for (const name of ["hp_ingress_proxy", "hp_mariadb", "hp_phpmyadmin", "hp_sftp"]) {
      mockDaemon.containers.set(name, record(name, OLD));
    }
    for (const c of PINNED_PANEL_CONTAINERS) {
      await expect(adapter.applyPanelContainerPin(c)).resolves.toMatchObject({ component: c });
      expect(ensures[c]).toHaveBeenCalledTimes(1);
    }
    expect(ensures.phpmyadmin).toHaveBeenCalledWith({ ifPresent: true });
  });
});

describe("the apply route", () => {
  it("takes only one of the four pinned names: mail_relay, an unknown name or any other key never reaches the daemon", async () => {
    const { adapter, mockDaemon } = await setup();
    const { client, raw } = await ipc(adapter);
    const mark = mockDaemon.requestedPaths.length;
    await expect(adapter.applyPanelContainerPin("mail_relay" as PinnedPanelContainer)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(client.applyPanelContainerPin("../hp_web" as PinnedPanelContainer)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    for (const body of [
      { component: "mail_relay" },
      { component: "sftp", image: OLD },
      { component: "sftp", tag: "latest" },
      { component: ["sftp"] },
      {},
    ]) {
      const res = await raw(body);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
    }
    expect(mockDaemon.requestedPaths.slice(mark)).toEqual([]);
  });

  it("over the signed IPC with the simulator: true by default, false by the hook, true after apply; missing is NOT_FOUND", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const { client } = await ipc(sim);
    expect((await client.getPanelContainers()).map((r) => r.imageCurrent)).toEqual([true, true, null, null, null]);
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    expect((await client.getPanelContainers())[1]?.imageCurrent).toBe(false);
    await expect(client.applyPanelContainerPin("shared_database")).resolves.toEqual({
      component: "shared_database", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true,
    });
    expect((await client.getPanelContainers())[1]?.imageCurrent).toBe(true);
    await expect(client.applyPanelContainerPin("phpmyadmin")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
