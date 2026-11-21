import { type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { BackupTargetSchema, type BackupTarget } from "@hosting-panel/contracts";
import { isInvokedDirectly } from "@hosting-panel/contracts/invoked-directly";
import { buildAwsSharedCredentials } from "../backup-jobs.js";
import {
  DEFAULT_BACKUP_KEY_FILE,
  DEFAULT_PANEL_DUMP_DIR,
  type LocalPanelRepoSource,
  type PanelFetchProblem,
  type PanelFetchResult,
} from "../backup-runner.js";
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  DEFAULT_SECRETS_ROOT_DIR,
  DockerEngineSocketAdapter,
} from "../docker-engine-adapter.js";

// Valid input is two keys of at most 256 characters each; anything longer is refused anyway.
const STDIN_MAX_BYTES = 4096;

const EXIT_BY_PROBLEM: Partial<Record<PanelFetchProblem, number>> = {
  refused: 2,
  unreachable: 3,
  tls_failed: 3,
  wrong_region: 3,
  auth_failed: 3,
  bucket_missing: 3,
  no_copy: 4,
  wrong_key: 5,
  key_file_missing: 5,
  no_space: 6,
  local_target_unmounted: 7,
  local_target_unsafe: 8,
};

// The same rules as the runner's own check (it re-validates), with the layout of a restic repository on top.
const LOCAL_REPO_CHARS = /^\/[A-Za-z0-9._@+/-]+$/;
const LOCAL_REPO_DENYLIST = ["/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/root", "/var/lib/docker"] as const;
const LOCAL_REPO_MAX_LENGTH = 255;
const RESTIC_DIRS = ["keys", "data", "snapshots", "index"] as const;

export interface PanelFetchIo {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly uid: number;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly createAdapter?: (paths: { readonly backupKeyFile: string; readonly panelDumpDir: string }) => {
    fetchPanelCopy(target: BackupTarget | LocalPanelRepoSource, panelDumpDir: string, signal: AbortSignal): Promise<PanelFetchResult>;
  };
}

type Source = { readonly s3: BackupTarget } | { readonly localRepo: string };

/** Reads the source from flags (and stdin for S3); null when anything is off. */
function readTarget(argv: readonly string[], stdin: string): Source | null {
  let values: { endpoint?: string; region?: string; bucket?: string; prefix?: string; "local-repo"?: string };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        endpoint: { type: "string" },
        region: { type: "string" },
        bucket: { type: "string" },
        prefix: { type: "string" },
        "local-repo": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return null;
  }
  if (values["local-repo"] !== undefined) {
    // A path, no S3 flag and nothing on stdin: this mode never takes a key.
    const mixed = values.endpoint ?? values.region ?? values.bucket ?? values.prefix;
    const dir = values["local-repo"];
    if (mixed !== undefined || stdin !== "" || dir.length > LOCAL_REPO_MAX_LENGTH || !LOCAL_REPO_CHARS.test(dir)) return null;
    return { localRepo: dir };
  }
  const lines = stdin.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length === 3 && lines[2] === "") lines.pop();
  if (lines.length !== 2) return null;
  const parsed = BackupTargetSchema.safeParse({
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    prefix: values.prefix ?? "",
    accessKeyId: lines[0],
    secretAccessKey: lines[1],
  });
  if (!parsed.success) return null;
  try {
    buildAwsSharedCredentials(parsed.data.accessKeyId, parsed.data.secretAccessKey);
  } catch {
    return null;
  }
  return { s3: parsed.data };
}

/**
 * Checks a `--local-repo` directory without touching it: canonical path outside the system and executor directories, no
 * symlink in it or above it, a directory owned by a non-root user and not writable by others (group bits are the normal
 * 2770 layout), and the layout of a restic repository. A directory the executor cannot read is left to restic.
 */
async function checkLocalRepo(repoDir: string, panelDumpDir: string): Promise<PanelFetchProblem | null> {
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);
  const dump = path.resolve(panelDumpDir);
  if (
    path.posix.normalize(repoDir) !== repoDir ||
    repoDir.endsWith("/") ||
    LOCAL_REPO_DENYLIST.some((d) => within(repoDir, d)) ||
    within(repoDir, dump) ||
    within(dump, repoDir)
  ) {
    return "local_target_unsafe";
  }
  const parts = repoDir.split("/").slice(1);
  let current = "";
  let dirStat: Stats | undefined;
  for (const part of parts) {
    current += `/${part}`;
    try {
      dirStat = await lstat(current);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? "local_target_unmounted" : "local_target_unsafe";
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return "local_target_unsafe";
  }
  const dir = dirStat!;
  if (dir.uid === 0 || (dir.mode & 0o002) !== 0) return "local_target_unsafe";
  try {
    const config = await lstat(`${repoDir}/config`);
    if (config.isSymbolicLink() || !config.isFile() || config.uid !== dir.uid || (config.mode & 0o002) !== 0) {
      return "local_target_unsafe";
    }
    for (const name of RESTIC_DIRS) {
      const sub = await lstat(`${repoDir}/${name}`);
      if (sub.isSymbolicLink() || !sub.isDirectory()) return "local_target_unsafe";
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "no_copy";
    // Another user's 0700 repository: the fetch container runs as that user and restic is the judge.
    if (code !== "EACCES") return "local_target_unsafe";
  }
  return null;
}

/** Fetches the newest panel copy into HP_PANEL_DUMP_DIR; returns the process exit code. */
export async function main(io: PanelFetchIo): Promise<number> {
  const fail = (problem: PanelFetchProblem): number => {
    io.stderr(`panel-fetch: ${problem}`);
    return EXIT_BY_PROBLEM[problem] ?? 1;
  };
  if (io.uid === 0) return fail("refused");
  const source = readTarget(io.argv, io.stdin);
  if (source === null) return fail("refused");
  const panelDumpDir = io.env.HP_PANEL_DUMP_DIR?.trim() || DEFAULT_PANEL_DUMP_DIR;
  if ("localRepo" in source) {
    const problem = await checkLocalRepo(source.localRepo, panelDumpDir);
    if (problem !== null) return fail(problem);
  }
  const target: BackupTarget | LocalPanelRepoSource =
    "localRepo" in source ? { kind: "local_repo", repoDir: source.localRepo } : source.s3;
  const backupKeyFile = io.env.HP_BACKUP_KEY_FILE?.trim() || DEFAULT_BACKUP_KEY_FILE;
  const createAdapter =
    io.createAdapter ??
    ((paths) =>
      new DockerEngineSocketAdapter({
        dockerSocketPath: DEFAULT_DOCKER_SOCKET_PATH,
        secretsRootDir: DEFAULT_SECRETS_ROOT_DIR,
        ...paths,
      }));
  // Ctrl-C or a stop during the fetch: the runner's own clean-up runs, then exit 1 (R122).
  const stopped = new AbortController();
  const stop = (): void => stopped.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let result: PanelFetchResult;
  try {
    result = await createAdapter({ backupKeyFile, panelDumpDir }).fetchPanelCopy(
      target,
      panelDumpDir,
      stopped.signal,
    );
  } catch {
    return fail("other");
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (stopped.signal.aborted) return fail("interrupted");
  if (!result.ok) return fail(result.problem);
  io.stdout(JSON.stringify({ snapshotId: result.snapshotId, time: result.time }));
  return 0;
}

/** Reads stdin up to the cap; the rest is dropped, which the length checks then refuse. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    size += buf.length;
    if (size > STDIN_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).subarray(0, STDIN_MAX_BYTES + 1).toString("utf8");
}

if (isInvokedDirectly(import.meta.url)) {
  void readStdin()
    .then((stdin) =>
      main({
        argv: process.argv.slice(2),
        stdin,
        env: process.env,
        uid: process.getuid?.() ?? 0,
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
      }),
    )
    .catch(() => {
      process.stderr.write("panel-fetch: other\n");
      return 1;
    })
    .then((code) => {
      // main's clean-up is done; a stopped image pull or storage check must not keep Node alive (R124).
      process.exit(code);
    });
}
