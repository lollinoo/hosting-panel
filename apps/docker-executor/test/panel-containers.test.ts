import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PANEL_CONTAINERS, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  MAIL_RELAY_SASL_FILE,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SignedDockerExecutorIpcClient,
  buildHardenedContainerCreatePayload,
  buildSharedDatabaseContainerPayload,
} from "../src/index.js";
import { maskPhpMyAdminQuery } from "../src/docker-logs.js";
import { type MockDockerContainerRecord, startMockDockerDaemon } from "./mock-docker-daemon.js";

const HMAC_KEY = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "0123456789abcdef0123456789abcdef-m5h-ipc-key" } as const;
const ROTATION = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };
const DOCKER_ID = "d0c4e11d".repeat(8);

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0).reverse()) {
    await task();
  }
});

function record(name: string, extra: Partial<MockDockerContainerRecord>): MockDockerContainerRecord {
  return {
    id: DOCKER_ID,
    name,
    image: "example/panel:1",
    env: [],
    labels: {},
    running: true,
    status: "running",
    restartCount: 0,
    hostConfig: {},
    networks: {},
    ...extra,
  };
}

/** One docker log frame: 1 = stdout, 2 = stderr. */
function frame(text: string, stream = 1): Buffer {
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([head, Buffer.from(text)]);
}

async function setup(options?: Parameters<typeof startMockDockerDaemon>[0]) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-m5h-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon(options);
  cleanup.push(() => mockDaemon.close());
  const mailDir = path.join(tmp, "mail");
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    mailRelaySecretDir: mailDir,
    sftpStateDir: path.join(tmp, "sftp"),
  });
  return { adapter, mockDaemon, mailDir };
}

async function ipc(executor: DockerEngineSocketAdapter | InMemoryDockerSimulatorAdapter) {
  const server = new DockerExecutorIpcServer({
    executor,
    keyring: { "hmac-v1": HMAC_KEY as IpcVerificationKey },
    transport: "loopback-test",
  });
  cleanup.push(() => server.stop());
  const bound = await server.start();
  return new SignedDockerExecutorIpcClient({
    signingKey: HMAC_KEY as IpcSigningKey,
    transport: "loopback-test",
    port: bound.port,
  });
}

describe("getPanelContainers", () => {
  it("always five rows in contract order; missing is a state, not an error", async () => {
    const { adapter, mockDaemon, mailDir } = await setup();
    mockDaemon.containers.set("a", record("hp_mariadb", { startedAt: "2026-11-16T10:00:00.123456789Z", restartCount: 2 }));
    mockDaemon.containers.set("b", record("hp_sftp", { startedAt: "0001-01-01T00:00:00Z", dead: true, running: false }));
    const rows = await adapter.getPanelContainers();
    expect(rows.map((r) => r.component)).toEqual([...PANEL_CONTAINERS]);
    expect(rows).toEqual([
      { component: "ingress_proxy", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
      { component: "shared_database", state: "running", expected: true, startedAt: "2026-11-16T10:00:00.123Z", restartCount: 2, imageCurrent: false },
      { component: "phpmyadmin", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
      { component: "sftp", state: "degraded", expected: false, startedAt: null, restartCount: 0, imageCurrent: false },
      { component: "mail_relay", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain(DOCKER_ID);

    await mkdir(mailDir, { recursive: true });
    await writeFile(path.join(mailDir, MAIL_RELAY_SASL_FILE), "sentinel");
    const after = await adapter.getPanelContainers();
    expect(after.find((r) => r.component === "mail_relay")?.expected).toBe(true);
  });

  it("an Engine that answers 500 or not at all is DOCKER_ENGINE_UNAVAILABLE", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.failInspects.remaining = 1;
    await expect(adapter.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    const gone = new DockerEngineSocketAdapter({ dockerSocketPath: `/tmp/hp-m5h-absent-${String(process.pid)}.sock` });
    await expect(gone.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    await expect(gone.getPanelContainerLogs({ component: "sftp", tail: 5 })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });
});

describe("getPanelContainerLogs", () => {
  const pmaLine =
    '2026-11-16T10:00:00.000000000Z 172.30.0.1 - u [16/Nov/2026] "GET /index.php?route=/sql&db=wp&token=MADEUPTOKEN123&sql_query=SELECT+1 HTTP/1.0" 200 512 "http://x/phpmyadmin/s1/?token=MADEUPTOKEN123&sql_query=DROP" "agent"\n';
  const logsBodyFn = (ref: string) =>
    frame(ref === "hp_phpmyadmin" ? pmaLine : "2026-11-16T10:00:00Z db ready?a=b\n", 2);

  it("reads by name with tail, masks phpMyAdmin query strings only", async () => {
    const { adapter, mockDaemon } = await setup({ logsBodyFn });
    mockDaemon.containers.set("p", record("hp_phpmyadmin", {}));
    mockDaemon.containers.set("m", record("hp_mariadb", {}));
    const pma = await adapter.getPanelContainerLogs({ component: "phpmyadmin", tail: 7 });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/hp_phpmyadmin/logs?") && p.includes("tail=7"))).toBe(true);
    expect(pma).toHaveLength(1);
    expect(pma[0]?.stream).toBe("stderr");
    expect(pma[0]?.text).toBe(
      '172.30.0.1 - u [16/Nov/2026] "GET /index.php?[masked] HTTP/1.0" 200 512 "http://x/phpmyadmin/s1/?[masked]" "agent"',
    );
    expect(pma[0]?.text).not.toMatch(/MADEUPTOKEN123|sql_query|SELECT|DROP/);
    const db = await adapter.getPanelContainerLogs({ component: "shared_database", tail: 3 });
    expect(db).toEqual([{ at: "2026-11-16T10:00:00Z", stream: "stderr", text: "db ready?a=b" }]);
    expect(JSON.stringify([pma, db])).not.toContain(DOCKER_ID);
  });

  it("the mask removes every query string of a line", () => {
    expect(maskPhpMyAdminQuery('"GET /a?x=1 HTTP/1.1" "http://h/b?y=2"')).toBe('"GET /a?[masked] HTTP/1.1" "http://h/b?[masked]"');
  });

  it("a missing container is NOT_FOUND", async () => {
    const { adapter } = await setup();
    await expect(adapter.getPanelContainerLogs({ component: "phpmyadmin", tail: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("panel IPC routes", () => {
  it("serves both calls over signed GETs", async () => {
    const { adapter, mockDaemon } = await setup({ logsBodyFn: () => frame("2026-11-16T10:00:00Z hello\n") });
    mockDaemon.containers.set("m", record("hp_mariadb", {}));
    const client = await ipc(adapter);
    const rows = await client.getPanelContainers();
    expect(rows).toHaveLength(5);
    expect(rows[1]).toMatchObject({ component: "shared_database", state: "running" });
    await expect(client.getPanelContainerLogs({ component: "shared_database", tail: 2 })).resolves.toEqual([
      { at: "2026-11-16T10:00:00Z", stream: "stdout", text: "hello" },
    ]);
    const bare = await ipc((await setup()).adapter);
    await expect(bare.getPanelContainerLogs({ component: "sftp", tail: 2 })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it.each([
    ["hp_x", 5],
    ["../x", 5],
    ["sftp", 501],
    ["sftp", 0],
  ])("refuses component=%s tail=%s with 400 before any Engine call", async (component, tail) => {
    const { adapter, mockDaemon } = await setup();
    const client = await ipc(adapter);
    await expect(client.getPanelContainerLogs({ component: component as "sftp", tail })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(mockDaemon.requestedPaths).toEqual([]);
  });

  it("uses 10 s and 35 s budgets, and a timeout is DOCKER_ENGINE_UNAVAILABLE", async () => {
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => { silent.closeAllConnections(); silent.close(resolve); }));
    const port = (silent.address() as { port: number }).port;
    const fast = new SignedDockerExecutorIpcClient({ signingKey: HMAC_KEY as IpcSigningKey, transport: "loopback-test", port, timeoutMs: 100 });
    await expect(fast.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    await expect(fast.getPanelContainerLogs({ component: "sftp", tail: 1 })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });

    const client = new SignedDockerExecutorIpcClient({ signingKey: HMAC_KEY as IpcSigningKey, transport: "loopback-test", port });
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
      timeouts.push(opts.timeout);
      throw new Error("stop");
    }) as never);
    await client.getPanelContainers().catch(() => undefined);
    await client.getPanelContainerLogs({ component: "sftp", tail: 1 }).catch(() => undefined);
    expect(timeouts).toEqual([10_000, 35_000]);
  });
});

describe("log rotation changes no hash", () => {
  it("the site payload has LogConfig and the same labels", () => {
    const payload = buildHardenedContainerCreatePayload(
      createApprovedServiceSpec({
        serviceInstanceId: "svc_rot",
        siteId: "site_rot",
        organizationId: "org_rot",
        image: "ghcr.io/example/webapp:1.0.0",
        containerName: "hp-site-rot",
        revisionNumber: 4,
        specHash: "hash_rot",
      }),
    );
    expect(payload.HostConfig.LogConfig).toEqual(ROTATION);
    expect(payload.Labels).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.organization_id": "org_rot",
      "io.hostingpanel.site_id": "site_rot",
      "io.hostingpanel.service_instance_id": "svc_rot",
      "io.hostingpanel.revision_number": "4",
      "io.hostingpanel.spec_hash": "hash_rot",
    });
  });

  it("hp_mariadb keeps its config label, is not recreated, and is created with LogConfig", async () => {
    const input = { user: "998:998", dataDirHostPath: "/var/lib/hosting-panel/mariadb/data", rootKeyHostPath: "/etc/hosting-panel/mariadb-root.key", adminSubnet: "172.30.250.0/24" };
    // Pinned before M5b: a change here recreates every hp_mariadb.
    expect(buildSharedDatabaseContainerPayload(input).Labels[SHARED_DB_CONFIG_SHA256_LABEL]).toBe(
      "8dee76a038cfc52b1614f1949d64fb774b07bf7db9ca321ad8fd618b33bbba01",
    );

    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-m5h-db-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanup.push(() => mockDaemon.close());
    const dataDir = path.join(tmp, "data");
    const keyFile = path.join(tmp, "root.key");
    await mkdir(dataDir, { recursive: true });
    await writeFile(keyFile, "k".repeat(64));
    const uid = process.getuid?.() ?? 1000;
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      sharedDbDataDir: dataDir,
      sharedDbRootKeyFile: keyFile,
      executorUid: uid + 1,
    });
    await adapter.ensureSharedDatabase();
    const created = [...mockDaemon.containers.values()].find((c) => c.name === "hp_mariadb");
    expect(created?.hostConfig.LogConfig).toEqual(ROTATION);

    // A container made before M5b: no LogConfig, same label. It must stay.
    if (created) {
      created.hostConfig = { ...created.hostConfig, LogConfig: null };
    }
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureSharedDatabase();
    expect(mockDaemon.requestedPaths.slice(mark).filter((p) => p.includes("/containers/create") || p.includes("force"))).toEqual([]);
  });
});

describe("simulator", () => {
  it("defaults, overrides, engine switch, missing logs and the mask", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    expect(await sim.getPanelContainers()).toEqual([
      { component: "ingress_proxy", state: "running", expected: false, startedAt: null, restartCount: 0, imageCurrent: true },
      { component: "shared_database", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true },
      { component: "phpmyadmin", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
      { component: "sftp", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
      { component: "mail_relay", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
    ]);
    sim.setPanelContainer("phpmyadmin", { state: "stopped", expected: true, restartCount: 3 });
    expect((await sim.getPanelContainers())[2]).toEqual({
      component: "phpmyadmin", state: "stopped", expected: true, startedAt: null, restartCount: 3, imageCurrent: true,
    });
    sim.setPanelContainerLogs("phpmyadmin", [
      { at: null, stream: "stdout", text: "a" },
      { at: null, stream: "stdout", text: '"GET /i.php?token=T HTTP/1.1"' },
    ]);
    expect(await sim.getPanelContainerLogs({ component: "phpmyadmin", tail: 1 })).toEqual([
      { at: null, stream: "stdout", text: '"GET /i.php?[masked] HTTP/1.1"' },
    ]);
    await expect(sim.getPanelContainerLogs({ component: "sftp", tail: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    sim.setEngineReachable(false);
    await expect(sim.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    await expect(sim.getPanelContainerLogs({ component: "phpmyadmin", tail: 1 })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });
});
