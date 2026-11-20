import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { DockerEngineSocketAdapter, InMemoryDockerSimulatorAdapter } from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const SVC = "svc_qa_secrets";
const SECRETS = { DB_PASSWORD: "pw-one", API_TOKEN: "tok-one" } as const;
const NAMES = Object.keys(SECRETS).sort();

async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) await chmodTree(child);
    else if (!entry.isSymbolicLink()) await chmod(child, 0o600).catch(() => undefined);
  }
}

describe("service secret files: hostile entries after a reboot (#7 QA)", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) await cleanupTasks.pop()?.();
  });

  function makeSpec() {
    return createApprovedServiceSpec({
      serviceInstanceId: SVC,
      siteId: "site_qa",
      organizationId: "org_qa",
      image: "ghcr.io/example/webapp:1.4.2",
      containerName: "hp-site-qa-web",
      env: { NODE_ENV: "production" },
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 192,
      revisionNumber: 1,
      specHash: "hash_qa_rev_1",
      domains: ["qa.hosting.example"],
      exposeHttp: true,
      internalPort: 3000,
      volumeMounts: [],
      resolvedSecrets: { ...SECRETS },
    });
  }

  async function tempBase() {
    const base = await mkdtemp(path.join(os.tmpdir(), "hp-exec-secrets-qa-"));
    cleanupTasks.push(async () => {
      await chmodTree(base);
      await rm(base, { recursive: true, force: true });
    });
    return base;
  }

  async function setup() {
    const base = await tempBase();
    const secretsRootDir = path.join(base, "secrets");
    const serviceDir = path.join(secretsRootDir, SVC);
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    const mockDaemon = await startMockDockerDaemon({});
    cleanupTasks.push(() => mockDaemon.close());
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir,
      ingressRootDir: path.join(base, "ingress"),
      ingressHttpPort: 18080,
      pullMissingImages: false,
    });
    const spec = makeSpec();
    expect((await adapter.deployService(spec)).status).toBe("succeeded");
    return { adapter, spec, secretsRootDir, serviceDir, outside };
  }

  const staleEntries = async (root: string) =>
    (await readdir(root)).filter((n) => n.startsWith(".stale-"));

  /** A real 0700 folder holding exactly the expected 0444 regular files and nothing else (no temp leftovers). */
  async function expectGoodFolder(serviceDir: string, expected: Record<string, string> = { ...SECRETS }) {
    const dir = await lstat(serviceDir);
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o777).toBe(0o700);
    expect((await readdir(serviceDir)).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, value] of Object.entries(expected)) {
      const st = await lstat(path.join(serviceDir, name));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o444);
      expect(await readFile(path.join(serviceDir, name), "utf8")).toBe(value);
    }
  }

  const act = (adapter: DockerEngineSocketAdapter, spec: ReturnType<typeof makeSpec>, action: "restart" | "deploy") =>
    action === "restart" ? adapter.restartService(SVC, SECRETS) : adapter.deployService(spec);

  it.each(["restart", "deploy"] as const)(
    "%s never follows a symlink standing where the service folder should be",
    async (action) => {
      const { adapter, spec, serviceDir, outside } = await setup();
      await writeFile(path.join(outside, "DB_PASSWORD"), "keep", { mode: 0o600 });
      await rm(serviceDir, { recursive: true, force: true });
      await symlink(outside, serviceDir);

      expect((await act(adapter, spec, action)).status).toBe("succeeded");

      await expectGoodFolder(serviceDir);
      expect(await readdir(outside)).toEqual(["DB_PASSWORD"]);
      expect(await readFile(path.join(outside, "DB_PASSWORD"), "utf8")).toBe("keep");
      expect((await stat(path.join(outside, "DB_PASSWORD"))).mode & 0o777).toBe(0o600);
      expect((await stat(outside)).mode & 0o777).not.toBe(0o700);
    },
  );

  it("a dangling symlink standing where the service folder should be creates nothing at its target", async () => {
    const { adapter, serviceDir, outside } = await setup();
    const target = path.join(outside, "not-yet");
    await rm(serviceDir, { recursive: true, force: true });
    await symlink(target, serviceDir);

    await adapter.restartService(SVC, SECRETS);

    await expectGoodFolder(serviceDir);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["restart", "deploy"] as const)(
    "%s never writes through a symlink standing where a secret file should be",
    async (action) => {
      const { adapter, spec, serviceDir, outside } = await setup();
      const victimFile = path.join(outside, "victim.txt");
      const victimDir = path.join(outside, "victim-dir");
      await writeFile(victimFile, "keep", { mode: 0o600 });
      await mkdir(victimDir);
      await rm(path.join(serviceDir, "DB_PASSWORD"));
      await rm(path.join(serviceDir, "API_TOKEN"));
      await symlink(victimFile, path.join(serviceDir, "DB_PASSWORD"));
      await symlink(victimDir, path.join(serviceDir, "API_TOKEN"));

      expect((await act(adapter, spec, action)).status).toBe("succeeded");

      await expectGoodFolder(serviceDir);
      expect(await readFile(victimFile, "utf8")).toBe("keep");
      expect((await stat(victimFile)).mode & 0o777).toBe(0o600);
      expect(await readdir(victimDir)).toEqual([]);
    },
  );

  it.each(["restart", "deploy"] as const)(
    "%s replaces a regular file standing where the service folder should be",
    async (action) => {
      const { adapter, spec, secretsRootDir, serviceDir } = await setup();
      await rm(serviceDir, { recursive: true, force: true });
      await writeFile(serviceDir, "not a folder", { mode: 0o644 });

      expect((await act(adapter, spec, action)).status).toBe("succeeded");

      await expectGoodFolder(serviceDir);
      expect(await staleEntries(secretsRootDir)).toEqual([]);
    },
  );

  it("a folder on one secret name repairs that name only; the good file is rewritten and nothing is set aside", async () => {
    const { adapter, secretsRootDir, serviceDir } = await setup();
    await rm(path.join(serviceDir, "DB_PASSWORD"));
    await mkdir(path.join(serviceDir, "DB_PASSWORD", "nested"), { recursive: true });

    await adapter.restartService(SVC, SECRETS);

    await expectGoodFolder(serviceDir);
    expect(await staleEntries(secretsRootDir)).toEqual([]);
  });

  describe(".stale-* entries", () => {
    /** A folder the executor cannot empty (leaf 0555 with content) forces the whole <svc> folder aside. */
    async function simulateStuckReboot(serviceDir: string): Promise<void> {
      await chmodTree(serviceDir);
      await rm(serviceDir, { recursive: true, force: true });
      for (const name of NAMES) await mkdir(path.join(serviceDir, name), { recursive: true });
      await writeFile(path.join(serviceDir, "DB_PASSWORD", "stray"), "x");
      await chmod(path.join(serviceDir, "DB_PASSWORD"), 0o555);
    }

    it("repairs after the first one add nothing, so a boot costs at most one entry per service", async () => {
      const { adapter, secretsRootDir, serviceDir } = await setup();
      await simulateStuckReboot(serviceDir);

      await adapter.restartService(SVC, SECRETS);
      expect(await staleEntries(secretsRootDir)).toHaveLength(1);

      await adapter.restartService(SVC, SECRETS);
      await adapter.restartService(SVC, SECRETS);
      expect(await staleEntries(secretsRootDir)).toHaveLength(1);
      await expectGoodFolder(serviceDir);
    });

    it("entries pile up at most one per reboot, and nothing in the executor removes them (tmpfs does at boot)", async () => {
      const { adapter, secretsRootDir, serviceDir } = await setup();
      for (let reboot = 1; reboot <= 3; reboot += 1) {
        await simulateStuckReboot(serviceDir);
        await adapter.restartService(SVC, SECRETS);
        expect((await staleEntries(secretsRootDir)).length).toBeLessThanOrEqual(reboot);
      }
      await expectGoodFolder(serviceDir);
      // Stop is the one action that purges: it removes the live folder, and the earlier entries stay.
      await adapter.stopService(SVC);
      expect((await staleEntries(secretsRootDir)).length).toBeGreaterThan(0);
    });
  });

  it.each([undefined, {}] as const)(
    "restart with %j secrets after a reboot writes nothing, sets nothing aside and does not throw",
    async (secrets) => {
      const { adapter, secretsRootDir, serviceDir } = await setup();
      await chmodTree(serviceDir);
      await rm(serviceDir, { recursive: true, force: true });
      for (const name of NAMES) await mkdir(path.join(serviceDir, name), { recursive: true });

      await expect(adapter.restartService(SVC, secrets)).resolves.toMatchObject({ status: "succeeded" });

      for (const name of NAMES) expect((await lstat(path.join(serviceDir, name))).isDirectory()).toBe(true);
      expect(await readdir(secretsRootDir)).toEqual([SVC]);
    },
  );

  it("the simulator with a secrets folder repairs a folder on a secret name at restart, keeping the other files", async () => {
    const base = await tempBase();
    const secretsRootDir = path.join(base, "secrets");
    const serviceDir = path.join(secretsRootDir, SVC);
    const simulator = new InMemoryDockerSimulatorAdapter({ secretsRootDir });
    await simulator.deployService(makeSpec());
    await rm(path.join(serviceDir, "DB_PASSWORD"));
    await mkdir(path.join(serviceDir, "DB_PASSWORD"));
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await rm(path.join(serviceDir, "API_TOKEN"));
    await symlink(outside, path.join(serviceDir, "API_TOKEN"));

    await simulator.restartService(SVC, { DB_PASSWORD: "pw-two", API_TOKEN: "tok-two" });

    await expectGoodFolder(serviceDir, { DB_PASSWORD: "pw-two", API_TOKEN: "tok-two" });
    expect(await readdir(outside)).toEqual([]);
  });
});
