import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackupsIpcRequestSchema, type BackupsIpcRequest } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackupRunner, type BackupRunnerDeps, type DockerRequest } from "../src/index.js";

const SNAPSHOT_ID = "a1b2c3d4".repeat(8);
const OP = (n: number, suffix = ""): string => `op_${n.toString(16).padStart(32, "0")}${suffix}`;
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;
const S3_TARGET = {
  endpoint: "https://storage.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: "AKIAEXAMPLEKEY12345",
  secretAccessKey: "secret-example-key-0123456789",
} as const;
const DUMP_BYTES = 100;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanups.splice(0).reverse()) await task();
});

const frame = (text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const summaryLine = JSON.stringify({
  message_type: "summary",
  snapshot_id: SNAPSHOT_ID,
  data_added: 4096,
  total_bytes_processed: DUMP_BYTES + 64,
  files_new: 2,
  files_changed: 0,
  files_unmodified: 0,
  total_duration: 1,
});

async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-panel-two-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  const panelDumpDir = path.join(tmp, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o770 });
  await chmod(panelDumpDir, 0o770);
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${"deadbeef".repeat(8)}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "db-root.key");
  await writeFile(sharedDbRootKeyFile, "db-root-pass", { mode: 0o400 });

  const created: Array<{ name: string; secrets: string[]; mounts: string[] }> = [];
  const behaviors = new Map<string, { stdout?: string }>();
  const json = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const empty = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });
  const request: DockerRequest = async (method, reqPath, body) => {
    const url = new URL(`http://docker${reqPath}`);
    const p = url.pathname;
    if (method === "POST" && p === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      behaviors.set(name, name.endsWith("_pup") ? { stdout: summaryLine } : {});
      const payload = body as { HostConfig: { Mounts?: Array<{ Source: string }> } };
      const secretDir = /job_bk_[^/]+/.exec(JSON.stringify(body))?.[0];
      const secrets = secretDir ? await readdir(path.join(secretsRootDir, secretDir)).catch(() => []) : [];
      created.push({ name, secrets: secretDir ? [secretDir, ...secrets] : [], mounts: (payload.HostConfig.Mounts ?? []).map((m) => m.Source) });
      return json(201, { Id: `id_${name}` });
    }
    const op = /^\/containers\/id_([^/]+)\/(start|wait|logs|kill)$/.exec(p);
    if (op) {
      const b = behaviors.get(op[1]!) ?? {};
      if (op[2] === "start") return empty(204);
      if (op[2] === "wait") return json(200, { StatusCode: 0 });
      if (op[2] === "logs") {
        const wantOut = url.searchParams.get("stdout") === "1";
        return { statusCode: 200, body: wantOut && b.stdout ? frame(b.stdout) : Buffer.alloc(0) };
      }
      return empty(204);
    }
    if (method === "DELETE" && p.startsWith("/containers/")) return empty(204);
    throw new Error(`Unexpected Docker call ${method} ${reqPath}`);
  };
  const deps: BackupRunnerDeps = {
    request,
    ensureImage: async () => undefined,
    ensureBackupNetwork: vi.fn(async () => undefined),
    listSiteDatabases: async () => [],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: `${UID}:${GID}`,
    backupWorkDir: path.join(tmp, "backup-work"),
    panelDumpDir,
    sharedDbDataDir: path.join(tmp, "mariadb-data"),
    fetch: vi.fn(async () => new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof globalThis.fetch,
  };
  return { runner: new BackupRunner(deps), panelDumpDir, secretsRootDir, created };
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

const writeDump = (dir: string, dumpId: string): Promise<void> =>
  writeFile(path.join(dir, `${dumpId}.dump`), Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(DUMP_BYTES - 5)]), {
    mode: 0o640,
  });

const panelReq = (jobId: string, dumpId?: string) =>
  ({
    action: "panelStart",
    jobId,
    ...(dumpId === undefined ? {} : { dumpId }),
    target: S3_TARGET,
    masterKey: "ab".repeat(32),
    retentionDays: 30,
  }) as Extract<BackupsIpcRequest, { action: "panelStart" }>;

describe("panelStart second copy (dumpId and -t2 job ids)", () => {
  it("accepts op_x and op_x-t2 job ids and an optional op_x dumpId, nothing else", () => {
    const base = { action: "panelStart", target: S3_TARGET, masterKey: "ab".repeat(32), retentionDays: 30 };
    const parse = (extra: Record<string, unknown>) => BackupsIpcRequestSchema.safeParse({ ...base, ...extra }).success;
    expect(parse({ jobId: OP(1) })).toBe(true);
    expect(parse({ jobId: OP(1, "-t2") })).toBe(true);
    expect(parse({ jobId: OP(1, "-t2"), dumpId: OP(1) })).toBe(true);
    expect(parse({ jobId: OP(1, "-forget") })).toBe(false);
    expect(parse({ jobId: OP(1, "-t3") })).toBe(false);
    expect(parse({ jobId: OP(1, "-t2"), dumpId: OP(1, "-t2") })).toBe(false);
    expect(parse({ jobId: OP(1, "-t2"), dumpId: "../x" })).toBe(false);
  });

  it("runs two sequential panel jobs on one dump, each with its own containers and secrets", async () => {
    const env = await setup();
    const first = OP(1);
    const second = OP(1, "-t2");
    await writeDump(env.panelDumpDir, first);

    await env.runner.run(panelReq(first));
    await expect(settled(env.runner, first)).resolves.toMatchObject({ state: "succeeded" });
    // The API keeps the dump until both copies settle: the second one reads the first one's file.
    await env.runner.run(panelReq(second, first));
    await expect(settled(env.runner, second)).resolves.toMatchObject({
      state: "succeeded",
      snapshot: { snapshotId: SNAPSHOT_ID },
    });

    const names = env.created.map((c) => c.name);
    expect(names).toEqual(
      [first, second].flatMap((id) => [`hp_bk_${id}_prepo`, `hp_bk_${id}_pup`, `hp_bk_${id}_pkeep`]),
    );
    const step = (id: string, suffix: string) => env.created.find((c) => c.name === `hp_bk_${id}_${suffix}`)!;
    expect(step(second, "pup").mounts.some((m) => m.endsWith(`/${first}.dump`))).toBe(true);
    expect(step(first, "pup").mounts.some((m) => m.endsWith(`/${first}.dump`))).toBe(true);
    // Each copy writes and removes its own secret directories (restic credentials and master key).
    expect(step(first, "pup").secrets[0]).toBe(`job_bk_pn_${first}`);
    expect(step(second, "pup").secrets[0]).toBe(`job_bk_pn_${second}`);
    expect(await readdir(env.secretsRootDir)).toEqual([]);
  });

  it("without dumpId a -t2 job looks for its own dump and fails panel_dump_missing", async () => {
    const env = await setup();
    await writeDump(env.panelDumpDir, OP(2));
    await env.runner.run(panelReq(OP(2, "-t2")));
    await expect(settled(env.runner, OP(2, "-t2"))).resolves.toMatchObject({
      state: "failed",
      failure: "panel_dump_missing",
    });
    expect(env.created).toEqual([]);
  });

  it("a missing dump for the given dumpId fails panel_dump_missing", async () => {
    const env = await setup();
    await env.runner.run(panelReq(OP(3, "-t2"), OP(3)));
    await expect(settled(env.runner, OP(3, "-t2"))).resolves.toMatchObject({
      state: "failed",
      failure: "panel_dump_missing",
    });
  });

  it("the panel lane serialises op_x and op_x-t2 panel jobs", async () => {
    const env = await setup();
    await writeDump(env.panelDumpDir, OP(4));
    await env.runner.run(panelReq(OP(4)));
    await expect(env.runner.run(panelReq(OP(4, "-t2"), OP(4)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await settled(env.runner, OP(4));
    await env.runner.run(panelReq(OP(4, "-t2"), OP(4)));
    await expect(settled(env.runner, OP(4, "-t2"))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("the per-site lock serialises op_x and op_x-t2 site jobs", async () => {
    const env = await setup();
    const start = (jobId: string) =>
      ({ action: "start", jobId, siteId: "site1", serviceInstanceId: "svc_site1", target: S3_TARGET }) as BackupsIpcRequest;
    await env.runner.run(start(OP(5)));
    await expect(env.runner.run(start(OP(5, "-t2")))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await settled(env.runner, OP(5));
    await expect(env.runner.run(start(OP(5, "-t2")))).resolves.toMatchObject({ jobId: OP(5, "-t2") });
    await settled(env.runner, OP(5, "-t2"));
  });
});
