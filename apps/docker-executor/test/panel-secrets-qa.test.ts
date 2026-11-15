// QA (A3, R113): the master key and the S3 keys of a panel copy job reach no log line, status,
// error, IPC body, container config, note or file, except the one read-only job file during the job.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import {
  BackupsIpcRequestSchema,
  signIpcRequest,
  type BackupTarget,
  type IpcSigningKey,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BackupRunner,
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorCodedError,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
  type BackupRunnerDeps,
  type DockerRequest,
} from "../src/index.js";
import { main as panelFetchMain } from "../src/cli/panel-fetch.js";

const MASTER_KEY = `5e17${"a5".repeat(30)}`;
const ACCESS_KEY = "HPQA_SENTINEL_ACCESS_7731";
const SECRET_KEY = "HPQA_SENTINEL_SECRET_4410";
const BACKUP_KEY = "b0c1".repeat(16);
const SENTINELS = [MASTER_KEY, MASTER_KEY.toUpperCase(), ACCESS_KEY, SECRET_KEY, BACKUP_KEY];
const JOB = `op_${"7".repeat(32)}`;
const SNAP = "d4".repeat(32);
const DUMP = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(2043, 1)]);
const TARGET: BackupTarget = {
  endpoint: "https://s3.example.test:9000",
  region: "eu-south-1",
  bucket: "panel-qa",
  prefix: "qa",
  accessKeyId: ACCESS_KEY,
  secretAccessKey: SECRET_KEY,
};
const panelReq = (over: Record<string, unknown> = {}) => ({
  action: "panelStart" as const,
  jobId: JOB,
  target: TARGET,
  masterKey: MASTER_KEY,
  retentionDays: 7,
  ...over,
});

/** Fails with the sentinel's index, never its value, so a failing test prints no secret either. */
function expectClean(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : inspect(value, { depth: Infinity, showHidden: true });
  const json = typeof value === "string" ? "" : JSON.stringify(value) ?? "";
  const hits = SENTINELS.map((s, i) => (text.includes(s) || json.includes(s) ? i : -1)).filter((i) => i >= 0);
  expect(hits, label).toEqual([]);
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanups.splice(0).reverse()) await task();
});

/** Captures every console line; a leak through any level counts. */
function captureConsole(): string[] {
  const lines: string[] = [];
  for (const level of ["log", "error", "warn", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: Infinity }))).join(" "));
    });
  }
  return lines;
}

interface Stage {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  onWait?: () => Promise<void>;
}

/** A Docker Engine stand-in: records requests, runs scripted stages per container-name suffix. */
function fakeEngine(stages: Record<string, Stage>, createStatus = 201) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const payloads = new Map<string, Record<string, unknown>>();
  const reply = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const frame = (stream: 1 | 2, text: string) => {
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(Buffer.byteLength(text), 4);
    return Buffer.concat([head, Buffer.from(text)]);
  };
  const stageOf = (name: string) => stages[Object.keys(stages).find((s) => name.endsWith(s)) ?? ""] ?? {};
  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath, body });
    const url = new URL(`http://docker${reqPath}`);
    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      payloads.set(name, body as Record<string, unknown>);
      // A hostile engine that echoes the request back in its error body.
      return createStatus === 201 ? reply(201, { Id: name }) : reply(createStatus, { message: JSON.stringify(body) });
    }
    const m = /^\/containers\/([^/]+)\/(start|wait|logs)$/.exec(url.pathname);
    if (m) {
      const stage = stageOf(decodeURIComponent(m[1]!));
      if (m[2] === "start") return { statusCode: 204, body: Buffer.alloc(0) };
      if (m[2] === "wait") {
        await stage.onWait?.();
        return reply(200, { StatusCode: stage.exitCode ?? 0 });
      }
      const frames: Buffer[] = [];
      if (url.searchParams.get("stdout") === "1" && stage.stdout) frames.push(frame(1, stage.stdout));
      if (url.searchParams.get("stderr") === "1" && stage.stderr) frames.push(frame(2, stage.stderr));
      return { statusCode: 200, body: Buffer.concat(frames) };
    }
    if (method === "DELETE" && url.pathname.startsWith("/containers/")) return { statusCode: 204, body: Buffer.alloc(0) };
    if (method === "GET" && url.pathname === "/containers/json") return reply(200, []);
    return reply(404, { message: "not found" });
  };
  return { request, requests, payloads };
}

const summary = (bytes: number) =>
  JSON.stringify({
    message_type: "summary",
    snapshot_id: SNAP,
    data_added: 10,
    total_bytes_processed: bytes,
    files_new: 2,
    files_changed: 0,
    files_unmodified: 0,
    total_duration: 0.2,
  });

async function setup(opts: {
  stages?: Record<string, Stage>;
  createStatus?: number;
  dump?: "missing" | "symlink";
  fetch?: typeof globalThis.fetch;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-panel-qa-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const secretsRootDir = path.join(root, "secrets");
  const panelDumpDir = path.join(root, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o2770 });
  const dumpPath = path.join(panelDumpDir, `${JOB}.dump`);
  if (opts.dump === "symlink") {
    await writeFile(path.join(root, "real.dump"), DUMP);
    await symlink(path.join(root, "real.dump"), dumpPath);
  } else if (opts.dump !== "missing") {
    await writeFile(dumpPath, DUMP, { mode: 0o640 });
  }
  const backupKeyFile = path.join(root, "backup.key");
  await writeFile(backupKeyFile, `${BACKUP_KEY}\n`, { mode: 0o400 });
  const engine = fakeEngine(opts.stages ?? {}, opts.createStatus);
  const lines = captureConsole();
  const deps: BackupRunnerDeps = {
    request: engine.request,
    ensureImage: async () => undefined,
    ensureBackupNetwork: async () => undefined,
    listSiteDatabases: async () => [],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile: path.join(root, "mariadb-root"),
    sharedDbNetworkName: "hp_shared_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: "990:990",
    backupWorkDir: path.join(root, "work"),
    panelDumpDir,
    fetch:
      opts.fetch ??
      ((async () => new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof globalThis.fetch),
  };
  return { root, secretsRootDir, backupKeyFile, engine, lines, runner: new BackupRunner(deps) };
}

async function settle(runner: BackupRunner) {
  for (let i = 0; i < 400; i += 1) {
    const status = await runner.run({ action: "status", jobId: JOB });
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not settle");
}

/** Env, Cmd, Entrypoint and Labels never carry a secret or a host secret path; only mounts may name one. */
function expectPayloadsClean(payloads: Map<string, Record<string, unknown>>, secretsRootDir: string): void {
  for (const [name, p] of payloads) {
    const visible = { Env: p.Env, Cmd: p.Cmd, Entrypoint: p.Entrypoint, Labels: p.Labels, User: p.User };
    expectClean(`${name} Env/Cmd/Entrypoint/Labels`, visible);
    expect(JSON.stringify(visible), `${name} names no host secret path`).not.toContain(secretsRootDir);
    expectClean(`${name} whole payload`, p);
    const hostConfig = (p.HostConfig ?? {}) as Record<string, unknown>;
    const { Binds: _b, Mounts: _m, ...rest } = hostConfig;
    expect(JSON.stringify(rest), `${name} host secret path only in mounts`).not.toContain(secretsRootDir);
  }
}

describe("panel copy secrets (A3, R113): every runner path", () => {
  const SIZE = DUMP.length + 64;
  it.each([
    { label: "success", stages: { _pup: { stdout: summary(SIZE) } }, state: "succeeded", failure: null },
    { label: "dump missing", dump: "missing" as const, state: "failed", failure: "panel_dump_missing" },
    { label: "dump a symlink", dump: "symlink" as const, state: "failed", failure: "panel_dump_missing" },
    {
      label: "wrong key",
      stages: { _prepo: { exitCode: 12, stderr: "Fatal: wrong password or no key found\n" } },
      state: "failed",
      failure: "wrong_key",
    },
    {
      label: "storage unreachable",
      fetch: (async () => {
        // Shaped like undici's refusal, with a key in the text as a hostile extra.
        const cause = Object.assign(new Error(`connect ECONNREFUSED ${SECRET_KEY}`), { code: "ECONNREFUSED" });
        throw new TypeError(`fetch failed ${SECRET_KEY}`, { cause });
      }) as unknown as typeof globalThis.fetch,
      state: "failed",
      failure: "unreachable",
    },
    {
      label: "keep step failing",
      stages: { _pup: { stdout: summary(SIZE) }, _pkeep: { exitCode: 1, stderr: "Fatal: unable to prune\n" } },
      state: "succeeded",
      failure: null,
    },
    { label: "engine 500 at create", createStatus: 500, state: "failed", failure: "other" },
  ])("$label: ends $state and leaks nothing", async (c) => {
    const during: { files: string[]; keyMode: number; keyText: string; runner: string } = {
      files: [],
      keyMode: -1,
      keyText: "",
      runner: "",
    };
    const stages = { ...(c.stages ?? {}) } as Record<string, Stage>;
    const ctx = await setup({ stages, dump: c.dump, fetch: c.fetch, createStatus: c.createStatus });
    const probe = async () => {
      // While the upload runs: exactly one file holds the master key, and it is read-only.
      const holders: string[] = [];
      for (const f of await filesUnder(ctx.root)) {
        if ((await readFile(f, "utf8")).includes(MASTER_KEY)) holders.push(path.relative(ctx.root, f));
      }
      during.files = holders;
      const keyFile = path.join(ctx.secretsRootDir, `job_bk_mk_${JOB}`, "SECRETS_MASTER_KEY");
      during.keyMode = (await stat(keyFile)).mode & 0o777;
      during.keyText = await readFile(keyFile, "utf8");
      during.runner = inspect(ctx.runner, { depth: Infinity, showHidden: true });
    };
    // The fake engine reads `stages` at call time, so the probe can be attached after setup.
    if (c.label === "success") stages._pup = { ...stages._pup, onWait: probe };

    const first = await ctx.runner.run(panelReq());
    const status = await settle(ctx.runner);
    expect(status).toMatchObject({ state: c.state, failure: c.failure });

    if (c.label === "success") {
      expect(during.files).toEqual([`secrets/job_bk_mk_${JOB}/SECRETS_MASTER_KEY`]);
      expect(during.keyText).toBe(MASTER_KEY);
      expect(during.keyMode & 0o222, "job key file is read-only").toBe(0);
      expectClean("util.inspect(runner) during the job", during.runner);
    }
    // Afterwards: no secret directory, and no file but the backup key file carries any sentinel.
    expect(await readdir(ctx.secretsRootDir).catch(() => [])).toEqual([]);
    for (const f of await filesUnder(ctx.root)) {
      if (f === ctx.backupKeyFile) continue;
      expectClean(`file ${path.relative(ctx.root, f)}`, (await readFile(f)).toString("latin1"));
    }
    expectClean("console lines", ctx.lines.join("\n"));
    expectClean("status answers", [first, status]);
    expectClean("docker requests", ctx.engine.requests);
    expectPayloadsClean(ctx.engine.payloads, ctx.secretsRootDir);
    expectClean("util.inspect(runner) after the job", ctx.runner);
  });
});

describe("panel copy secrets: schema refusals and thrown errors", () => {
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["upper-case key", { masterKey: MASTER_KEY.toUpperCase() }],
    ["63-character key", { masterKey: MASTER_KEY.slice(1) }],
    ["65-character key", { masterKey: `${MASTER_KEY}0` }],
    ["extra top-level key", { note: MASTER_KEY }],
    ["extra target key", { target: { ...TARGET, token: SECRET_KEY } }],
    ["retentionDays 0", { retentionDays: 0 }],
    ["retentionDays 366", { retentionDays: 366 }],
    ["bad job id", { jobId: "op_../../x" }],
  ];

  it.each(hostile)("%s: refused by the schema, VALIDATION_ERROR, no Docker call, no echo", async (_l, over) => {
    expect(BackupsIpcRequestSchema.safeParse(panelReq(over)).success).toBe(false);
    const ctx = await setup({});
    let caught: unknown = null;
    try {
      await ctx.runner.run(panelReq(over) as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutorCodedError);
    expect((caught as ExecutorCodedError).code).toBe("VALIDATION_ERROR");
    expectClean("thrown error", caught);
    expectClean("thrown error text", `${String(caught)} ${(caught as Error).stack ?? ""}`);
    expect(ctx.engine.requests).toEqual([]);
    expect(await readdir(ctx.secretsRootDir).catch(() => [])).toEqual([]);
    expectClean("console lines", ctx.lines.join("\n"));
  });
});

describe("panel copy secrets: adapter, simulator and IPC", () => {
  it("util.inspect of a real adapter after a panel job holds no sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hp-panel-qa-ad-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const panelDumpDir = path.join(root, "panel-dump");
    await mkdir(panelDumpDir, { mode: 0o2770 });
    const backupKeyFile = path.join(root, "backup.key");
    await writeFile(backupKeyFile, BACKUP_KEY, { mode: 0o400 });
    const lines = captureConsole();
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: path.join(root, "no-docker.sock"),
      secretsRootDir: path.join(root, "secrets"),
      backupWorkDir: path.join(root, "work"),
      backupKeyFile,
      panelDumpDir,
      pullMissingImages: false,
    });
    // No dump: the job fails before any Docker call, so no engine is needed.
    const first = await adapter.backups(panelReq());
    let status = first;
    for (let i = 0; i < 200 && status.state === "running"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = await adapter.backups({ action: "status", jobId: JOB });
    }
    expect(status).toMatchObject({ state: "failed", failure: "panel_dump_missing" });
    expectClean("util.inspect(adapter)", adapter);
    expectClean("status", [first, status]);
    expectClean("console lines", lines.join("\n"));
  });

  it("simulator and signed IPC: statuses, error bodies and util.inspect carry no sentinel", async () => {
    const lines = captureConsole();
    const simulator = new InMemoryDockerSimulatorAdapter();
    const key: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "panel-secrets-qa-hmac-key-0123456789abcdef" };
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": key },
      transport: "loopback-test",
      runtimeBackend: "local-simulator",
    });
    cleanups.push(() => server.stop());
    const { port } = await server.start();
    const client = new SignedDockerExecutorIpcClient({ signingKey: key, transport: "loopback-test", port: port! });
    const rawPost = async (bodyObj: unknown) => {
      const body = JSON.stringify(bodyObj);
      const headers = signIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/backups",
        body,
        key,
        nonce: randomBytes(8).toString("hex"),
      });
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/backups`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
      });
      return { status: res.status, text: await res.text() };
    };

    const ok = await client.backups(panelReq());
    expect(ok.jobId).toBe(JOB);
    const done = await client.backups({ action: "status", jobId: JOB });
    expectClean("IPC statuses", [ok, done]);
    expect(simulator.backupState.panelJobIds()).toEqual([JOB]);

    for (const over of [{ masterKey: MASTER_KEY.toUpperCase() }, { retentionDays: 366 }, { extra: SECRET_KEY }]) {
      const raw = await rawPost(panelReq(over));
      expect(raw.status).toBe(400);
      expect(raw.text).toContain("VALIDATION_ERROR");
      expectClean("IPC error body", raw.text);
      let caught: unknown = null;
      try {
        await client.backups(panelReq(over) as never);
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expectClean("IPC client error", caught);
      expectClean("IPC client error text", `${String(caught)} ${(caught as Error).stack ?? ""}`);
    }
    expectClean("util.inspect(simulator)", simulator);
    expectClean("util.inspect(client)", client);
    expectClean("console lines", lines.join("\n"));
  });
});

describe("panel-fetch CLI: keys on stdin never reach its output", () => {
  const argv = ["--endpoint", TARGET.endpoint, "--region", TARGET.region, "--bucket", TARGET.bucket, "--prefix", "qa"];
  const env = { HP_PANEL_DUMP_DIR: "/tmp/hp-qa-unused", HP_BACKUP_KEY_FILE: "/tmp/hp-qa-unused.key" };
  const stdin = `${ACCESS_KEY}\n${SECRET_KEY}\n`;

  const runCli = async (result: unknown, opts: { stdin?: string; throws?: boolean } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    let seen: BackupTarget | null = null;
    const code = await panelFetchMain({
      argv,
      stdin: opts.stdin ?? stdin,
      env,
      uid: 1000,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      createAdapter: () => ({
        fetchPanelCopy: async (target: BackupTarget) => {
          seen = target;
          if (opts.throws) throw new Error(`boom ${SECRET_KEY} ${MASTER_KEY}`);
          return result as never;
        },
      }),
    });
    return { code, out, err, seen: seen as BackupTarget | null };
  };

  it.each([
    [{ ok: true, snapshotId: SNAP, time: "2026-11-15T10:00:00Z" }, 0],
    [{ ok: false, problem: "refused" }, 2],
    [{ ok: false, problem: "unreachable" }, 3],
    [{ ok: false, problem: "auth_failed" }, 3],
    [{ ok: false, problem: "no_copy" }, 4],
    [{ ok: false, problem: "wrong_key" }, 5],
    [{ ok: false, problem: "key_file_missing" }, 5],
    [{ ok: false, problem: "no_space" }, 6],
    [{ ok: false, problem: "other" }, 1],
  ])("%j → exit %i with clean output", async (result, exit) => {
    const r = await runCli(result);
    expect(r.code).toBe(exit);
    expect(r.seen?.accessKeyId).toBe(ACCESS_KEY);
    expect(r.seen?.secretAccessKey).toBe(SECRET_KEY);
    expectClean("CLI stdout+stderr", [...r.out, ...r.err].join("\n"));
    expectClean("CLI argv", argv.join(" "));
  });

  it("an adapter that throws with the keys in its message → exit 1, output clean", async () => {
    const r = await runCli(null, { throws: true });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["panel-fetch: other"]);
    expectClean("CLI output", [...r.out, ...r.err].join("\n"));
  });

  it("malformed stdin (one line, three lines) → exit 2 refused, output clean, adapter never built", async () => {
    for (const bad of [`${ACCESS_KEY}\n`, `${ACCESS_KEY}\n${SECRET_KEY}\n${MASTER_KEY}\n`]) {
      const r = await runCli({ ok: true, snapshotId: SNAP, time: "t" }, { stdin: bad });
      expect(r.code).toBe(2);
      expect(r.seen).toBeNull();
      expectClean("CLI output", [...r.out, ...r.err].join("\n"));
    }
  });
});

