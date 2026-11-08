import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHARED_MARIADB_IMAGE } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SHARED_DB_DATA_DIR,
  DEFAULT_SHARED_DB_ROOT_KEY_FILE,
  DockerEngineSocketAdapter,
  SHARED_DB_ALIAS,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SHARED_DB_CONTAINER_NAME,
  SHARED_DB_NETWORK_NAME,
  buildSharedDatabaseContainerPayload,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const defaultInput = {
  user: "998:998",
  dataDirHostPath: DEFAULT_SHARED_DB_DATA_DIR,
  rootKeyHostPath: DEFAULT_SHARED_DB_ROOT_KEY_FILE,
  adminSubnet: "172.30.250.0/24",
};

describe("buildSharedDatabaseContainerPayload", () => {
  it("mariadb payload binds only persistent host paths", () => {
    const payload = buildSharedDatabaseContainerPayload(defaultInput);
    expect(payload.Image).toBe(SHARED_MARIADB_IMAGE);
    expect(payload.User).toBe("998:998");
    expect(payload.HostConfig.Binds).toEqual([
      "/var/lib/hosting-panel/mariadb/data:/var/lib/mysql",
      "/etc/hosting-panel/mariadb-root.key:/run/secrets/mariadb-root:ro",
    ]);
    expect(JSON.stringify(payload)).not.toContain("/run/hosting-panel");
    expect("PortBindings" in payload.HostConfig).toBe(false);
    expect((payload.HostConfig as { CapAdd?: unknown }).CapAdd).toBeUndefined();
    expect(payload.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 1073741824,
      MemorySwap: 1073741824,
      NanoCpus: 1e9,
      PidsLimit: 512,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: SHARED_DB_NETWORK_NAME,
    });
    expect(payload.NetworkingConfig.EndpointsConfig[SHARED_DB_NETWORK_NAME]?.Aliases).toEqual([
      SHARED_DB_ALIAS,
    ]);
    expect(payload.Cmd).toEqual([
      "--innodb-buffer-pool-size=256M",
      "--max-connections=150",
      "--skip-name-resolve",
    ]);
    expect(payload.Labels["io.hostingpanel.role"]).toBe("shared_database");
    expect(payload.Labels[SHARED_DB_CONFIG_SHA256_LABEL]).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.Env).toContain("MARIADB_ROOT_PASSWORD_FILE=/run/secrets/mariadb-root");
    expect(payload.Env).toContain("MARIADB_AUTO_UPGRADE=1");
  });

  it("mariadb payload refuses docker.sock", () => {
    expect(() =>
      buildSharedDatabaseContainerPayload({
        ...defaultInput,
        dataDirHostPath: "/var/run/docker.sock",
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
    expect(() =>
      buildSharedDatabaseContainerPayload({ ...defaultInput, rootKeyHostPath: "/run/docker.sock" }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("config label changes with the config", () => {
    const a = buildSharedDatabaseContainerPayload(defaultInput);
    const b = buildSharedDatabaseContainerPayload({ ...defaultInput, user: "997:997" });
    expect(a.Labels[SHARED_DB_CONFIG_SHA256_LABEL]).not.toBe(
      b.Labels[SHARED_DB_CONFIG_SHA256_LABEL],
    );
  });
});

describe("DockerEngineSocketAdapter shared database", () => {
  async function setup(options?: { readonly withKey?: boolean; readonly ownUid?: boolean }) {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-mariadb-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());
    const dataDir = path.join(tmpBaseDir, "mariadb", "data");
    const keyFile = path.join(tmpBaseDir, "mariadb-root.key");
    await mkdir(dataDir, { recursive: true });
    if (options?.withKey !== false) {
      await writeFile(keyFile, "k".repeat(64));
    }
    const uid = process.getuid?.() ?? 1000;
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpBaseDir, "secrets"),
      ingressRootDir: path.join(tmpBaseDir, "ingress"),
      pullMissingImages: false,
      sharedDbDataDir: dataDir,
      sharedDbRootKeyFile: keyFile,
      // The test owns the data dir; pretend the executor runs as someone else.
      ...(options?.ownUid ? {} : { executorUid: uid + 1 }),
    });
    const mariadb = () =>
      [...mockDaemon.containers.values()].find((c) => c.name === SHARED_DB_CONTAINER_NAME);
    const recreateCalls = (from: number) =>
      mockDaemon.requestedPaths
        .slice(from)
        .filter((p) => p.includes("/containers/create") || /\/containers\/[^/]+\?force/.test(p));
    return { adapter, mockDaemon, mariadb, recreateCalls, uid };
  }

  it("mariadb root may log in only from the admin subnet", async () => {
    const { adapter, mockDaemon, mariadb } = await setup();
    await adapter.ensureSharedDatabase();
    expect(mariadb()?.env).toContain("MARIADB_ROOT_HOST=172.30.250.%");
    const net = mockDaemon.createdNetworks.find((n) => n.Name === SHARED_DB_NETWORK_NAME);
    expect(net?.IPAM?.Config?.[0]?.Subnet).toBe("172.30.250.0/24");
    expect(net?.Internal).toBe(true);
  });

  it("ensureSharedDatabase does not recreate an up-to-date container", async () => {
    const { adapter, mockDaemon, mariadb, recreateCalls, uid } = await setup();
    await expect(adapter.ensureSharedDatabase()).resolves.toMatchObject({
      component: "shared_database",
      status: "running",
    });
    const first = mariadb();
    expect(first?.running).toBe(true);
    expect(first?.user).toBe(`${String(uid)}:${String(process.getgid?.() ?? uid)}`);
    expect(await adapter.isSharedDatabaseRunning()).toBe(true);

    // Docker merges the image's own ENV into Config.Env: must not count as a change.
    first?.env.push("PATH=/usr/local/sbin:/usr/bin", "MARIADB_VERSION=1:12.3.3", "GOSU_VERSION=1.17");
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureSharedDatabase();
    expect(recreateCalls(mark)).toEqual([]);
    expect(mariadb()?.id).toBe(first?.id);

    if (first) {
      first.labels[SHARED_DB_CONFIG_SHA256_LABEL] = "stale";
    }
    const mark2 = mockDaemon.requestedPaths.length;
    await adapter.ensureSharedDatabase();
    expect(recreateCalls(mark2)).toHaveLength(2);
    expect(mariadb()?.id).not.toBe(first?.id);
    expect(mariadb()?.running).toBe(true);
  });

  it("ensureSharedDatabase starts a stopped container without recreating it", async () => {
    const { adapter, mockDaemon, mariadb, recreateCalls } = await setup();
    await adapter.ensureSharedDatabase();
    const first = mariadb();
    if (first) {
      first.running = false;
      first.status = "exited";
    }
    expect(await adapter.isSharedDatabaseRunning()).toBe(false);
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureSharedDatabase();
    expect(recreateCalls(mark)).toEqual([]);
    expect(mariadb()?.running).toBe(true);
  });

  it("ensureSharedDatabase refuses when the key file is missing", async () => {
    const { adapter, mockDaemon } = await setup({ withKey: false });
    await expect(adapter.ensureSharedDatabase()).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
  });

  it("ensureSharedDatabase refuses a data dir owned by the executor's uid", async () => {
    const { adapter, mockDaemon } = await setup({ ownUid: true });
    await expect(adapter.ensureSharedDatabase()).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
  });

  it("isSharedDatabaseRunning is false when hp_mariadb is missing", async () => {
    const { adapter } = await setup();
    expect(await adapter.isSharedDatabaseRunning()).toBe(false);
  });

  it("ensureSharedDatabase reattaches hp_mariadb to every site internal network", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.createdNetworks.push(
      { Name: "hp_site_a_net", Labels: { "io.hostingpanel.network_role": "site_internal" } },
      { Name: "hp_site_gone_net", Labels: { "io.hostingpanel.network_role": "site_internal" } },
      { Name: "hp_edge_a_net", Labels: { "io.hostingpanel.network_role": "site_edge" } },
    );
    mockDaemon.vanishedNetworks.add("hp_site_gone_net");
    await adapter.ensureSharedDatabase();
    const calls = mockDaemon.networkConnectCalls.filter(
      (c) => c.container === SHARED_DB_CONTAINER_NAME,
    );
    expect(calls).toEqual([
      { network: "hp_site_a_net", container: SHARED_DB_CONTAINER_NAME, aliases: [SHARED_DB_ALIAS] },
      {
        network: "hp_site_gone_net",
        container: SHARED_DB_CONTAINER_NAME,
        aliases: [SHARED_DB_ALIAS],
      },
    ]);
  });

  it("deployService attaches hp_mariadb to the site network with alias hp-mariadb", async () => {
    const { adapter, mockDaemon } = await setup();
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_wp",
      siteId: "site_wp",
      organizationId: "org_wp",
      image: "ghcr.io/example/webapp:1.4.2",
      containerName: "hp-site-wp-web",
      env: {},
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 128,
      revisionNumber: 1,
      specHash: "hash_wp_1",
    });
    const res = await adapter.deployService(spec);
    expect(res.status).toBe("succeeded");
    expect(mockDaemon.networkConnectCalls).toContainEqual({
      network: "hp_site_site_wp_net",
      container: SHARED_DB_CONTAINER_NAME,
      aliases: [SHARED_DB_ALIAS],
    });
  });

  it("deployService ignores a missing hp_mariadb", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.vanishedNetworks.add("hp_site_site_wp2_net");
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_wp2",
      siteId: "site_wp2",
      organizationId: "org_wp",
      image: "ghcr.io/example/webapp:1.4.2",
      containerName: "hp-site-wp2-web",
      env: {},
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 128,
      revisionNumber: 1,
      specHash: "hash_wp2_1",
    });
    await expect(adapter.deployService(spec)).resolves.toMatchObject({ status: "succeeded" });
  });
});
