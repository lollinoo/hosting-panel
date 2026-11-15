import { parseArgs } from "node:util";
import { BackupTargetSchema, type BackupTarget } from "@hosting-panel/contracts";
import { isInvokedDirectly } from "@hosting-panel/contracts/invoked-directly";
import { buildAwsSharedCredentials } from "../backup-jobs.js";
import {
  DEFAULT_BACKUP_KEY_FILE,
  DEFAULT_PANEL_DUMP_DIR,
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
};

export interface PanelFetchIo {
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly uid: number;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly createAdapter?: (paths: { readonly backupKeyFile: string; readonly panelDumpDir: string }) => {
    fetchPanelCopy(target: BackupTarget, panelDumpDir: string, signal: AbortSignal): Promise<PanelFetchResult>;
  };
}

/** Reads the target from flags and stdin; null when anything is off. */
function readTarget(argv: readonly string[], stdin: string): BackupTarget | null {
  let values: { endpoint?: string; region?: string; bucket?: string; prefix?: string };
  try {
    values = parseArgs({
      args: [...argv],
      options: {
        endpoint: { type: "string" },
        region: { type: "string" },
        bucket: { type: "string" },
        prefix: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return null;
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
  return parsed.data;
}

/** Fetches the newest panel copy into HP_PANEL_DUMP_DIR; returns the process exit code. */
export async function main(io: PanelFetchIo): Promise<number> {
  const fail = (problem: PanelFetchProblem): number => {
    io.stderr(`panel-fetch: ${problem}`);
    return EXIT_BY_PROBLEM[problem] ?? 1;
  };
  if (io.uid === 0) return fail("refused");
  const target = readTarget(io.argv, io.stdin);
  if (target === null) return fail("refused");
  const panelDumpDir = io.env.HP_PANEL_DUMP_DIR?.trim() || DEFAULT_PANEL_DUMP_DIR;
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
