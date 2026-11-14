import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PHPMYADMIN_PORT,
  PHPMYADMIN_IMAGE,
  PHPMYADMIN_UPLOAD_LIMIT_MB,
  findPlaintextSecretKeys,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PHPMYADMIN_CONFIG_DIR,
  DockerEngineSocketAdapter,
  PHPMYADMIN_CONFIG_SHA256_LABEL,
  PHPMYADMIN_CONTAINER_NAME,
  PHPMYADMIN_NETWORK_NAME,
  SHARED_DB_ALIAS,
  SHARED_DB_CONTAINER_NAME,
  buildPhpMyAdminContainerPayload,
  ensurePhpMyAdminContainer,
  parsePhpMyAdminPortFromEnv,
  renderPhpMyAdminConfig,
  type PhpMyAdminDeps,
} from "../src/index.js";
import { startMockDockerDaemon, type MockDockerContainerRecord } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

async function makeTempDir(prefix = "hp-pma-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const PINNED_CONFIG_PHP = [
  "<?php",
  "// Managed by hp-docker-executor. No secrets.",
  "$cfg['blowfish_secret'] = '';",
  "$cfg['Servers'][1]['host'] = 'hp-mariadb';",
  "$cfg['Servers'][1]['port'] = 3306;",
  "$cfg['Servers'][1]['auth_type'] = 'http';",
  "$cfg['Servers'][1]['AllowRoot'] = false;",
  "$cfg['Servers'][1]['AllowNoPassword'] = false;",
  "$cfg['Servers'][1]['hide_db'] = '^(information_schema|mysql|performance_schema|sys)$';",
  "$cfg['AllowArbitraryServer'] = false;",
  "$cfg['VersionCheck'] = false;",
  "$cfg['SendErrorReports'] = 'never';",
  "$cfg['PmaNoRelation_DisableWarning'] = true;",
  "$cfg['ShowChgPassword'] = false;",
  "$cfg['ShowServerInfo'] = false;",
  "$cfg['UploadDir'] = '';",
  "$cfg['SaveDir'] = '';",
  "$cfg['TempDir'] = '/var/www/html/tmp';",
  "$cfg['MemoryLimit'] = '0';",
  "$p = $_SERVER['HTTP_X_FORWARDED_PREFIX'] ?? '';",
  "if (preg_match('#^/phpmyadmin/[A-Za-z0-9_-]{1,128}/$#', $p) === 1) {",
  "    $cfg['PmaAbsoluteUri'] = $p;",
  "}",
  "",
].join("\n");

const PINNED_BASE_PAYLOAD = {
  Image: PHPMYADMIN_IMAGE,
  User: "33:33",
  ExposedPorts: { "80/tcp": {} },
  Env: [
    `UPLOAD_LIMIT=${String(PHPMYADMIN_UPLOAD_LIMIT_MB)}M`,
    "MEMORY_LIMIT=64M",
    "MAX_EXECUTION_TIME=300",
  ],
  Labels: {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": "phpmyadmin",
  },
  HostConfig: {
    Privileged: false,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    ReadonlyRootfs: true,
    Memory: 536_870_912,
    MemorySwap: 536_870_912,
    PidsLimit: 100,
    NanoCpus: 500_000_000,
    RestartPolicy: { Name: "unless-stopped" },
    LogConfig: {
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    },
    Tmpfs: {
      "/var/run/apache2": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0755,size=1m",
      "/sessions": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0700,size=8m",
      "/var/www/html/tmp": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=0700,size=16m",
      "/tmp": "rw,nosuid,nodev,noexec,uid=33,gid=33,mode=1777,size=48m",
    },
    NetworkMode: PHPMYADMIN_NETWORK_NAME,
    PortBindings: {
      "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(DEFAULT_PHPMYADMIN_PORT) }],
    },
    Binds: [
      `${DEFAULT_PHPMYADMIN_CONFIG_DIR}/config.inc.php:/etc/phpmyadmin/config.inc.php:ro`,
      `${DEFAULT_PHPMYADMIN_CONFIG_DIR}/hp-mpm.conf:/etc/apache2/conf-enabled/hp-mpm.conf:ro`,
    ],
  },
};

const PINNED_MPM_CONF = [
  "<IfModule mpm_prefork_module>",
  "StartServers 2",
  "MinSpareServers 1",
  "MaxSpareServers 2",
  "MaxRequestWorkers 4",
  "MaxConnectionsPerChild 50",
  "</IfModule>",
  "",
].join("\n");

const PINNED_CONFIG_SHA256 = createHash("sha256")
  .update(
    JSON.stringify({
      payload: PINNED_BASE_PAYLOAD,
      configText: PINNED_CONFIG_PHP,
      mpmText: PINNED_MPM_CONF,
    }),
  )
  .digest("hex");

interface FakeInspectRecord {
  Id: string;
  State: { Running: boolean };
  Config: { Labels?: Record<string, string> };
}

function createFakeDeps(options?: {
  readonly configDir: string;
  readonly existing?: FakeInspectRecord | null;
  readonly port?: number;
  readonly containerName?: string;
  readonly networkName?: string;
  readonly sharedDbContainerName?: string;
  readonly dbHost?: string;
  readonly createdId?: string;
}) {
  const calls: Array<{ step: string; args: unknown[] }> = [];
  let containerState: FakeInspectRecord | null = options?.existing ?? null;
  const createdId = options?.createdId ?? "pma_created_0123456789abcdef";

  const deps: PhpMyAdminDeps = {
    containerName: options?.containerName ?? PHPMYADMIN_CONTAINER_NAME,
    networkName: options?.networkName ?? PHPMYADMIN_NETWORK_NAME,
    configDir: options?.configDir ?? DEFAULT_PHPMYADMIN_CONFIG_DIR,
    port: options?.port ?? DEFAULT_PHPMYADMIN_PORT,
    sharedDbContainerName: options?.sharedDbContainerName ?? SHARED_DB_CONTAINER_NAME,
    dbHost: options?.dbHost,
    ensureImageAvailable: vi.fn(async (image: string) => {
      calls.push({ step: "ensureImageAvailable", args: [image] });
    }),
    ensureNetwork: vi.fn(async (name: string, o: { internal: boolean; labels: Record<string, string> }) => {
      calls.push({ step: "ensureNetwork", args: [name, o] });
    }),
    connectContainerToNetwork: vi.fn(async (net: string, ref: string, aliases?: string[]) => {
      calls.push({ step: "connectContainerToNetwork", args: [net, ref, aliases] });
      return true;
    }),
    inspectContainerByNameOrId: vi.fn(async (ref: string) => {
      calls.push({ step: "inspectContainerByNameOrId", args: [ref] });
      return containerState;
    }),
    stopAndRemoveContainer: vi.fn(async (id: string) => {
      calls.push({ step: "stopAndRemoveContainer", args: [id] });
      containerState = null;
    }),
    request: vi.fn(async (method: string, endpointPath: string, body?: unknown, o?: { timeoutMs?: number }) => {
      calls.push({ step: "request", args: [method, endpointPath, body, o] });
      if (method === "POST" && endpointPath.startsWith("/containers/create")) {
        return {
          statusCode: 201,
          body: Buffer.from(JSON.stringify({ Id: createdId }), "utf8"),
        };
      }
      if (method === "POST" && endpointPath.endsWith("/start")) {
        return { statusCode: 204, body: Buffer.alloc(0) };
      }
      throw new Error(`Unexpected request: ${method} ${endpointPath}`);
    }),
  };

  return { deps, calls, getContainer: () => containerState };
}

describe("renderPhpMyAdminConfig", () => {
  it("renders the exact pinned config.inc.php for hp-mariadb", () => {
    expect(renderPhpMyAdminConfig(SHARED_DB_ALIAS)).toBe(PINNED_CONFIG_PHP);
    expect(renderPhpMyAdminConfig("db.internal")).toContain(
      "$cfg['Servers'][1]['host'] = 'db.internal';",
    );
  });

  it("sets MemoryLimit to 0 so PHP memory_limit applies to imports and exports", () => {
    expect(renderPhpMyAdminConfig(SHARED_DB_ALIAS)).toContain("$cfg['MemoryLimit'] = '0';");
  });

  it("rejects unsafe or non-hostname dbHost values with VALIDATION_ERROR without echoing input", () => {
    for (const badHost of [
      "",
      "hp-mariadb'; phpinfo(); //",
      "hp mariadb",
      "hp_mariadb",
      "-leading-dash",
      "trailing-dash-",
      "double..dot",
      "hp\nmariadb",
      "hp\0mariadb",
      "a".repeat(254),
    ]) {
      let caught: unknown;
      try {
        renderPhpMyAdminConfig(badHost);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected ${JSON.stringify(badHost)} to throw`).toMatchObject({
        code: "VALIDATION_ERROR",
      });
      if (badHost.length >= 4 && caught instanceof Error) {
        expect(caught.message).not.toContain(badHost);
      }
    }
  });
});

describe("buildPhpMyAdminContainerPayload", () => {
  it("builds the exact locked-down container payload and pinned configSha256", () => {
    const built = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: `${DEFAULT_PHPMYADMIN_CONFIG_DIR}/config.inc.php`,
      port: DEFAULT_PHPMYADMIN_PORT,
    });

    expect(built.configSha256).toBe(PINNED_CONFIG_SHA256);
    expect(built.payload).toEqual({
      ...PINNED_BASE_PAYLOAD,
      Labels: {
        ...PINNED_BASE_PAYLOAD.Labels,
        [PHPMYADMIN_CONFIG_SHA256_LABEL]: PINNED_CONFIG_SHA256,
      },
    });

    const hostConfig = built.payload.HostConfig as Record<string, unknown>;
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.Privileged).toBe(false);
    expect(hostConfig.CapDrop).toEqual(["ALL"]);
    expect(hostConfig.CapAdd).toBeUndefined();
    expect(hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(hostConfig.Memory).toBe(536_870_912);
    expect(hostConfig.MemorySwap).toBe(536_870_912);
    expect(hostConfig.PidsLimit).toBe(100);
    expect(hostConfig.NanoCpus).toBe(500_000_000);
    expect(hostConfig.PortBindings).toEqual({
      "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8306" }],
    });

    const envMap: Record<string, string> = {};
    for (const entry of built.payload.Env as string[]) {
      const idx = entry.indexOf("=");
      envMap[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    expect(findPlaintextSecretKeys({ env: envMap })).toEqual([]);
  });

  it("keeps workers times 64 MiB at most three quarters of the container memory", async () => {
    const tmpDir = await makeTempDir("hp-pma-budget-");
    const configDir = path.join(tmpDir, "pma");
    const { deps } = createFakeDeps({ configDir, existing: null });
    await ensurePhpMyAdminContainer(deps);

    const mpmText = await readFile(path.join(configDir, "hp-mpm.conf"), "utf8");
    const workerMatch = /MaxRequestWorkers\s+(\d+)/.exec(mpmText);
    expect(workerMatch).not.toBeNull();
    const workers = Number(workerMatch![1]);

    const { payload } = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: path.join(configDir, "config.inc.php"),
      port: DEFAULT_PHPMYADMIN_PORT,
    });
    const hostConfig = payload.HostConfig as Record<string, unknown>;
    const envList = payload.Env as string[];
    const memMatch = /^MEMORY_LIMIT=(\d+)M$/m.exec(envList.join("\n"));
    expect(memMatch).not.toBeNull();
    const phpLimitMiB = Number(memMatch![1]);
    const containerMemoryBytes = hostConfig.Memory as number;

    expect(workers).toBe(4);
    expect(phpLimitMiB).toBe(64);
    expect(containerMemoryBytes).toBe(512 * 1024 * 1024);
    expect(workers * phpLimitMiB * 1024 * 1024).toBeLessThanOrEqual((containerMemoryBytes * 3) / 4);
  });

  it("changes configSha256 when image, port, network, or configFile changes", () => {
    const base = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: "/var/lib/hosting-panel/phpmyadmin/config.inc.php",
      port: 8306,
    });
    const diffPort = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: "/var/lib/hosting-panel/phpmyadmin/config.inc.php",
      port: 18306,
    });
    const diffImage = buildPhpMyAdminContainerPayload({
      image: "phpmyadmin@sha256:0000000000000000000000000000000000000000000000000000000000000000",
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: "/var/lib/hosting-panel/phpmyadmin/config.inc.php",
      port: 8306,
    });
    expect(diffPort.configSha256).not.toBe(base.configSha256);
    expect(diffImage.configSha256).not.toBe(base.configSha256);
    const diffDbHost = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: "/var/lib/hosting-panel/phpmyadmin/config.inc.php",
      port: 8306,
      dbHost: "db-2.internal",
    });
    expect(diffDbHost.configSha256).not.toBe(base.configSha256);
  });

  it("refuses docker.sock bind and unsafe inputs without leaking paths", () => {
    const sockPath = "/var/run/docker.sock";
    let caught: unknown;
    try {
      buildPhpMyAdminContainerPayload({
        containerName: PHPMYADMIN_CONTAINER_NAME,
        network: PHPMYADMIN_NETWORK_NAME,
        configFile: sockPath,
        port: 8306,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect((caught as Error).message).not.toContain(sockPath);

    expect(() =>
      buildPhpMyAdminContainerPayload({
        containerName: PHPMYADMIN_CONTAINER_NAME,
        network: PHPMYADMIN_NETWORK_NAME,
        configFile: "/tmp/a:b/config.inc.php",
        port: 8306,
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));

    expect(() =>
      buildPhpMyAdminContainerPayload({
        containerName: "../bad",
        network: PHPMYADMIN_NETWORK_NAME,
        configFile: "/tmp/pma/config.inc.php",
        port: 8306,
      }),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));

    expect(() =>
      buildPhpMyAdminContainerPayload({
        containerName: PHPMYADMIN_CONTAINER_NAME,
        network: PHPMYADMIN_NETWORK_NAME,
        configFile: "/tmp/pma/config.inc.php",
        port: 0,
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("ensurePhpMyAdminContainer", () => {
  it("does nothing when ifPresent is true and container does not exist", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "phpmyadmin-absent");
    const { deps, calls } = createFakeDeps({ configDir, existing: null });

    await ensurePhpMyAdminContainer(deps, { ifPresent: true });

    expect(calls.map((c) => c.step)).toEqual(["inspectContainerByNameOrId"]);
    expect(deps.ensureNetwork).not.toHaveBeenCalled();
    expect(deps.connectContainerToNetwork).not.toHaveBeenCalled();
    expect(deps.ensureImageAvailable).not.toHaveBeenCalled();
    expect(deps.stopAndRemoveContainer).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
    await expect(lstat(configDir)).rejects.toThrow();
  });

  it("creates config (0644), network, connects mariadb, pulls image, creates and starts on fresh ensure in exact order", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma");
    const { deps, calls } = createFakeDeps({ configDir, existing: null, port: 18306 });

    await ensurePhpMyAdminContainer(deps);

    const configPath = path.join(configDir, "config.inc.php");
    expect(await readFile(configPath, "utf8")).toBe(PINNED_CONFIG_PHP);
    expect((await stat(configPath)).mode & 0o777).toBe(0o644);
    const mpmPath = path.join(configDir, "hp-mpm.conf");
    expect(await readFile(mpmPath, "utf8")).toContain("MaxRequestWorkers 4");
    expect((await stat(mpmPath)).mode & 0o777).toBe(0o644);
    expect((await stat(configDir)).mode & 0o777).toBe(0o755);

    expect(calls.map((c) => c.step)).toEqual([
      "inspectContainerByNameOrId",
      "ensureNetwork",
      "connectContainerToNetwork",
      "ensureImageAvailable",
      "request",
      "request",
    ]);
    expect(calls[0]!.args).toEqual([PHPMYADMIN_CONTAINER_NAME]);
    expect(calls[1]!.args).toEqual([
      PHPMYADMIN_NETWORK_NAME,
      {
        internal: false,
        labels: {
          "io.hostingpanel.managed": "true",
          "io.hostingpanel.network_role": "phpmyadmin",
        },
      },
    ]);
    expect(calls[2]!.args).toEqual([
      PHPMYADMIN_NETWORK_NAME,
      SHARED_DB_CONTAINER_NAME,
      [SHARED_DB_ALIAS],
    ]);
    expect(calls[3]!.args).toEqual([PHPMYADMIN_IMAGE]);
    expect(calls[4]!.args[0]).toBe("POST");
    expect(calls[4]!.args[1]).toBe(`/containers/create?name=${PHPMYADMIN_CONTAINER_NAME}`);
    expect(calls[5]!.args[0]).toBe("POST");
    expect(calls[5]!.args[1]).toBe("/containers/pma_created_0123456789abcdef/start");

    // CP-01: never stop/remove/create/start/exec on database container
    expect(deps.stopAndRemoveContainer).not.toHaveBeenCalled();
    for (const c of calls) {
      if (c.step !== "connectContainerToNetwork") {
        expect(JSON.stringify(c.args)).not.toContain(SHARED_DB_CONTAINER_NAME);
      }
    }
  });

  it("leaves running container untouched and skips image/create/start/remove when hash matches (connect-only for DB)", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma");
    const configFile = path.join(configDir, "config.inc.php");
    await mkdir(configDir, { mode: 0o755 });
    await writeFile(configFile, PINNED_CONFIG_PHP, { mode: 0o644 });
    const beforeInode = (await stat(configFile)).ino;

    const { configSha256 } = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile,
      port: DEFAULT_PHPMYADMIN_PORT,
    });

    const { deps, calls } = createFakeDeps({
      configDir,
      existing: {
        Id: "pma_existing_id",
        State: { Running: true },
        Config: { Labels: { [PHPMYADMIN_CONFIG_SHA256_LABEL]: configSha256 } },
      },
    });

    await ensurePhpMyAdminContainer(deps);

    expect((await stat(configFile)).ino).toBe(beforeInode);
    expect(calls.map((c) => c.step)).toEqual([
      "inspectContainerByNameOrId",
      "ensureNetwork",
      "connectContainerToNetwork",
    ]);
    expect(calls[2]!.args).toEqual([
      PHPMYADMIN_NETWORK_NAME,
      SHARED_DB_CONTAINER_NAME,
      [SHARED_DB_ALIAS],
    ]);
    expect(deps.ensureImageAvailable).not.toHaveBeenCalled();
    expect(deps.stopAndRemoveContainer).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
  });

  it("starts a stopped container without recreating when hash matches", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma");
    const configFile = path.join(configDir, "config.inc.php");
    const { configSha256 } = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile,
      port: DEFAULT_PHPMYADMIN_PORT,
    });

    const { deps, calls } = createFakeDeps({
      configDir,
      existing: {
        Id: "pma_stopped_id",
        State: { Running: false },
        Config: { Labels: { [PHPMYADMIN_CONFIG_SHA256_LABEL]: configSha256 } },
      },
    });

    await ensurePhpMyAdminContainer(deps);

    expect(calls.map((c) => c.step)).toEqual([
      "inspectContainerByNameOrId",
      "ensureNetwork",
      "connectContainerToNetwork",
      "request",
    ]);
    expect(calls[3]!.args[0]).toBe("POST");
    expect(calls[3]!.args[1]).toBe("/containers/pma_stopped_id/start");
    expect(deps.stopAndRemoveContainer).not.toHaveBeenCalled();
    expect(deps.ensureImageAvailable).not.toHaveBeenCalled();
  });

  it("recreates container (pull -> stopAndRemove -> create -> start) when config hash, image, or port differs", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma");
    const { deps, calls } = createFakeDeps({
      configDir,
      existing: {
        Id: "pma_old_id",
        State: { Running: true },
        Config: { Labels: { [PHPMYADMIN_CONFIG_SHA256_LABEL]: "stale-hash-0000" } },
      },
    });

    await ensurePhpMyAdminContainer(deps, { ifPresent: true });

    expect(calls.map((c) => c.step)).toEqual([
      "inspectContainerByNameOrId",
      "ensureNetwork",
      "connectContainerToNetwork",
      "ensureImageAvailable",
      "stopAndRemoveContainer",
      "request",
      "request",
    ]);
    expect(calls[4]!.args).toEqual(["pma_old_id"]);
    expect(calls[5]!.args[1]).toBe(`/containers/create?name=${PHPMYADMIN_CONTAINER_NAME}`);
    expect(calls[6]!.args[1]).toBe("/containers/pma_created_0123456789abcdef/start");
  });

  it("passes custom dbHost into config.inc.php and recreates when config text changes", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma-reconf");
    const { configSha256: baseSha } = buildPhpMyAdminContainerPayload({
      containerName: PHPMYADMIN_CONTAINER_NAME,
      network: PHPMYADMIN_NETWORK_NAME,
      configFile: path.join(configDir, "config.inc.php"),
      port: DEFAULT_PHPMYADMIN_PORT,
    });
    const { deps, calls } = createFakeDeps({
      configDir,
      dbHost: "hp-mariadb-reconf",
      existing: {
        Id: "pma_old_dbhost",
        State: { Running: true },
        Config: { Labels: { [PHPMYADMIN_CONFIG_SHA256_LABEL]: baseSha } },
      },
    });

    await ensurePhpMyAdminContainer(deps);

    const writtenConfig = await readFile(path.join(configDir, "config.inc.php"), "utf8");
    expect(writtenConfig).toContain("$cfg['Servers'][1]['host'] = 'hp-mariadb-reconf';");
    expect(calls[2]!.args).toEqual([
      PHPMYADMIN_NETWORK_NAME,
      SHARED_DB_CONTAINER_NAME,
      ["hp-mariadb-reconf"],
    ]);
    expect(calls.map((c) => c.step)).toEqual([
      "inspectContainerByNameOrId",
      "ensureNetwork",
      "connectContainerToNetwork",
      "ensureImageAvailable",
      "stopAndRemoveContainer",
      "request",
      "request",
    ]);
  });

  it("maps engine failures to DOCKER_ENGINE_UNAVAILABLE without leaking paths or container ids", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma-err");
    const secretContainerId = "secret_ctr_id_9876543210abcdef";

    const failScenarios: Array<(deps: PhpMyAdminDeps) => void> = [
      (d) => {
        d.inspectContainerByNameOrId = async () => {
          throw new Error(`connect ENOENT /var/run/docker.sock for ${secretContainerId}`);
        };
      },
      (d) => {
        d.ensureNetwork = async () => {
          throw new Error(`network failure in ${configDir}`);
        };
      },
      (d) => {
        d.connectContainerToNetwork = async () => {
          throw new Error(`No such container: ${SHARED_DB_CONTAINER_NAME} (${secretContainerId})`);
        };
      },
      (d) => {
        d.connectContainerToNetwork = async () => false;
      },
      (d) => {
        d.ensureImageAvailable = async () => {
          throw new Error(`pull failed from ${configDir}`);
        };
      },
      (d) => {
        d.request = async () => ({ statusCode: 500, body: Buffer.from(secretContainerId) });
      },
    ];

    for (const mutate of failScenarios) {
      const { deps } = createFakeDeps({
        configDir,
        existing: {
          Id: secretContainerId,
          State: { Running: true },
          Config: { Labels: { [PHPMYADMIN_CONFIG_SHA256_LABEL]: "old" } },
        },
      });
      mutate(deps);
      let caught: unknown;
      try {
        await ensurePhpMyAdminContainer(deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
      const msg = (caught as Error).message;
      expect(msg).not.toContain(configDir);
      expect(msg).not.toContain(tmpDir);
      expect(msg).not.toContain(secretContainerId);
      expect(msg).not.toContain("/var/run/docker.sock");
    }
  });

  it("refuses symlink at config.inc.php with HOST_POLICY_DENIED without leaking path", async () => {
    const tmpDir = await makeTempDir();
    const configDir = path.join(tmpDir, "pma-sym");
    await mkdir(configDir, { mode: 0o755 });
    const targetFile = path.join(tmpDir, "outside.txt");
    await writeFile(targetFile, "secret", "utf8");
    await symlink(targetFile, path.join(configDir, "config.inc.php"));

    const { deps } = createFakeDeps({ configDir, existing: null });
    let caught: unknown;
    try {
      await ensurePhpMyAdminContainer(deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect((caught as Error).message).not.toContain(configDir);
    expect((caught as Error).message).not.toContain(tmpDir);
  });
});

describe("DockerEngineSocketAdapter.ensurePhpMyAdmin with mock Docker daemon", () => {
  function seedContainer(
    containers: Map<string, MockDockerContainerRecord>,
    id: string,
    name: string,
    role: string,
  ): MockDockerContainerRecord {
    const rec: MockDockerContainerRecord = {
      id,
      name,
      image: "mariadb:12.3.3",
      env: [],
      labels: { "io.hostingpanel.managed": "true", "io.hostingpanel.role": role },
      running: true,
      status: "running",
      restartCount: 0,
      hostConfig: { Privileged: false, CapDrop: ["ALL"], Binds: [] },
      networks: {},
    };
    containers.set(id, rec);
    return rec;
  }

  it("serializes concurrent calls, handles already-exists on DB reconnect, and obeys CP-01", async () => {
    const tmpDir = await makeTempDir("hp-pma-adapter-");
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());

    const dbCtr = seedContainer(mockDaemon.containers, "db_ctr_id_0001", "hp_test_db", "shared_database");
    const siteCtr = seedContainer(mockDaemon.containers, "site_ctr_id_0001", "hp-site-1", "site");
    const configDir = path.join(tmpDir, "pma-cfg");

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpDir, "secrets"),
      ingressRootDir: path.join(tmpDir, "ingress"),
      pullMissingImages: false,
      sharedDbContainerName: "hp_test_db",
      phpMyAdminContainerName: "hp_test_pma",
      phpMyAdminNetworkName: "hp_test_pma_net",
      phpMyAdminConfigDir: configDir,
      phpMyAdminPort: 28306,
    });

    await adapter.ensurePhpMyAdmin({ ifPresent: true });
    expect(mockDaemon.createdNetworks).toEqual([]);

    await Promise.all([adapter.ensurePhpMyAdmin(), adapter.ensurePhpMyAdmin()]);

    const pmaContainers = [...mockDaemon.containers.values()].filter((c) => c.name === "hp_test_pma");
    expect(pmaContainers).toHaveLength(1);
    expect(pmaContainers[0]!.running).toBe(true);
    expect(mockDaemon.createdNetworks.map((n) => n.Name)).toEqual(["hp_test_pma_net"]);
    expect(dbCtr.networks["hp_test_pma_net"]).toEqual({ Aliases: [SHARED_DB_ALIAS] });

    // Second ensure call sees same hash -> no recreate, still reconnects DB idempotently.
    const countBefore = mockDaemon.containers.get(pmaContainers[0]!.id)!.id;
    const reqMark = mockDaemon.requestedPaths.length;
    await adapter.ensurePhpMyAdmin();
    const afterPaths = mockDaemon.requestedPaths.slice(reqMark);
    expect(afterPaths.some((p) => p.includes("/containers/create"))).toBe(false);
    expect(afterPaths.some((p) => p.includes("/start"))).toBe(false);
    expect([...mockDaemon.containers.values()].find((c) => c.name === "hp_test_pma")?.id).toBe(
      countBefore,
    );

    // CP-01: MariaDB and site containers never stopped/restarted/removed/execed.
    expect(mockDaemon.execCalls).toEqual([]);
    expect(dbCtr.running).toBe(true);
    expect(siteCtr.running).toBe(true);
    for (const raw of mockDaemon.requestedPaths) {
      expect(raw).not.toMatch(/\/containers\/(hp_test_db|db_ctr_id_0001|hp-site-1|site_ctr_id_0001)\/(stop|restart)/);
    }

    // Missing MariaDB returns DOCKER_ENGINE_UNAVAILABLE.
    mockDaemon.missingContainers.add("hp_test_db");
    await expect(adapter.ensurePhpMyAdmin()).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });

  it("serializes ensurePhpMyAdmin() behind an in-flight ensurePhpMyAdmin({ ifPresent: true }) and creates the container once", async () => {
    const tmpDir = await makeTempDir("hp-pma-ifpresent-race-");
    const events: string[] = [];
    const mockDaemon = await startMockDockerDaemon({
      onRequest(method, routePath) {
        events.push(`req:${method}:${routePath}`);
      },
    });
    cleanupTasks.push(() => mockDaemon.close());

    seedContainer(mockDaemon.containers, "db_ctr_id_0002", "hp_test_db", "shared_database");

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpDir, "secrets"),
      ingressRootDir: path.join(tmpDir, "ingress"),
      pullMissingImages: false,
      sharedDbContainerName: "hp_test_db",
      phpMyAdminContainerName: "hp_test_pma",
      phpMyAdminNetworkName: "hp_test_pma_net",
      phpMyAdminConfigDir: path.join(tmpDir, "pma-cfg"),
      phpMyAdminPort: 28307,
    });

    const pIfPresent = adapter.ensurePhpMyAdmin({ ifPresent: true }).then(() => {
      events.push("done:ifPresent");
    });
    const pFull = adapter.ensurePhpMyAdmin().then(() => {
      events.push("done:full");
    });

    await Promise.all([pIfPresent, pFull]);

    const firstDoneIdx = events.indexOf("done:ifPresent");
    const inspectIndices = events
      .map((e, i) => (e === "req:GET:/containers/hp_test_pma/json" ? i : -1))
      .filter((i) => i >= 0);
    expect(inspectIndices).toHaveLength(2);
    expect(inspectIndices[0]).toBeLessThan(firstDoneIdx);
    expect(firstDoneIdx).toBeLessThan(inspectIndices[1]!);

    const createCalls = events.filter((e) => e === "req:POST:/containers/create");
    expect(createCalls).toHaveLength(1);
    const pmaContainers = [...mockDaemon.containers.values()].filter((c) => c.name === "hp_test_pma");
    expect(pmaContainers).toHaveLength(1);
    expect(pmaContainers[0]!.running).toBe(true);
  });
});

describe("parsePhpMyAdminPortFromEnv", () => {
  it("defaults to 8306, accepts valid ports, and refuses reserved/invalid ports", () => {
    expect(parsePhpMyAdminPortFromEnv({})).toBe(DEFAULT_PHPMYADMIN_PORT);
    expect(parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "   " })).toBe(DEFAULT_PHPMYADMIN_PORT);
    expect(parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "1" })).toBe(1);
    expect(parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "8306" })).toBe(8306);
    expect(parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "18306" })).toBe(18306);
    expect(parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "65535" })).toBe(65535);

    for (const badPort of ["22", "80", "443", "2222", "3000", "4000", "5432", "0", "65536", "abc"]) {
      expect(
        () => parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: badPort }),
        `expected HP_PHPMYADMIN_PORT=${badPort} to throw`,
      ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }

    expect(() => parsePhpMyAdminPortFromEnv({ HP_PHPMYADMIN_PORT: "2222" })).toThrow(/2222/);
  });
});
