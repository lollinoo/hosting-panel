import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { BackupProblem } from "@hosting-panel/contracts";

export const PG_DUMP_PATH = "/usr/lib/postgresql/18/bin/pg_dump";
export const PANEL_DUMP_TIMEOUT_MS = 30 * 60_000;
export const PANEL_DUMP_MAX_OUTPUT_BYTES = 64 * 1024;
const SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const SOCKET_HOST = "hp-socket.invalid";

export type PanelDumpFailure = "tool_missing" | "exit" | "timeout" | "output_cap";

export interface PanelDumpCommand {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** A pg_dump failure that carries only a reason code, never the tool's own output. */
export class PanelDumpError extends Error {
  public readonly problem: BackupProblem;
  public constructor(
    public readonly reason: PanelDumpFailure,
    public readonly exitCode: number | null = null,
  ) {
    super(`panel dump failed (${reason})`);
    this.problem = reason === "tool_missing" ? "panel_dump_tool_missing" : "panel_dump_failed";
  }
}

/** Builds pg_dump's argument list and its whole environment from DATABASE_URL. */
export function buildPanelDumpCommand(databaseUrl: string, outFile: string): PanelDumpCommand {
  let url: URL;
  try {
    // WHATWG URL refuses the socket form `user:pw@/db`, so give it a placeholder host.
    url = new URL(databaseUrl.replace(/@\//, `@${SOCKET_HOST}/`));
  } catch {
    throw new PanelDumpError("exit");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new PanelDumpError("exit");
  }
  const q = url.searchParams;
  const host = decodeURIComponent(url.hostname);
  const env: Record<string, string> = {
    LC_ALL: "C",
    PGCONNECT_TIMEOUT: "10",
    PGAPPNAME: "hp-panel-backup",
  };
  const pgHost = q.get("host") ?? (host === SOCKET_HOST ? "" : host);
  if (pgHost) env.PGHOST = pgHost;
  const port = q.get("port") ?? url.port;
  if (port) env.PGPORT = port;
  const user = q.get("user") ?? decodeURIComponent(url.username);
  if (user) env.PGUSER = user;
  const pw = q.get("password") ?? decodeURIComponent(url.password);
  if (pw) env.PGPASSWORD = pw;
  const db = q.get("dbname") ?? decodeURIComponent(url.pathname.slice(1));
  if (db) env.PGDATABASE = db;
  const ssl = q.get("sslmode");
  if (ssl) {
    if (!SSL_MODES.has(ssl)) throw new PanelDumpError("exit");
    env.PGSSLMODE = ssl;
  }
  return {
    args: ["--format=custom", "--compress=none", "--no-password", "--file", outFile],
    env,
  };
}

type ExecFileRunner = (file: string, args: readonly string[], options: object) => Promise<unknown>;

/** Runs PG_DUMP_PATH (never a caller's path) without a shell; on failure removes the output file and throws a PanelDumpError. */
export async function runPanelDump(
  cmd: PanelDumpCommand,
  run: ExecFileRunner = promisify(execFile) as ExecFileRunner,
): Promise<void> {
  try {
    await run(PG_DUMP_PATH, cmd.args, {
      env: cmd.env,
      timeout: PANEL_DUMP_TIMEOUT_MS,
      maxBuffer: PANEL_DUMP_MAX_OUTPUT_BYTES,
      killSignal: "SIGKILL",
      shell: false,
    });
  } catch (err) {
    const e = (err ?? {}) as { code?: unknown; killed?: unknown };
    const reason: PanelDumpFailure =
      e.code === "ENOENT"
        ? "tool_missing"
        : e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "output_cap"
          : e.killed === true
            ? "timeout"
            : "exit";
    await rm(cmd.args[cmd.args.length - 1]!, { force: true });
    throw new PanelDumpError(reason, typeof e.code === "number" ? e.code : null);
  }
}
