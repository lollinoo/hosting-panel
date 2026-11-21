/**
 * QA (BKP-05 / BKP-06, executor side): hostile local-target layouts driven through the real BackupRunner and the real
 * guard on a real temp filesystem, with a fake Docker engine. Every refusal must carry its typed problem and happen
 * before any container, secret, staging volume, network or S3 call; nothing may be written outside the root or into
 * an empty mountpoint. Also: mounts / container hardening of the local branch and the S3 branch pinned byte for byte.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BackupsIpcRequestSchema, type BackupsIpcRequest } from "@hosting-panel/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BACKUP_DISK_FREE_FLOOR_BYTES, BackupRunner, type BackupRunnerDeps, type DockerRequest } from "../src/index.js";

const execFileAsync = promisify(execFile);
const BACKUP_KEY = "deadbeef".repeat(8);
const SNAPSHOT_ID = "a1b2c3d4".repeat(8);
const TARGET_ID = `bkt_${"cd".repeat(16)}`;
const LOCAL_TARGET = { kind: "local", targetId: TARGET_ID } as const;
const MARKER = ".hp-local-target";
const MARKER_CONTENT = `hosting-panel local backup target ${TARGET_ID}\n`;
const OP = (n: number, suffix = ""): string => `op_${n.toString(16).padStart(32, "0")}${suffix}`;
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;
const GIB = 1_073_741_824;
const FLOOR = BACKUP_DISK_FREE_FLOOR_BYTES;
const SITE = "site1";

const cleanups: Array<() => Promise<unknown>> = [];
// The unit runs with UMask=0007; mkdir's 0770 must not be filtered further.
let oldUmask: number | undefined;
beforeAll(() => {
  try {
    oldUmask = process.umask(0o007);
  } catch {
    // worker threads cannot change the umask
  }
});
afterAll(() => {
  if (oldUmask !== undefined) process.umask(oldUmask);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanups.splice(0).reverse()) await task();
});

const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const summaryLine = (): string =>
  JSON.stringify({
    message_type: "summary",
    snapshot_id: SNAPSHOT_ID,
    data_added: 4096,
    total_bytes_processed: 65536,
    files_new: 4,
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
      readonly Privileged?: boolean;
      readonly ReadonlyRootfs?: boolean;
      readonly CapDrop?: readonly string[];
      readonly CapAdd?: readonly string[];
      readonly SecurityOpt?: readonly string[];
      readonly Binds?: readonly string[];
      readonly Mounts?: readonly { Type: string; Source: string; Target: string; ReadOnly: boolean }[];
      readonly GroupAdd?: readonly string[];
    };
  };
  readonly secrets: Record<string, string>;
}

interface StepBehavior {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const S3_TARGET = {
  endpoint: "https://storage.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod/cluster1",
  accessKeyId: "AKIAEXAMPLE000000001",
  secretAccessKey: "secretsecretsecretsecret0000000000000001",
} as const;

async function setup(opts?: {
  steps?: (name: string) => StepBehavior;
  databases?: readonly { name: string; sizeBytes: number }[];
  bytesAvailable?: bigint;
  executorUser?: string;
  open?: BackupRunnerDeps["localTargetOpen"];
}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-adv-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  // The root lives one level down so a symlinked ancestor can be planted too.
  const base = path.join(tmp, "base");
  const root = path.join(base, "repos");
  await mkdir(root, { recursive: true, mode: 0o770 });
  await chmod(base, 0o700);
  await chmod(root, 0o2770); // as bootstrap-dedicated.sh: new directories inherit setgid (RestrictSUIDSGID forbids asking)
  const panelDumpDir = path.join(tmp, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o770 });
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${BACKUP_KEY}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "db-root.key");
  await writeFile(sharedDbRootKeyFile, "db-root-pass", { mode: 0o400 });

  const created: Created[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const behaviors = new Map<string, StepBehavior>();
  const liveVolumes = new Set<string>(["hp_vol_svc_site1_html"]);
  const fetchSpy = vi.fn(async () => new Response("<ListBucketResult/>", { status: 200 }));
  const networkSpy = vi.fn(async () => undefined);

  const json = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const empty = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });
  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath, body });
    const url = new URL(`http://docker${reqPath}`);
    const p = url.pathname;
    if (method === "POST" && p === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      behaviors.set(name, opts?.steps?.(name) ?? {});
      const secrets: Record<string, string> = {};
      const m = /job_bk_[^/"]+/.exec(JSON.stringify(body));
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
      if (op[2] === "start") return empty(204);
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
    ensureImage: async () => undefined,
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
    localRepoRoot: root,
    localTargetStatfs: async () => ({
      bsize: 1n,
      blocks: 100n * BigInt(GIB),
      bavail: opts?.bytesAvailable ?? 50n * BigInt(GIB),
      files: 1000n,
      ffree: 1000n,
    }),
    ...(opts?.open ? { localTargetOpen: opts.open } : {}),
  };
  return {
    runner: new BackupRunner(deps),
    deps,
    tmp,
    base,
    root,
    panelDumpDir,
    secretsRootDir,
    created,
    requests,
    fetchSpy,
    networkSpy,
    withUser: (executorUser: string) => new BackupRunner({ ...deps, executorUser }),
    withDeps: (over: Partial<BackupRunnerDeps>) => new BackupRunner({ ...deps, ...over }),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;

async function settled(runner: BackupRunner, jobId: string) {
  const until = performance.now() + 3_000;
  while (performance.now() < until) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`job ${jobId} did not settle (hang)`);
}

const upStep = (name: string): StepBehavior => (name.endsWith("_up") || name.endsWith("_pup") ? { stdout: summaryLine() } : {});

async function initTarget(env: Env): Promise<void> {
  await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toMatchObject({ outcome: "ok" });
  env.created.length = 0;
  env.requests.length = 0;
  env.networkSpy.mockClear();
}

/** One runner action that binds a local repository; resolves to the typed problem (or null on success). */
interface Action {
  readonly name: string;
  readonly scope: "site" | "panel";
  readonly run: (env: Env, runner: BackupRunner, n: number) => Promise<string | null>;
}
const failureOf = (s: { state: string; failure: string | null }): string | null => (s.state === "succeeded" ? null : (s.failure ?? s.state));

const ACTIONS: readonly Action[] = [
  {
    name: "start",
    scope: "site",
    run: async (_e, runner, n) => {
      await runner.run({ action: "start", jobId: OP(n), siteId: SITE, serviceInstanceId: "svc_site1", target: LOCAL_TARGET });
      return failureOf(await settled(runner, OP(n)));
    },
  },
  {
    name: "forget",
    scope: "site",
    run: async (_e, runner, n) => {
      const jobId = OP(n, "-forget");
      await runner.run({ action: "forget", jobId, siteId: SITE, target: LOCAL_TARGET, snapshotIds: [SNAPSHOT_ID] });
      return failureOf(await settled(runner, jobId));
    },
  },
  {
    name: "restore",
    scope: "site",
    run: async (_e, runner, n) => {
      await runner.run({
        action: "restore",
        jobId: OP(n),
        siteId: SITE,
        serviceInstanceId: "svc_site1",
        snapshotId: SNAPSHOT_ID,
        target: LOCAL_TARGET,
      });
      return failureOf(await settled(runner, OP(n)));
    },
  },
  {
    name: "archive",
    scope: "site",
    run: async (_e, runner, n) => {
      await runner.run({ action: "archive", jobId: OP(n), siteId: SITE, snapshotId: SNAPSHOT_ID, target: LOCAL_TARGET });
      return failureOf(await settled(runner, OP(n)));
    },
  },
  {
    name: "panelStart",
    scope: "panel",
    run: async (env, runner, n) => {
      await writeFile(path.join(env.panelDumpDir, `${OP(n)}.dump`), Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(95)]), { mode: 0o640 });
      await runner.run({ action: "panelStart", jobId: OP(n), target: LOCAL_TARGET, masterKey: "ab".repeat(32), retentionDays: 30 });
      return failureOf(await settled(runner, OP(n)));
    },
  },
  {
    name: "test",
    scope: "panel",
    run: async (_e, runner) => {
      const r = await runner.run({ action: "test", target: LOCAL_TARGET });
      return r.outcome === "ok" ? null : r.problem;
    },
  },
];

/** The executor's own work dirs and the test's dump handover are not "the backup disk". */
const disk = (l: readonly string[]): string[] => l.filter((e) => !e.startsWith("panel-dump/") && !e.startsWith("backup-work/"));

/** Names, types, modes and symlink targets of a tree (no mtimes: a refused guard must not change any of them). */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const name of (await readdir(d).catch(() => [])).sort()) {
      const full = path.join(d, name);
      const st = await lstat(full);
      const r = path.posix.join(rel, name);
      if (st.isSymbolicLink()) out.push(`${r} -> ${await readlink(full)}`);
      else if (st.isDirectory()) {
        out.push(`${r}/ ${(st.mode & 0o7777).toString(8)}`);
        await walk(full, r);
      } else out.push(`${r} ${(st.mode & 0o7777).toString(8)} ${st.size}`);
    }
  };
  await walk(dir, "");
  return out;
}

const siteDir = (env: Env, ...rest: string[]): string => path.join(env.root, TARGET_ID, "sites", SITE, ...rest);
const panelDir = (env: Env): string => path.join(env.root, TARGET_ID, "panel");

/** Asserts the cheap invariants of every refusal: nothing was created, called or leaked. */
async function expectNothingStarted(env: Env): Promise<void> {
  expect(env.created.map((c) => c.name)).toEqual([]);
  expect(env.requests.filter((r) => r.path.startsWith("/networks"))).toEqual([]);
  // A restore stages into a volume of its own before the guard; a refusal must remove it again (no leak). Any
  // other action must not create one at all.
  const made = env.requests.filter((r) => r.method === "POST" && r.path === "/volumes/create").map((r) => (r.body as { Name: string }).Name);
  const dropped = env.requests.filter((r) => r.method === "DELETE" && r.path.startsWith("/volumes/")).map((r) => decodeURIComponent(r.path.slice("/volumes/".length).split("?")[0]!));
  expect(made.filter((n) => !dropped.includes(n)), "leaked staging volume").toEqual([]);
  expect(env.fetchSpy).not.toHaveBeenCalled();
  expect(env.networkSpy).not.toHaveBeenCalled();
  expect(await readdir(env.secretsRootDir)).toEqual([]);
}

interface Scenario {
  readonly name: string;
  readonly problem: "local_target_unsafe" | "local_target_unmounted";
  /** Which scopes the mutation affects (the other scope's repository stays valid). */
  readonly scopes: readonly ("site" | "panel")[];
  readonly mutate: (env: Env) => Promise<void>;
  readonly executorUser?: (uid: number, gid: number) => string;
  /** Directories that must stay exactly as they are (hostile symlink targets). */
  readonly outside?: readonly string[];
}

const BOTH = ["site", "panel"] as const;
const outsideDir = (env: Env): string => path.join(env.tmp, "outside");
async function makeOutside(env: Env): Promise<string> {
  const dir = outsideDir(env);
  await mkdir(dir, { mode: 0o700, recursive: true });
  return dir;
}
const replaceWith = async (p: string, make: () => Promise<void>): Promise<void> => {
  await rm(p, { recursive: true, force: true });
  await make();
};

const SCENARIOS: readonly Scenario[] = [
  // --- root ---
  {
    name: "root replaced by a symlink to the real directory",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      await rename(env.root, `${env.root}.real`);
      await symlink(`${env.root}.real`, env.root);
    },
  },
  {
    name: "root replaced by a symlink to an outside directory",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      const out = await makeOutside(env);
      await rm(env.root, { recursive: true });
      await symlink(out, env.root);
    },
    outside: ["outside"],
  },
  {
    name: "symlinked ancestor of the root",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      await rename(env.base, `${env.base}.real`);
      await symlink(`${env.base}.real`, env.base);
    },
  },
  {
    name: "world-writable root (0777)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => void (await chmod(env.root, 0o777)),
  },
  {
    name: "other-writable root (0702)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => void (await chmod(env.root, 0o702)),
  },
  {
    name: "group-writable root (0720)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => void (await chmod(env.root, 0o720)),
  },
  {
    name: "root owned by someone else (executor uid differs)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async () => undefined,
    executorUser: (uid, gid) => `${uid + 1}:${gid}`,
  },
  // --- <root>/<targetId> ---
  {
    name: "<targetId> replaced by a symlink to a copy that carries a valid marker",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      const out = await makeOutside(env);
      const copy = path.join(out, "copy");
      await rename(path.join(env.root, TARGET_ID), copy);
      await symlink(copy, path.join(env.root, TARGET_ID));
    },
    outside: ["outside"],
  },
  {
    name: "<targetId> replaced by a symlink to an empty outside directory",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      const out = await makeOutside(env);
      await replaceWith(path.join(env.root, TARGET_ID), () => symlink(out, path.join(env.root, TARGET_ID)));
    },
    outside: ["outside"],
  },
  {
    name: "<targetId> replaced by a dangling symlink",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      await replaceWith(path.join(env.root, TARGET_ID), () => symlink(path.join(env.tmp, "does-not-exist"), path.join(env.root, TARGET_ID)));
    },
    outside: [],
  },
  {
    name: "<targetId> is a regular file",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      await replaceWith(path.join(env.root, TARGET_ID), () => writeFile(path.join(env.root, TARGET_ID), MARKER_CONTENT));
    },
  },
  {
    name: "world-writable <targetId> (0777)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => void (await chmod(path.join(env.root, TARGET_ID), 0o777)),
  },
  // --- marker / unmounted disk ---
  {
    name: "marker deleted (unmounted disk: empty mountpoint with stale dirs)",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => rm(path.join(env.root, TARGET_ID, MARKER)),
  },
  {
    name: "mountpoint completely empty",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => {
      for (const n of await readdir(path.join(env.root, TARGET_ID))) await rm(path.join(env.root, TARGET_ID, n), { recursive: true });
    },
  },
  {
    name: "<targetId> missing under an existing root",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => rm(path.join(env.root, TARGET_ID), { recursive: true }),
  },
  {
    name: "root missing (disk not mounted)",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => rm(env.root, { recursive: true }),
  },
  {
    name: "marker of another target",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => writeFile(path.join(env.root, TARGET_ID, MARKER), `hosting-panel local backup target bkt_${"ee".repeat(16)}\n`),
  },
  {
    name: "marker without the trailing newline",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => writeFile(path.join(env.root, TARGET_ID, MARKER), MARKER_CONTENT.trimEnd()),
  },
  {
    name: "marker with extra trailing content",
    problem: "local_target_unmounted",
    scopes: BOTH,
    mutate: async (env) => writeFile(path.join(env.root, TARGET_ID, MARKER), `${MARKER_CONTENT}x`),
  },
  {
    name: "marker is a symlink to a file with the right content",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      const out = await makeOutside(env);
      await writeFile(path.join(out, "m"), MARKER_CONTENT);
      await replaceWith(path.join(env.root, TARGET_ID, MARKER), () => symlink(path.join(out, "m"), path.join(env.root, TARGET_ID, MARKER)));
    },
    outside: ["outside"],
  },
  {
    name: "marker is a FIFO (must not block)",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      const m = path.join(env.root, TARGET_ID, MARKER);
      await rm(m);
      await execFileAsync("mkfifo", [m]);
    },
  },
  {
    name: "marker is a 1 MiB file",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => writeFile(path.join(env.root, TARGET_ID, MARKER), "x".repeat(1_048_576)),
  },
  // --- sites/<siteId> and panel ---
  {
    name: "sites/ replaced by a symlink to an outside directory",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      const out = await makeOutside(env);
      await replaceWith(path.join(env.root, TARGET_ID, "sites"), () => symlink(out, path.join(env.root, TARGET_ID, "sites")));
    },
    outside: ["outside"],
  },
  {
    name: "sites/<siteId> replaced by a symlink to an outside directory",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      const out = await makeOutside(env);
      await replaceWith(siteDir(env), () => symlink(out, siteDir(env)));
    },
    outside: ["outside"],
  },
  {
    name: "sites/<siteId> replaced by a symlink to another site's repository",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      const other = path.join(env.root, TARGET_ID, "sites", "site2");
      await mkdir(other, { mode: 0o2770 });
      await chmod(other, 0o2770);
      await replaceWith(siteDir(env), () => symlink(other, siteDir(env)));
    },
  },
  {
    name: "sites/<siteId> is a regular file",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      await replaceWith(siteDir(env), () => writeFile(siteDir(env), "not a directory"));
    },
  },
  {
    name: "sites is a regular file",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      await replaceWith(path.join(env.root, TARGET_ID, "sites"), () => writeFile(path.join(env.root, TARGET_ID, "sites"), "x"));
    },
  },
  {
    name: "sites/<siteId> is a dangling symlink (its target must not be created)",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      await replaceWith(siteDir(env), () => symlink(path.join(env.tmp, "ghost"), siteDir(env)));
    },
    outside: [],
  },
  {
    name: "sites/<siteId> symlinks to ../../.. (escapes the root)",
    problem: "local_target_unsafe",
    scopes: ["site"],
    mutate: async (env) => {
      await replaceWith(siteDir(env), () => symlink("../../..", siteDir(env)));
    },
  },
  {
    name: "panel/ replaced by a symlink to an outside directory",
    problem: "local_target_unsafe",
    scopes: ["panel"],
    mutate: async (env) => {
      const out = await makeOutside(env);
      await replaceWith(panelDir(env), () => symlink(out, panelDir(env)));
    },
    outside: ["outside"],
  },
  {
    name: "panel/ is a regular file",
    problem: "local_target_unsafe",
    scopes: ["panel"],
    mutate: async (env) => {
      await replaceWith(panelDir(env), () => writeFile(panelDir(env), "x"));
    },
  },
  // --- leaf modes and owners ---
  ...(["site", "panel"] as const).flatMap((scope): Scenario[] =>
    (
      [
        ["0777", 0o777],
        ["0770 without setgid", 0o770],
        ["0700", 0o700],
        ["2775 (other r-x)", 0o2775],
        ["2777", 0o2777],
        ["2750 (no group write)", 0o2750],
      ] as const
    ).map(([label, mode]) => ({
      name: `${scope} leaf with mode ${label}`,
      problem: "local_target_unsafe" as const,
      scopes: [scope],
      mutate: async (env: Env) => {
        const leaf = scope === "site" ? siteDir(env) : panelDir(env);
        await mkdir(leaf, { recursive: true, mode: 0o700 });
        await chmod(leaf, mode);
      },
    })),
  ),
  {
    name: "leaf owned by another group than the executor gid",
    problem: "local_target_unsafe",
    scopes: BOTH,
    mutate: async (env) => {
      await mkdir(siteDir(env), { recursive: true, mode: 0o700 });
      await chmod(siteDir(env), 0o2770);
    },
    executorUser: (uid, gid) => `${uid}:${gid + 1}`,
  },
];

describe("BKP-05: hostile local targets are refused before any container (runner + real guard)", () => {
  for (const scenario of SCENARIOS) {
    for (const action of ACTIONS.filter((a) => scenario.scopes.includes(a.scope))) {
      it(`${scenario.name} -> ${scenario.problem} for ${action.name}`, async () => {
        const env = await setup({ steps: upStep });
        await initTarget(env);
        await scenario.mutate(env);
        const outsideBefore = await tree(env.tmp);
        const runner = scenario.executorUser ? env.withUser(scenario.executorUser(UID, GID)) : env.runner;

        const problem = await action.run(env, runner, 1);

        expect(problem).toBe(scenario.problem);
        await expectNothingStarted(env);
        // Nothing appeared or changed under the temp tree (root, outside targets, mountpoint).
        expect(disk(await tree(env.tmp))).toEqual(disk(outsideBefore));
      });
    }
  }

  it("localInit refuses the same hostile roots and creates nothing outside", async () => {
    for (const hostile of ["root symlink", "world-writable root", "ancestor symlink", "target symlink", "foreign marker"] as const) {
      const env = await setup();
      const out = await makeOutside(env);
      if (hostile === "root symlink") {
        await rm(env.root, { recursive: true });
        await symlink(out, env.root);
      } else if (hostile === "world-writable root") await chmod(env.root, 0o777);
      else if (hostile === "ancestor symlink") {
        await rename(env.base, `${env.base}.real`);
        await symlink(`${env.base}.real`, env.base);
      } else if (hostile === "target symlink") await symlink(out, path.join(env.root, TARGET_ID));
      else {
        await mkdir(path.join(env.root, TARGET_ID), { mode: 0o700 });
        await writeFile(path.join(env.root, TARGET_ID, MARKER), `hosting-panel local backup target bkt_${"ee".repeat(16)}\n`);
      }
      const before = await tree(env.tmp);
      await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET }), hostile).resolves.toEqual({
        outcome: "failed",
        problem: "local_target_unsafe",
      });
      expect(disk(await tree(env.tmp)), hostile).toEqual(disk(before));
      await expectNothingStarted(env);
    }
  });

  it("localInit refuses a non-empty unmarked mountpoint instead of adopting it", async () => {
    const env = await setup();
    await mkdir(path.join(env.root, TARGET_ID), { mode: 0o700 });
    await writeFile(path.join(env.root, TARGET_ID, "someone-elses-data"), "precious");
    await expect(env.runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_unsafe",
    });
    expect(await readdir(path.join(env.root, TARGET_ID))).toEqual(["someone-elses-data"]);
    expect(env.created).toEqual([]);
  });

  it("never writes into the empty mountpoint of an unmounted disk, for any intent (no dirs, no marker, no probe)", async () => {
    const env = await setup({ steps: upStep });
    await mkdir(path.join(env.root, TARGET_ID), { mode: 0o700 });
    for (const [i, action] of ACTIONS.entries()) {
      expect(await action.run(env, env.runner, 10 + i), action.name).toBe("local_target_unmounted");
    }
    expect(await readdir(path.join(env.root, TARGET_ID))).toEqual([]);
    await expectNothingStarted(env);
  });

  it("a target that was never initialised is unmounted and is not created by any backup action", async () => {
    const env = await setup({ steps: upStep });
    for (const [i, action] of ACTIONS.entries()) {
      expect(await action.run(env, env.runner, 20 + i), action.name).toBe("local_target_unmounted");
    }
    expect(await readdir(env.root)).toEqual([]);
    await expectNothingStarted(env);
  });

  it("a disabled root (HP_BACKUP_LOCAL_ROOT invalid) answers local_target_unsafe for every action and touches nothing", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const runner = env.withDeps({ localRepoRoot: null });
    const before = await tree(env.tmp);
    for (const [i, action] of ACTIONS.entries()) {
      expect(await action.run(env, runner, 30 + i), action.name).toBe("local_target_unsafe");
    }
    expect(await runner.run({ action: "localInit", target: LOCAL_TARGET })).toEqual({ outcome: "failed", problem: "local_target_unsafe" });
    expect(disk(await tree(env.tmp))).toEqual(disk(before));
    await expectNothingStarted(env);
  });

  it("an executorUser that is not uid:gid disables local targets instead of guessing ids", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    for (const bad of ["hp-executor", "0", "1000:", ":1000", "-1:5", "1000:1000:7"]) {
      const runner = env.withUser(bad);
      expect(await ACTIONS[0]!.run(env, runner, 40), bad).toBe("local_target_unsafe");
    }
    await expectNothingStarted(env);
  });

  it("a symlink swapped in after a good run is caught on the next run (no stale trust)", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    expect(await ACTIONS[0]!.run(env, env.runner, 50)).toBeNull();
    env.created.length = 0;
    const out = await makeOutside(env);
    await rm(siteDir(env), { recursive: true });
    await symlink(out, siteDir(env));
    expect(await ACTIONS[0]!.run(env, env.runner, 51)).toBe("local_target_unsafe");
    expect(env.created).toEqual([]);
    expect(await readdir(out)).toEqual([]);
  });
});

describe("BKP-05: ids and requests that try to escape the root never reach the filesystem", () => {
  const oddSiteIds = ["..", ".", "a/b", "../etc", "a\0b", "-x", "a b", "a".repeat(65), "à", "", "a/../b", "%2e%2e", ".hidden"];
  it("rejects odd site ids at the request boundary with VALIDATION_ERROR and creates nothing", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const before = await tree(env.tmp);
    for (const siteId of oddSiteIds) {
      const reqs = [
        { action: "start", jobId: OP(60), siteId, serviceInstanceId: "svc_site1", target: LOCAL_TARGET },
        { action: "forget", jobId: OP(61, "-forget"), siteId, target: LOCAL_TARGET, snapshotIds: [SNAPSHOT_ID] },
        { action: "restore", jobId: OP(62), siteId, serviceInstanceId: "svc_site1", snapshotId: SNAPSHOT_ID, target: LOCAL_TARGET },
        { action: "archive", jobId: OP(63), siteId, snapshotId: SNAPSHOT_ID, target: LOCAL_TARGET },
      ] as unknown as BackupsIpcRequest[];
      for (const req of reqs) {
        await expect(env.runner.run(req), `${req.action} ${JSON.stringify(siteId)}`).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect(disk(await tree(env.tmp))).toEqual(disk(before));
    await expectNothingStarted(env);
  });

  const oddTargetIds = [
    "../x",
    "..",
    "/etc",
    `${TARGET_ID}/..`,
    `${TARGET_ID}/../${TARGET_ID}`,
    `${TARGET_ID}\0`,
    `${TARGET_ID}\n`,
    `BKT_${"cd".repeat(16)}`,
    `bkt_${"CD".repeat(16)}`,
    `bkt_${"cd".repeat(15)}`,
    `bkt_${"cd".repeat(17)}`,
    `bkt_${"zz".repeat(16)}`,
    "bkt_",
    "",
    ` ${TARGET_ID}`,
  ];
  it("rejects odd target ids for every action, local or init, and creates nothing", async () => {
    const env = await setup({ steps: upStep });
    const before = await tree(env.tmp);
    for (const targetId of oddTargetIds) {
      const target = { kind: "local", targetId };
      const reqs = [
        { action: "localInit", target },
        { action: "test", target },
        { action: "start", jobId: OP(70), siteId: SITE, serviceInstanceId: "svc_site1", target },
        { action: "forget", jobId: OP(71, "-forget"), siteId: SITE, target, snapshotIds: [SNAPSHOT_ID] },
        { action: "restore", jobId: OP(72), siteId: SITE, serviceInstanceId: "svc_site1", snapshotId: SNAPSHOT_ID, target },
        { action: "archive", jobId: OP(73), siteId: SITE, snapshotId: SNAPSHOT_ID, target },
        { action: "panelStart", jobId: OP(74), target, masterKey: "ab".repeat(32), retentionDays: 30 },
      ] as unknown as BackupsIpcRequest[];
      for (const req of reqs) {
        await expect(env.runner.run(req), `${req.action} ${JSON.stringify(targetId)}`).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    expect(disk(await tree(env.tmp))).toEqual(disk(before));
    await expectNothingStarted(env);
  });

  it("a local target carrying a path, root or extra key is refused by the schema (the executor resolves paths itself)", () => {
    const base = { action: "test" } as const;
    for (const target of [
      { kind: "local", targetId: TARGET_ID, path: "/etc" },
      { kind: "local", targetId: TARGET_ID, root: "/" },
      { kind: "local", path: "/etc" },
      { kind: "local", targetId: TARGET_ID, endpoint: "https://x" },
      { kind: "Local", targetId: TARGET_ID },
    ]) {
      expect(BackupsIpcRequestSchema.safeParse({ ...base, target }).success, JSON.stringify(target)).toBe(false);
    }
    expect(BackupsIpcRequestSchema.safeParse({ action: "localInit", target: S3_TARGET }).success).toBe(false);
  });

  it("is not fooled by a site id that only looks like a sibling: two sites never share a repository", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    expect(await ACTIONS[0]!.run(env, env.runner, 80)).toBeNull();
    await env.runner.run({ action: "start", jobId: OP(81), siteId: "site1-b", serviceInstanceId: "svc_site1", target: LOCAL_TARGET });
    expect(failureOf(await settled(env.runner, OP(81)))).toBeNull();
    const repos = env.created.filter((c) => c.name.endsWith("_up")).map((c) => c.payload.HostConfig.Mounts!.map((m) => m.Source));
    expect(repos).toEqual([[siteDir(env)], [path.join(env.root, TARGET_ID, "sites", "site1-b")]]);
  });
});

describe("BKP-05: read-only filesystem and probe failures answer before any restic call, without hanging", () => {
  const errnoError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  const probeOnly = (e: NodeJS.ErrnoException): BackupRunnerDeps["localTargetOpen"] => async (p, flags, mode) => {
    if (p.includes(".hp-probe-")) throw e;
    // Unreachable: only the probe uses the seam.
    throw new Error(`unexpected open of ${p} ${flags} ${mode}`);
  };

  const cases: ReadonlyArray<readonly [string, string]> = [
    ["EROFS", "local_target_readonly"],
    ["ENOSPC", "no_space"],
    ["EDQUOT", "no_space"],
    ["EACCES", "local_target_unsafe"],
    ["EPERM", "local_target_unsafe"],
    ["EIO", "local_target_unmounted"],
    ["ENXIO", "local_target_unmounted"],
    ["ESTALE", "local_target_unmounted"],
    ["EEXIST", "local_target_unsafe"],
  ];
  for (const [code, problem] of cases) {
    it(`probe ${code} -> ${problem} for every action, before any container`, async () => {
      const env = await setup({ steps: upStep });
      await initTarget(env);
      const runner = env.withDeps({ localTargetOpen: probeOnly(errnoError(code)) });
      for (const [i, action] of ACTIONS.entries()) {
        const started = performance.now();
        expect(await action.run(env, runner, 100 + i), `${action.name} ${code}`).toBe(problem);
        expect(performance.now() - started, "no hang").toBeLessThan(2_000);
      }
      await expectNothingStarted(env);
    });
  }

  it("localInit on a read-only disk creates the marker dirs it can, then reports local_target_readonly and never starts restic", async () => {
    const env = await setup();
    const runner = env.withDeps({ localTargetOpen: probeOnly(errnoError("EROFS")) });
    await expect(runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toEqual({
      outcome: "failed",
      problem: "local_target_readonly",
    });
    expect(env.created).toEqual([]);
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("a write or fsync that fails after the probe opened maps to its class, closes the handle and removes the probe", async () => {
    for (const [code, problem, failing] of [
      ["EROFS", "local_target_readonly", "write"],
      ["ENOSPC", "no_space", "write"],
      ["EROFS", "local_target_readonly", "sync"],
      ["EIO", "local_target_unmounted", "sync"],
    ] as const) {
      const env = await setup({ steps: upStep });
      await initTarget(env);
      const { open } = await import("node:fs/promises");
      let closed = 0;
      const runner = env.withDeps({
        localTargetOpen: async (p, flags, mode) => {
          const fh = await open(p, flags, mode);
          return new Proxy(fh, {
            get(target, prop) {
              if (prop === failing) return async () => Promise.reject(errnoError(code));
              if (prop === "close") return async () => (closed++, target.close());
              const v = Reflect.get(target, prop, target) as unknown;
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
            },
          });
        },
      });
      expect(await ACTIONS[0]!.run(env, runner, 120), `${code}/${failing}`).toBe(problem);
      expect(closed).toBe(1);
      expect(await readdir(siteDir(env)), "probe file removed").toEqual([]);
      await expectNothingStarted(env);
    }
  });

  it("a probe that never settles is not outlived by a fast failure elsewhere (guard has no timer: documented via the seam)", async () => {
    // The guard has no timeout of its own; this pins that a probe rejection (not a hang) is what a dead mount yields.
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const runner = env.withDeps({ localTargetOpen: probeOnly(errnoError("EIO")) });
    const result = await Promise.race([
      ACTIONS[0]!.run(env, runner, 130),
      new Promise<string>((resolve) => setTimeout(() => resolve("HUNG"), 2_500)),
    ]);
    expect(result).toBe("local_target_unmounted");
  });

  it("restic itself reporting a read-only filesystem on the repo step becomes local_target_readonly (second line of defence)", async () => {
    for (const stderr of ["Fatal: unable to create lock in backend: open /backup/repository/sites/site1/locks/x: read-only file system", "Fatal: Read-only file system"]) {
      const env = await setup({ steps: (name) => (name.endsWith("_repo") ? { exitCode: 1, stderr } : {}) });
      await initTarget(env);
      expect(await ACTIONS[0]!.run(env, env.runner, 140)).toBe("local_target_readonly");
    }
  });
});

describe("BKP-06: insufficient space is refused before any container (floor + estimate, bigint, all actions)", () => {
  it("every action fails no_space just below the 1 GiB floor and nothing is created", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    // Reuse the initialised layout on the low-space runner: same root, only the statfs answer differs.
    const low = roomy.withDeps({
      localTargetStatfs: async () => ({ bsize: 1n, blocks: 100n * BigInt(GIB), bavail: BigInt(FLOOR - 1), files: 1000n, ffree: 1000n }),
    });
    // Only intents that grow the repository carry the floor; forget/restore/archive are covered below.
    for (const [i, action] of ACTIONS.entries()) {
      if (["forget", "restore", "archive"].includes(action.name)) continue;
      expect(await action.run(roomy, low, 200 + i), action.name).toBe("no_space");
    }
    await expectNothingStarted(roomy);
  });

  it("a nearly full disk (400 MiB free) still lets forget, restore and archive run: retention can reclaim space", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const nearlyFull = roomy.withDeps({
      localTargetStatfs: async () => ({ bsize: 1n, blocks: 100n * BigInt(GIB), bavail: 400n * 1024n * 1024n, files: 1000n, ffree: 1000n }),
    });
    for (const [i, action] of ACTIONS.entries()) {
      const result = await action.run(roomy, nearlyFull, 280 + i);
      // restore may still fail for its own reasons (no staged volume in this harness): it only must pass the space guard.
      if (["forget", "restore", "archive"].includes(action.name)) expect(result, action.name).not.toBe("no_space");
      else expect(result, action.name).toBe("no_space");
    }
  });

  it("the floor itself passes: exactly 1 GiB available is enough for floor-only intents (forget, test)", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const exact = roomy.withDeps({
      localTargetStatfs: async () => ({ bsize: 1n, blocks: 100n * BigInt(GIB), bavail: BigInt(FLOOR), files: 1000n, ffree: 1000n }),
    });
    expect(await ACTIONS.find((a) => a.name === "forget")!.run(roomy, exact, 210)).toBeNull();
    expect(await ACTIONS.find((a) => a.name === "test")!.run(roomy, exact, 211)).toBeNull();
  });

  it("uses bavail (not bfree), bsize-scaled bytes, and survives values above 2^53 without wrapping", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const statfs = (bavail: bigint, bsize: bigint) => async () => ({ bsize, blocks: 2n ** 60n, bavail, files: 1000n, ffree: 1000n });
    // 2^20 blocks of 4096 = 4 GiB: ok. 255 blocks of 4096 = 1020 KiB: no_space even though the block count looks big.
    expect(await ACTIONS[0]!.run(roomy, roomy.withDeps({ localTargetStatfs: statfs(2n ** 20n, 4096n) }), 220)).toBeNull();
    expect(await ACTIONS[0]!.run(roomy, roomy.withDeps({ localTargetStatfs: statfs(255n, 4096n) }), 221)).toBe("no_space");
    // bavail*bsize = 2^70 would overflow a double mantissa and an int32: must still pass, not NaN/negative.
    expect(await ACTIONS[0]!.run(roomy, roomy.withDeps({ localTargetStatfs: statfs(2n ** 40n, 2n ** 30n) }), 222)).toBeNull();
  });

  it("a filesystem with no free inodes is no_space even with free bytes", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const runner = roomy.withDeps({
      localTargetStatfs: async () => ({ bsize: 1n, blocks: 100n * BigInt(GIB), bavail: 50n * BigInt(GIB), files: 1000n, ffree: 0n }),
    });
    expect(await ACTIONS[0]!.run(roomy, runner, 230)).toBe("no_space");
    await expectNothingStarted(roomy);
  });

  it("a statfs failure (dead mount) is local_target_unmounted, never a crash or a hang", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const runner = roomy.withDeps({
      localTargetStatfs: async () => {
        throw Object.assign(new Error("ENODEV"), { code: "ENODEV" });
      },
    });
    for (const [i, action] of ACTIONS.entries()) expect(await action.run(roomy, runner, 240 + i), action.name).toBe("local_target_unmounted");
    await expectNothingStarted(roomy);
  });

  it("start: floor + the SUM of the site's database sizes is required, to the byte, and a refusal leaves no staging volume", async () => {
    const databases = [
      { name: "wp_0123456789ab", sizeBytes: 3 * GIB },
      { name: "wp_0123456789cd", sizeBytes: 5 * GIB + 7 },
    ];
    const need = BigInt(FLOOR + 8 * GIB + 7);
    const short = await setup({ steps: upStep, databases, bytesAvailable: need - 1n });
    await initTarget(short);
    expect(await ACTIONS[0]!.run(short, short.runner, 250)).toBe("no_space");
    await expectNothingStarted(short);
    expect(short.requests.some((r) => r.method === "POST" && r.path === "/volumes/create")).toBe(false);

    const ok = await setup({ steps: upStep, databases, bytesAvailable: need });
    await initTarget(ok);
    expect(await ACTIONS[0]!.run(ok, ok.runner, 251)).toBeNull();
  });

  it("start without any database needs only the floor", async () => {
    const env = await setup({ steps: upStep, databases: [], bytesAvailable: BigInt(FLOOR) });
    await initTarget(env);
    expect(await ACTIONS[0]!.run(env, env.runner, 255)).toBeNull();
  });

  it("panelStart: floor + the dump size is required (a bigger dump flips an otherwise fine disk to no_space)", async () => {
    const dump = 4096;
    const short = await setup({ steps: upStep, bytesAvailable: BigInt(FLOOR + dump - 1) });
    await initTarget(short);
    await writeFile(path.join(short.panelDumpDir, `${OP(260)}.dump`), Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(dump - 5)]), { mode: 0o640 });
    await short.runner.run({ action: "panelStart", jobId: OP(260), target: LOCAL_TARGET, masterKey: "ab".repeat(32), retentionDays: 30 });
    expect(failureOf(await settled(short.runner, OP(260)))).toBe("no_space");
    await expectNothingStarted(short);
  });

  it("a failed space check leaves the panel dump handover and the site volume untouched (site stays healthy)", async () => {
    const roomy = await setup({ steps: upStep });
    await initTarget(roomy);
    const low = roomy.withDeps({
      localTargetStatfs: async () => ({ bsize: 1n, blocks: 100n * BigInt(GIB), bavail: 1n, files: 1000n, ffree: 1000n }),
    });
    expect(await ACTIONS[0]!.run(roomy, low, 270)).toBe("no_space");
    // No volume was deleted either (a cleanup that removed the live site volume would be a data-loss bug).
    expect(roomy.requests.filter((r) => r.method === "DELETE")).toEqual([]);
    // A subsequent run with room succeeds: the failed job left no lock/state behind (no deadlock).
    expect(await ACTIONS[0]!.run(roomy, roomy.runner, 271)).toBeNull();
  });
});

describe("BKP-05: mounts, uid/gid and container hardening of the local branch", () => {
  const SECURITY_KEYS = ["docker.sock", "/var/run", "/run/docker"];

  function expectHardened(c: Created, label: string): void {
    const h = c.payload.HostConfig;
    expect(h.Privileged, label).toBe(false);
    expect(h.ReadonlyRootfs, label).toBe(true);
    expect(h.CapDrop, label).toEqual(["ALL"]);
    expect(h.CapAdd, label).toBeUndefined();
    expect(h.SecurityOpt, label).toContain("no-new-privileges:true");
    expect(h.NetworkMode, label).not.toBe("host");
    const json = JSON.stringify(c.payload);
    for (const k of SECURITY_KEYS) expect(json, `${label} ${k}`).not.toContain(k);
    expect(json, label).not.toMatch(/"(Pid|Ipc|Uts|Userns)Mode":"host"/);
    expect(json, label).not.toContain('"Devices"');
    expect(c.payload.User, label).toMatch(/^[1-9]\d*(:[0-9]+)?$/); // never root
  }

  async function runAllLocal(): Promise<{ env: Env; byAction: Map<string, Created[]> }> {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const byAction = new Map<string, Created[]>();
    for (const [i, action] of ACTIONS.entries()) {
      env.created.length = 0;
      // restore/archive read an existing leaf: the start before it created it.
      await action.run(env, env.runner, 300 + i);
      byAction.set(action.name, [...env.created]);
    }
    return { env, byAction };
  }

  it("every restic container: hardened, networkless, no docker.sock, non-root, only the executor group added", async () => {
    const { env, byAction } = await runAllLocal();
    let seen = 0;
    for (const [action, containers] of byAction) {
      for (const c of containers) {
        if (!c.payload.HostConfig.Mounts?.some((m) => m.Target.startsWith("/backup/repository"))) continue;
        seen++;
        const label = `${action}/${c.name}`;
        expectHardened(c, label);
        expect(c.payload.HostConfig.NetworkMode, label).toBe("none");
        const [uid] = (c.payload.User ?? "").split(":");
        expect(Number(uid), label).toBeGreaterThan(0);
        // Design E1: site steps keep the site owner (33:33) and ALWAYS carry the executor gid as the one extra
        // group; archive _zip, the panel steps and the local test run as the executor itself.
        const siteStep = ["start", "forget", "restore"].includes(action);
        expect(c.payload.User, label).toBe(siteStep ? "33:33" : `${UID}:${GID}`);
        expect(c.payload.HostConfig.GroupAdd, label).toEqual([String(GID)]);
        expect(Object.keys(c.secrets), label).toEqual(["RESTIC_PASSWORD"]);
        expect(JSON.stringify(c.payload), label).not.toMatch(/AWS_|HP_REGION|s3\./);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10);
    expect(env.fetchSpy).not.toHaveBeenCalled();
  });

  it("mounts only the needed leaf rw: nothing else under the root, no parent, no sibling, no root, no targetId dir", async () => {
    const { env, byAction } = await runAllLocal();
    const forbidden = new Set([env.root, path.join(env.root, TARGET_ID), path.join(env.root, TARGET_ID, "sites"), path.dirname(env.root), env.base]);
    for (const [action, containers] of byAction) {
      for (const c of containers) {
        const label = `${action}/${c.name}`;
        const mounts = c.payload.HostConfig.Mounts ?? [];
        const binds = c.payload.HostConfig.Binds ?? [];
        const sources = [...mounts.map((m) => m.Source), ...binds.map((b) => b.split(":")[0]!)];
        for (const s of sources) {
          expect(forbidden.has(s), `${label} mounts ${s}`).toBe(false);
          if (s.startsWith(env.root)) {
            expect([siteDir(env), panelDir(env)], `${label} ${s}`).toContain(s);
          }
        }
        // The repository never goes through Binds (Docker would create a missing source as root).
        expect(binds.some((b) => b.startsWith(env.root)), label).toBe(false);
        const repoMounts = mounts.filter((m) => m.Source.startsWith(env.root));
        expect(repoMounts.length, label).toBeLessThanOrEqual(1);
        for (const m of repoMounts) {
          expect(m.Type, label).toBe("bind");
          expect(m.Target, label).toMatch(/^\/backup\/repository\/(sites\/site1|panel)$/);
          expect(m.ReadOnly, label).toBe(false);
          // site actions get the site repo, panel actions the panel repo: never the other one
          expect(m.Source, label).toBe(action === "panelStart" || action === "test" ? panelDir(env) : siteDir(env));
        }
      }
    }
  });

  it("start: every bind of the restic containers except the repository is read-only (site files, staging, secrets)", async () => {
    const { byAction } = await runAllLocal();
    const containers = byAction.get("start")!;
    expect(containers.map((c) => c.name)).toEqual([`hp_bk_${OP(300)}_repo`, `hp_bk_${OP(300)}_dump`, `hp_bk_${OP(300)}_up`]);
    for (const c of containers.filter((x) => !x.name.endsWith("_dump"))) {
      const binds = c.payload.HostConfig.Binds ?? [];
      expect(binds.length, c.name).toBeGreaterThan(0);
      for (const b of binds) expect(b.endsWith(":ro"), `${c.name} ${b}`).toBe(true);
    }
    const up = containers.find((c) => c.name.endsWith("_up"))!;
    expect(up.payload.HostConfig.Binds).toEqual(
      expect.arrayContaining([expect.stringMatching(/hp_vol_svc_site1_html:\/backup\/files:ro$/), expect.stringMatching(/:\/backup\/databases:ro$/)]),
    );
    // The dump container runs without the repository at all and without the backup disk.
    const dump = containers.find((c) => c.name.endsWith("_dump"))!;
    expect(JSON.stringify(dump.payload)).not.toContain("/backup/repository");
    expect(dump.payload.HostConfig.Mounts).toBeUndefined();
  });

  it("forget and panel containers bind nothing but the leaf (rw) and read-only secrets", async () => {
    const { byAction } = await runAllLocal();
    for (const name of ["forget", "panelStart", "test"]) {
      for (const c of byAction.get(name)!) {
        if (c.name.endsWith("_pkeep") || c.name.endsWith("_pup")) continue; // panel upload mounts the dump dir by design
        for (const b of c.payload.HostConfig.Binds ?? []) expect(b.endsWith(":ro"), `${name}/${c.name} ${b}`).toBe(true);
      }
    }
  });

  it("restic containers never receive the other target or other site repositories when several exist", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    const otherId = `bkt_${"12".repeat(16)}`;
    await expect(env.runner.run({ action: "localInit", target: { kind: "local", targetId: otherId } })).resolves.toMatchObject({ outcome: "ok" });
    env.created.length = 0;
    expect(await ACTIONS[0]!.run(env, env.runner, 330)).toBeNull();
    for (const c of env.created) {
      expect(JSON.stringify(c.payload), c.name).not.toContain(otherId);
      expect(JSON.stringify(c.payload), c.name).not.toContain(`${TARGET_ID}/panel`);
    }
  });

  it("the restic repository mount source is the canonical guarded path, never a symlink or a relative path", async () => {
    const { env, byAction } = await runAllLocal();
    for (const containers of byAction.values()) {
      for (const c of containers) {
        for (const m of c.payload.HostConfig.Mounts ?? []) {
          if (!m.Target.startsWith("/backup/repository")) continue;
          expect(path.isAbsolute(m.Source)).toBe(true);
          expect(path.normalize(m.Source)).toBe(m.Source);
          expect((await lstat(m.Source)).isSymbolicLink()).toBe(false);
          expect(m.Source.startsWith(`${env.root}/`)).toBe(true);
          const st = await stat(m.Source);
          expect(st.mode & 0o7777).toBe(0o2770);
          expect(st.gid).toBe(GID);
        }
      }
    }
  });

  it("the leaf and its parents end up with the modes of the design after a real backup", async () => {
    const env = await setup({ steps: upStep });
    await initTarget(env);
    expect(await ACTIONS[0]!.run(env, env.runner, 340)).toBeNull();
    const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o7777;
    expect(await mode(env.root)).toBe(0o2770);
    expect(await mode(path.join(env.root, TARGET_ID))).toBe(0o2770);
    expect(await mode(path.join(env.root, TARGET_ID, "sites"))).toBe(0o2770);
    expect(await mode(siteDir(env))).toBe(0o2770);
    expect(await mode(panelDir(env))).toBe(0o2770);
    expect(await mode(path.join(env.root, TARGET_ID, MARKER))).toBe(0o600);
    expect(await readFile(path.join(env.root, TARGET_ID, MARKER), "utf8")).toBe(MARKER_CONTENT);
    expect(await readdir(siteDir(env))).toEqual([]); // probe removed
  });

  it("fetchPanelCopy from a local repo: :ro mount, networkless, non-root, hardened, no docker.sock", async () => {
    const env = await setup({ steps: () => ({ stdout: `HP_SNAP ${SNAPSHOT_ID} 2026-11-20T10:00:00Z\n` }) });
    const repoDir = path.join(env.tmp, "disk", "panel");
    await mkdir(repoDir, { recursive: true, mode: 0o2770 });
    await chmod(repoDir, 0o2770);
    const out = path.join(env.tmp, "handover");
    await mkdir(out, { mode: 0o770 });
    await writeFile(path.join(out, "restore.pgdump"), "PGDMP");
    await writeFile(path.join(out, "restore.key"), "ab".repeat(32));
    const result = await env.runner.fetchPanelCopy({ kind: "local_repo", repoDir }, out);
    expect(result.ok).toBe(true);
    const c = env.created[0]!;
    expectHardened(c, "fetchPanelCopy");
    expect(c.payload.HostConfig.NetworkMode).toBe("none");
    expect(c.payload.HostConfig.Mounts!.filter((m) => m.Source === repoDir)).toEqual([
      { Type: "bind", Source: repoDir, Target: "/backup/repository/panel", ReadOnly: true },
    ]);
    expect(c.payload.User).toBe(`${UID}:${GID}`);
  });
});

describe("BKP-05: the S3 branch payloads stay byte-identical to the frozen pins", () => {
  const normalise = (env: Env, text: string): string =>
    text
      .replaceAll(env.tmp, "<TMP>")
      .replace(/test_[0-9a-f]{16}/g, "test_<id>");

  interface Step {
    readonly key: string;
    readonly run: (env: Env) => Promise<unknown>;
  }
  const S3_STEPS: readonly Step[] = [
    { key: "test", run: (env) => env.runner.run({ action: "test", target: S3_TARGET }) },
    {
      key: "start",
      run: async (env) => {
        await env.runner.run({ action: "start", jobId: OP(1), siteId: SITE, serviceInstanceId: "svc_site1", target: S3_TARGET });
        return settled(env.runner, OP(1));
      },
    },
    {
      key: "forget",
      run: async (env) => {
        await env.runner.run({ action: "forget", jobId: OP(2, "-forget"), siteId: SITE, target: S3_TARGET, snapshotIds: [SNAPSHOT_ID] });
        return settled(env.runner, OP(2, "-forget"));
      },
    },
    {
      key: "archive",
      run: async (env) => {
        await env.runner.run({ action: "archive", jobId: OP(3), siteId: SITE, snapshotId: SNAPSHOT_ID, target: S3_TARGET });
        return settled(env.runner, OP(3));
      },
    },
    {
      key: "restore",
      run: async (env) => {
        await env.runner.run({ action: "restore", jobId: OP(4), siteId: SITE, serviceInstanceId: "svc_site1", snapshotId: SNAPSHOT_ID, target: S3_TARGET });
        return settled(env.runner, OP(4));
      },
    },
    {
      key: "panelStart",
      run: async (env) => {
        await writeFile(path.join(env.panelDumpDir, `${OP(5)}.dump`), Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(95)]), { mode: 0o640 });
        await env.runner.run({ action: "panelStart", jobId: OP(5), target: S3_TARGET, masterKey: "ab".repeat(32), retentionDays: 30 });
        return settled(env.runner, OP(5));
      },
    },
  ];

  async function capture(key: string, local: boolean): Promise<{ hash: string; json: string; env: Env }> {
    const step = S3_STEPS.find((s) => s.key === key)!;
    const env = await setup({ steps: upStep });
    // The runner must behave the same with or without a configured local root.
    const runner = local ? env.runner : env.withDeps({ localRepoRoot: null });
    const patched = { ...env, runner } as Env;
    await step.run(patched);
    const json = normalise(
      env,
      JSON.stringify({
        created: env.created.map((c) => ({ name: c.name, payload: c.payload, secrets: c.secrets })),
        docker: env.requests.map((r) => `${r.method} ${r.path}`),
        fetchCalls: env.fetchSpy.mock.calls.length,
        networkCalls: env.networkSpy.mock.calls.length,
      }),
    );
    return { hash: createHash("sha256").update(json).digest("hex"), json, env };
  }

  // sha256 of the conversation produced by the pre-M3 runner (ad100f3) for the same inputs; regenerate only with a
  // deliberate pin change. A mismatch means an S3 request/secret/Docker call changed shape.
  const PINNED: Record<string, string> = {
    test: "f518d8b70818e5d367eb752e5ac5c61d495ea8057c8356aa5c8b1c08bca8315a",
    start: "acd828cc2ccb46ddc3010bb2e0ff8427c4bd22ffac8bb4ff60f0e0b3a459dd97",
    forget: "6a41ca05dc8b10c53997e0a07822f027c57cec499efe9cc60d0c724a5e30b691",
    archive: "98cf207e563e06c3c7f5032558f77405ed6255bd8914983187a68c7897802a78",
    restore: "66bda6bd814a2b8af29110109f2a69f4d52eec9c40abf674bdcf3d1146a15368",
    panelStart: "3dbd2228baff8ff090446f7d8cb5da8e21a505587114db4d469950d3669edbab",
  };

  for (const step of S3_STEPS) {
    it(`S3 ${step.key}: Docker conversation, payloads and secrets equal the ad100f3 pin`, async () => {
      const withRoot = await capture(step.key, true);
      const noRoot = await capture(step.key, false);
      // Independent of whether a local root is configured.
      expect(withRoot.json).toBe(noRoot.json);
      // No local-only key ever leaks into an S3 payload.
      expect(withRoot.json).not.toMatch(/\/backup\/repository|bkt_/);
      // The panel upload already carries the dump group at ad100f3; no other S3 step has a GroupAdd.
      if (step.key !== "panelStart") expect(withRoot.json).not.toContain('"GroupAdd"');
      expect(withRoot.json).toContain("AWS_SHARED_CREDENTIALS");
      expect(withRoot.hash).toBe(PINNED[step.key]);
    });
  }
});
