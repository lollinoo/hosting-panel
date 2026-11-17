import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESTIC_IMAGE, SHARED_MARIADB_IMAGE, type BackupsIpcRequest, type BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_FORGET_TIMEOUT_MS,
  BACKUP_STATUS_MAX,
  BACKUP_STATUS_TTL_MS,
  BACKUP_TEST_BUDGET_MS,
  BackupRunner,
  DEFAULT_BACKUP_NETWORK_NAME,
  type BackupRunnerDeps,
  type DockerRequest,
} from "../src/index.js";

const ACCESS_KEY_SENTINEL = "HP_SENTINEL_ACCESS_KEY_991";
const SECRET_KEY_SENTINEL = "HP_SENTINEL_SECRET_KEY_882";
const BACKUP_KEY_SENTINEL = "deadbeef".repeat(8); // 64 hex chars
const BAD_SNAPSHOT_ID = "0".repeat(64);
const GOOD_SNAPSHOT_ID = "a1b2c3d4".repeat(8);

const VALID_TARGET: BackupTarget = {
  endpoint: "https://storage.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: ACCESS_KEY_SENTINEL,
  secretAccessKey: SECRET_KEY_SENTINEL,
};

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const jobHex = (n: number): string => `op_${n.toString(16).padStart(32, "0")}`;

function encodeDockerLogFrame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function makeSummaryLine(snapshotId = GOOD_SNAPSHOT_ID): string {
  return JSON.stringify({
    message_type: "summary",
    snapshot_id: snapshotId,
    data_added: 4096,
    total_bytes_processed: 65536,
    files_new: 4,
    files_changed: 2,
    files_unmodified: 10,
    total_duration: 1.25,
  });
}

function makeOkFetch(onStep?: (method: string, url: URL) => void): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    onStep?.(method, url);
    if (method === "GET") {
      return new Response("<ListBucketResult/>", { status: 200 });
    }
    if (method === "PUT") {
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof globalThis.fetch;
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

type StageSuffix = "test" | "repo" | "dump" | "up" | "drop" | "forget";

interface StageBehavior {
  createStatus?: number;
  throwAfterCreate?: boolean;
  startStatus?: number;
  waitExitCode?: number | "hang";
  stdout?: string;
  stderr?: string;
  waitResolver?: () => { exitCode: number };
  onStart?: (name: string) => Promise<void> | void;
}

function suffixForName(name: string): StageSuffix {
  if (name.startsWith("hp_bk_test_")) return "test";
  if (name.endsWith("_repo")) return "repo";
  if (name.endsWith("_dump")) return "dump";
  if (name.endsWith("_up")) return "up";
  if (name.endsWith("_drop")) return "drop";
  return "forget";
}

function createDockerHarness(opts?: {
  siteVolumeExists?: boolean;
  stages?: Partial<Record<StageSuffix, StageBehavior | (() => StageBehavior)>>;
  throwAfterVolumeCreate?: boolean;
  volumesListResponse?: {
    statusCode: number;
    volumes?: readonly { Name: string; Labels?: Record<string, string> }[];
  };
  onSecretsSeen?: (dir: string, files: Record<string, string>) => void;
  secretsRootDir?: string;
}) {
  const requests: RecordedRequest[] = [];
  const containersById = new Map<string, { name: string; stage: StageBehavior }>();
  const allNamesById = new Map<string, string>();
  const containersByName = new Map<string, string>();
  const createdContainers = new Set<string>();
  const liveVolumes = new Map<string, Record<string, string>>();
  if (opts?.siteVolumeExists !== false) {
    liveVolumes.set("hp_vol_svc_site1_html", { "io.hostingpanel.managed": "true" });
  }
  const killCalls: string[] = [];
  const deletedContainers: string[] = [];
  const deletedVolumes: string[] = [];
  const pendingWaitResolvers = new Map<string, (statusCode: number) => void>();
  let seq = 0;

  const jsonRes = (statusCode: number, body: unknown) => ({
    statusCode,
    body: Buffer.from(JSON.stringify(body), "utf8"),
  });
  const emptyRes = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });

  const resolveContainerRef = (rawRef: string): { id: string; name: string; stage: StageBehavior } | null => {
    const decoded = decodeURIComponent(rawRef);
    const byId = containersById.get(decoded);
    if (byId) return { id: decoded, ...byId };
    const id = containersByName.get(decoded);
    if (!id) return null;
    const found = containersById.get(id);
    return found ? { id, ...found } : null;
  };

  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath, body });
    const parsedUrl = new URL(`http://docker${reqPath}`);
    const pathname = parsedUrl.pathname;

    if (method === "POST" && pathname === "/containers/create") {
      const name = parsedUrl.searchParams.get("name") ?? "";
      const stageCfg = opts?.stages?.[suffixForName(name)];
      const stage: StageBehavior =
        typeof stageCfg === "function" ? stageCfg() : { ...(stageCfg ?? {}) };
      const createStatus = stage.createStatus ?? 201;
      if (createStatus !== 201) {
        return jsonRes(createStatus, { message: "create error" });
      }
      seq += 1;
      const id = `cid_${name}_${String(seq)}`;
      containersById.set(id, { name, stage });
      allNamesById.set(id, name);
      containersByName.set(name, id);
      createdContainers.add(name);
      if (stage.throwAfterCreate) {
        throw new Error("socket reset after container create");
      }

      if (opts?.onSecretsSeen && opts.secretsRootDir && typeof body === "object" && body !== null) {
        const jobSecretMatch = /job_bk_[^/]+/.exec(JSON.stringify(body));
        if (jobSecretMatch) {
          const dir = path.join(opts.secretsRootDir, jobSecretMatch[0]);
          const entries = await readdir(dir).catch(() => []);
          const files: Record<string, string> = {};
          for (const entry of entries) {
            files[entry] = await readFile(path.join(dir, entry), "utf8");
          }
          opts.onSecretsSeen(jobSecretMatch[0], files);
        }
      }
      return jsonRes(201, { Id: id, Warnings: [] });
    }

    const startMatch = /^\/containers\/([^/]+)\/start$/.exec(pathname);
    if (method === "POST" && startMatch) {
      const ref = resolveContainerRef(startMatch[1]!);
      if (!ref) return emptyRes(404);
      const startStatus = ref.stage.startStatus ?? 204;
      await ref.stage.onStart?.(ref.name);
      return emptyRes(startStatus);
    }

    const waitMatch = /^\/containers\/([^/]+)\/wait$/.exec(pathname);
    if (method === "POST" && waitMatch) {
      const ref = resolveContainerRef(waitMatch[1]!);
      if (!ref) return emptyRes(404);
      const exitCode = ref.stage.waitExitCode ?? 0;
      if (exitCode === "hang") {
        const status = await new Promise<number>((resolve) => {
          pendingWaitResolvers.set(ref.name, resolve);
        });
        return jsonRes(200, { StatusCode: status });
      }
      return jsonRes(200, { StatusCode: exitCode });
    }

    const killMatch = /^\/containers\/([^/]+)\/kill$/.exec(pathname);
    if (method === "POST" && killMatch) {
      const ref = resolveContainerRef(killMatch[1]!);
      if (!ref) return emptyRes(404);
      killCalls.push(ref.name);
      const resolver = pendingWaitResolvers.get(ref.name);
      if (resolver) {
        pendingWaitResolvers.delete(ref.name);
        resolver(137);
      }
      return emptyRes(204);
    }

    const logsMatch = /^\/containers\/([^/]+)\/logs$/.exec(pathname);
    if (method === "GET" && logsMatch) {
      const ref = resolveContainerRef(logsMatch[1]!);
      if (!ref) return emptyRes(404);
      const wantOut = parsedUrl.searchParams.get("stdout") === "1";
      const wantErr = parsedUrl.searchParams.get("stderr") === "1";
      const chunks: Buffer[] = [];
      if (wantOut && ref.stage.stdout) {
        chunks.push(encodeDockerLogFrame(1, ref.stage.stdout));
      }
      if (wantErr && ref.stage.stderr) {
        chunks.push(encodeDockerLogFrame(2, ref.stage.stderr));
      }
      return { statusCode: 200, body: Buffer.concat(chunks) };
    }

    const deleteContainerMatch = /^\/containers\/([^/]+)$/.exec(pathname);
    if (method === "DELETE" && deleteContainerMatch) {
      const ref = resolveContainerRef(deleteContainerMatch[1]!);
      if (!ref) return emptyRes(404);
      deletedContainers.push(ref.name);
      const resolver = pendingWaitResolvers.get(ref.name);
      if (resolver) {
        pendingWaitResolvers.delete(ref.name);
        resolver(137);
      }
      containersById.delete(ref.id);
      containersByName.delete(ref.name);
      return emptyRes(204);
    }

    if (method === "POST" && pathname === "/volumes/create") {
      const payload = body as { Name?: string; Labels?: Record<string, string> };
      const name = payload?.Name ?? "";
      liveVolumes.set(name, payload?.Labels ?? {});
      if (opts?.throwAfterVolumeCreate) {
        throw new Error("socket reset after volume create");
      }
      return jsonRes(201, { Name: name });
    }

    if (method === "GET" && pathname === "/volumes") {
      const cfg = opts?.volumesListResponse ?? { statusCode: 200, volumes: [] };
      if (cfg.statusCode !== 200) {
        return jsonRes(cfg.statusCode, { message: "volumes list error" });
      }
      return jsonRes(200, { Volumes: cfg.volumes ?? [] });
    }

    const volMatch = /^\/volumes\/([^/]+)$/.exec(pathname);
    if (method === "GET" && volMatch) {
      const name = decodeURIComponent(volMatch[1]!);
      if (!liveVolumes.has(name)) {
        return jsonRes(404, { message: "no such volume" });
      }
      return jsonRes(200, { Name: name, Labels: liveVolumes.get(name) });
    }
    if (method === "DELETE" && volMatch) {
      const name = decodeURIComponent(volMatch[1]!);
      deletedVolumes.push(name);
      if (!liveVolumes.has(name)) {
        return jsonRes(404, { message: "no such volume" });
      }
      liveVolumes.delete(name);
      return emptyRes(204);
    }

    throw new Error(`Unexpected Docker API call: ${method} ${reqPath}`);
  };

  const assertCp01AndSecrets = (thrownOrReturnedText: string[] = []): void => {
    for (const call of requests) {
      const serialized = JSON.stringify({ path: call.path, body: call.body });
      expect(serialized).not.toContain(ACCESS_KEY_SENTINEL);
      expect(serialized).not.toContain(SECRET_KEY_SENTINEL);
      expect(serialized).not.toContain(BACKUP_KEY_SENTINEL);

      // Ruling R61 (CP-01): never stop/pause/restart/exec any container.
      expect(call.path).not.toMatch(/\/(stop|pause|unpause|restart|exec)(?:\?|$)/);

      if (call.method === "POST" && call.path.startsWith("/containers/create")) {
        const name = new URL(`http://docker${call.path}`).searchParams.get("name") ?? "";
        expect(name.startsWith("hp_bk_")).toBe(true);
        const cfg = call.body as { HostConfig?: { Binds?: string[]; NetworkMode?: string } };
        for (const bind of cfg.HostConfig?.Binds ?? []) {
          if (bind.includes(":/backup/files")) {
            expect(bind.endsWith(":ro")).toBe(true);
          }
          expect(bind).not.toContain("docker.sock");
        }
      }

      const containerOpMatch = /^\/containers\/([^/?]+)\/(start|kill)$/.exec(call.path);
      if (containerOpMatch) {
        const ref = decodeURIComponent(containerOpMatch[1]!);
        const resolved = resolveContainerRef(ref)?.name ?? allNamesById.get(ref) ?? ref;
        expect(resolved.startsWith("hp_bk_")).toBe(true);
      }

      if (call.method === "DELETE" && call.path.startsWith("/containers/")) {
        const rawRef = decodeURIComponent(call.path.slice("/containers/".length).split("?")[0]!);
        const refName = allNamesById.get(rawRef) ?? rawRef;
        expect(refName.startsWith("hp_bk_")).toBe(true);
      }

      if (call.method === "POST" && call.path === "/volumes/create") {
        const name = (call.body as { Name?: string })?.Name ?? "";
        expect(name.startsWith("hp_bk_")).toBe(true);
      }

      if (call.method === "DELETE" && call.path.startsWith("/volumes/")) {
        const name = decodeURIComponent(call.path.slice("/volumes/".length).split("?")[0]!);
        expect(name.startsWith("hp_bk_")).toBe(true);
      }
    }

    for (const text of thrownOrReturnedText) {
      expect(text).not.toContain(ACCESS_KEY_SENTINEL);
      expect(text).not.toContain(SECRET_KEY_SENTINEL);
      expect(text).not.toContain(BACKUP_KEY_SENTINEL);
    }
  };

  return {
    request,
    requests,
    killCalls,
    deletedContainers,
    deletedVolumes,
    liveVolumes,
    createdContainers,
    resolvePendingWait(name: string, exitCode: number) {
      const fn = pendingWaitResolvers.get(name);
      if (fn) {
        pendingWaitResolvers.delete(name);
        fn(exitCode);
      }
    },
    assertCp01AndSecrets,
  };
}

async function setupRunner(opts?: {
  keyContent?: string | null;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  databases?: readonly { name: string; sizeBytes: number }[];
  listSiteDatabases?: BackupRunnerDeps["listSiteDatabases"];
  ensureImage?: (image: string) => Promise<void>;
  ensureBackupNetwork?: () => Promise<void>;
  harnessOpts?: Parameters<typeof createDockerHarness>[0];
}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-backup-runner-test-"));
  cleanupTasks.push(() => rm(tmpDir, { recursive: true, force: true }));

  const secretsRootDir = path.join(tmpDir, "secrets");
  await mkdir(secretsRootDir, { recursive: true, mode: 0o700 });
  await chmod(secretsRootDir, 0o700);

  const backupKeyFile = path.join(tmpDir, "backup.key");
  if (opts?.keyContent !== null) {
    await writeFile(backupKeyFile, `${opts?.keyContent ?? BACKUP_KEY_SENTINEL}\n`, { mode: 0o400 });
  }

  const sharedDbRootKeyFile = path.join(tmpDir, "mariadb-root.key");
  await writeFile(sharedDbRootKeyFile, "db-root-pass", { mode: 0o400 });

  const harness = createDockerHarness({ ...opts?.harnessOpts, secretsRootDir });
  const ensuredImages: string[] = [];
  let ensureNetworkCalls = 0;

  const deps: BackupRunnerDeps = {
    request: harness.request,
    ensureImage: opts?.ensureImage ?? (async (image) => {
      ensuredImages.push(image);
    }),
    ensureBackupNetwork: opts?.ensureBackupNetwork ?? (async () => {
      ensureNetworkCalls += 1;
    }),
    listSiteDatabases:
      opts?.listSiteDatabases ?? (async () => opts?.databases ?? [{ name: "wp_0123456789ab", sizeBytes: 2048 }]),
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    executorUser: "990:990",
    backupWorkDir: path.join(tmpDir, "backup-work"),
    sharedDbDataDir: path.join(tmpDir, "mariadb-data"),
    now: opts?.now,
    fetch: opts?.fetch ?? makeOkFetch(),
  };

  return {
    runner: new BackupRunner(deps),
    harness,
    secretsRootDir,
    backupKeyFile,
    ensuredImages,
    getEnsureNetworkCalls: () => ensureNetworkCalls,
  };
}

async function waitForSettled(runner: BackupRunner, jobId: string) {
  const until = performance.now() + 2_000;
  while (performance.now() < until) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") {
      return status;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Backup job ${jobId} did not settle in time`);
}

async function waitUntilCondition(cond: () => boolean): Promise<void> {
  const until = performance.now() + 2_000;
  while (performance.now() < until) {
    if (cond()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not met in time");
}

describe("BackupRunner", () => {
  it("runs a full test flow, mounts temp secrets without leaking them, and cleans up", async () => {
    const seenSecrets: Array<{ dir: string; files: Record<string, string> }> = [];
    const { runner, harness, secretsRootDir, ensuredImages, getEnsureNetworkCalls } =
      await setupRunner({
        harnessOpts: {
          onSecretsSeen: (dir, files) => seenSecrets.push({ dir, files }),
        },
      });

    const result = await runner.run({ action: "test", target: VALID_TARGET });

    expect(result).toEqual({ outcome: "ok", problem: null });
    expect(ensuredImages).toEqual([RESTIC_IMAGE]);
    expect(getEnsureNetworkCalls()).toBe(1);
    expect(seenSecrets).toHaveLength(1);
    expect(seenSecrets[0]!.dir).toMatch(/^job_bk_test_[0-9a-f]{16}$/);
    expect(seenSecrets[0]!.files.RESTIC_PASSWORD).toBe(BACKUP_KEY_SENTINEL);
    expect(seenSecrets[0]!.files.AWS_SHARED_CREDENTIALS).toContain(ACCESS_KEY_SENTINEL);
    expect(seenSecrets[0]!.files.AWS_SHARED_CREDENTIALS).toContain(SECRET_KEY_SENTINEL);
    expect(harness.deletedContainers).toHaveLength(1);
    expect(await readdir(secretsRootDir)).toEqual([]);
    harness.assertCp01AndSecrets([JSON.stringify(result)]);
  });

  it("returns key_file_missing without calling S3 or Docker when backup.key is absent or malformed", async () => {
    const fetchSpy = makeOkFetch();
    const missing = await setupRunner({ keyContent: null, fetch: fetchSpy });
    await expect(missing.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "key_file_missing",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(missing.harness.requests).toEqual([]);

    const malformed = await setupRunner({ keyContent: "not-64-hex\n", fetch: fetchSpy });
    await expect(malformed.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "key_file_missing",
    });
  });

  it("maps test S3 failures, container create 404 -> tool_unavailable, engine errors, exit 1/11/12, and timeout", async () => {
    // 1. S3 failure skips container creation.
    const s3FailFetch = vi.fn(async () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })) as unknown as typeof globalThis.fetch;
    const s3Fail = await setupRunner({ fetch: s3FailFetch });
    await expect(s3Fail.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "bucket_missing",
    });
    expect(s3Fail.harness.requests).toEqual([]);

    // 2. Container create 404 -> tool_unavailable and cleans secrets.
    const create404 = await setupRunner({ harnessOpts: { stages: { test: { createStatus: 404 } } } });
    await expect(create404.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "tool_unavailable",
    });
    expect(await readdir(create404.secretsRootDir)).toEqual([]);

    // 3. Container create 500 -> throws DOCKER_ENGINE_UNAVAILABLE.
    const create500 = await setupRunner({ harnessOpts: { stages: { test: { createStatus: 500 } } } });
    await expect(create500.runner.run({ action: "test", target: VALID_TARGET })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(await readdir(create500.secretsRootDir)).toEqual([]);

    // 4. Restic exit 12 -> wrong_key, exit 11 -> repository_locked, exit 1 -> stderr class.
    for (const [exitCode, stderr, expected] of [
      [12, "", "wrong_key"],
      [11, "", "repository_locked"],
      [1, `AccessDenied for ${SECRET_KEY_SENTINEL}`, "write_denied"],
    ] as const) {
      const ctx = await setupRunner({
        harnessOpts: { stages: { test: { waitExitCode: exitCode, stderr } } },
      });
      await expect(ctx.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
        outcome: "failed",
        problem: expected,
      });
      ctx.harness.assertCp01AndSecrets();
    }

    // 5. Shared 30s timeout budget: S3 probe + image prep consume 20s, hanging wait is killed at +10s.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let clockMs = 1_000_000;
    let timedStarted = false;
    const probeFetch = vi.fn(async () => {
      clockMs += 3_000;
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const timed = await setupRunner({
      now: () => clockMs,
      fetch: probeFetch,
      ensureImage: async () => {
        clockMs += 11_000;
      },
      harnessOpts: {
        stages: {
          test: {
            waitExitCode: "hang",
            onStart: () => {
              timedStarted = true;
            },
          },
        },
      },
    });
    const testPromise = timed.runner.run({ action: "test", target: VALID_TARGET });
    await waitUntilCondition(() => timedStarted);
    await vi.advanceTimersByTimeAsync(10_500);
    await expect(testPromise).resolves.toEqual({ outcome: "failed", problem: "timeout" });
    expect(timed.harness.killCalls).toHaveLength(1);
    expect(timed.harness.deletedContainers).toHaveLength(1);
    expect(await readdir(timed.secretsRootDir)).toEqual([]);
    vi.useRealTimers();
  });

  it("rejects a second concurrent test with RESOURCE_LOCKED and rejects invalid requests with VALIDATION_ERROR", async () => {
    let startedName = "";
    const { runner, harness } = await setupRunner({
      harnessOpts: {
        stages: {
          test: {
            waitExitCode: "hang",
            onStart: (name) => {
              startedName = name;
            },
          },
        },
      },
    });

    const first = runner.run({ action: "test", target: VALID_TARGET });
    first.catch(() => undefined);
    await waitUntilCondition(() => startedName !== "");
    await expect(runner.run({ action: "test", target: VALID_TARGET })).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });

    harness.resolvePendingWait(startedName, 0);
    await expect(first).resolves.toEqual({ outcome: "ok", problem: null });

    await expect(
      runner.run({ action: "status", jobId: "bad-id" } as unknown as BackupsIpcRequest),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Validation error with secret keys must not leak credentials.
    let errText = "";
    try {
      await runner.run({
        action: "test",
        target: { ...VALID_TARGET, region: "INVALID_REGION" },
      });
    } catch (err) {
      errText = err instanceof Error ? err.message : String(err);
    }
    expect(errText).toContain("region");
    harness.assertCp01AndSecrets([errText]);
  });

  it("starts a full site+database backup in background, returns running immediately, and cleans containers before staging volume", async () => {
    const id = jobHex(1);
    const { runner, harness, secretsRootDir, ensuredImages } = await setupRunner({
      databases: [{ name: "wp_0123456789ab", sizeBytes: 4096 }],
      harnessOpts: {
        stages: {
          repo: { waitExitCode: 0 },
          dump: { waitExitCode: 0 },
          up: { waitExitCode: 0, stdout: `${makeSummaryLine()}\n` },
        },
      },
    });

    const initial = await runner.run({
      action: "start",
      jobId: id,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(initial).toEqual({ jobId: id, state: "running", failure: null, snapshot: null });

    // Idempotent replay with same jobId while running or settled never triggers RESOURCE_LOCKED.
    const replay = await runner.run({
      action: "start",
      jobId: id,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(replay.jobId).toBe(id);

    const done = await waitForSettled(runner, id);
    expect(done).toEqual({
      jobId: id,
      state: "succeeded",
      failure: null,
      snapshot: {
        snapshotId: GOOD_SNAPSHOT_ID,
        bytesAdded: 4096,
        totalBytes: 65536,
        fileCount: 16,
        durationMs: 1250,
      },
    });
    expect(ensuredImages).toEqual([RESTIC_IMAGE, SHARED_MARIADB_IMAGE]);
    expect(harness.deletedContainers).toEqual([
      `hp_bk_${id}_repo`,
      `hp_bk_${id}_dump`,
      `hp_bk_${id}_up`,
    ]);
    expect(harness.deletedVolumes).toEqual([`hp_bk_${id}`]);
    const lastContainerDeleteIdx = harness.requests.findLastIndex(
      (r) => r.method === "DELETE" && r.path.startsWith("/containers/"),
    );
    const volumeDeleteIdx = harness.requests.findIndex(
      (r) => r.method === "DELETE" && r.path === `/volumes/${encodeURIComponent(`hp_bk_${id}`)}`,
    );
    expect(lastContainerDeleteIdx).toBeGreaterThan(-1);
    expect(volumeDeleteIdx).toBeGreaterThan(lastContainerDeleteIdx);
    expect(await readdir(secretsRootDir)).toEqual([]);
    harness.assertCp01AndSecrets([JSON.stringify(done)]);
  });

  it("skips mariadb prewarm, staging volume, and dump container when the site has zero databases", async () => {
    const id = jobHex(2);
    const { runner, harness, ensuredImages } = await setupRunner({
      databases: [],
      harnessOpts: { stages: { up: { waitExitCode: 0, stdout: `${makeSummaryLine()}\n` } } },
    });

    await runner.run({
      action: "start",
      jobId: id,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    const done = await waitForSettled(runner, id);
    expect(done.state).toBe("succeeded");
    expect(ensuredImages).toEqual([RESTIC_IMAGE]);
    expect(harness.requests.some((r) => r.path === "/volumes/create")).toBe(false);
    expect([...harness.createdContainers]).toEqual([`hp_bk_${id}_repo`, `hp_bk_${id}_up`]);
    harness.assertCp01AndSecrets();
  });

  it("drops partial snapshot on upload exit 3 and clears snapshot while failing files_unreadable", async () => {
    const id = jobHex(3);
    const { runner, harness } = await setupRunner({
      databases: [],
      harnessOpts: {
        stages: {
          up: { waitExitCode: 3, stdout: `${makeSummaryLine(BAD_SNAPSHOT_ID)}\n` },
          drop: { waitExitCode: 0 },
        },
      },
    });

    await runner.run({
      action: "start",
      jobId: id,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    const done = await waitForSettled(runner, id);
    expect(done).toEqual({
      jobId: id,
      state: "failed",
      failure: "files_unreadable",
      snapshot: null,
    });
    expect(harness.createdContainers.has(`hp_bk_${id}_drop`)).toBe(true);
    expect(harness.deletedContainers).toContain(`hp_bk_${id}_drop`);
    harness.assertCp01AndSecrets();
  });

  it("fails backup start cleanly for missing site volume, repo exit 10/12, dump exit 75, and malformed summary", async () => {
    const missingVol = await setupRunner({ harnessOpts: { siteVolumeExists: false } });
    await missingVol.runner.run({
      action: "start",
      jobId: jobHex(4),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(missingVol.runner, jobHex(4))).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });
    expect(missingVol.harness.requests.some((r) => r.path === "/volumes/create")).toBe(false);
    expect(missingVol.harness.requests.some((r) => r.path.startsWith("/containers/create"))).toBe(false);

    const repo10 = await setupRunner({ databases: [], harnessOpts: { stages: { repo: { waitExitCode: 10 } } } });
    await repo10.runner.run({
      action: "start",
      jobId: jobHex(5),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(repo10.runner, jobHex(5))).toMatchObject({
      state: "failed",
      failure: "other",
    });

    const repo12 = await setupRunner({ databases: [], harnessOpts: { stages: { repo: { waitExitCode: 12 } } } });
    await repo12.runner.run({
      action: "start",
      jobId: jobHex(6),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(repo12.runner, jobHex(6))).toMatchObject({
      state: "failed",
      failure: "wrong_key",
    });

    const dump75 = await setupRunner({ harnessOpts: { stages: { dump: { waitExitCode: 75 } } } });
    await dump75.runner.run({
      action: "start",
      jobId: jobHex(7),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(dump75.runner, jobHex(7))).toMatchObject({
      state: "failed",
      failure: "no_space",
    });
    expect(dump75.harness.deletedVolumes).toEqual([`hp_bk_${jobHex(7)}`]);

    const badSum = await setupRunner({
      databases: [],
      harnessOpts: { stages: { up: { waitExitCode: 0, stdout: "no summary line\n" } } },
    });
    await badSum.runner.run({
      action: "start",
      jobId: jobHex(8),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(badSum.runner, jobHex(8))).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });
  });

  it("enforces per-site lock and global concurrent limit of 2 across start and forget", async () => {
    let holdSite1 = "";
    const { runner, harness } = await setupRunner({
      databases: [],
      harnessOpts: {
        stages: {
          repo: {
            waitExitCode: "hang",
            onStart: (name) => {
              if (!holdSite1) holdSite1 = name;
            },
          },
          up: { waitExitCode: 0, stdout: `${makeSummaryLine()}\n` },
        },
      },
    });

    await runner.run({
      action: "start",
      jobId: jobHex(10),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });

    // Same site -> RESOURCE_LOCKED even with a different jobId.
    await expect(
      runner.run({
        action: "start",
        jobId: jobHex(11),
        siteId: "site1",
        serviceInstanceId: "svc_site1",
        target: VALID_TARGET,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(
      runner.run({
        action: "forget",
        jobId: `${jobHex(11)}-forget`,
        siteId: "site1",
        target: VALID_TARGET,
        snapshotIds: [GOOD_SNAPSHOT_ID],
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    // Second site allowed up to global cap 2, third site blocked.
    harness.liveVolumes.set("hp_vol_svc_site2_html", { "io.hostingpanel.managed": "true" });
    harness.liveVolumes.set("hp_vol_svc_site3_html", { "io.hostingpanel.managed": "true" });
    await runner.run({
      action: "start",
      jobId: jobHex(12),
      siteId: "site2",
      serviceInstanceId: "svc_site2",
      target: VALID_TARGET,
    });
    await expect(
      runner.run({
        action: "start",
        jobId: jobHex(13),
        siteId: "site3",
        serviceInstanceId: "svc_site3",
        target: VALID_TARGET,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    await waitUntilCondition(
      () =>
        harness.createdContainers.has(`hp_bk_${jobHex(10)}_repo`) &&
        harness.createdContainers.has(`hp_bk_${jobHex(12)}_repo`),
    );
    harness.resolvePendingWait(`hp_bk_${jobHex(10)}_repo`, 0);
    harness.resolvePendingWait(`hp_bk_${jobHex(12)}_repo`, 0);
    expect((await waitForSettled(runner, jobHex(10))).state).toBe("succeeded");
    expect((await waitForSettled(runner, jobHex(12))).state).toBe("succeeded");

    // Once released, site3 starts normally.
    await runner.run({
      action: "start",
      jobId: jobHex(13),
      siteId: "site3",
      serviceInstanceId: "svc_site3",
      target: VALID_TARGET,
    });
    await waitUntilCondition(() => harness.createdContainers.has(`hp_bk_${jobHex(13)}_repo`));
    harness.resolvePendingWait(`hp_bk_${jobHex(13)}_repo`, 0);
    expect((await waitForSettled(runner, jobHex(13))).state).toBe("succeeded");
  });

  it("handles forget success, repo missing (exit 10) -> succeeded without forget container, and forget timeout", async () => {
    const okForgetId = `${jobHex(19)}-forget`;
    const okForget = await setupRunner({
      harnessOpts: { stages: { repo: { waitExitCode: 0 }, forget: { waitExitCode: 0 } } },
    });
    await okForget.runner.run({
      action: "forget",
      jobId: okForgetId,
      siteId: "site1",
      target: VALID_TARGET,
      snapshotIds: [GOOD_SNAPSHOT_ID],
    });
    expect(await waitForSettled(okForget.runner, okForgetId)).toEqual({
      jobId: okForgetId,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(okForget.harness.deletedContainers).toEqual([
      `hp_bk_${okForgetId}_repo`,
      `hp_bk_${okForgetId}_forget`,
    ]);
    okForget.harness.assertCp01AndSecrets();

    const missingRepoId = `${jobHex(20)}-forget`;
    const missingRepo = await setupRunner({
      harnessOpts: { stages: { repo: { waitExitCode: 10 } } },
    });
    await missingRepo.runner.run({
      action: "forget",
      jobId: missingRepoId,
      siteId: "site1",
      target: VALID_TARGET,
      snapshotIds: [GOOD_SNAPSHOT_ID],
    });
    expect(await waitForSettled(missingRepo.runner, missingRepoId)).toEqual({
      jobId: missingRepoId,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(missingRepo.harness.createdContainers.has(`hp_bk_${missingRepoId}_forget`)).toBe(false);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let forgetStarted = false;
    const timeoutId = `${jobHex(21)}-forget`;
    const timedForget = await setupRunner({
      harnessOpts: {
        stages: {
          repo: { waitExitCode: 0 },
          forget: {
            waitExitCode: "hang",
            onStart: () => {
              forgetStarted = true;
            },
          },
        },
      },
    });
    await timedForget.runner.run({
      action: "forget",
      jobId: timeoutId,
      siteId: "site1",
      target: VALID_TARGET,
      snapshotIds: [GOOD_SNAPSHOT_ID],
    });
    await waitUntilCondition(() => forgetStarted);
    await vi.advanceTimersByTimeAsync(BACKUP_FORGET_TIMEOUT_MS + 100);
    expect(await waitForSettled(timedForget.runner, timeoutId)).toEqual({
      jobId: timeoutId,
      state: "failed",
      failure: "timeout",
      snapshot: null,
    });
    expect(timedForget.harness.killCalls).toEqual([`hp_bk_${timeoutId}_forget`]);
    vi.useRealTimers();
  });

  it("returns unknown for missing jobId and evicts settled statuses by TTL (24h) and max count (500)", async () => {
    let clockMs = 10_000;
    const { runner } = await setupRunner({
      now: () => clockMs,
      databases: [],
      harnessOpts: { stages: { up: { waitExitCode: 0, stdout: `${makeSummaryLine()}\n` } } },
    });

    await expect(runner.run({ action: "status", jobId: jobHex(999) })).resolves.toEqual({
      jobId: jobHex(999),
      state: "unknown",
      failure: null,
      snapshot: null,
    });

    // Run BACKUP_STATUS_MAX + 3 fast jobs at unique timestamps.
    for (let i = 1; i <= BACKUP_STATUS_MAX + 3; i += 1) {
      clockMs += 10;
      const id = jobHex(1000 + i);
      await runner.run({
        action: "start",
        jobId: id,
        siteId: `site_${i}`,
        serviceInstanceId: `svc_site_${i}`,
        target: VALID_TARGET,
      });
      await waitForSettled(runner, id);
    }

    // Site volumes were absent, so each job settled quickly as failed while exercising status eviction.
    expect((await runner.run({ action: "status", jobId: jobHex(1001) })).state).toBe("unknown");
    expect((await runner.run({ action: "status", jobId: jobHex(1002) })).state).toBe("unknown");
    expect((await runner.run({ action: "status", jobId: jobHex(1003) })).state).toBe("unknown");
    expect((await runner.run({ action: "status", jobId: jobHex(1004) })).state).toBe("failed");

    // Advance past BACKUP_STATUS_TTL_MS -> remaining jobs evicted.
    clockMs += BACKUP_STATUS_TTL_MS + 1;
    expect((await runner.run({ action: "status", jobId: jobHex(1004) })).state).toBe("unknown");
  });

  it("removes only hp_bk_* orphan backup_staging volumes and throws DOCKER_ENGINE_UNAVAILABLE if list fails", async () => {
    const ok = await setupRunner({
      harnessOpts: {
        volumesListResponse: {
          statusCode: 200,
          volumes: [
            { Name: `hp_bk_${jobHex(1)}` },
            { Name: `hp_bk_${jobHex(2)}` },
            { Name: "hp_vol_svc_site1_html" },
          ],
        },
      },
    });
    ok.harness.liveVolumes.set(`hp_bk_${jobHex(1)}`, { "io.hostingpanel.role": "backup_staging" });
    ok.harness.liveVolumes.set(`hp_bk_${jobHex(2)}`, { "io.hostingpanel.role": "backup_staging" });

    await ok.runner.removeOrphans();
    expect(ok.harness.deletedVolumes).toEqual([`hp_bk_${jobHex(1)}`, `hp_bk_${jobHex(2)}`]);
    expect(ok.harness.liveVolumes.has("hp_vol_svc_site1_html")).toBe(true);
    ok.harness.assertCp01AndSecrets();

    const fail = await setupRunner({
      harnessOpts: { volumesListResponse: { statusCode: 500 } },
    });
    await expect(fail.runner.removeOrphans()).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });

  it("handles test timeout right at deadline edge (prep exceeds 30s budget after S3 ok)", async () => {
    let clockMs = 5_000_000;
    const { runner, harness } = await setupRunner({
      now: () => clockMs,
      fetch: vi.fn(async () => {
        clockMs += 3_000;
        return new Response(null, { status: 204 });
      }) as unknown as typeof globalThis.fetch,
      ensureImage: async () => {
        clockMs += BACKUP_TEST_BUDGET_MS;
      },
    });

    const result = await runner.run({ action: "test", target: VALID_TARGET });
    expect(result).toEqual({ outcome: "failed", problem: "timeout" });
    expect(harness.requests).toEqual([]);
  });

  it("maps failing ensureImage to tool_unavailable across test, start, and forget and bounds test pull inside 30s budget", async () => {
    const resticFail = await setupRunner({
      ensureImage: async () => {
        throw new Error("pull failed");
      },
    });
    await expect(resticFail.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "tool_unavailable",
    });

    await resticFail.runner.run({
      action: "start",
      jobId: jobHex(50),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(resticFail.runner, jobHex(50))).toMatchObject({
      state: "failed",
      failure: "tool_unavailable",
      snapshot: null,
    });

    const forgetId = `${jobHex(51)}-forget`;
    await resticFail.runner.run({
      action: "forget",
      jobId: forgetId,
      siteId: "site1",
      target: VALID_TARGET,
      snapshotIds: [GOOD_SNAPSHOT_ID],
    });
    expect(await waitForSettled(resticFail.runner, forgetId)).toMatchObject({
      state: "failed",
      failure: "tool_unavailable",
      snapshot: null,
    });

    const dbImgFail = await setupRunner({
      ensureImage: async (img) => {
        if (img === SHARED_MARIADB_IMAGE) {
          throw new Error("mariadb pull failed");
        }
      },
    });
    await dbImgFail.runner.run({
      action: "start",
      jobId: jobHex(52),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(dbImgFail.runner, jobHex(52))).toMatchObject({
      state: "failed",
      failure: "tool_unavailable",
      snapshot: null,
    });

    // Hanging pull during connection test must still finish within the 30 s budget.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const hangingPull = await setupRunner({
      ensureImage: async () => new Promise<void>(() => undefined),
    });
    const testPromise = hangingPull.runner.run({ action: "test", target: VALID_TARGET });
    await vi.advanceTimersByTimeAsync(BACKUP_TEST_BUDGET_MS + 100);
    await expect(testPromise).resolves.toEqual({ outcome: "failed", problem: "timeout" });
    vi.useRealTimers();
  });

  it("maps listSiteDatabases failure to database_dump_failed and exit code 137 to other", async () => {
    const dbDown = await setupRunner({
      listSiteDatabases: async () => {
        throw new Error("hp_mariadb unavailable");
      },
    });
    await dbDown.runner.run({
      action: "start",
      jobId: jobHex(53),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(dbDown.runner, jobHex(53))).toMatchObject({
      state: "failed",
      failure: "database_dump_failed",
      snapshot: null,
    });

    const oomTest = await setupRunner({
      harnessOpts: { stages: { test: { waitExitCode: 137 } } },
    });
    await expect(oomTest.runner.run({ action: "test", target: VALID_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "other",
    });

    const oomDump = await setupRunner({
      harnessOpts: { stages: { dump: { waitExitCode: 137 } } },
    });
    await oomDump.runner.run({
      action: "start",
      jobId: jobHex(54),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(oomDump.runner, jobHex(54))).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });

    const oomUpload = await setupRunner({
      databases: [],
      harnessOpts: { stages: { up: { waitExitCode: 137 } } },
    });
    await oomUpload.runner.run({
      action: "start",
      jobId: jobHex(55),
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(oomUpload.runner, jobHex(55))).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });
  });

  it("removes a created container or staging volume by name right away when create throws", async () => {
    const testThrow = await setupRunner({
      harnessOpts: { stages: { test: { throwAfterCreate: true } } },
    });
    await expect(testThrow.runner.run({ action: "test", target: VALID_TARGET })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    const createdTestNames = Array.from(testThrow.harness.createdContainers);
    expect(createdTestNames).toHaveLength(1);
    expect(testThrow.harness.deletedContainers).toEqual(createdTestNames);
    const testCreateIdx = testThrow.harness.requests.findIndex(
      (r) => r.method === "POST" && r.path.startsWith("/containers/create"),
    );
    expect(testCreateIdx).toBeGreaterThanOrEqual(0);
    expect(testThrow.harness.requests[testCreateIdx + 1]).toMatchObject({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(createdTestNames[0]!)}?force=true&v=true`,
    });

    const dumpThrow = await setupRunner({
      harnessOpts: { stages: { dump: { throwAfterCreate: true } } },
    });
    const dumpJobId = jobHex(56);
    await dumpThrow.runner.run({
      action: "start",
      jobId: dumpJobId,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(dumpThrow.runner, dumpJobId)).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });
    const dumpName = `hp_bk_${dumpJobId}_dump`;
    expect(dumpThrow.harness.deletedContainers).toContain(dumpName);
    const dumpCreateIdx = dumpThrow.harness.requests.findIndex(
      (r) => r.method === "POST" && r.path === `/containers/create?name=${encodeURIComponent(dumpName)}`,
    );
    expect(dumpCreateIdx).toBeGreaterThanOrEqual(0);
    expect(dumpThrow.harness.requests[dumpCreateIdx + 1]).toMatchObject({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(dumpName)}?force=true&v=true`,
    });

    const volThrow = await setupRunner({
      harnessOpts: { throwAfterVolumeCreate: true },
    });
    const volJobId = jobHex(57);
    await volThrow.runner.run({
      action: "start",
      jobId: volJobId,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      target: VALID_TARGET,
    });
    expect(await waitForSettled(volThrow.runner, volJobId)).toMatchObject({
      state: "failed",
      failure: "other",
      snapshot: null,
    });
    const stagingName = `hp_bk_${volJobId}`;
    expect(volThrow.harness.deletedVolumes).toEqual([stagingName]);
    expect(volThrow.harness.liveVolumes.has(stagingName)).toBe(false);
    const volCreateIdx = volThrow.harness.requests.findIndex(
      (r) => r.method === "POST" && r.path === "/volumes/create",
    );
    expect(volCreateIdx).toBeGreaterThanOrEqual(0);
    expect(volThrow.harness.requests[volCreateIdx + 1]).toMatchObject({
      method: "DELETE",
      path: `/volumes/${encodeURIComponent(stagingName)}`,
    });
  });
});
