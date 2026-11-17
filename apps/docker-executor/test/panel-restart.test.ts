import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PANEL_CONTAINERS, type IpcSigningKey, type IpcVerificationKey, type PanelContainer } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  PANEL_RESTART_STOP_SECONDS,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";
import { type MockDockerContainerRecord, startMockDockerDaemon } from "./mock-docker-daemon.js";

const HMAC_KEY = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "0123456789abcdef0123456789abcdef-m5c-restart" } as const;
const NAMES: Record<PanelContainer, string> = {
  ingress_proxy: "hp_ingress_proxy",
  shared_database: "hp_mariadb",
  phpmyadmin: "hp_phpmyadmin",
  sftp: "hp_sftp",
  mail_relay: "hp_mail_relay",
};

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function record(name: string, extra?: Partial<MockDockerContainerRecord>): MockDockerContainerRecord {
  return {
    id: `${name}_id`, name, image: "example/panel:1", env: [], labels: {}, running: true, status: "running",
    restartCount: 0, hostConfig: {}, networks: {}, ...extra,
  };
}

async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-m5c-restart-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon();
  cleanup.push(() => mockDaemon.close());
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    mailRelaySecretDir: path.join(tmp, "mail"),
    sftpStateDir: path.join(tmp, "sftp"),
    sharedDbDataDir: path.join(tmp, "db"),
    sharedDbRootKeyFile: path.join(tmp, "db.key"),
    phpMyAdminConfigDir: path.join(tmp, "pma"),
    pullMissingImages: false,
  });
  return { adapter, mockDaemon };
}

const restarts = (paths: readonly string[]) => paths.filter((p) => /\/containers\/[^/]+\/restart/.test(p));

describe("restartPanelContainer", () => {
  it("restarts exactly the fixed name of each component with its stop time", async () => {
    const { adapter, mockDaemon } = await setup();
    for (const c of PANEL_CONTAINERS) mockDaemon.containers.set(NAMES[c], record(NAMES[c], { startedAt: "2026-11-17T01:00:00.5Z" }));
    for (const c of PANEL_CONTAINERS) {
      const mark = mockDaemon.requestedPaths.length;
      await expect(adapter.restartPanelContainer({ component: c })).resolves.toEqual({ startedAt: "2026-11-17T01:00:00.500Z" });
      expect(restarts(mockDaemon.requestedPaths.slice(mark)).map((p) => p.replace(/^\/v1\.\d+/, ""))).toEqual([
        `/containers/${NAMES[c]}/restart?t=${String(PANEL_RESTART_STOP_SECONDS[c])}`,
      ]);
    }
    expect(PANEL_RESTART_STOP_SECONDS).toEqual({ ingress_proxy: 5, shared_database: 5, phpmyadmin: 5, sftp: 5, mail_relay: 10 });
  });

  it("a missing container is NOT_FOUND, a daemon error INTERNAL_ERROR, and no Engine text leaks", async () => {
    const { adapter, mockDaemon } = await setup();
    await expect(adapter.restartPanelContainer({ component: "sftp" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    mockDaemon.containers.set("hp_sftp", record("hp_sftp"));
    mockDaemon.failRestarts.remaining = 1;
    const err = (await adapter.restartPanelContainer({ component: "sftp" }).catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(err.message).not.toContain("restart failed");
  });

  it("is RESOURCE_LOCKED while an ensure or apply of that component is in flight", async () => {
    const { adapter, mockDaemon } = await setup();
    for (const c of PANEL_CONTAINERS) mockDaemon.containers.set(NAMES[c], record(NAMES[c]));
    const busy: Record<PanelContainer, () => Promise<unknown>> = {
      ingress_proxy: () => adapter.ensureIngressProxy(),
      shared_database: () => adapter.ensureSharedDatabase(),
      phpmyadmin: () => adapter.ensurePhpMyAdmin({ ifPresent: true }),
      sftp: () => adapter.ensureSftpFromState(),
      mail_relay: () => adapter.applyMailRelay(null),
    };
    for (const c of PANEL_CONTAINERS) {
      const ensure = busy[c]().catch(() => undefined);
      const mark = mockDaemon.requestedPaths.length;
      await expect(adapter.restartPanelContainer({ component: c })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      await ensure;
      expect(restarts(mockDaemon.requestedPaths.slice(mark))).toEqual([]);
    }
  });

  it("a second restart of the same component is RESOURCE_LOCKED, and an ensure waits for a running restart", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.containers.set("hp_mail_relay", record("hp_mail_relay"));
    mockDaemon.containers.set("hp_sftp", record("hp_sftp"));
    let release!: () => void;
    mockDaemon.holdRestarts.until = new Promise<void>((r) => (release = r));
    const restart = adapter.restartPanelContainer({ component: "mail_relay" });
    await expect(adapter.restartPanelContainer({ component: "mail_relay" })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await new Promise((r) => setTimeout(r, 50)); // the restart request is now held by the daemon
    const other = adapter.restartPanelContainer({ component: "sftp" }); // another component is not locked by it
    await new Promise((r) => setTimeout(r, 50));
    const mark = mockDaemon.requestedPaths.length;
    const apply = adapter.applyMailRelay(null);
    await new Promise((r) => setTimeout(r, 100));
    expect(mockDaemon.requestedPaths.slice(mark)).toEqual([]);
    release();
    await restart;
    await apply;
    await expect(other).resolves.toBeDefined();
    expect(mockDaemon.requestedPaths.slice(mark).some((p) => p.includes("/containers/hp_mail_relay/json"))).toBe(true);
  });

  it("a component outside the five never reaches the daemon, directly or over the signed IPC", async () => {
    const { adapter, mockDaemon } = await setup();
    const mark = mockDaemon.requestedPaths.length;
    await expect(adapter.restartPanelContainer({ component: "hp_web" as PanelContainer })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    const server = new DockerExecutorIpcServer({
      executor: adapter,
      keyring: { "hmac-v1": HMAC_KEY as IpcVerificationKey },
      transport: "loopback-test",
    });
    cleanup.push(() => server.stop());
    const bound = await server.start();
    const client = new SignedDockerExecutorIpcClient({ signingKey: HMAC_KEY as IpcSigningKey, transport: "loopback-test", port: bound.port });
    await expect(client.restartPanelContainer({ component: "../hp_web" as PanelContainer })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mockDaemon.requestedPaths.slice(mark)).toEqual([]);
  });
});
