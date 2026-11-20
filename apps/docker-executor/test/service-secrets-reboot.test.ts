import { statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerEngineSocketAdapter } from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const SVC = "svc_prod_web";
const SECRETS = { DB_PASSWORD: "pw-one", API_TOKEN: "tok-one" } as const;
const NAMES = Object.keys(SECRETS);

async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chmodTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

describe("service secret files after a reboot (#7)", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
  });

  async function setup() {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-exec-reboot-"));
    cleanupTasks.push(async () => {
      await chmodTree(tmpBaseDir);
      await rm(tmpBaseDir, { recursive: true, force: true });
    });
    const secretsRootDir = path.join(tmpBaseDir, "secrets");
    const serviceDir = path.join(secretsRootDir, SVC);
    /** For each POST start/restart: whether every secret source was a regular file at that moment. */
    const snapshots: { action: string; allFiles: boolean }[] = [];
    const mockDaemon = await startMockDockerDaemon({
      onRequest(method, routePath) {
        const m = /^(?:\/v1\.\d+)?\/containers\/[^/]+\/(start|restart)$/.exec(routePath);
        if (method !== "POST" || !m) return;
        const allFiles = NAMES.every((name) => {
          try {
            return statSync(path.join(serviceDir, name)).isFile();
          } catch {
            return false;
          }
        });
        snapshots.push({ action: m[1] ?? "", allFiles });
      },
    });
    cleanupTasks.push(() => mockDaemon.close());
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir,
      ingressRootDir: path.join(tmpBaseDir, "ingress"),
      ingressHttpPort: 18080,
      pullMissingImages: false,
    });
    const spec = createApprovedServiceSpec({
      serviceInstanceId: SVC,
      siteId: "site_alpha",
      organizationId: "org_alpha",
      image: "ghcr.io/example/webapp:1.4.2",
      containerName: "hp-site-alpha-web",
      env: { NODE_ENV: "production" },
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 192,
      revisionNumber: 7,
      specHash: "hash_alpha_rev_7",
      domains: ["alpha.hosting.example"],
      exposeHttp: true,
      internalPort: 3000,
      volumeMounts: [],
      resolvedSecrets: { ...SECRETS },
    });
    expect((await adapter.deployService(spec)).status).toBe("succeeded");
    snapshots.length = 0;
    return { adapter, spec, secretsRootDir, serviceDir, snapshots };
  }

  /** What Docker leaves at boot for a missing bind source: one folder per secret name. */
  async function simulateReboot(serviceDir: string): Promise<void> {
    await chmodTree(serviceDir);
    await rm(serviceDir, { recursive: true, force: true });
    for (const name of NAMES) await mkdir(path.join(serviceDir, name), { recursive: true });
  }

  async function expectSecretFiles(
    serviceDir: string,
    expected: Record<string, string> = { ...SECRETS },
  ): Promise<void> {
    expect((await stat(serviceDir)).mode & 0o777).toBe(0o700);
    for (const [name, value] of Object.entries(expected)) {
      const st = await lstat(path.join(serviceDir, name));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o444);
      expect(await readFile(path.join(serviceDir, name), "utf8")).toBe(value);
    }
  }

  it("restart writes the secret files again before Docker restarts the container", async () => {
    const { adapter, serviceDir, snapshots } = await setup();
    await rm(serviceDir, { recursive: true, force: true });

    expect((await adapter.restartService(SVC, SECRETS)).status).toBe("succeeded");

    await expectSecretFiles(serviceDir);
    expect(snapshots).toEqual([{ action: "restart", allFiles: true }]);
  });

  it("restart replaces a folder that stands where a secret file should be", async () => {
    const { adapter, serviceDir, snapshots } = await setup();
    await simulateReboot(serviceDir);

    await adapter.restartService(SVC, SECRETS);

    await expectSecretFiles(serviceDir);
    expect(snapshots).toEqual([{ action: "restart", allFiles: true }]);
  });

  it("a service folder the executor does not own is set aside, then written", async () => {
    const { adapter, serviceDir, snapshots } = await setup();
    await simulateReboot(serviceDir);
    // The open handle keeps the old inode alive, so the file system cannot hand it out again.
    const oldDir = await open(serviceDir, "r");
    cleanupTasks.push(() => oldDir.close());
    const before = (await oldDir.stat()).ino;
    const realUid = process.getuid?.() ?? 0;

    const spy = vi.spyOn(process, "getuid").mockReturnValue(realUid + 1);
    try {
      await adapter.restartService(SVC, SECRETS);
    } finally {
      spy.mockRestore();
    }

    expect((await stat(serviceDir)).ino).not.toBe(before);
    await expectSecretFiles(serviceDir);
    expect(snapshots).toEqual([{ action: "restart", allFiles: true }]);
  });

  it("a folder the executor cannot empty is set aside, then written", async () => {
    const { adapter, serviceDir, snapshots } = await setup();
    await simulateReboot(serviceDir);
    const leaf = path.join(serviceDir, "DB_PASSWORD");
    await writeFile(path.join(leaf, "stray"), "x");
    await chmod(leaf, 0o555);

    await adapter.restartService(SVC, SECRETS);

    await expectSecretFiles(serviceDir);
    expect(snapshots).toEqual([{ action: "restart", allFiles: true }]);
  });

  it("deploy replaces the folders and starts the container with the files", async () => {
    const { adapter, spec, serviceDir, snapshots } = await setup();
    await simulateReboot(serviceDir);

    expect((await adapter.deployService(spec)).status).toBe("succeeded");

    await expectSecretFiles(serviceDir);
    expect(snapshots.filter((s) => s.action === "start")).not.toHaveLength(0);
    expect(snapshots.every((s) => s.allFiles)).toBe(true);
  });

  it("stop, then restart, writes the secret files again (L41)", async () => {
    const { adapter, serviceDir, snapshots } = await setup();
    await adapter.stopService(SVC);
    await expect(stat(serviceDir)).rejects.toMatchObject({ code: "ENOENT" });

    await adapter.restartService(SVC, SECRETS);

    await expectSecretFiles(serviceDir);
    expect(snapshots).toEqual([{ action: "restart", allFiles: true }]);
  });

  it("stop removes a service folder the executor cannot empty", async () => {
    const { adapter, serviceDir } = await setup();
    await simulateReboot(serviceDir);
    const leaf = path.join(serviceDir, "DB_PASSWORD");
    await writeFile(path.join(leaf, "stray"), "x");
    await chmod(leaf, 0o555);

    expect((await adapter.stopService(SVC)).status).toBe("succeeded");

    await expect(stat(serviceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restart with secrets adds files and keeps the others", async () => {
    const { adapter, serviceDir } = await setup();

    await adapter.restartService(SVC, { DB_PASSWORD: "pw-two" });

    await expectSecretFiles(serviceDir, { DB_PASSWORD: "pw-two", API_TOKEN: "tok-one" });
  });

  it("restart without secrets and restart of a missing container write nothing", async () => {
    const { adapter, secretsRootDir, serviceDir } = await setup();
    await rm(serviceDir, { recursive: true, force: true });

    await adapter.restartService(SVC);
    await expect(stat(serviceDir)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(adapter.restartService("svc_missing", SECRETS)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(stat(path.join(secretsRootDir, "svc_missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
