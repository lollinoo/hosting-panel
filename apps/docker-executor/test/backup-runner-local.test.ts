import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackupsIpcRequest } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BackupRunner,
  type BackupRunnerDeps,
  type DockerRequest,
} from "../src/index.js";

const BACKUP_KEY = "deadbeef".repeat(8);
const SNAPSHOT_ID = "a1b2c3d4".repeat(8);
const TARGET_ID = `bkt_${"ab".repeat(16)}`;
const LOCAL_TARGET = { kind: "local", targetId: TARGET_ID } as const;
const OP = (n: number, suffix = ""): string => `op_${n.toString(16).padStart(32, "0")}${suffix}`;
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;
const GIB = 1024 * 1024 * 1024;
const FLOOR = BACKUP_DISK_FREE_FLOOR_BYTES;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanups.splice(0).reverse()) await task();
});

const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const summaryLine = (totalBytes = 65536, filesNew = 4): string =>
  JSON.stringify({
    message_type: "summary",
    snapshot_id: SNAPSHOT_ID,
    data_added: 4096,
    total_bytes_processed: totalBytes,
    files_new: filesNew,
    files_changed: 0,
    files_unmodified: 0,
    total_duration: 1,
  });

interface Created {
  readonly name: string;
  readonly payload: {
    readonly User?: string;
    readonly Env?: readonly string[];
    readonly HostConfig: {
      readonly NetworkMode: string;
      readonly Binds?: readonly string[];
      readonly Mounts?: readonly { Source: string; Target: string; ReadOnly: boolean }[];
      readonly GroupAdd?: readonly string[];
    };
  };
  /** The files of every job secret directory at create time. */
  readonly secrets: Record<string, string>;
}

interface StepBehavior {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly onStart?: () => Promise<void>;
}

async function setup(opts?: {
  steps?: (name: string) => StepBehavior;
  databases?: readonly { name: string; sizeBytes: number }[];
  bytesAvailable?: bigint;
  localRepoRoot?: string | null;
  executorUser?: string;
}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-runner-local-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  const root = path.join(tmp, "repos");
  // What bootstrap-dedicated.sh does: the root is 2770, so the guard's folders inherit setgid.
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o2770);
  const panelDumpDir = path.join(tmp, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o770 });
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${BACKUP_KEY}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "db-root.key");
  await writeFile(sharedDbRootKeyFile, "db-root-pass", { mode: 0o400 });

  const created: Created[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  const behaviors = new Map<string, StepBehavior>();
  const liveVolumes = new Set<string>(["hp_vol_svc_site1_html"]);
  const fetchSpy = vi.fn(async () => new Response("<ListBucketResult/>", { status: 200 }));
  const networkSpy = vi.fn(async () => undefined);
  const ensured: string[] = [];

  const json = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const empty = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });
  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath });
    const url = new URL(`http://docker${reqPath}`);
    const p = url.pathname;
    if (method === "POST" && p === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      behaviors.set(name, opts?.steps?.(name) ?? {});
      const secrets: Record<string, string> = {};
      const m = /job_bk_[^/]+/.exec(JSON.stringify(body));
      if (m) {
        const dir = path.join(secretsRootDir, m[0]);
        for (const f of await readdir(dir).catch(() => [])) secrets[f] = await readFile(path.join(dir, f), "utf8");
      }
      created.push({ name, payload: body as Created["payload"], secrets });
      return json(201, { Id: `id_${name}` });
    }
    const op = /^\/containers\/id_([^/]+)\/(start|wait|logs|kill)$/.exec(p);
    if (op) {
      const b = behaviors.get(op[1]!) ?? {};
      if (op[2] === "start") {
        await b.onStart?.();
        return empty(204);
      }
      if (op[2] === "wait") return json(200, { StatusCode: b.exitCode ?? 0 });
      if (op[2] === "logs") {
        const wantOut = url.searchParams.get("stdout") === "1";
        const text = wantOut ? b.stdout : b.stderr;
        return { statusCode: 200, body: text ? frame(wantOut ? 1 : 2, text) : Buffer.alloc(0) };
      }
      return empty(204);
    }
    if (method === "DELETE" && p.startsWith("/containers/")) return empty(204);
    if (method === "POST" && p === "/volumes/create") {
      liveVolumes.add((body as { Name: string }).Name);
      return json(201, {});
    }
    const vol = /^\/volumes\/([^/]+)$/.exec(p);
    if (vol) {
      const name = decodeURIComponent(vol[1]!);
      if (method === "GET") return liveVolumes.has(name) ? json(200, { Name: name }) : json(404, {});
      liveVolumes.delete(name);
      return empty(204);
    }
    throw new Error(`Unexpected Docker call ${method} ${reqPath}`);
  };

  const deps: BackupRunnerDeps = {
    request,
    ensureImage: async (image) => void ensured.push(image),
    ensureBackupNetwork: networkSpy,
    listSiteDatabases: async () => opts?.databases ?? [{ name: "wp_0123456789ab", sizeBytes: 2048 }],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: opts?.executorUser ?? `${UID}:${GID}`,
    backupWorkDir: path.join(tmp, "backup-work"),
    panelDumpDir,
    sharedDbDataDir: path.join(tmp, "mariadb-data"),
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
    localRepoRoot: opts?.localRepoRoot === undefined ? root : opts.localRepoRoot,
    localTargetStatfs: async () => ({
      bsize: 1n,
      blocks: 100n * BigInt(GIB),
      bavail: opts?.bytesAvailable ?? 50n * BigInt(GIB),
      files: 1000n,
      ffree: 1000n,
    }),
  };
  const runner = new BackupRunner(deps);
  return {
    runner,
    deps,
    tmp,
    root,
    panelDumpDir,
    secretsRootDir,
    created,
    requests,
    fetchSpy,
    networkSpy,
    ensured,
    createdNames: () => created.map((c) => c.name),
    newRunner: () => new BackupRunner(deps),
  };
}

async function settled(runner: BackupRunner, jobId: string) {
  const until = performance.now() + 3_000;
  while (performance.now() < until) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`job ${jobId} did not settle`);
}

const startReq = (jobId: string, extra: Partial<Extract<BackupsIpcRequest, { action: "start" }>> = {}) =>
  ({
    action: "start",
    jobId,
    siteId: "site1",
    serviceInstanceId: "svc_site1",
    target: LOCAL_TARGET,
    ...extra,
  }) as Extract<BackupsIpcRequest, { action: "start" }>;

const upStep = (name: string): StepBehavior =>
  name.endsWith("_up") ? { stdout: summaryLine() } : {};

async function initTarget(env: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toMatchObject({ outcome: "ok" });
  env.created.length = 0;
  env.requests.length = 0;
  env.networkSpy.mockClear();
}

describe("BackupRunner local targets", () => {
  it("localInit creates marker and dirs, tests the panel repo as the executor and reports bytes and the root", async () => {
    const env = await setup();
    const result = await env.runner.run({ action: "localInit", target: LOCAL_TARGET });

    expect(result).toEqual({
      outcome: "ok",
      problem: null,
      availableBytes: 50 * GIB,
      totalBytes: 100 * GIB,
      localRoot: env.root,
    });
    expect(await readFile(path.join(env.root, TARGET_ID, ".hp-local-target"), "utf8")).toBe(
      `hosting-panel local backup target ${TARGET_ID}\n`,
    );
    expect(((await stat(path.join(env.root, TARGET_ID, "panel"))).mode & 0o7777).toString(8)).toBe("2770");

    expect(env.created).toHaveLength(1);
    const [test] = env.created;
    expect(test!.name).toMatch(/^hp_bk_test_[0-9a-f]{16}$/);
    expect(test!.payload.User).toBe(`${UID}:${GID}`);
    expect(test!.payload.HostConfig.NetworkMode).toBe("none");
    expect(test!.payload.HostConfig.Mounts).toEqual([
      {
        Type: "bind",
        Source: path.join(env.root, TARGET_ID, "panel"),
        Target: "/backup/repository/panel",
        ReadOnly: false,
      },
    ]);
    expect(test!.payload.HostConfig.GroupAdd).toEqual([String(GID)]);
    // BKP-04: only the restic password reaches the container; no S3 contact, no backup network.
    expect(Object.keys(test!.secrets)).toEqual(["RESTIC_PASSWORD"]);
    expect(JSON.stringify(test!.payload)).not.toMatch(/AWS_|HP_REGION|s3\./);
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("localInit is idempotent and test reuses the guard without creating the target", async () => {
    const env = await setup();
    await initTarget(env);
    await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toMatchObject({ outcome: "ok" });
    await expect(env.runner.run({ action: "test", target: LOCAL_TARGET })).resolves.toMatchObject({
      outcome: "ok",
      availableBytes: 50 * GIB,
      localRoot: env.root,
    });

    const other = { kind: "local", targetId: `bkt_${"cd".repeat(16)}` } as const;
    await expect(env.runner.run({ action: "test", target: other })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_unmounted",
    });
    expect(await readdir(env.root)).toEqual([TARGET_ID]);
  });

  it("answers local_target_unsafe for every local request when the root is invalid", async () => {
    const env = await setup({ localRepoRoot: null });
    await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_unsafe",
    });
    await expect(env.runner.run({ action: "test", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_unsafe",
    });
    expect(env.created).toEqual([]);
  });

  it("reports key_file_missing and no_space before any container on a local test", async () => {
    const env = await setup({ bytesAvailable: BigInt(FLOOR - 1) });
    await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "no_space",
    });
    expect(env.created).toEqual([]);
  });

  it("maps restic stderr of a local test through the local classifier", async () => {
    const env = await setup({
      steps: (name) => (name.startsWith("hp_bk_test_") ? { exitCode: 1, stderr: "Fatal: Read-only file system" } : {}),
    });
    await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_readonly",
    });
  });

  it("runs a local start without S3, AWS secret or backup network, binding only its own leaf", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);

    const jobId = OP(1);
    await env.runner.run(startReq(jobId));
    const status = await settled(env.runner, jobId);

    expect(status).toMatchObject({ state: "succeeded", failure: null, snapshot: { snapshotId: SNAPSHOT_ID } });
    expect(env.createdNames()).toEqual([`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_dump`, `hp_bk_${jobId}_up`]);
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();

    const leaf = path.join(env.root, TARGET_ID, "sites", "site1");
    const containerPath = "/backup/repository/sites/site1";
    for (const name of [`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_up`]) {
      const c = env.created.find((x) => x.name === name)!;
      expect(c.payload.HostConfig.Mounts).toEqual([{ Type: "bind", Source: leaf, Target: containerPath, ReadOnly: false }]);
      expect(c.payload.HostConfig.NetworkMode).toBe("none");
      expect(c.payload.HostConfig.GroupAdd).toEqual([String(GID)]);
      expect(c.payload.Env).toContain(`RESTIC_REPOSITORY=${containerPath}`);
      expect(Object.keys(c.secrets)).toEqual(["RESTIC_PASSWORD"]);
      expect(JSON.stringify(c.payload)).not.toMatch(/AWS_|HP_REGION|s3\./);
      expect((c.payload.HostConfig.Binds ?? []).some((b) => b.includes(leaf))).toBe(false);
    }
    expect(((await stat(leaf)).mode & 0o7777).toString(8)).toBe("2770");
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("names the second copy op_x-t2 (containers and secrets) and accepts it for start", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);

    const jobId = OP(2, "-t2");
    await env.runner.run(startReq(jobId));
    await expect(settled(env.runner, jobId)).resolves.toMatchObject({ state: "succeeded" });

    expect(env.createdNames()).toEqual([`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_dump`, `hp_bk_${jobId}_up`]);
    expect(env.requests.some((r) => r.path.includes(`name=hp_bk_${jobId}_repo`))).toBe(true);
    const secretNames = env.created.map((c) => /job_bk_[^"/]+/.exec(JSON.stringify(c.payload))?.[0]);
    expect(new Set(secretNames.filter((s) => s !== undefined))).toEqual(new Set([`job_bk_${jobId}`]));
  });

  it("fails a local start with the guard class and creates zero containers and no staging volume (BKP-05)", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    await unlink(path.join(env.root, TARGET_ID, ".hp-local-target"));

    const jobId = OP(3);
    await env.runner.run(startReq(jobId));
    const status = await settled(env.runner, jobId);

    expect(status).toMatchObject({ state: "failed", failure: "local_target_unmounted", snapshot: null });
    expect(env.created).toEqual([]);
    expect(env.requests.filter((r) => r.path.startsWith("/volumes/create"))).toEqual([]);
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("refuses a symlinked target directory and writes nothing outside the root", async () => {
    const env = await setup({ steps: upStep });
    const outside = path.join(env.tmp, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(env.root, TARGET_ID));

    const jobId = OP(4);
    await env.runner.run(startReq(jobId));
    await expect(settled(env.runner, jobId)).resolves.toMatchObject({ state: "failed", failure: "local_target_unsafe" });
    expect(await readdir(outside)).toEqual([]);
    expect(env.created).toEqual([]);
  });

  it("sizes the local backup guard as the free-space floor plus the sum of the database sizes (BKP-06)", async () => {
    const databases = [
      { name: "wp_0123456789ab", sizeBytes: 3 * GIB },
      { name: "wp_0123456789cd", sizeBytes: GIB },
    ];
    const short = await setup({ steps: upStep, databases, bytesAvailable: BigInt(FLOOR + 4 * GIB - 1) });
    await initTarget(short);
    await short.runner.run(startReq(OP(5)));
    await expect(settled(short.runner, OP(5))).resolves.toMatchObject({ state: "failed", failure: "no_space" });
    expect(short.created).toEqual([]);

    const exact = await setup({ steps: upStep, databases, bytesAvailable: BigInt(FLOOR + 4 * GIB) });
    await initTarget(exact);
    await exact.runner.run(startReq(OP(6)));
    await expect(settled(exact.runner, OP(6))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("classifies a local restic failure with the local classifier", async () => {
    const env = await setup({
      steps: (name) => (name.endsWith("_up") ? { exitCode: 1, stderr: "Fatal: permission denied" } : {}),
    });
    await initTarget(env);
    await env.runner.run(startReq(OP(7)));
    await expect(settled(env.runner, OP(7))).resolves.toMatchObject({ state: "failed", failure: "local_target_unsafe" });
  });

  it("forgets from a local repository through its leaf only, without S3 or network", async () => {
    const env = await setup();
    await initTarget(env);
    const jobId = OP(8, "-forget");
    await env.runner.run({ action: "forget", jobId, siteId: "site1", target: LOCAL_TARGET, snapshotIds: [SNAPSHOT_ID] });
    await expect(settled(env.runner, jobId)).resolves.toMatchObject({ state: "succeeded" });

    expect(env.createdNames()).toEqual([`hp_bk_${jobId}_repo`, `hp_bk_${jobId}_forget`]);
    for (const c of env.created) {
      expect(c.payload.HostConfig.Mounts).toHaveLength(1);
      expect(c.payload.HostConfig.Mounts![0]!.Target).toBe("/backup/repository/sites/site1");
      expect(Object.keys(c.secrets)).toEqual(["RESTIC_PASSWORD"]);
    }
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();
  });

  it("archives from an existing local leaf and fails with other when the leaf is missing (read intent never creates it)", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const missing = OP(9);
    await env.runner.run({ action: "archive", jobId: missing, siteId: "site1", snapshotId: SNAPSHOT_ID, target: LOCAL_TARGET });
    await expect(settled(env.runner, missing)).resolves.toMatchObject({ state: "failed", failure: "other" });
    expect(env.created).toEqual([]);
    await expect(stat(path.join(env.root, TARGET_ID, "sites", "site1"))).rejects.toThrow();

    await env.runner.run(startReq(OP(10)));
    await settled(env.runner, OP(10));
    env.created.length = 0;

    const jobId = OP(11);
    await env.runner.run({ action: "archive", jobId, siteId: "site1", snapshotId: SNAPSHOT_ID, target: LOCAL_TARGET });
    // The fake container writes no zip: the job ends "other" after the local container ran.
    await settled(env.runner, jobId);
    expect(env.createdNames()).toEqual([`hp_bk_${jobId}_zip`]);
    const zip = env.created[0]!;
    expect(zip.payload.User).toBe(`${UID}:${GID}`);
    expect(zip.payload.HostConfig.NetworkMode).toBe("none");
    expect(zip.payload.HostConfig.Mounts!.some((m) => m.Target === "/backup/repository/sites/site1")).toBe(true);
    expect(Object.keys(zip.secrets)).toEqual(["RESTIC_PASSWORD"]);
    expect(env.networkSpy).not.toHaveBeenCalled();
  });

  it("restores through the local leaf, bypassing S3, and fails closed when the target is unmounted", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    await env.runner.run(startReq(OP(12)));
    await settled(env.runner, OP(12));
    env.created.length = 0;

    const jobId = OP(13);
    await env.runner.run({
      action: "restore",
      jobId,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      snapshotId: SNAPSHOT_ID,
      target: LOCAL_TARGET,
    });
    await settled(env.runner, jobId);
    const fetches = env.created.filter((c) => c.name.includes("_rs_fetch"));
    expect(fetches.length).toBeGreaterThan(0);
    for (const c of fetches) {
      expect(c.payload.HostConfig.NetworkMode).toBe("none");
      expect(c.payload.HostConfig.Mounts!.some((m) => m.Target === "/backup/repository/sites/site1")).toBe(true);
      expect(Object.keys(c.secrets)).not.toContain("AWS_SHARED_CREDENTIALS");
    }
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();

    await unlink(path.join(env.root, TARGET_ID, ".hp-local-target"));
    env.created.length = 0;
    const failing = OP(14);
    await env.runner.run({
      action: "restore",
      jobId: failing,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      snapshotId: SNAPSHOT_ID,
      target: LOCAL_TARGET,
    });
    await expect(settled(env.runner, failing)).resolves.toMatchObject({ state: "failed", failure: "local_target_unmounted" });
    expect(env.created).toEqual([]);
  });

  it("reports unknown for a local job after a restart (BKP-14)", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const jobId = OP(15, "-t2");
    await env.runner.run(startReq(jobId));
    await settled(env.runner, jobId);

    await expect(env.newRunner().run({ action: "status", jobId })).resolves.toEqual({
      jobId,
      state: "unknown",
      failure: null,
      snapshot: null,
    });
  });
});

describe("BackupRunner local panel backup", () => {
  const writeDump = async (dir: string, jobId: string, bytes = 100): Promise<number> => {
    const content = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(bytes - 5)]);
    await writeFile(path.join(dir, `${jobId}.dump`), content, { mode: 0o640 });
    return content.length;
  };
  const panelReq = (jobId: string) =>
    ({
      action: "panelStart",
      jobId,
      target: LOCAL_TARGET,
      masterKey: "ab".repeat(32),
      retentionDays: 30,
    }) as Extract<BackupsIpcRequest, { action: "panelStart" }>;

  it("backs the panel up to the local panel leaf as the executor and sizes the guard with the dump", async () => {
    const jobId = OP(20);
    const size = 100;
    const short = await setup({ bytesAvailable: BigInt(FLOOR + size - 1) });
    await writeDump(short.panelDumpDir, jobId, size);
    await initTarget(short);
    await short.runner.run(panelReq(jobId));
    await expect(settled(short.runner, jobId)).resolves.toMatchObject({ state: "failed", failure: "no_space" });
    expect(short.created).toEqual([]);

    const env = await setup({
      bytesAvailable: BigInt(FLOOR + size),
      steps: (name) => (name.endsWith("_pup") ? { stdout: summaryLine(size + 64, 2) } : {}),
    });
    await writeDump(env.panelDumpDir, jobId, size);
    await initTarget(env);
    await env.runner.run(panelReq(jobId));
    await expect(settled(env.runner, jobId)).resolves.toMatchObject({ state: "succeeded", snapshot: { snapshotId: SNAPSHOT_ID } });

    expect(env.createdNames()).toEqual([`hp_bk_${jobId}_prepo`, `hp_bk_${jobId}_pup`, `hp_bk_${jobId}_pkeep`]);
    for (const c of env.created) {
      expect(c.payload.User).toBe(`${UID}:${GID}`);
      expect(c.payload.HostConfig.NetworkMode).toBe("none");
      expect(c.payload.HostConfig.Mounts!.some((m) => m.Target === "/backup/repository/panel")).toBe(true);
      expect(JSON.stringify(c.payload)).not.toMatch(/AWS_|HP_REGION|s3\./);
    }
    const restic = env.created.filter((c) => c.name.endsWith("_prepo") || c.name.endsWith("_pup"));
    for (const c of restic) expect(Object.keys(c.secrets)).not.toContain("AWS_SHARED_CREDENTIALS");
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();
  });
});

describe("BackupRunner.fetchPanelCopy from a local repository (CLI only)", () => {
  const FETCH_OK: StepBehavior = {
    stdout: `HP_SNAP ${SNAPSHOT_ID} 2026-11-20T10:00:00Z\n`,
  };

  async function fetchEnv() {
    let out = "";
    const env = await setup({
      steps: () => ({
        ...FETCH_OK,
        onStart: async () => {
          await writeFile(path.join(out, "restore.pgdump"), "PGDMP-data");
          await writeFile(path.join(out, "restore.key"), "ab".repeat(32));
        },
      }),
    });
    out = path.join(env.tmp, "handover");
    await mkdir(out, { mode: 0o770 });
    const repoDir = path.join(env.tmp, "disk", "panel");
    await mkdir(repoDir, { recursive: true, mode: 0o2770 });
    await chmod(repoDir, 0o2770);
    return { env, out, repoDir };
  }

  it("runs a read-only, networkless fetch as the repository owner and returns the snapshot", async () => {
    const { env, out, repoDir } = await fetchEnv();
    const result = await env.runner.fetchPanelCopy({ kind: "local_repo", repoDir }, out);

    expect(result).toEqual({ ok: true, snapshotId: SNAPSHOT_ID, time: "2026-11-20T10:00:00.000Z" });
    expect(env.created).toHaveLength(1);
    const c = env.created[0]!;
    expect(c.payload.User).toBe(`${UID}:${GID}`);
    expect(c.payload.HostConfig.NetworkMode).toBe("none");
    expect(c.payload.HostConfig.Mounts![0]).toMatchObject({ Source: repoDir, Target: "/backup/repository/panel", ReadOnly: true });
    expect(Object.keys(c.secrets)).toEqual(["RESTIC_PASSWORD"]);
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("re-validates the directory: missing is unmounted; symlink, relative, non-canonical, o+w, denylisted and root-owned are unsafe", async () => {
    const { env, out, repoDir } = await fetchEnv();
    const run = (repoDirArg: string) => env.runner.fetchPanelCopy({ kind: "local_repo", repoDir: repoDirArg }, out);

    await expect(run(path.join(env.tmp, "gone"))).resolves.toEqual({ ok: false, problem: "local_target_unmounted" });

    const link = path.join(env.tmp, "link");
    await symlink(repoDir, link);
    await expect(run(link)).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });
    await expect(run("relative/panel")).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });
    await expect(run(`${repoDir}/../panel`)).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });
    await expect(run("/etc")).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });
    await expect(run("/var/lib/docker/volumes")).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });

    await chmod(repoDir, 0o2777);
    await expect(run(repoDir)).resolves.toEqual({ ok: false, problem: "local_target_unsafe" });
    expect(env.created).toEqual([]);
  });

  it("keeps the S3 target path unchanged (probe, backup network, AWS secret)", async () => {
    const { env, out } = await fetchEnv();
    const result = await env.runner.fetchPanelCopy(
      {
        endpoint: "https://storage.example.com:9000",
        region: "eu-central-1",
        bucket: "panel-backups",
        prefix: "prod",
        accessKeyId: "AKIAEXAMPLE000000001",
        secretAccessKey: "secretsecretsecretsecret0000000000000001",
      },
      out,
    );
    expect(result.ok).toBe(true);
    expect(env.fetchSpy).toHaveBeenCalled();
    expect(env.networkSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(env.created[0]!.secrets).sort()).toEqual(["AWS_SHARED_CREDENTIALS", "RESTIC_PASSWORD"]);
  });
});
