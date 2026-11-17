import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PHP_VERSION,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  SITE_FILE_CHUNK_BYTES,
  resolveWordpressImage,
  siteDatabasePrefix,
  type BackupsIpcRequest,
  type BackupTarget,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_EXIT_CODES,
  BACKUP_ARCHIVE_TTL_MS,
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BACKUP_RESTORE_FILES_TIMEOUT_MS,
  BACKUP_RESTORE_FINISH_TIMEOUT_MS,
  BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
  BACKUP_RESTORE_SETTLE_START_MS,
  BACKUP_RESTORE_SWITCH_TIMEOUT_MS,
  BACKUP_RESTORE_UNDO_TIMEOUT_MS,
  BACKUP_STATUS_TTL_MS,
  BackupRunner,
  DEFAULT_BACKUP_NETWORK_NAME,
  DEFAULT_BACKUP_WORK_DIR,
  RESTORE_EXIT_DB_IMPORT_FAILED,
  RESTORE_EXIT_DB_UNREACHABLE,
  RESTORE_EXIT_DEFINER_MISSING,
  RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF,
  RESTORE_EXIT_FILES_PLAN_EXISTS,
  RESTORE_EXIT_FINISH_CLEANUP_FAILED,
  RESTORE_EXIT_GATE_REMOVE_FAILED,
  RESTORE_EXIT_INVALID_DB_NAME,
  RESTORE_EXIT_INVALID_FILENAMES,
  RESTORE_EXIT_NO_SPACE,
  RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY,
  readRestoreNote,
  type BackupRunnerDeps,
  type DockerRequest,
} from "../src/index.js";
import { RESTORE_EXIT_INVALID_OBJECT_NAME, writeRestoreNote } from "../src/restore-jobs.js";

// R124: lets a test fail chosen note writes the way a full disk does.
const noteWrites = vi.hoisted(() => ({ fail: null as ((note: { stage: string }) => boolean) | null }));
vi.mock("../src/restore-jobs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/restore-jobs.js")>();
  return {
    ...mod,
    writeRestoreNote: (dir: string, note: Parameters<typeof mod.writeRestoreNote>[1]) =>
      noteWrites.fail?.(note)
        ? Promise.reject(Object.assign(new Error("no space"), { code: "ENOSPC" }))
        : mod.writeRestoreNote(dir, note),
  };
});

const ACCESS_KEY_SENTINEL = "HP_SENTINEL_RS_ACCESS_991";
const SECRET_KEY_SENTINEL = "HP_SENTINEL_RS_SECRET_882";
const BACKUP_KEY_SENTINEL = "cafe1234".repeat(8);
const DB_ROOT_SENTINEL = "HP_SENTINEL_DB_ROOT_773";
const GOOD_SNAPSHOT_ID = "b2c3d4e5".repeat(8);

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
  noteWrites.fail = null;
  vi.restoreAllMocks();
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

function makeOkFetch(): typeof globalThis.fetch {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response("<ListBucketResult/>", { status: 200 });
    if (method === "PUT") return new Response(null, { status: 200 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 405 });
  }) as unknown as typeof globalThis.fetch;
}

type RestoreStageSuffix =
  | "rs_own"
  | "rs_fetch"
  | "rs_fetch_files"
  | "rs_gate_on"
  | "rs_gate_undo"
  | "rs_gate_end"
  | "rs_prepare"
  | "rs_switch"
  | "rs_files"
  | "rs_finish"
  | "rs_undo_files"
  | "rs_undo_db"
  | "zip"
  | "repo"
  | "dump"
  | "up"
  | "drop"
  | "forget"
  | "test";

interface StageBehavior {
  createStatus?: number;
  throwAfterCreate?: boolean;
  startStatus?: number;
  waitExitCode?: number | "hang";
  stdout?: string;
  stderr?: string;
  onCreate?: (name: string, payload: unknown) => Promise<void> | void;
  onStart?: (name: string) => Promise<void> | void;
}

function suffixForName(name: string): RestoreStageSuffix {
  if (name.startsWith("hp_bk_test_")) return "test";
  for (const suffix of [
    "rs_undo_files",
    "rs_undo_db",
    "rs_own",
    "rs_fetch_files",
    "rs_gate_on",
    "rs_gate_undo",
    "rs_gate_end",
    "rs_fetch",
    "rs_prepare",
    "rs_switch",
    "rs_files",
    "rs_finish",
    "zip",
    "repo",
    "dump",
    "up",
    "drop",
    "forget",
  ] as const) {
    if (name.endsWith(`_${suffix}`)) return suffix;
  }
  return "test";
}

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function createRestoreDockerHarness(opts?: {
  siteVolumes?: readonly string[];
  stages?: Partial<Record<RestoreStageSuffix, StageBehavior | ((name: string) => StageBehavior)>>;
  volumesListResponse?: {
    statusCode: number;
    volumes?: readonly { Name: string; Labels?: Record<string, string> }[];
  };
  failVolumeCreate?: boolean;
  failDeleteVolumeNames?: ReadonlySet<string>;
  secretsRootDir?: string;
  onVolumeCreate?: (name: string) => Promise<void> | void;
  onVolumeDelete?: (name: string) => Promise<void> | void;
}) {
  const requests: RecordedRequest[] = [];
  const containersById = new Map<string, { name: string; stage: StageBehavior; payload: unknown }>();
  const allNamesById = new Map<string, string>();
  const containersByName = new Map<string, string>();
  const createdSequence: string[] = [];
  const containerPayloads = new Map<string, unknown>();
  const liveVolumes = new Map<string, Record<string, string>>();
  for (const vol of opts?.siteVolumes ?? ["hp_vol_svc_site1_html", "hp_vol_svc_site2_html", "hp_vol_svc_site3_html"]) {
    liveVolumes.set(vol, { "io.hostingpanel.managed": "true" });
  }
  const killCalls: string[] = [];
  const deletedContainers: string[] = [];
  const deletedVolumes: string[] = [];
  const events: string[] = [];
  const pendingWaitResolvers = new Map<string, (statusCode: number) => void>();
  let seq = 0;

  const jsonRes = (statusCode: number, body: unknown) => ({
    statusCode,
    body: Buffer.from(JSON.stringify(body), "utf8"),
  });
  const emptyRes = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });

  const resolveContainerRef = (
    rawRef: string,
  ): { id: string; name: string; stage: StageBehavior; payload: unknown } | null => {
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
      const suffix = suffixForName(name);
      const rawStage = opts?.stages?.[suffix];
      const stage: StageBehavior =
        typeof rawStage === "function" ? rawStage(name) : { ...(rawStage ?? {}) };
      await stage.onCreate?.(name, body);
      const createStatus = stage.createStatus ?? 201;
      if (createStatus !== 201) {
        return jsonRes(createStatus, { message: "create failed" });
      }
      seq += 1;
      const id = `cid_${name}_${String(seq)}`;
      containersById.set(id, { name, stage, payload: body });
      allNamesById.set(id, name);
      containersByName.set(name, id);
      createdSequence.push(name);
      containerPayloads.set(name, body);
      events.push(`container:create:${name}`);
      if (stage.throwAfterCreate) {
        throw new Error("socket reset after create");
      }
      return jsonRes(201, { Id: id, Warnings: [] });
    }

    const startMatch = /^\/containers\/([^/]+)\/start$/.exec(pathname);
    if (method === "POST" && startMatch) {
      const ref = resolveContainerRef(startMatch[1]!);
      if (!ref) return emptyRes(404);
      events.push(`container:start:${ref.name}`);
      await ref.stage.onStart?.(ref.name);
      return emptyRes(ref.stage.startStatus ?? 204);
    }

    const waitMatch = /^\/containers\/([^/]+)\/wait$/.exec(pathname);
    if (method === "POST" && waitMatch) {
      const ref = resolveContainerRef(waitMatch[1]!);
      if (!ref) return emptyRes(404);
      let exitCode = ref.stage.waitExitCode;
      if (exitCode === undefined) {
        if (ref.name.endsWith("_rs_fetch")) {
          exitCode = 0;
        } else {
          exitCode = 0;
        }
      }
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
      const defaultOut = ref.name.endsWith("_rs_fetch") ? "4096\n" : "";
      const out = ref.stage.stdout ?? defaultOut;
      if (wantOut && out) {
        chunks.push(encodeDockerLogFrame(1, out));
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
      events.push(`container:delete:${ref.name}`);
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
      if (opts?.failVolumeCreate) {
        return jsonRes(500, { message: "volume create failed" });
      }
      const payload = body as { Name?: string; Labels?: Record<string, string> };
      const name = payload?.Name ?? "";
      await opts?.onVolumeCreate?.(name);
      liveVolumes.set(name, payload?.Labels ?? {});
      events.push(`volume:create:${name}`);
      return jsonRes(201, { Name: name });
    }

    if (method === "GET" && pathname === "/volumes") {
      const cfg = opts?.volumesListResponse ?? { statusCode: 200 };
      if (cfg.statusCode !== 200) {
        return jsonRes(cfg.statusCode, { message: "volumes list error" });
      }
      const vols =
        cfg.volumes ??
        [...liveVolumes.entries()].map(([Name, Labels]) => ({ Name, Labels }));
      return jsonRes(200, { Volumes: vols });
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
      await opts?.onVolumeDelete?.(name);
      if (opts?.failDeleteVolumeNames?.has(name)) {
        return jsonRes(500, { message: "volume delete failed" });
      }
      deletedVolumes.push(name);
      events.push(`volume:delete:${name}`);
      if (!liveVolumes.has(name)) {
        return jsonRes(404, { message: "no such volume" });
      }
      liveVolumes.delete(name);
      return emptyRes(204);
    }

    throw new Error(`Unexpected Docker API call: ${method} ${reqPath}`);
  };

  // ownVolumes: site volumes this job created itself, the only non-`hp_bk_` volumes it may create or remove.
  const assertCp01AndNoLeaks = (
    extraStrings: readonly string[] = [],
    ownVolumes: readonly string[] = [],
  ): void => {
    for (const call of requests) {
      const serialized = JSON.stringify({ path: call.path, body: call.body });
      for (const secret of [
        ACCESS_KEY_SENTINEL,
        SECRET_KEY_SENTINEL,
        BACKUP_KEY_SENTINEL,
        DB_ROOT_SENTINEL,
      ]) {
        expect(serialized).not.toContain(secret);
      }
      // CP-01: never stop, pause, unpause, restart, or exec any container.
      expect(call.path).not.toMatch(/\/(stop|pause|unpause|restart|exec)(?:\?|$)/);

      if (call.method === "POST" && call.path.startsWith("/containers/create")) {
        const name = new URL(`http://docker${call.path}`).searchParams.get("name") ?? "";
        expect(name.startsWith("hp_bk_")).toBe(true);
        const cfg = call.body as { HostConfig?: { Binds?: string[] } };
        for (const bind of cfg.HostConfig?.Binds ?? []) {
          expect(bind).not.toContain("docker.sock");
        }
      }
      const opMatch = /^\/containers\/([^/?]+)\/(start|kill)$/.exec(call.path);
      if (opMatch) {
        const ref = decodeURIComponent(opMatch[1]!);
        const name = resolveContainerRef(ref)?.name ?? allNamesById.get(ref) ?? ref;
        expect(name.startsWith("hp_bk_")).toBe(true);
      }
      if (call.method === "DELETE" && call.path.startsWith("/containers/")) {
        const rawRef = decodeURIComponent(call.path.slice("/containers/".length).split("?")[0]!);
        const name = allNamesById.get(rawRef) ?? rawRef;
        expect(name.startsWith("hp_bk_")).toBe(true);
      }
      if (
        (call.method === "POST" && call.path === "/volumes/create") ||
        (call.method === "DELETE" && call.path.startsWith("/volumes/"))
      ) {
        const volName =
          call.method === "POST"
            ? (call.body as { Name?: string })?.Name ?? ""
            : decodeURIComponent(call.path.slice("/volumes/".length).split("?")[0]!);
        expect(volName.startsWith("hp_bk_") || ownVolumes.includes(volName)).toBe(true);
      }
    }

    for (const s of extraStrings) {
      for (const secret of [
        ACCESS_KEY_SENTINEL,
        SECRET_KEY_SENTINEL,
        BACKUP_KEY_SENTINEL,
        DB_ROOT_SENTINEL,
      ]) {
        expect(s).not.toContain(secret);
      }
    }
  };

  return {
    request,
    requests,
    createdSequence,
    containerPayloads,
    liveVolumes,
    killCalls,
    deletedContainers,
    deletedVolumes,
    events,
    pendingWaitResolvers,
    resolvePendingWait(name: string, exitCode: number) {
      const fn = pendingWaitResolvers.get(name);
      if (fn) {
        pendingWaitResolvers.delete(name);
        fn(exitCode);
      }
    },
    assertCp01AndNoLeaks,
  };
}

interface TestSetupOpts {
  tmpDir?: string;
  keyContent?: string | null;
  dbRootContent?: string | null;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  ensureImage?: (image: string) => Promise<void>;
  ensureBackupNetwork?: () => Promise<void>;
  statfs?: BackupRunnerDeps["statfs"];
  harnessOpts?: Parameters<typeof createRestoreDockerHarness>[0];
}

async function setupRestoreRunner(opts?: TestSetupOpts) {
  const ownsTmp = opts?.tmpDir === undefined;
  const tmpDir = opts?.tmpDir ?? (await mkdtemp(path.join(os.tmpdir(), "hp-restore-runner-test-")));
  if (ownsTmp) {
    cleanupTasks.push(() => rm(tmpDir, { recursive: true, force: true }));
  }

  const secretsRootDir = path.join(tmpDir, "secrets");
  await mkdir(secretsRootDir, { recursive: true, mode: 0o700 });
  await chmod(secretsRootDir, 0o700);

  const backupKeyFile = path.join(tmpDir, "backup.key");
  if (opts?.keyContent !== null) {
    await writeFile(backupKeyFile, `${opts?.keyContent ?? BACKUP_KEY_SENTINEL}\n`, { mode: 0o400 });
  }

  const sharedDbRootKeyFile = path.join(tmpDir, "mariadb-root.key");
  if (opts?.dbRootContent !== null) {
    await writeFile(sharedDbRootKeyFile, `${opts?.dbRootContent ?? DB_ROOT_SENTINEL}\n`, {
      mode: 0o400,
    });
  }

  const sharedDbDataDir = path.join(tmpDir, "mariadb-data");
  await mkdir(sharedDbDataDir, { recursive: true, mode: 0o700 });

  const backupWorkDir = path.join(tmpDir, "backup-work");

  const harness = createRestoreDockerHarness({ ...opts?.harnessOpts, secretsRootDir });
  const ensuredImages: string[] = [];

  const deps: BackupRunnerDeps = {
    request: harness.request,
    ensureImage:
      opts?.ensureImage ??
      (async (image) => {
        ensuredImages.push(image);
      }),
    ensureBackupNetwork: opts?.ensureBackupNetwork ?? (async () => undefined),
    listSiteDatabases: async () => [{ name: "wp_0123456789ab", sizeBytes: 2048 }],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    executorUser: "990:990",
    backupWorkDir,
    sharedDbDataDir,
    statfs:
      opts?.statfs ??
      (async () => ({
        bavail: 1_000_000,
        bsize: 4096,
      })),
    now: opts?.now,
    fetch: opts?.fetch ?? makeOkFetch(),
  };

  return {
    runner: new BackupRunner(deps),
    tmpDir,
    backupWorkDir,
    restoresDir: path.join(backupWorkDir, "restores"),
    archivesDir: path.join(backupWorkDir, "archives"),
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbDataDir,
    harness,
    ensuredImages,
  };
}

async function waitForSettled(runner: BackupRunner, jobId: string) {
  const until = performance.now() + 2_500;
  while (performance.now() < until) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") {
      return status;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Job ${jobId} did not settle in time`);
}

async function waitUntil(cond: () => boolean): Promise<void> {
  const until = performance.now() + 2_500;
  while (performance.now() < until) {
    if (cond()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition timed out");
}

function restoreReq(jobId: string, siteId = "site1", serviceInstanceId = "svc_site1"): BackupsIpcRequest {
  return {
    action: "restore",
    jobId,
    siteId,
    serviceInstanceId,
    target: VALID_TARGET,
    snapshotId: GOOD_SNAPSHOT_ID,
  };
}

function archiveReq(jobId: string, siteId = "site1"): BackupsIpcRequest {
  return {
    action: "archive",
    jobId,
    siteId,
    target: VALID_TARGET,
    snapshotId: GOOD_SNAPSHOT_ID,
  };
}

describe("BackupRunner restore, settle, archive, and forgetSite", () => {
  it("exports DEFAULT_BACKUP_WORK_DIR and restore constants + readRestoreNote from index", () => {
    expect(DEFAULT_BACKUP_WORK_DIR).toBe("/var/lib/hosting-panel/backups");
    expect(typeof readRestoreNote).toBe("function");
    expect(ARCHIVE_EXIT_CODES[RESTORE_EXIT_NO_SPACE]).toBe("no_space");
  });

  it("runs a full restore in exact stage order with note transitions, pre-fetched images, disk check, and cleanups", async () => {
    const jobId = jobHex(1);
    let sawNoteBeforeVolCreate = false;
    let sawAllImagesBeforeFetch = false;
    let noteAtSwitch: string | undefined;
    let noteAtFinish: string | undefined;

    const ctx = await setupRestoreRunner({
      harnessOpts: {
        onVolumeCreate: async (volName) => {
          if (volName === `hp_bk_${jobId}`) {
            const note = await readRestoreNote(ctx.restoresDir, jobId);
            sawNoteBeforeVolCreate = note?.stage === "prepare";
          }
        },
        stages: {
          rs_fetch: {
            onCreate: () => {
              sawAllImagesBeforeFetch =
                ctx.ensuredImages.includes(RESTIC_IMAGE) &&
                ctx.ensuredImages.includes(SHARED_MARIADB_IMAGE) &&
                ctx.ensuredImages.includes(resolveWordpressImage(DEFAULT_PHP_VERSION));
            },
          },
          rs_switch: {
            onCreate: async () => {
              noteAtSwitch = (await readRestoreNote(ctx.restoresDir, jobId))?.stage;
            },
          },
          rs_finish: {
            onCreate: async () => {
              noteAtFinish = (await readRestoreNote(ctx.restoresDir, jobId))?.stage;
            },
          },
        },
      },
    });

    const startRes = await ctx.runner.run(restoreReq(jobId));
    expect(startRes).toEqual({
      jobId,
      state: "running",
      failure: null,
      snapshot: null,
    });
    expect("archive" in startRes).toBe(false);

    // Idempotent repeat returns existing status without error.
    expect(await ctx.runner.run(restoreReq(jobId))).toEqual(startRes);

    // Busy site rejects concurrent restore, start, or archive.
    await expect(ctx.runner.run(restoreReq(jobHex(2)))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    await expect(ctx.runner.run(archiveReq(jobHex(3)))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });

    const finalRes = await waitForSettled(ctx.runner, jobId);
    expect(finalRes).toEqual({
      jobId,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect("archive" in finalRes).toBe(false);

    expect(sawNoteBeforeVolCreate).toBe(true);
    expect(sawAllImagesBeforeFetch).toBe(true);
    expect(ctx.ensuredImages).toEqual([
      RESTIC_IMAGE,
      SHARED_MARIADB_IMAGE,
      resolveWordpressImage(DEFAULT_PHP_VERSION),
    ]);
    expect(noteAtSwitch).toBe("switch");
    expect(noteAtFinish).toBe("switched");

    expect(ctx.harness.createdSequence).toEqual([
      `hp_bk_${jobId}_rs_fetch`,
      `hp_bk_${jobId}_rs_fetch_files`,
      `hp_bk_${jobId}_rs_prepare`,
      `hp_bk_${jobId}_rs_gate_on`,
      `hp_bk_${jobId}_rs_switch`,
      `hp_bk_${jobId}_rs_files`,
      `hp_bk_${jobId}_rs_finish`,
    ]);

    // Check containers deleted before staging volume removed.
    const volDeleteIdx = ctx.harness.events.indexOf(`volume:delete:hp_bk_${jobId}`);
    expect(volDeleteIdx).toBeGreaterThan(-1);
    for (const cName of ctx.harness.createdSequence) {
      expect(ctx.harness.events.indexOf(`container:delete:${cName}`)).toBeLessThan(volDeleteIdx);
    }
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jobId}`)).toBe(false);
    expect(await readdir(ctx.secretsRootDir)).toEqual([]);

    const finalNote = await readRestoreNote(ctx.restoresDir, jobId);
    expect(finalNote).toMatchObject({
      v: 1,
      jobId,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "succeeded",
      failure: null,
    });
    expect(typeof finalNote?.endedAt).toBe("string");

    // Payload isolation checks: default WP image for files, DB secret only for DB steps, restic secret only for fetch.
    const fetchBody = ctx.harness.containerPayloads.get(`hp_bk_${jobId}_rs_fetch`) as {
      Env: string[];
    };
    expect(fetchBody.Env.some((e) => e.startsWith("MARIADB_ROOT_FILE="))).toBe(false);
    const prepareBody = ctx.harness.containerPayloads.get(`hp_bk_${jobId}_rs_prepare`) as {
      Env: string[];
      HostConfig: { Binds: string[] };
    };
    expect(prepareBody.Env.some((e) => e.startsWith("MARIADB_ROOT_FILE="))).toBe(true);
    expect(prepareBody.HostConfig.Binds.some((b) => b.includes("hp_vol_"))).toBe(false);
    const filesBody = ctx.harness.containerPayloads.get(`hp_bk_${jobId}_rs_files`) as {
      Image: string;
      HostConfig: { NetworkMode: string; Binds: string[] };
    };
    expect(filesBody.Image).toBe(resolveWordpressImage(DEFAULT_PHP_VERSION));
    expect(filesBody.HostConfig.NetworkMode).toBe("none");

    ctx.harness.assertCp01AndNoLeaks([JSON.stringify(finalRes), JSON.stringify(finalNote)]);
  });

  it("enforces global 2-job limit across restore and archive and cleans pre-fetch failures with nothing touched", async () => {
    const j1 = jobHex(10);
    const j2 = jobHex(11);
    const ctxHold = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_fetch: { waitExitCode: "hang" },
          zip: { waitExitCode: "hang" },
        },
      },
    });
    await ctxHold.runner.run(restoreReq(j1, "site1", "svc_site1"));
    await ctxHold.runner.run(archiveReq(j2, "site2"));
    await expect(ctxHold.runner.run(restoreReq(jobHex(12), "site3", "svc_site3"))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    await waitUntil(
      () =>
        ctxHold.harness.pendingWaitResolvers.has(`hp_bk_${j1}_rs_fetch`) &&
        ctxHold.harness.pendingWaitResolvers.has(`hp_bk_${j2}_zip`),
    );
    ctxHold.harness.resolvePendingWait(`hp_bk_${j1}_rs_fetch`, 0);
    ctxHold.harness.resolvePendingWait(`hp_bk_${j2}_zip`, 12);
    await waitForSettled(ctxHold.runner, j1);
    await waitForSettled(ctxHold.runner, j2);

    // Pre-fetch image failure: restore_prepare_failed with zero step or undo containers run.
    const wpImageFail = await setupRestoreRunner({
      ensureImage: async (img) => {
        if (img === resolveWordpressImage(DEFAULT_PHP_VERSION)) {
          throw new Error("pull failed");
        }
      },
    });
    const jImg = jobHex(13);
    await wpImageFail.runner.run(restoreReq(jImg));
    expect(await waitForSettled(wpImageFail.runner, jImg)).toEqual({
      jobId: jImg,
      state: "failed",
      failure: "restore_prepare_failed",
      snapshot: null,
    });
    expect(wpImageFail.harness.createdSequence).toEqual([]);
    expect(wpImageFail.harness.liveVolumes.has(`hp_bk_${jImg}`)).toBe(false);
    expect(await readRestoreNote(wpImageFail.restoresDir, jImg)).toMatchObject({
      stage: "ended",
      state: "failed",
      failure: "restore_prepare_failed",
    });

    // Missing backup key: key_file_missing.
    const missingKey = await setupRestoreRunner({ keyContent: null });
    const jKey = jobHex(14);
    await missingKey.runner.run(restoreReq(jKey));
    expect(await waitForSettled(missingKey.runner, jKey)).toEqual({
      jobId: jKey,
      state: "failed",
      failure: "key_file_missing",
      snapshot: null,
    });
    expect(missingKey.harness.createdSequence).toEqual([]);
    expect(missingKey.harness.liveVolumes.has(`hp_bk_${jKey}`)).toBe(false);

    // S3 probe failure -> probe problem, nothing touched.
    const badS3 = await setupRestoreRunner({
      fetch: vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof globalThis.fetch,
    });
    const jS3 = jobHex(15);
    await badS3.runner.run(restoreReq(jS3));
    expect(await waitForSettled(badS3.runner, jS3)).toEqual({
      jobId: jS3,
      state: "failed",
      failure: "auth_failed",
      snapshot: null,
    });
    expect(badS3.harness.createdSequence).toEqual([]);
  });

  it("handles pre-switch failures (_rs_fetch, MariaDB disk space, _rs_prepare) by running _rs_undo_db and keeping failure class", async () => {
    for (const [idx, exitCode, expected] of [
      [20, RESTORE_EXIT_NO_SPACE, "no_space"],
      [21, RESTORE_EXIT_INVALID_FILENAMES, "restore_prepare_failed"],
      [22, 12, "wrong_key"],
      [23, 124, "timeout"],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_fetch: { waitExitCode: exitCode } } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "failed",
        failure: expected,
        snapshot: null,
      });
      expect(ctx.harness.createdSequence).toEqual([`hp_bk_${jid}_rs_fetch`, `hp_bk_${jid}_rs_undo_db`, `hp_bk_${jid}_rs_gate_end`]);
      expect(ctx.harness.liveVolumes.has(`hp_bk_${jid}`)).toBe(false);
    }

    // MariaDB disk space insufficient after _rs_fetch stdout dumpKiB -> no_space + _rs_undo_db.
    const lowDisk = await setupRestoreRunner({
      harnessOpts: { stages: { rs_fetch: { waitExitCode: 0, stdout: "8192\n" } } },
      statfs: async () => ({
        bsize: 1024,
        bavail: Math.floor((BACKUP_DISK_FREE_FLOOR_BYTES + 8192 * 1024) / 1024) - 1,
      }),
    });
    const jDisk = jobHex(24);
    await lowDisk.runner.run(restoreReq(jDisk));
    expect(await waitForSettled(lowDisk.runner, jDisk)).toEqual({
      jobId: jDisk,
      state: "failed",
      failure: "no_space",
      snapshot: null,
    });
    expect(lowDisk.harness.createdSequence).toEqual([
      `hp_bk_${jDisk}_rs_fetch`,
      `hp_bk_${jDisk}_rs_fetch_files`,
      `hp_bk_${jDisk}_rs_undo_db`,
      `hp_bk_${jDisk}_rs_gate_end`,
    ]);
    expect(lowDisk.harness.liveVolumes.has(`hp_bk_${jDisk}`)).toBe(false);

    // _rs_prepare exits: 83 -> definer_missing, 80/81/82/11 -> restore_prepare_failed, 124 -> timeout.
    for (const [idx, exitCode, expected] of [
      [25, RESTORE_EXIT_DEFINER_MISSING, "definer_missing"],
      [26, RESTORE_EXIT_EVENT_SCHEDULER_NOT_OFF, "restore_prepare_failed"],
      [27, RESTORE_EXIT_INVALID_DB_NAME, "restore_prepare_failed"],
      [28, RESTORE_EXIT_DB_IMPORT_FAILED, "restore_prepare_failed"],
      [29, RESTORE_EXIT_DB_UNREACHABLE, "restore_prepare_failed"],
      [30, 124, "timeout"],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_prepare: { waitExitCode: exitCode } } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "failed",
        failure: expected,
        snapshot: null,
      });
      expect(ctx.harness.createdSequence).toEqual([
        `hp_bk_${jid}_rs_fetch`,
        `hp_bk_${jid}_rs_fetch_files`,
        `hp_bk_${jid}_rs_prepare`,
        `hp_bk_${jid}_rs_undo_db`,
        `hp_bk_${jid}_rs_gate_end`,
      ]);
      expect(ctx.harness.liveVolumes.has(`hp_bk_${jid}`)).toBe(false);
    }
  });

  it("handles switch and files failures (including 124 and create error) via ordered undo, and freezes leftovers on undo_incomplete", async () => {
    // _rs_switch fails (exit 124 NEVER timeout -> switch_undone; create fail -> switch_undone).
    for (const [idx, switchStage, expectSwitchCreated] of [
      [31, { waitExitCode: 124 }, true],
      [32, { createStatus: 500 }, false],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_switch: switchStage } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "failed",
        failure: "switch_undone",
        snapshot: null,
      });
      expect(ctx.harness.createdSequence).toEqual([
        `hp_bk_${jid}_rs_fetch`,
        `hp_bk_${jid}_rs_fetch_files`,
        `hp_bk_${jid}_rs_prepare`,
        `hp_bk_${jid}_rs_gate_on`,
        ...(expectSwitchCreated ? [`hp_bk_${jid}_rs_switch`] : []),
        `hp_bk_${jid}_rs_undo_files`,
        `hp_bk_${jid}_rs_gate_undo`,
        `hp_bk_${jid}_rs_undo_db`,
        `hp_bk_${jid}_rs_gate_end`,
      ]);
      expect(ctx.harness.liveVolumes.has(`hp_bk_${jid}`)).toBe(false);
    }

    // _rs_files fails (exit 93, exit 124 -> switch_undone, NEVER timeout).
    for (const [idx, exitCode] of [
      [33, RESTORE_EXIT_FILES_PLAN_EXISTS],
      [34, 124],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_files: { waitExitCode: exitCode } } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "failed",
        failure: "switch_undone",
        snapshot: null,
      });
      expect(ctx.harness.createdSequence).toEqual([
        `hp_bk_${jid}_rs_fetch`,
        `hp_bk_${jid}_rs_fetch_files`,
        `hp_bk_${jid}_rs_prepare`,
        `hp_bk_${jid}_rs_gate_on`,
        `hp_bk_${jid}_rs_switch`,
        `hp_bk_${jid}_rs_files`,
        `hp_bk_${jid}_rs_undo_files`,
        `hp_bk_${jid}_rs_gate_undo`,
        `hp_bk_${jid}_rs_undo_db`,
        `hp_bk_${jid}_rs_gate_end`,
      ]);
      expect(ctx.harness.liveVolumes.has(`hp_bk_${jid}`)).toBe(false);
    }

    // _rs_undo_files fails -> _rs_undo_db MUST NOT run; undo_incomplete keeps staging vol & note.
    const undoFilesFail = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_files: { waitExitCode: 1 },
          rs_undo_files: { waitExitCode: 1 },
        },
      },
    });
    const jUndoFiles = jobHex(35);
    await undoFilesFail.runner.run(restoreReq(jUndoFiles));
    expect(await waitForSettled(undoFilesFail.runner, jUndoFiles)).toEqual({
      jobId: jUndoFiles,
      state: "failed",
      failure: "undo_incomplete",
      snapshot: null,
    });
    expect(undoFilesFail.harness.createdSequence).toEqual([
      `hp_bk_${jUndoFiles}_rs_fetch`,
      `hp_bk_${jUndoFiles}_rs_fetch_files`,
      `hp_bk_${jUndoFiles}_rs_prepare`,
      `hp_bk_${jUndoFiles}_rs_gate_on`,
      `hp_bk_${jUndoFiles}_rs_switch`,
      `hp_bk_${jUndoFiles}_rs_files`,
      `hp_bk_${jUndoFiles}_rs_undo_files`,
    ]);
    expect(undoFilesFail.harness.liveVolumes.has(`hp_bk_${jUndoFiles}`)).toBe(true);
    expect(await readRestoreNote(undoFilesFail.restoresDir, jUndoFiles)).toMatchObject({
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
    });

    // _rs_undo_db fails (exit 92) -> undo_incomplete keeps staging vol & note.
    const undoDbFail = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_files: { waitExitCode: 1 },
          rs_undo_db: { waitExitCode: RESTORE_EXIT_UNDO_SCHEMA_NOT_EMPTY },
        },
      },
    });
    const jUndoDb = jobHex(36);
    await undoDbFail.runner.run(restoreReq(jUndoDb));
    expect(await waitForSettled(undoDbFail.runner, jUndoDb)).toEqual({
      jobId: jUndoDb,
      state: "failed",
      failure: "undo_incomplete",
      snapshot: null,
    });
    expect(undoDbFail.harness.liveVolumes.has(`hp_bk_${jUndoDb}`)).toBe(true);
    expect(await readRestoreNote(undoDbFail.restoresDir, jUndoDb)).toMatchObject({
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
    });
  });

  it("enforces R79 on _rs_finish and R80 cleanup of same-site undo_incomplete leftovers on later succeeded restore", async () => {
    // 1. _rs_finish exit 96 / unknown 2 / create failure -> undo_incomplete with NO undo, note & vol kept.
    for (const [idx, finishStage] of [
      [40, { waitExitCode: RESTORE_EXIT_GATE_REMOVE_FAILED }],
      [41, { waitExitCode: 2 }],
      [42, { createStatus: 404 }],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_finish: finishStage } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "failed",
        failure: "undo_incomplete",
        snapshot: null,
      });
      expect(ctx.harness.createdSequence.some((n) => n.includes("_rs_undo_"))).toBe(false);
      expect(ctx.harness.liveVolumes.has(`hp_bk_${jid}`)).toBe(true);
      expect(await readRestoreNote(ctx.restoresDir, jid)).toMatchObject({
        stage: "ended",
        state: "failed",
        failure: "undo_incomplete",
      });
    }

    // 2. _rs_finish exits 97, 11, or 124 -> succeeded, note stays at "switched"!
    for (const [idx, exitCode] of [
      [43, RESTORE_EXIT_FINISH_CLEANUP_FAILED],
      [44, RESTORE_EXIT_DB_UNREACHABLE],
      [45, 124],
    ] as const) {
      const ctx = await setupRestoreRunner({
        harnessOpts: { stages: { rs_finish: { waitExitCode: exitCode } } },
      });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: "succeeded",
        failure: null,
        snapshot: null,
      });
      expect(await readRestoreNote(ctx.restoresDir, jid)).toMatchObject({
        stage: "switched",
      });
    }

    // 3. R80: later succeeded restore of site1 cleans site1's old undo_incomplete but never site2's.
    const oldX = jobHex(46);
    const oldY = jobHex(47);
    const newX = jobHex(48);
    const ctxR80 = await setupRestoreRunner();
    await writeRestoreNote(ctxR80.restoresDir, {
      v: 1,
      jobId: oldX,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: "2026-11-15T01:00:00.000Z",
    });
    await writeRestoreNote(ctxR80.restoresDir, {
      v: 1,
      jobId: oldY,
      siteId: "site2",
      serviceInstanceId: "svc_site2",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: "2026-11-15T01:00:00.000Z",
    });
    ctxR80.harness.liveVolumes.set(`hp_bk_${oldX}`, { "io.hostingpanel.role": "backup_staging" });
    ctxR80.harness.liveVolumes.set(`hp_bk_${oldY}`, { "io.hostingpanel.role": "backup_staging" });

    await ctxR80.runner.run(restoreReq(newX, "site1", "svc_site1"));
    expect(await waitForSettled(ctxR80.runner, newX)).toEqual({
      jobId: newX,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(ctxR80.harness.createdSequence).toContain(`hp_bk_${oldX}_rs_finish`);
    expect(ctxR80.harness.createdSequence).not.toContain(`hp_bk_${oldY}_rs_finish`);
    expect(ctxR80.harness.liveVolumes.has(`hp_bk_${oldX}`)).toBe(false);
    expect(await readRestoreNote(ctxR80.restoresDir, oldX)).toBeNull();
    expect(ctxR80.harness.liveVolumes.has(`hp_bk_${oldY}`)).toBe(true);
    expect(await readRestoreNote(ctxR80.restoresDir, oldY)).not.toBeNull();

    // 4. R80 cleanup failure is logged and does NOT fail the new restore.
    const oldXFail = jobHex(49);
    const newX2 = jobHex(50);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctxLog = await setupRestoreRunner({
      harnessOpts: {
        failDeleteVolumeNames: new Set([`hp_bk_${oldXFail}`]),
      },
    });
    await writeRestoreNote(ctxLog.restoresDir, {
      v: 1,
      jobId: oldXFail,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: "2026-11-15T01:00:00.000Z",
    });
    ctxLog.harness.liveVolumes.set(`hp_bk_${oldXFail}`, { "io.hostingpanel.role": "backup_staging" });

    await ctxLog.runner.run(restoreReq(newX2, "site1", "svc_site1"));
    expect(await waitForSettled(ctxLog.runner, newX2)).toEqual({
      jobId: newX2,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(errSpy).toHaveBeenCalled();
    ctxLog.harness.assertCp01AndNoLeaks(errSpy.mock.calls.flat().map(String));
  });

  it("enforces E14 step timeouts and kills hung containers at their exact step budget", async () => {
    for (const [idx, suffix, timeoutMs, expected] of [
      [51, "rs_prepare", BACKUP_RESTORE_PREPARE_TIMEOUT_MS, "timeout"],
      [52, "rs_switch", BACKUP_RESTORE_SWITCH_TIMEOUT_MS, "switch_undone"],
      [53, "rs_files", BACKUP_RESTORE_FILES_TIMEOUT_MS, "switch_undone"],
      [54, "rs_undo_db", BACKUP_RESTORE_UNDO_TIMEOUT_MS, "undo_incomplete"],
      [55, "rs_finish", BACKUP_RESTORE_FINISH_TIMEOUT_MS, "succeeded"],
    ] as const) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let started = false;
      const stages: Parameters<typeof createRestoreDockerHarness>[0] = {
        stages: {
          ...(suffix === "rs_undo_db" ? { rs_files: { waitExitCode: 1 } } : {}),
          [suffix]: {
            waitExitCode: "hang",
            onStart: () => {
              started = true;
            },
          },
        },
      };
      const ctx = await setupRestoreRunner({ harnessOpts: stages });
      const jid = jobHex(idx);
      await ctx.runner.run(restoreReq(jid));
      await waitUntil(() => started);
      await vi.advanceTimersByTimeAsync(timeoutMs + 100);
      expect(await waitForSettled(ctx.runner, jid)).toEqual({
        jobId: jid,
        state: expected === "succeeded" ? "succeeded" : "failed",
        failure: expected === "succeeded" ? null : expected,
        snapshot: null,
      });
      expect(ctx.harness.killCalls).toContain(`hp_bk_${jid}_${suffix}`);
      vi.useRealTimers();
    }
  });

  it("settles all crash note stages at start, honors TTL & R80 retention, keeps noted volumes in removeOrphans, and guards corrupt/unreadable notes", async () => {
    const clockMs = 1_700_000_000_000;
    const sharedTmp = await mkdtemp(path.join(os.tmpdir(), "hp-settle-shared-"));
    cleanupTasks.push(() => rm(sharedTmp, { recursive: true, force: true }));
    const restoresDir = path.join(sharedTmp, "backup-work", "restores");

    const jPrepare = jobHex(60);
    const jSwitch = jobHex(61);
    const jSwitched = jobHex(62);
    const jEndedFresh = jobHex(63);
    const jEndedOld = jobHex(64);
    const jEndedOldUndo = jobHex(65);
    const jDangling = jobHex(66);
    const jCorrupt = jobHex(67);
    const jSymlink = jobHex(68);

    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jPrepare,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "prepare",
    });
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jSwitch,
      siteId: "site2",
      serviceInstanceId: "svc_site2",
      stage: "switch",
    });
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jSwitched,
      siteId: "site3",
      serviceInstanceId: "svc_site3",
      stage: "switched",
    });
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jEndedFresh,
      siteId: "site4",
      serviceInstanceId: "svc_site4",
      stage: "ended",
      state: "succeeded",
      failure: null,
      endedAt: new Date(clockMs - 60_000).toISOString(),
    });
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jEndedOld,
      siteId: "site4",
      serviceInstanceId: "svc_site4",
      stage: "ended",
      state: "failed",
      failure: "switch_undone",
      endedAt: new Date(clockMs - BACKUP_STATUS_TTL_MS - 1_000).toISOString(),
    });
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jEndedOldUndo,
      siteId: "site5",
      serviceInstanceId: "svc_site5",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: new Date(clockMs - BACKUP_STATUS_TTL_MS * 3).toISOString(),
    });
    // Corrupt JSON and symlink notes must be logged and left completely untouched.
    await writeFile(path.join(restoresDir, `${jCorrupt}.json`), "{broken json", { mode: 0o600 });
    await symlink(path.join(restoresDir, `${jEndedFresh}.json`), path.join(restoresDir, `${jSymlink}.json`));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const liveStagingVols = [
      `hp_bk_${jPrepare}`,
      `hp_bk_${jSwitch}`,
      `hp_bk_${jEndedOldUndo}`,
      `hp_bk_${jDangling}`,
    ];
    const ctx = await setupRestoreRunner({
      tmpDir: sharedTmp,
      now: () => clockMs,
      harnessOpts: {
        siteVolumes: [
          "hp_vol_svc_site1_html",
          "hp_vol_svc_site2_html",
          "hp_vol_svc_site3_html",
          "hp_vol_svc_site5_html",
          ...liveStagingVols,
        ],
        volumesListResponse: {
          statusCode: 200,
          volumes: liveStagingVols.map((Name) => ({
            Name,
            Labels: { "io.hostingpanel.role": "backup_staging" },
          })),
        },
      },
    });
    for (const v of liveStagingVols) {
      ctx.harness.liveVolumes.set(v, { "io.hostingpanel.role": "backup_staging" });
    }

    // 1. removeOrphans keeps noted staging volumes and removes dangling hp_bk_<jDangling>.
    await ctx.runner.removeOrphans();
    expect(ctx.harness.deletedVolumes).toEqual([`hp_bk_${jDangling}`]);
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jPrepare}`)).toBe(true);
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jSwitch}`)).toBe(true);
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jEndedOldUndo}`)).toBe(true);

    // 2. settleRestores() settles prepare -> interrupted, switch -> switch_undone, switched -> succeeded.
    await ctx.runner.settleRestores();
    expect(await waitForSettled(ctx.runner, jPrepare)).toEqual({
      jobId: jPrepare,
      state: "failed",
      failure: "interrupted",
      snapshot: null,
    });
    expect(ctx.harness.createdSequence).not.toContain(`hp_bk_${jPrepare}_rs_finish`);
    expect(ctx.harness.createdSequence).toContain(`hp_bk_${jPrepare}_rs_undo_db`);

    expect(await waitForSettled(ctx.runner, jSwitch)).toEqual({
      jobId: jSwitch,
      state: "failed",
      failure: "switch_undone",
      snapshot: null,
    });
    expect(await waitForSettled(ctx.runner, jSwitched)).toEqual({
      jobId: jSwitched,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });

    // Fresh ended stays & answers status; old non-undo_incomplete deleted; old undo_incomplete stays!
    expect(await ctx.runner.run({ action: "status", jobId: jEndedFresh })).toEqual({
      jobId: jEndedFresh,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(await ctx.runner.run({ action: "status", jobId: jEndedOld })).toEqual({
      jobId: jEndedOld,
      state: "unknown",
      failure: null,
      snapshot: null,
    });
    expect(await readRestoreNote(restoresDir, jEndedOld)).toBeNull();
    expect(await ctx.runner.run({ action: "status", jobId: jEndedOldUndo })).toEqual({
      jobId: jEndedOldUndo,
      state: "failed",
      failure: "undo_incomplete",
      snapshot: null,
    });
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jEndedOldUndo}`)).toBe(true);

    // Corrupt & symlink notes still untouched, status returns unknown, errors logged.
    expect(await readFile(path.join(restoresDir, `${jCorrupt}.json`), "utf8")).toBe("{broken json");
    expect((await lstat(path.join(restoresDir, `${jSymlink}.json`))).isSymbolicLink()).toBe(true);
    expect(await ctx.runner.run({ action: "status", jobId: jCorrupt })).toMatchObject({ state: "unknown" });
    expect(errSpy).toHaveBeenCalled();

    // Staging volumes of settled prepare & switch were deleted.
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jPrepare}`)).toBe(false);
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jSwitch}`)).toBe(false);
  });

  it("bounds settleRestores wait at start, handles duplicate settle calls idempotently, and never restarts unknown settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const sharedTmp = await mkdtemp(path.join(os.tmpdir(), "hp-settle-bound-"));
    cleanupTasks.push(() => rm(sharedTmp, { recursive: true, force: true }));
    const restoresDir = path.join(sharedTmp, "backup-work", "restores");

    const jSlow = jobHex(70);
    await writeRestoreNote(restoresDir, {
      v: 1,
      jobId: jSlow,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "prepare",
    });

    const ctx = await setupRestoreRunner({
      tmpDir: sharedTmp,
      harnessOpts: { stages: { rs_undo_db: { waitExitCode: "hang" } } },
    });

    let settledReturned = false;
    const settleP = ctx.runner.settleRestores().then(() => {
      settledReturned = true;
    });
    await waitUntil(() => ctx.harness.pendingWaitResolvers.has(`hp_bk_${jSlow}_rs_undo_db`));
    expect(settledReturned).toBe(false);

    // Past BACKUP_RESTORE_SETTLE_START_MS, startup continues with settlement still running in background.
    await vi.advanceTimersByTimeAsync(BACKUP_RESTORE_SETTLE_START_MS + 10);
    await settleP;
    expect(settledReturned).toBe(true);

    expect(await ctx.runner.run({ action: "status", jobId: jSlow })).toMatchObject({
      jobId: jSlow,
      state: "running",
    });
    // Site lock is held while background settlement continues.
    await expect(ctx.runner.run(restoreReq(jobHex(71)))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    // Calling settle twice in a row while running does not start a second container.
    expect(await ctx.runner.run({ action: "settle", jobId: jSlow })).toMatchObject({ state: "running" });
    expect(await ctx.runner.run({ action: "settle", jobId: jSlow })).toMatchObject({ state: "running" });
    expect(
      ctx.harness.createdSequence.filter((n) => n === `hp_bk_${jSlow}_rs_undo_db`),
    ).toHaveLength(1);

    ctx.harness.resolvePendingWait(`hp_bk_${jSlow}_rs_undo_db`, 0);
    expect(await waitForSettled(ctx.runner, jSlow)).toEqual({
      jobId: jSlow,
      state: "failed",
      failure: "interrupted",
      snapshot: null,
    });
    vi.useRealTimers();

    // Unknown note on settle returns unknown and never creates a restore container.
    const countBefore = ctx.harness.createdSequence.length;
    expect(await ctx.runner.run({ action: "settle", jobId: jobHex(72) })).toEqual({
      jobId: jobHex(72),
      state: "unknown",
      failure: null,
      snapshot: null,
    });
    expect(ctx.harness.createdSequence).toHaveLength(countBefore);

    // 3 unsettled notes across 3 sites respect BACKUP_MAX_RUNNING_JOBS (2 concurrent max) and all finish.
    const tmpConcurrency = await mkdtemp(path.join(os.tmpdir(), "hp-settle-3sites-"));
    cleanupTasks.push(() => rm(tmpConcurrency, { recursive: true, force: true }));
    const restoresDirConcurrency = path.join(tmpConcurrency, "backup-work", "restores");
    const jC1 = jobHex(74);
    const jC2 = jobHex(75);
    const jC3 = jobHex(76);
    for (const [idx, jid] of [jC1, jC2, jC3].entries()) {
      await writeRestoreNote(restoresDirConcurrency, {
        v: 1,
        jobId: jid,
        siteId: `site_${idx + 1}`,
        serviceInstanceId: `svc_${idx + 1}`,
        stage: "prepare",
      });
    }
    const ctx3 = await setupRestoreRunner({
      tmpDir: tmpConcurrency,
      harnessOpts: { stages: { rs_undo_db: { waitExitCode: "hang" } } },
    });
    let maxRunningSeen = 0;
    const settle3P = ctx3.runner.settleRestores();
    await waitUntil(() => ctx3.harness.pendingWaitResolvers.size === 2);
    maxRunningSeen = Math.max(maxRunningSeen, ctx3.harness.pendingWaitResolvers.size);
    // Give microtasks a turn to verify the 3rd job is queued, not started prematurely.
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx3.harness.pendingWaitResolvers.size).toBe(2);

    ctx3.harness.resolvePendingWait(`hp_bk_${jC1}_rs_undo_db`, 0);
    await waitUntil(() => ctx3.harness.pendingWaitResolvers.has(`hp_bk_${jC3}_rs_undo_db`));
    maxRunningSeen = Math.max(maxRunningSeen, ctx3.harness.pendingWaitResolvers.size);
    ctx3.harness.resolvePendingWait(`hp_bk_${jC2}_rs_undo_db`, 0);
    ctx3.harness.resolvePendingWait(`hp_bk_${jC3}_rs_undo_db`, 0);
    await settle3P;
    expect(maxRunningSeen).toBe(2);
    for (const jid of [jC1, jC2, jC3]) {
      expect(await ctx3.runner.run({ action: "status", jobId: jid })).toEqual({
        jobId: jid,
        state: "failed",
        failure: "interrupted",
        snapshot: null,
      });
    }

    // Unfinished "switched" note after post-gate failure (97) keeps note "switched" and succeeds, and explicit settle retries finish.
    const jPostGate = jobHex(73);
    let retryFinishCalls = 0;
    const ctxRetry = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_finish: () => {
            retryFinishCalls += 1;
            return { waitExitCode: retryFinishCalls === 1 ? 97 : 0 };
          },
        },
      },
    });
    await writeRestoreNote(ctxRetry.restoresDir, {
      v: 1,
      jobId: jPostGate,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "switched",
    });
    await ctxRetry.runner.settleRestores();
    expect(await waitForSettled(ctxRetry.runner, jPostGate)).toMatchObject({
      state: "succeeded",
      failure: null,
    });
    expect((await readRestoreNote(ctxRetry.restoresDir, jPostGate))?.stage).toBe("switched");
    await ctxRetry.runner.run({ action: "settle", jobId: jPostGate });
    expect(await waitForSettled(ctxRetry.runner, jPostGate)).toMatchObject({
      state: "succeeded",
      failure: null,
    });
    expect((await readRestoreNote(ctxRetry.restoresDir, jPostGate))?.stage).toBe("ended");
    expect(retryFinishCalls).toBe(2);

    // Hang the explicit settle finish so we can test duplicate `settle` calls.
    const jDup = jobHex(74);
    const ctxManual = await setupRestoreRunner({
      harnessOpts: { stages: { rs_finish: { waitExitCode: "hang" } } },
    });
    await writeRestoreNote(ctxManual.restoresDir, {
      v: 1,
      jobId: jDup,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "switched",
    });
    const s1 = await ctxManual.runner.run({ action: "settle", jobId: jDup });
    const s2 = await ctxManual.runner.run({ action: "settle", jobId: jDup });
    expect(s1.state).toBe("running");
    expect(s2.state).toBe("running");
    await waitUntil(() => ctxManual.harness.pendingWaitResolvers.has(`hp_bk_${jDup}_rs_finish`));
    expect(
      ctxManual.harness.createdSequence.filter((n) => n === `hp_bk_${jDup}_rs_finish`),
    ).toHaveLength(1);
    ctxManual.harness.resolvePendingWait(`hp_bk_${jDup}_rs_finish`, 0);
    expect(await waitForSettled(ctxManual.runner, jDup)).toEqual({
      jobId: jDup,
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
  });

  it("handles full archive lifecycle: build zip, 0700 dir, chunked reads < 1 MiB, replacement, expiry, discard, failures, and emptyArchives", async () => {
    const jA1 = jobHex(80);
    const jA2 = jobHex(81);
    const jFail = jobHex(82);

    const tmpArchives = await mkdtemp(path.join(os.tmpdir(), "hp-archive-test-"));
    cleanupTasks.push(() => rm(tmpArchives, { recursive: true, force: true }));
    const preArchivesDir = path.join(tmpArchives, "backup-work", "archives");
    const payloadBytes = Buffer.alloc(SITE_FILE_CHUNK_BYTES * 2 + 123, 0x5a);
    payloadBytes.write("PK\x05\x06", 0, "latin1");
    const ctx = await setupRestoreRunner({
      tmpDir: tmpArchives,
      harnessOpts: {
        stages: {
          zip: (name) => ({
            onStart: async () => {
              const idMatch = /^hp_bk_(op_[0-9a-f]{32})_zip$/.exec(name);
              const targetId = idMatch?.[1];
              if (!targetId) throw new Error(`unexpected zip container ${name}`);
              await writeFile(path.join(preArchivesDir, `${targetId}.part`), payloadBytes);
              if (targetId !== jFail) {
                await rm(path.join(preArchivesDir, `${targetId}.zip`), { force: true });
                await writeFile(path.join(preArchivesDir, `${targetId}.zip`), payloadBytes);
                await rm(path.join(preArchivesDir, `${targetId}.part`), { force: true });
              }
            },
            waitExitCode: name.includes(jFail) ? RESTORE_EXIT_NO_SPACE : 0,
          }),
        },
      },
    });

    const startA1 = await ctx.runner.run(archiveReq(jA1, "site1"));
    expect("archive" in startA1).toBe(false);
    // While archive job is running -> RESOURCE_LOCKED "archive_preparing".
    await expect(
      ctx.runner.run({ action: "readArchive", jobId: jA1, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED", message: "archive_preparing" });

    const doneA1 = await waitForSettled(ctx.runner, jA1);
    expect(doneA1.state).toBe("succeeded");
    expect(doneA1.snapshot).toBeNull();
    expect(doneA1.archive?.sizeBytes).toBe(payloadBytes.length);
    const dirMode = (await stat(ctx.archivesDir)).mode & 0o777;
    expect(dirMode).toBe(0o700);

    // Check payload binds & executorUser.
    const zipBody = ctx.harness.containerPayloads.get(`hp_bk_${jA1}_zip`) as {
      User: string;
      HostConfig: { Binds: string[] };
    };
    expect(zipBody.User).toBe("990:990");
    expect(zipBody.HostConfig.Binds.some((b) => b === `${ctx.archivesDir}:/a`)).toBe(true);

    // Read full file in bounded chunks (< 1 MiB response each).
    const pieces: Buffer[] = [];
    let offset = 0;
    while (true) {
      const chunk = await ctx.runner.run({
        action: "readArchive",
        jobId: jA1,
        offset,
        length: SITE_FILE_CHUNK_BYTES,
      });
      expect(Buffer.byteLength(JSON.stringify(chunk), "utf8")).toBeLessThan(1_048_576);
      const raw = Buffer.from(chunk.dataBase64, "base64");
      pieces.push(raw);
      offset += raw.length;
      if (chunk.eof) {
        expect(offset).toBe(payloadBytes.length);
        break;
      }
    }
    expect(Buffer.concat(pieces).equals(payloadBytes)).toBe(true);
    expect(
      await ctx.runner.run({
        action: "readArchive",
        jobId: jA1,
        offset: payloadBytes.length,
        length: 64,
      }),
    ).toEqual({
      dataBase64: "",
      size: payloadBytes.length,
      eof: true,
    });

    // Starting a second archive for site1 replaces the first immediately.
    await ctx.runner.run(archiveReq(jA2, "site1"));
    await expect(
      ctx.runner.run({ action: "readArchive", jobId: jA1, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    await waitForSettled(ctx.runner, jA2);

    // Failed archive deletes .part and produces no archive.
    await ctx.runner.run(archiveReq(jFail, "site2"));
    const failRes = await waitForSettled(ctx.runner, jFail);
    expect(failRes).toEqual({
      jobId: jFail,
      state: "failed",
      failure: "no_space",
      snapshot: null,
    });
    expect("archive" in failRes).toBe(false);
    expect(await readdir(ctx.archivesDir)).not.toContain(`${jFail}.part`);

    // discardArchive removes jA2 zip and makes readArchive throw archive_gone.
    expect(await ctx.runner.run({ action: "discardArchive", jobId: jA2 })).toEqual({ discarded: true });
    expect(await ctx.runner.run({ action: "discardArchive", jobId: jA2 })).toEqual({ discarded: false });
    await expect(
      ctx.runner.run({ action: "readArchive", jobId: jA2, offset: 0, length: 64 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });

    // emptyArchives wipes leftovers in archives/.
    await writeFile(path.join(ctx.archivesDir, "stale.part"), "123");
    await ctx.runner.emptyArchives();
    expect(await readdir(ctx.archivesDir)).toEqual([]);

    // 60-minute timer deletes ready archive automatically.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const jExpire = jobHex(83);
    const expCtx = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          zip: {
            onStart: async () => {
              await writeFile(path.join(expCtx.archivesDir, `${jExpire}.zip`), Buffer.from("zipbytes"));
            },
          },
        },
      },
    });
    await expCtx.runner.run(archiveReq(jExpire, "site1"));
    await waitForSettled(expCtx.runner, jExpire);
    expect(await readdir(expCtx.archivesDir)).toContain(`${jExpire}.zip`);
    await vi.advanceTimersByTimeAsync(BACKUP_ARCHIVE_TTL_MS + 100);
    await expect(
      expCtx.runner.run({ action: "readArchive", jobId: jExpire, offset: 0, length: 16 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect(await readdir(expCtx.archivesDir)).toEqual([]);
    vi.useRealTimers();
  });

  it("forgetSite rejects unsettled notes with RESOURCE_LOCKED and clears ended/undo_incomplete notes, volumes, and archives for that site only", async () => {
    const jArch1 = jobHex(94);
    const jArch2 = jobHex(95);
    const tmpForget = await mkdtemp(path.join(os.tmpdir(), "hp-forget-site-"));
    cleanupTasks.push(() => rm(tmpForget, { recursive: true, force: true }));
    const preForgetArchivesDir = path.join(tmpForget, "backup-work", "archives");
    const ctx = await setupRestoreRunner({
      tmpDir: tmpForget,
      harnessOpts: {
        stages: {
          zip: (name) => ({
            onStart: async () => {
              const idMatch = /^hp_bk_(op_[0-9a-f]{32})_zip$/.exec(name);
              const targetId = idMatch?.[1];
              if (!targetId) throw new Error(`unexpected zip container ${name}`);
              await writeFile(path.join(preForgetArchivesDir, `${targetId}.zip`), Buffer.from("zipdata"));
            },
          }),
        },
      },
    });
    await ctx.runner.run(archiveReq(jArch1, "site1"));
    await waitForSettled(ctx.runner, jArch1);
    await ctx.runner.run(archiveReq(jArch2, "site2"));
    await waitForSettled(ctx.runner, jArch2);

    const jSite1Ended = jobHex(90);
    const jSite1Undo = jobHex(91);
    const jSite1Pending = jobHex(92);
    const jSite2Ended = jobHex(93);

    await writeRestoreNote(ctx.restoresDir, {
      v: 1,
      jobId: jSite1Ended,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "succeeded",
      failure: null,
      endedAt: "2026-11-15T01:00:00.000Z",
    });
    await writeRestoreNote(ctx.restoresDir, {
      v: 1,
      jobId: jSite1Undo,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: "2026-11-15T01:00:00.000Z",
    });
    await writeRestoreNote(ctx.restoresDir, {
      v: 1,
      jobId: jSite1Pending,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "switched",
    });
    await writeRestoreNote(ctx.restoresDir, {
      v: 1,
      jobId: jSite2Ended,
      siteId: "site2",
      serviceInstanceId: "svc_site2",
      stage: "ended",
      state: "failed",
      failure: "undo_incomplete",
      endedAt: "2026-11-15T01:00:00.000Z",
    });

    ctx.harness.liveVolumes.set(`hp_bk_${jSite1Undo}`, { "io.hostingpanel.role": "backup_staging" });
    ctx.harness.liveVolumes.set(`hp_bk_${jSite2Ended}`, { "io.hostingpanel.role": "backup_staging" });

    // Unsettled note -> RESOURCE_LOCKED and nothing deleted.
    await expect(ctx.runner.forgetSite("site1")).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jSite1Undo}`)).toBe(true);
    expect(await readdir(ctx.archivesDir)).toContain(`${jArch1}.zip`);

    // Once jSite1Pending settles to ended, forgetSite clears site1's notes, staging vol, and archive, leaving site2 intact.
    await writeRestoreNote(ctx.restoresDir, {
      v: 1,
      jobId: jSite1Pending,
      siteId: "site1",
      serviceInstanceId: "svc_site1",
      stage: "ended",
      state: "succeeded",
      failure: null,
      endedAt: "2026-11-15T02:00:00.000Z",
    });
    await ctx.runner.forgetSite("site1");

    expect(ctx.harness.liveVolumes.has(`hp_bk_${jSite1Undo}`)).toBe(false);
    expect(await readRestoreNote(ctx.restoresDir, jSite1Ended)).toBeNull();
    expect(await readRestoreNote(ctx.restoresDir, jSite1Undo)).toBeNull();
    expect(await readRestoreNote(ctx.restoresDir, jSite1Pending)).toBeNull();
    await expect(
      ctx.runner.run({ action: "readArchive", jobId: jArch1, offset: 0, length: 16 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "archive_gone" });
    expect(await readdir(ctx.archivesDir)).not.toContain(`${jArch1}.zip`);

    // site2 left untouched.
    expect(ctx.harness.liveVolumes.has(`hp_bk_${jSite2Ended}`)).toBe(true);
    expect(await readRestoreNote(ctx.restoresDir, jSite2Ended)).not.toBeNull();
    expect(await readdir(ctx.archivesDir)).toContain(`${jArch2}.zip`);
  });

  it("maps RESTORE_EXIT_INVALID_OBJECT_NAME in prepare and switch and logs only allowlisted objectKind and database", async () => {
    const dbPrefix = siteDatabasePrefix("site1");
    const validDb = `${dbPrefix}_shop`;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // 1. Prepare failure: kind\tdb is the last stderr line, after client noise
    const prepCtx = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_prepare: {
            waitExitCode: RESTORE_EXIT_INVALID_OBJECT_NAME,
            stderr: `mariadb: client noise should_never_be_logged\nTRIGGER\t${validDb}\tshould_never_be_logged\n`,
          },
        },
      },
    });
    const jPrep = jobHex(84);
    await prepCtx.runner.run(restoreReq(jPrep));
    expect(await waitForSettled(prepCtx.runner, jPrep)).toEqual({
      jobId: jPrep,
      state: "failed",
      failure: "restore_prepare_failed",
      snapshot: null,
    });
    expect(prepCtx.harness.createdSequence).toEqual([
      `hp_bk_${jPrep}_rs_fetch`,
      `hp_bk_${jPrep}_rs_fetch_files`,
      `hp_bk_${jPrep}_rs_prepare`,
      `hp_bk_${jPrep}_rs_undo_db`,
      `hp_bk_${jPrep}_rs_gate_end`,
    ]);

    // 2. Switch failure with adversarial/invalid stderr still maps to switch_undone and sanitizes logs
    const switchCtx = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_switch: {
            waitExitCode: RESTORE_EXIT_INVALID_OBJECT_NAME,
            stderr: "BOGUS_KIND\t../evil_secret_obj\n",
          },
        },
      },
    });
    const jSwitch = jobHex(85);
    await switchCtx.runner.run(restoreReq(jSwitch));
    expect(await waitForSettled(switchCtx.runner, jSwitch)).toEqual({
      jobId: jSwitch,
      state: "failed",
      failure: "switch_undone",
      snapshot: null,
    });
    expect(switchCtx.harness.createdSequence).toEqual([
      `hp_bk_${jSwitch}_rs_fetch`,
      `hp_bk_${jSwitch}_rs_fetch_files`,
      `hp_bk_${jSwitch}_rs_prepare`,
      `hp_bk_${jSwitch}_rs_gate_on`,
      `hp_bk_${jSwitch}_rs_switch`,
      `hp_bk_${jSwitch}_rs_undo_files`,
      `hp_bk_${jSwitch}_rs_gate_undo`,
      `hp_bk_${jSwitch}_rs_undo_db`,
      `hp_bk_${jSwitch}_rs_gate_end`,
    ]);

    const loggedRecords = errSpy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
    const prepLog = loggedRecords.find(
      (r) => r.event === "restore_invalid_object_name" && r.jobId === jPrep,
    );
    expect(prepLog).toMatchObject({
      component: "hp-docker-executor",
      event: "restore_invalid_object_name",
      jobId: jPrep,
      siteId: "site1",
      step: "prepare",
      objectKind: "TRIGGER",
      database: validDb,
    });
    const switchLog = loggedRecords.find(
      (r) => r.event === "restore_invalid_object_name" && r.jobId === jSwitch,
    );
    expect(switchLog).toMatchObject({
      component: "hp-docker-executor",
      event: "restore_invalid_object_name",
      jobId: jSwitch,
      siteId: "site1",
      step: "switch",
      objectKind: "unknown",
      database: "unknown",
    });
    const allLogsText = JSON.stringify(loggedRecords);
    expect(allLogsText).not.toContain("should_never_be_logged");
    expect(allLogsText).not.toContain("evil_secret_obj");
  });

  it("logs RESTORE_EXIT_INVALID_OBJECT_NAME from the undo's database step and keeps undo_incomplete (R101)", async () => {
    const validDb = `${siteDatabasePrefix("site1")}_shop`;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner({
      harnessOpts: {
        stages: {
          rs_files: { waitExitCode: 1 },
          rs_undo_db: {
            waitExitCode: RESTORE_EXIT_INVALID_OBJECT_NAME,
            stderr: `mariadb: noise should_never_be_logged\nTABLE\t${validDb}\n`,
          },
        },
      },
    });
    const j = jobHex(86);
    await ctx.runner.run(restoreReq(j));
    expect(await waitForSettled(ctx.runner, j)).toEqual({
      jobId: j,
      state: "failed",
      failure: "undo_incomplete",
      snapshot: null,
    });
    const records = errSpy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
    expect(records.find((r) => r.event === "restore_invalid_object_name" && r.jobId === j)).toMatchObject({
      event: "restore_invalid_object_name",
      siteId: "site1",
      step: "undo",
      objectKind: "TABLE",
      database: validDb,
    });
    expect(JSON.stringify(records)).not.toContain("should_never_be_logged");
  });
});

describe("BackupRunner restore with createVolume", () => {
  const NEW_VOL = "hp_vol_svc_new_html";
  const newSiteReq = (jobId: string): BackupsIpcRequest => ({
    ...(restoreReq(jobId, "site9", "svc_new") as Extract<BackupsIpcRequest, { action: "restore" }>),
    createVolume: true,
  });
  const readNote = async (restoresDir: string, jobId: string) =>
    JSON.parse(await readFile(path.join(restoresDir, `${jobId}.json`), "utf8")) as Record<string, unknown>;

  it("flags the note first, creates the volume with site labels, gives it to 33:33 and keeps it on success", async () => {
    let noteAtCreate: Record<string, unknown> | null = null;
    const ctx = await setupRestoreRunner({
      harnessOpts: {
        onVolumeCreate: async (name) => {
          if (name === NEW_VOL) noteAtCreate = await readNote(ctx.restoresDir, j);
        },
      },
    });
    const j = jobHex(201);
    await ctx.runner.run(newSiteReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ state: "succeeded", failure: null });
    expect(noteAtCreate).toMatchObject({ stage: "prepare", createdVolume: true });
    const create = ctx.harness.requests.find(
      (r) => r.method === "POST" && r.path === "/volumes/create" && (r.body as { Name: string }).Name === NEW_VOL,
    );
    expect(create?.body).toEqual({
      Name: NEW_VOL,
      Labels: {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.site_id": "site9",
        "io.hostingpanel.service_instance_id": "svc_new",
      },
    });
    const own = ctx.harness.containerPayloads.get(`hp_bk_${j}_rs_own`) as {
      User: string;
      HostConfig: { CapAdd: string[]; Binds: string[]; NetworkMode: string };
    };
    expect(own).toMatchObject({ User: "0:0", HostConfig: { CapAdd: ["CHOWN", "FOWNER"], NetworkMode: "none" } });
    expect(own.HostConfig.Binds).toEqual([`${NEW_VOL}:/v`]);
    expect(ctx.harness.createdSequence.indexOf(`hp_bk_${j}_rs_own`)).toBeLessThan(
      ctx.harness.createdSequence.indexOf(`hp_bk_${j}_rs_fetch`),
    );
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(ctx.harness.deletedVolumes).not.toContain(NEW_VOL);
    expect(await readNote(ctx.restoresDir, j)).not.toHaveProperty("createdVolume");
    ctx.harness.assertCp01AndNoLeaks([], [NEW_VOL]);
  });

  it.each([
    ["the fetch fails", { stages: { rs_fetch: { waitExitCode: 1 } } }, null],
    ["the chown fails", { stages: { rs_own: { waitExitCode: 1 } } }, "restore_prepare_failed"],
    ["the switch is undone", { stages: { rs_files: { waitExitCode: 1 } } }, null],
  ] as const)("removes the volume it created when %s, after its containers are gone", async (_l, harnessOpts, failure) => {
    const ctx = await setupRestoreRunner({ harnessOpts });
    const j = jobHex(202);
    await ctx.runner.run(newSiteReq(j));
    const status = await waitForSettled(ctx.runner, j);
    expect(status.state).toBe("failed");
    if (failure) expect(status.failure).toBe(failure);
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(false);
    const volDelete = ctx.harness.events.indexOf(`volume:delete:${NEW_VOL}`);
    const lastContainerDelete = ctx.harness.events.map((e) => e.startsWith("container:delete:")).lastIndexOf(true);
    expect(volDelete).toBeGreaterThan(lastContainerDelete);
    expect(await readNote(ctx.restoresDir, j)).not.toHaveProperty("createdVolume");
    ctx.harness.assertCp01AndNoLeaks([], [NEW_VOL]);
  });

  it("fails restore_prepare_failed when the volume create throws, and cleans the name up", async () => {
    const ctx = await setupRestoreRunner({
      harnessOpts: {
        onVolumeCreate: (name) => {
          if (name === NEW_VOL) throw new Error("engine reset");
        },
      },
    });
    const j = jobHex(203);
    await ctx.runner.run(newSiteReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "restore_prepare_failed" });
    expect(ctx.harness.createdSequence.some((n) => n.endsWith("_rs_own") || n.endsWith("_rs_fetch"))).toBe(false);
    expect(ctx.harness.deletedVolumes).toContain(NEW_VOL);
  });

  it("keeps the volume after undo_incomplete", async () => {
    const ctx = await setupRestoreRunner({
      harnessOpts: { stages: { rs_files: { waitExitCode: 1 }, rs_undo_db: { waitExitCode: 1 } } },
    });
    const j = jobHex(204);
    await ctx.runner.run(newSiteReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "undo_incomplete" });
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(ctx.harness.deletedVolumes).not.toContain(NEW_VOL);
  });

  // H10 (R207 restore.2): once the files are switched, a failed `switched` note write is undo_incomplete and keeps everything.
  it.each([
    ["a customer's restore", false],
    ["an administrator's restore into a new volume", true],
  ] as const)("a failed switched note write after the files switch is undo_incomplete and removes nothing: %s", async (_l, created) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner();
    const j = jobHex(created ? 218 : 217);
    noteWrites.fail = (note) => note.stage === "switched";
    await ctx.runner.run(created ? newSiteReq(j) : restoreReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ state: "failed", failure: "undo_incomplete" });
    noteWrites.fail = null;
    const siteVolume = created ? NEW_VOL : "hp_vol_svc_site1_html";
    expect(ctx.harness.createdSequence).toContain(`hp_bk_${j}_rs_files`);
    expect(ctx.harness.createdSequence.some((n) => n.includes("_rs_undo_"))).toBe(false);
    expect(ctx.harness.liveVolumes.has(siteVolume)).toBe(true);
    expect(ctx.harness.liveVolumes.has(`hp_bk_${j}`)).toBe(true);
    expect(ctx.harness.deletedVolumes).toEqual([]);
    expect(ctx.harness.events.some((e) => e.startsWith("volume:delete:"))).toBe(false);
  });

  it("uses an existing volume unchanged and never removes it", async () => {
    const ctx = await setupRestoreRunner({
      harnessOpts: {
        siteVolumes: [NEW_VOL],
        stages: { rs_fetch: { waitExitCode: 1 } },
      },
    });
    const j = jobHex(205);
    await ctx.runner.run(newSiteReq(j));
    expect((await waitForSettled(ctx.runner, j)).state).toBe("failed");
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(ctx.harness.createdSequence).not.toContain(`hp_bk_${j}_rs_own`);
    expect(ctx.harness.requests.some((r) => (r.body as { Name?: string } | undefined)?.Name === NEW_VOL)).toBe(false);
    expect(ctx.harness.deletedVolumes).not.toContain(NEW_VOL);
    ctx.harness.assertCp01AndNoLeaks();
  });

  it("still fails restore_prepare_failed on a missing volume without the flag", async () => {
    const ctx = await setupRestoreRunner();
    const j = jobHex(206);
    await ctx.runner.run(restoreReq(j, "site9", "svc_new"));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "restore_prepare_failed" });
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(false);
    expect(ctx.harness.deletedVolumes).not.toContain(NEW_VOL);
  });

  it("logs only the job id when removal fails; settle at start leaves the volume and a later restore uses it (R122)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner({
      harnessOpts: { stages: { rs_fetch: { waitExitCode: 1 } }, failDeleteVolumeNames: new Set([NEW_VOL]) },
    });
    const j = jobHex(207);
    await ctx.runner.run(newSiteReq(j));
    expect((await waitForSettled(ctx.runner, j)).state).toBe("failed");
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(await readNote(ctx.restoresDir, j)).toMatchObject({ stage: "ended", state: "failed" });
    const records = errSpy.mock.calls.map((a) => JSON.parse(String(a[0])) as Record<string, unknown>);
    const rec = records.find((r) => r.event === "restore_created_volume_remove_failed");
    expect(rec).toBeDefined();
    expect(Object.keys(rec!).sort()).toEqual(["component", "event", "jobId", "timestamp"]);

    const again = await setupRestoreRunner({
      tmpDir: ctx.tmpDir,
      keyContent: null,
      dbRootContent: null,
      harnessOpts: { siteVolumes: [NEW_VOL] },
    });
    await again.runner.settleRestores();
    // A later restore may have filled the volume since the note ended: never delete it here.
    expect(again.harness.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/volumes/"))).toBe(false);
    expect(again.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(await again.runner.run({ action: "status", jobId: j })).toMatchObject({ state: "failed" });
    const j2 = jobHex(210);
    await again.runner.run(restoreReq(j2, "site9", "svc_new"));
    expect(await waitForSettled(again.runner, j2)).toMatchObject({ state: "succeeded", failure: null });
    expect(again.harness.liveVolumes.has(NEW_VOL)).toBe(true);
    expect(again.harness.deletedVolumes).not.toContain(NEW_VOL);
    again.harness.assertCp01AndNoLeaks();
  });

  it("deletes the note when its ended write fails, so a later start never removes a refilled volume (R124)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner({ harnessOpts: { stages: { rs_fetch: { waitExitCode: 1 } } } });
    const j = jobHex(211);
    noteWrites.fail = (note) => note.stage === "ended";
    await ctx.runner.run(newSiteReq(j));
    expect((await waitForSettled(ctx.runner, j)).state).toBe("failed");
    noteWrites.fail = null;
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(false);
    expect(ctx.harness.deletedVolumes).toContain(NEW_VOL);
    await expect(readNote(ctx.restoresDir, j)).rejects.toMatchObject({ code: "ENOENT" });

    const second = await setupRestoreRunner({ tmpDir: ctx.tmpDir, keyContent: null, dbRootContent: null });
    const j2 = jobHex(212);
    await second.runner.run(newSiteReq(j2));
    expect(await waitForSettled(second.runner, j2)).toMatchObject({ state: "succeeded", failure: null });
    expect(second.harness.liveVolumes.has(NEW_VOL)).toBe(true);

    const again = await setupRestoreRunner({
      tmpDir: ctx.tmpDir,
      keyContent: null,
      dbRootContent: null,
      harnessOpts: { siteVolumes: [NEW_VOL] },
    });
    await again.runner.settleRestores();
    expect(again.harness.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/volumes/"))).toBe(false);
    expect(again.harness.liveVolumes.has(NEW_VOL)).toBe(true);
  });

  it("settle of an interrupted note deletes the note when its ended write fails, and still removes the volume (R124)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-restore-cv-"));
    cleanupTasks.push(() => rm(tmpDir, { recursive: true, force: true }));
    const restoresDir = path.join(tmpDir, "backup-work", "restores");
    const j = jobHex(213);
    await writeRestoreNote(restoresDir, {
      v: 1, jobId: j, siteId: "site9", serviceInstanceId: "svc_new", stage: "prepare", createdVolume: true,
    });
    const ctx = await setupRestoreRunner({ tmpDir, harnessOpts: { siteVolumes: [NEW_VOL] } });
    noteWrites.fail = (note) => note.stage === "ended";
    await ctx.runner.settleRestores();
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "interrupted" });
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(false);
    await expect(readNote(restoresDir, j)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settle answers undo_incomplete from memory when every ended write fails (R125)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner({
      harnessOpts: { stages: { rs_files: { waitExitCode: 1 }, rs_undo_files: { waitExitCode: 1 } } },
    });
    const j = jobHex(214);
    noteWrites.fail = (note) => note.stage === "ended";
    await ctx.runner.run(restoreReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "undo_incomplete" });
    await expect(readNote(ctx.restoresDir, j)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ctx.runner.run({ action: "settle", jobId: j })).toEqual({
      jobId: j, state: "failed", failure: "undo_incomplete", snapshot: null,
    });
  });

  it("settle answers succeeded from memory when every ended write fails (R125)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner();
    const j = jobHex(215);
    noteWrites.fail = (note) => note.stage === "ended";
    await ctx.runner.run(restoreReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ state: "succeeded" });
    await expect(readNote(ctx.restoresDir, j)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ctx.runner.run({ action: "settle", jobId: j })).toEqual({
      jobId: j, state: "succeeded", failure: null, snapshot: null,
    });
  });

  it("writes the ended note once more after the delete, so the result outlives a restart (R125)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await setupRestoreRunner({
      harnessOpts: { stages: { rs_files: { waitExitCode: 1 }, rs_undo_files: { waitExitCode: 1 } } },
    });
    const j = jobHex(216);
    let endedWrites = 0;
    noteWrites.fail = (note) => note.stage === "ended" && endedWrites++ === 0;
    await ctx.runner.run(restoreReq(j));
    expect(await waitForSettled(ctx.runner, j)).toMatchObject({ failure: "undo_incomplete" });
    noteWrites.fail = null;
    expect(endedWrites).toBe(2);
    expect(await readNote(ctx.restoresDir, j)).toMatchObject({ stage: "ended", state: "failed", failure: "undo_incomplete" });

    const again = await setupRestoreRunner({ tmpDir: ctx.tmpDir, keyContent: null, dbRootContent: null });
    expect(await again.runner.run({ action: "settle", jobId: j })).toEqual({
      jobId: j, state: "failed", failure: "undo_incomplete", snapshot: null,
    });
  });

  it("settle removes the created volume of an interrupted job, and only when the note is flagged", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-restore-cv-"));
    cleanupTasks.push(() => rm(tmpDir, { recursive: true, force: true }));
    const restoresDir = path.join(tmpDir, "backup-work", "restores");
    const jFlag = jobHex(208);
    const jPlain = jobHex(209);
    await writeRestoreNote(restoresDir, {
      v: 1, jobId: jFlag, siteId: "site9", serviceInstanceId: "svc_new", stage: "prepare", createdVolume: true,
    });
    await writeRestoreNote(restoresDir, {
      v: 1, jobId: jPlain, siteId: "site8", serviceInstanceId: "svc_old", stage: "prepare",
    });
    const ctx = await setupRestoreRunner({ tmpDir, harnessOpts: { siteVolumes: [NEW_VOL, "hp_vol_svc_old_html"] } });
    await ctx.runner.settleRestores();
    expect(await waitForSettled(ctx.runner, jFlag)).toMatchObject({ failure: "interrupted" });
    expect(await waitForSettled(ctx.runner, jPlain)).toMatchObject({ failure: "interrupted" });
    expect(ctx.harness.liveVolumes.has(NEW_VOL)).toBe(false);
    expect(ctx.harness.liveVolumes.has("hp_vol_svc_old_html")).toBe(true);
    expect(await readNote(restoresDir, jFlag)).not.toHaveProperty("createdVolume");
    ctx.harness.assertCp01AndNoLeaks([], [NEW_VOL]);
  });
});
