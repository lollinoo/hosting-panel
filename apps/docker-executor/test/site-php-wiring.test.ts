import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcSigningKey, IpcVerificationKey } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_PHP_DIR,
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SITE_PHP_INI_TARGET,
  SignedDockerExecutorIpcClient,
  buildHardenedContainerCreatePayload,
  detectOutOfBandContainerModification,
  removeSitePhpIni,
  renderPhpIni,
  sitePhpBinds,
  sitePhpIniPath,
  writeSitePhpIni,
  type DockerContainerInspectPayload,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-site-php-ipc-key";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: HMAC_SECRET };

const PHP_DIR = "/srv/test-site-php";
const PHP_INI = { memory_limit: "256M", upload_max_filesize: "64M" } as const;

const specInput = (phpIni?: Record<string, string>) => ({
  serviceInstanceId: "svc_php",
  siteId: "site_php",
  organizationId: "org_php",
  image: "wordpress:6-php8.3-apache",
  containerName: "hp-site-php",
  env: {},
  resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
  pidsLimit: 128,
  revisionNumber: 1,
  specHash: "hash_php",
  exposeHttp: false,
  internalPort: 80,
  volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
  ...(phpIni !== undefined ? { phpIni } : {}),
});

describe("buildHardenedContainerCreatePayload with sitePhpBinds", () => {
  const spec = createApprovedServiceSpec(specInput({ ...PHP_INI }));
  const build = (binds: readonly string[]) => buildHardenedContainerCreatePayload(spec, { sitePhpBinds: binds });
  const denied = expect.objectContaining({ code: "HOST_POLICY_DENIED" });

  it("adds exactly its own read-only file bind", () => {
    const withoutPhp = buildHardenedContainerCreatePayload(spec);
    const payload = build(sitePhpBinds(PHP_DIR, "svc_php"));
    expect(payload.HostConfig.Binds).toEqual([
      ...(withoutPhp.HostConfig.Binds ?? []),
      `${PHP_DIR}/svc_php.ini:${SITE_PHP_INI_TARGET}:ro`,
    ]);
  });

  it("refuses a foreign path, another service's file, a writable bind and a traversal", () => {
    expect(() => build(["/etc/passwd:/x:ro"])).toThrow(denied);
    expect(() => build(sitePhpBinds(PHP_DIR, "svc_other"))).toThrow(denied);
    expect(() => build([`${PHP_DIR}/svc_php.ini:${SITE_PHP_INI_TARGET}`])).toThrow(denied);
    expect(() => build([`${PHP_DIR}/svc_php.ini:${SITE_PHP_INI_TARGET}:rw`])).toThrow(denied);
    expect(() => build([`${PHP_DIR}/../etc/svc_php.ini:${SITE_PHP_INI_TARGET}:ro`])).toThrow(denied);
  });

  it("leaves the binds untouched when no PHP bind is passed", () => {
    expect(buildHardenedContainerCreatePayload(createApprovedServiceSpec(specInput())).HostConfig.Binds).toEqual([
      "hp_vol_svc_php_html:/var/www/html",
    ]);
  });
});

describe("detectOutOfBandContainerModification with the PHP bind", () => {
  const inspectWith = (binds: readonly string[]): DockerContainerInspectPayload => ({
    Id: "ctr_php",
    Config: {
      Labels: {
        [MANAGED_DOCKER_LABELS.managed]: "true",
        [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_php",
        [MANAGED_DOCKER_LABELS.organizationId]: "org_php",
        [MANAGED_DOCKER_LABELS.siteId]: "site_php",
      },
      Env: [],
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: "hp_site_site_php_net",
      Binds: binds,
    },
  });
  const drift = (binds: readonly string[], phpDir?: string) =>
    detectOutOfBandContainerModification(
      inspectWith(binds),
      "svc_php",
      "/run/hosting-panel/secrets",
      undefined,
      undefined,
      phpDir,
    );

  it("its own file is no drift, with a custom and with the default directory", () => {
    expect(drift(sitePhpBinds(PHP_DIR, "svc_php"), PHP_DIR)).toBe(false);
    expect(drift(sitePhpBinds(DEFAULT_SITE_PHP_DIR, "svc_php"))).toBe(false);
  });

  it("another service's file, an extra bind, a writable bind or another directory is drift", () => {
    expect(drift(sitePhpBinds(PHP_DIR, "svc_other"), PHP_DIR)).toBe(true);
    expect(drift([...sitePhpBinds(PHP_DIR, "svc_php"), "/etc/passwd:/x:ro"], PHP_DIR)).toBe(true);
    expect(drift([`${PHP_DIR}/svc_php.ini:${SITE_PHP_INI_TARGET}`], PHP_DIR)).toBe(true);
    expect(drift(sitePhpBinds("/elsewhere", "svc_php"), PHP_DIR)).toBe(true);
    expect(drift(sitePhpBinds(PHP_DIR, "svc_php"))).toBe(true);
  });
});

describe("docker adapter PHP ini wiring", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  async function setup() {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-php-wire-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());
    const sitePhpDir = path.join(tmp, "site-php");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      sitePhpDir,
      pullMissingImages: false,
      backupWorkDir: path.join(tmp, "backups"),
    });
    return { adapter, mockDaemon, sitePhpDir };
  }

  const createdBinds = (d: Awaited<ReturnType<typeof setup>>["mockDaemon"]) =>
    [...d.containers.values()].find((c) => c.name === "hp-site-php")?.hostConfig.Binds ?? [];

  it("deploy with phpIni writes the file and binds it read-only", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    expect(createdBinds(mockDaemon)).toEqual([
      "hp_vol_svc_php_html:/var/www/html",
      `${sitePhpIniPath(sitePhpDir, "svc_php")}:${SITE_PHP_INI_TARGET}:ro`,
    ]);
    expect(await readFile(sitePhpIniPath(sitePhpDir, "svc_php"), "utf8")).toBe(renderPhpIni(PHP_INI));
    expect((await stat(sitePhpIniPath(sitePhpDir, "svc_php"))).mode & 0o777).toBe(0o644);
  });

  it("deploy without phpIni leaves the binds and the directory untouched", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput()));
    expect(createdBinds(mockDaemon)).toEqual(["hp_vol_svc_php_html:/var/www/html"]);
    await expect(stat(sitePhpDir)).rejects.toThrow();
  });

  it("redeploy without phpIni drops the bind", async () => {
    const { adapter, mockDaemon } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    expect(createdBinds(mockDaemon)).toHaveLength(2);
    await adapter.deployService(createApprovedServiceSpec({ ...specInput(), revisionNumber: 2, specHash: "hash_php2" }));
    expect(createdBinds(mockDaemon)).toEqual(["hp_vol_svc_php_html:/var/www/html"]);
  });

  it("a redeploy with new values rewrites the file", async () => {
    const { adapter, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    await adapter.deployService(
      createApprovedServiceSpec({ ...specInput({ memory_limit: "512M" }), revisionNumber: 2, specHash: "hash_php2" }),
    );
    expect(await readFile(sitePhpIniPath(sitePhpDir, "svc_php"), "utf8")).toBe(renderPhpIni({ memory_limit: "512M" }));
    expect(await readdir(sitePhpDir)).toEqual(["svc_php.ini"]);
  });

  it("a stopped site keeps its file, service delete removes it", async () => {
    const { adapter, sitePhpDir } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    await adapter.stopService("svc_php");
    await expect(stat(sitePhpIniPath(sitePhpDir, "svc_php"))).resolves.toBeTruthy();
    await adapter.deleteService("svc_php");
    await expect(stat(sitePhpIniPath(sitePhpDir, "svc_php"))).rejects.toThrow();
    await expect(adapter.deleteService("svc_php")).resolves.toMatchObject({ status: "succeeded" });
  });

  it("observed state does not call its own PHP bind out-of-band drift", async () => {
    const { adapter } = await setup();
    await adapter.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    expect(await adapter.getObservedState("svc_php")).toMatchObject({ outOfBandModified: false });
  });

  it("deploy over signed IPC keeps phpIni and binds the file", async () => {
    const { adapter, mockDaemon, sitePhpDir } = await setup();
    const socketPath = `/tmp/hp-exec-test-${randomBytes(5).toString("hex")}.sock`;
    const server = new DockerExecutorIpcServer({
      executor: adapter,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
    });
    cleanupTasks.push(() => server.stop());
    await server.start();
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, transport: "uds", socketPath });
    await client.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    expect(createdBinds(mockDaemon).slice(1)).toEqual(sitePhpBinds(sitePhpDir, "svc_php"));
    expect(await readFile(sitePhpIniPath(sitePhpDir, "svc_php"), "utf8")).toBe(renderPhpIni(PHP_INI));

    await client.deployService(createApprovedServiceSpec({ ...specInput(), revisionNumber: 2, specHash: "hash_php2" }));
    expect(createdBinds(mockDaemon)).toEqual(["hp_vol_svc_php_html:/var/www/html"]);
  });
});

describe("simulator PHP ini", () => {
  it("records what the real executor would write and forgets it on a spec without it", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await sim.deployService(createApprovedServiceSpec(specInput({ ...PHP_INI })));
    expect(sim.phpIniByService.get("svc_php")).toBe(renderPhpIni(PHP_INI));
    expect(sim.deployedSpecs.at(-1)?.phpIni).toEqual(PHP_INI);

    await sim.deployService(createApprovedServiceSpec({ ...specInput(), revisionNumber: 2, specHash: "hash_php2" }));
    expect(sim.phpIniByService.has("svc_php")).toBe(false);
  });

  it("an absent phpIni records nothing, and a service delete forgets the file", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await sim.deployService(createApprovedServiceSpec(specInput()));
    expect(sim.phpIniByService.size).toBe(0);
    await sim.deployService(createApprovedServiceSpec({ ...specInput({ ...PHP_INI }), revisionNumber: 2, specHash: "hash_php2" }));
    await sim.deleteService("svc_php");
    expect(sim.phpIniByService.size).toBe(0);
  });

  it("an invalid value fails like the real executor", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const bad = { ...createApprovedServiceSpec(specInput()), phpIni: { memory_limit: "1\nauto_prepend_file=x" } };
    await expect(sim.deployService(bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(sim.phpIniByService.size).toBe(0);
  });
});

describe("site-php exports and host directory", () => {
  it("writes and removes through the public index exports", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-php-index-"));
    try {
      const dir = path.join(tmp, "site-php");
      await writeSitePhpIni(dir, "svc_x", PHP_INI);
      expect(await readdir(dir)).toEqual(["svc_x.ini"]);
      await removeSitePhpIni(dir, "svc_x");
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("bootstrap-dedicated.sh creates the directory and names it in the dry run", async () => {
    const script = await readFile(
      path.resolve(import.meta.dirname, "../../../infra/linux/bootstrap-dedicated.sh"),
      "utf8",
    );
    const install = "install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-php";
    expect(script).toContain(install);
    expect(script).toContain("/var/lib/hosting-panel/site-php (0755 hp-executor:hp-executor)");
    const lines = script.split("\n");
    expect(lines.indexOf(install)).toBe(
      lines.indexOf("install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-mail") + 1,
    );
  });
});
