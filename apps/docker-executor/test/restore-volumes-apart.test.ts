// C2 (R207 restore.1): no container of a restore holds the site's files volume and the staging volume together.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackupsIpcRequest, BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { BackupRunner, DEFAULT_BACKUP_NETWORK_NAME, type DockerRequest } from "../src/backup-runner.js";
import { writeRestoreNote } from "../src/restore-jobs.js";
import { SHARED_DB_NETWORK_NAME } from "../src/shared-database.js";

const SITE = "site_apart_a";
const SVC = "svc_apart_a";
const SITE_VOLUME = `hp_vol_${SVC}_html`;
const SNAPSHOT_ID = "d4".repeat(32);
const TARGET: BackupTarget = {
  endpoint: "https://s3.example.test",
  region: "eu-central-1",
  bucket: "apart-bucket",
  prefix: "apart",
  accessKeyId: "HP_SENTINEL_APART_ACCESS",
  secretAccessKey: "HP_SENTINEL_APART_SECRET",
};
const jobId = (n: number): string => `op_${n.toString(16).padStart(32, "0")}`;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function logFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A runner over a fake Docker that records every container it creates; `exits` sets an exit code by name suffix. */
async function harness(opts: { readonly siteVolumeExists: boolean; readonly exits?: Readonly<Record<string, number>> }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-apart-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${"5e".repeat(32)}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "root.key");
  await writeFile(sharedDbRootKeyFile, "sentinel-root-password\n", { mode: 0o400 });
  const sharedDbDataDir = path.join(tmp, "db");
  await mkdir(sharedDbDataDir, { mode: 0o700 });

  const volumes = new Set<string>(opts.siteVolumeExists ? [SITE_VOLUME] : []);
  const created: Array<{ readonly name: string; readonly binds: readonly string[] }> = [];
  const exitFor = (name: string): number =>
    Object.entries(opts.exits ?? {}).find(([suffix]) => name.endsWith(`_${suffix}`))?.[1] ?? 0;
  const request: DockerRequest = async (method, urlPath, body) => {
    const url = new URL(`http://docker${urlPath}`);
    const res = (statusCode: number, json?: unknown) => ({
      statusCode,
      body: Buffer.from(json === undefined ? "" : JSON.stringify(json)),
    });
    if (method === "POST" && url.pathname === "/volumes/create") {
      volumes.add((body as { Name: string }).Name);
      return res(201, {});
    }
    const vol = /^\/volumes\/([^/]+)$/.exec(url.pathname);
    if (vol && method === "GET") return res(volumes.has(decodeURIComponent(vol[1]!)) ? 200 : 404, {});
    if (vol && method === "DELETE") return res(volumes.delete(decodeURIComponent(vol[1]!)) ? 204 : 404);
    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      created.push({ name, binds: (body as { HostConfig?: { Binds?: string[] } }).HostConfig?.Binds ?? [] });
      return res(201, { Id: name });
    }
    const op = /^\/containers\/([^/]+)\/(start|wait|logs|kill)$/.exec(url.pathname);
    if (op?.[2] === "start" || op?.[2] === "kill") return res(204);
    if (op?.[2] === "wait") return res(200, { StatusCode: exitFor(decodeURIComponent(op[1]!)) });
    if (op?.[2] === "logs") return { statusCode: 200, body: op[1]!.endsWith("_rs_fetch") ? logFrame("4096\n") : Buffer.alloc(0) };
    if (method === "DELETE" && url.pathname.startsWith("/containers/")) return res(204);
    if (method === "GET" && url.pathname === "/containers/json") return res(200, []);
    if (method === "GET" && url.pathname === "/volumes") return res(200, { Volumes: [] });
    return res(500, { message: "refused by the fake" });
  };
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    return method === "GET" ? new Response("<ListBucketResult/>", { status: 200 }) : new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  const backupWorkDir = path.join(tmp, "work");
  const runner = new BackupRunner({
    request,
    ensureImage: async () => undefined,
    ensureBackupNetwork: async () => undefined,
    listSiteDatabases: async () => [],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: SHARED_DB_NETWORK_NAME,
    backupNetworkName: DEFAULT_BACKUP_NETWORK_NAME,
    executorUser: "1000:1000",
    backupWorkDir,
    sharedDbDataDir,
    statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
    fetch: fakeFetch,
  });
  return { runner, created, restoresDir: path.join(backupWorkDir, "restores") };
}

async function settled(runner: BackupRunner, id: string): Promise<{ state: string; failure: string | null }> {
  const until = performance.now() + 5_000;
  for (;;) {
    const s = (await runner.run({ action: "status", jobId: id })) as { state: string; failure: string | null };
    if (s.state !== "running") return s;
    if (performance.now() > until) throw new Error(`job ${id} did not settle`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function expectApart(created: ReadonlyArray<{ readonly name: string; readonly binds: readonly string[] }>): void {
  expect(created.length).toBeGreaterThan(0);
  for (const c of created) {
    const site = c.binds.some((b) => b.startsWith(`${SITE_VOLUME}:`));
    const staging = c.binds.some((b) => /^hp_bk_op_[0-9a-f]{32}:/.test(b));
    expect({ name: c.name, both: site && staging }).toEqual({ name: c.name, both: false });
  }
}

const restore = (id: string, createVolume: boolean): BackupsIpcRequest => ({
  action: "restore",
  jobId: id,
  siteId: SITE,
  serviceInstanceId: SVC,
  target: TARGET,
  snapshotId: SNAPSHOT_ID,
  ...(createVolume ? { createVolume: true as const } : {}),
});

describe("restore: the site volume and the staging volume never meet (C2)", () => {
  // Each case: the containers it must reach, so that the sequence really ran.
  const cases: ReadonlyArray<{ readonly name: string; readonly exits?: Record<string, number>; readonly reach: readonly string[] }> = [
    { name: "a restore that succeeds", reach: ["rs_fetch", "rs_fetch_files", "rs_prepare", "rs_gate_on", "rs_switch", "rs_files", "rs_finish"] },
    { name: "a fetch that fails", exits: { rs_fetch_files: 95 }, reach: ["rs_fetch", "rs_undo_db", "rs_gate_end"] },
    { name: "a switch that fails", exits: { rs_switch: 81 }, reach: ["rs_undo_files", "rs_gate_undo", "rs_undo_db", "rs_gate_end"] },
  ];
  for (const c of cases) {
    for (const createVolume of [false, true]) {
      it(`${c.name}, ${createVolume ? "an administrator's restore into a new volume" : "a customer's restore"}`, async () => {
        const h = await harness({ siteVolumeExists: !createVolume, ...(c.exits ? { exits: c.exits } : {}) });
        const id = jobId(createVolume ? 2 : 1);
        await h.runner.run(restore(id, createVolume));
        await settled(h.runner, id);
        const reached = h.created.map((x) => x.name.slice(`hp_bk_${id}_`.length));
        expect(reached).toEqual(expect.arrayContaining([...c.reach]));
        expectApart(h.created);
      });
    }
  }

  for (const stage of ["prepare", "switch", "switched"] as const) {
    it(`the settle of a note at stage ${stage}`, async () => {
      const h = await harness({ siteVolumeExists: true });
      const id = jobId(3);
      await writeRestoreNote(h.restoresDir, { v: 1, jobId: id, siteId: SITE, serviceInstanceId: SVC, stage });
      await h.runner.settleRestores();
      expectApart(h.created);
    });
  }
});
