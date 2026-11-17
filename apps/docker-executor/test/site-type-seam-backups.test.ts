// M6a seam: backups and restores take the site type as a value; a type without a database is backed up and restored.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHARED_MARIADB_IMAGE, type BackupsIpcRequest, type BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildBackupUploadContainerPayload } from "../src/backup-jobs.js";
import { BackupRunner, type DockerRequest } from "../src/backup-runner.js";
import {
  RestoreNoteSchema,
  buildRestoreDbScript,
  buildRestoreFetchContainerPayload,
  buildRestoreFetchFilesContainerPayload,
  buildRestoreFetchFilesScript,
  buildRestoreFilesContainerPayload,
  buildRestoreFilesFinishContainerPayload,
  buildRestoreFilesScript,
  buildRestoreFinishContainerPayload,
  buildRestoreOwnContainerPayload,
  buildRestorePrepareContainerPayload,
  buildRestoreSwitchContainerPayload,
  buildRestoreUndoDbContainerPayload,
  buildRestoreUndoFilesContainerPayload,
  readRestoreNote,
  writeRestoreNote,
} from "../src/restore-jobs.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "../src/site-types/index.js";
import { TEST_EXECUTOR_SITE_TYPE } from "./support/test-site-type.js";

const T = TEST_EXECUTOR_SITE_TYPE;
const JOB = `op_${"d0".repeat(16)}`;
const ids = { jobId: JOB, siteId: "site_seam", serviceInstanceId: "svc_seam" };
const VOLUME = "hp_vol_svc_seam_public";
const TARGET: BackupTarget = {
  endpoint: "https://s3.example.test:9000",
  region: "eu-central-1",
  bucket: "seam-backups",
  prefix: "",
  accessKeyId: "sentinel-access-key",
  secretAccessKey: "sentinel-secret-key",
};
const restic = {
  secretBinds: ["/run/secrets-sentinel/a/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro"],
  secretFileEnv: ["RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD"],
};
const db = {
  sharedDbNetworkName: "hp_db_net",
  secretBinds: ["/run/secrets-sentinel/b/MARIADB_ROOT:/run/secrets/MARIADB_ROOT:ro"],
  secretFileEnv: ["MARIADB_ROOT_FILE=/run/secrets/MARIADB_ROOT"],
};
const WORDPRESS_WORDS = /wordpress|wp-|wp_|\/var\/www\/html|33:33|\.maintenance|mu-plugins|www-data/i;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-seam-backups-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const binds = (spec: { payload: unknown }): readonly string[] =>
  (spec.payload as { HostConfig: { Binds: string[] } }).HostConfig.Binds;

describe("backup and restore builders with a type without a database", () => {
  it("the upload backs up the type's volume as its owner and excludes only the restore dir", () => {
    const spec = buildBackupUploadContainerPayload({
      ...ids,
      siteType: T,
      target: TARGET,
      backupNetworkName: "hp_backup_net",
      ...restic,
      stagingVolumeName: null,
    });
    const cmd = spec.payload.Cmd as string[];
    expect(spec.payload.User).toBe("1000:1000");
    expect(binds(spec)).toContain(`${VOLUME}:/backup/files:ro`);
    expect(cmd.filter((_, i) => cmd[i - 1] === "--exclude")).toEqual(["/backup/files/.hp_rs_*"]);
  });

  it("fetch, files, undo files and own use the type's mount, owner, image and scripts", () => {
    const fetchIn = { ...ids, siteType: T, snapshotId: "5a".repeat(32), target: TARGET, backupNetworkName: "hp_backup_net", ...restic };
    const fetch = buildRestoreFetchFilesContainerPayload(fetchIn);
    expect(fetch.payload.User).toBe("1000:1000");
    expect(binds(fetch)).toContain(`${VOLUME}:/srv/public`);
    expect((fetch.payload.Entrypoint as string[])[2]).toBe(buildRestoreFetchFilesScript(T));
    expect(binds(buildRestoreFetchContainerPayload({ ...fetchIn, stagingVolumeName: `hp_bk_${JOB}` }))).not.toContain(`${VOLUME}:/srv/public`);

    for (const [spec, step] of [
      [buildRestoreFilesContainerPayload({ ...ids, siteType: T }), "switch"],
      [buildRestoreUndoFilesContainerPayload({ ...ids, siteType: T }), "undo"],
      [buildRestoreFilesFinishContainerPayload({ ...ids, siteType: T }), "finish"],
    ] as const) {
      expect(spec.payload.Image).toBe("hp-test-static-files:1");
      expect(spec.payload.User).toBe("1000:1000");
      expect(spec.payload.Cmd).toEqual(["sh", "-c", buildRestoreFilesScript(T)]);
      expect(spec.payload.Env).toContain(`HP_STEP=${step}`);
      expect(binds(spec)).toEqual([`${VOLUME}:/srv/public`]);
    }
    expect(buildRestoreFilesFinishContainerPayload({ ...ids, siteType: T }).containerName).toBe(`hp_bk_${JOB}_rs_finish`);

    const own = buildRestoreOwnContainerPayload({ ...ids, siteType: T });
    expect(own.payload.Entrypoint).toEqual(["/bin/sh", "-c", "chown 1000:1000 /v && chmod 0755 /v"]);
    expect(binds(own)).toEqual([`${VOLUME}:/v`]);
  });

  it("no database container payload is built when the database is null", () => {
    const staging = { stagingVolumeName: `hp_bk_${JOB}` };
    expect(() => buildRestoreDbScript(T)).toThrow();
    expect(() => buildRestorePrepareContainerPayload({ ...ids, siteType: T, ...staging, ...db })).toThrow();
    expect(() => buildRestoreSwitchContainerPayload({ ...ids, siteType: T, ...staging, ...db })).toThrow();
    expect(() => buildRestoreUndoDbContainerPayload({ ...ids, siteType: T, ...staging, ...db })).toThrow();
    expect(() => buildRestoreFinishContainerPayload({ ...ids, siteType: T, ...db })).toThrow();
    // The files finish step exists only for a type without a database gate.
    expect(() => buildRestoreFilesFinishContainerPayload({ ...ids, siteType: WORDPRESS_EXECUTOR_SITE_TYPE })).toThrow();
  });

  it("the scripts carry only the type's words", () => {
    const files = buildRestoreFilesScript(T);
    const fetch = buildRestoreFetchFilesScript(T);
    expect(files).not.toMatch(WORDPRESS_WORDS);
    expect(fetch).not.toMatch(WORDPRESS_WORDS);
    expect(files).toContain("W=/srv/public; R=$W/.hp_rs_$HP_H");
    expect(fetch).toContain("W=/srv/public; R=/srv/public/.hp_rs_$HP_H");
    expect(files).toContain('  for d in ""; do');
    expect(files).toContain("        .hp_rs_*) continue ;;");
    expect(files).not.toContain("mkdir -p");
    expect(files).toContain('finish)\n  rm -rf "$R" || exit 97\n  sync "$W" || exit 97 ;;');
    expect(buildRestoreFilesScript(WORDPRESS_EXECUTOR_SITE_TYPE)).not.toContain("finish)");
  });

  it("the note carries siteType for a non-legacy type, and an old note without it still reads", async () => {
    const dir = path.join(await tempDir(), "restores");
    await writeRestoreNote(dir, { v: 1, ...ids, stage: "switch", siteType: "teststatic" });
    expect(JSON.parse(await readFile(path.join(dir, `${JOB}.json`), "utf8"))).toMatchObject({ siteType: "teststatic" });
    expect((await readRestoreNote(dir, JOB))?.siteType).toBe("teststatic");

    const old = { v: 1, ...ids, stage: "prepare" };
    const parsed = RestoreNoteSchema.parse(old);
    expect(parsed.siteType).toBeUndefined();
    expect(RestoreNoteSchema.safeParse({ ...old, siteType: "../x" }).success).toBe(false);
  });
});

interface Created {
  readonly name: string;
  readonly body: { Image?: string };
}

/** A BackupRunner whose type resolver always answers the test type, over a fake Docker. */
async function setupRunner(): Promise<{
  runner: BackupRunner;
  created: Created[];
  ensured: string[];
  listed: string[];
  asked: string[];
  restoresDir: string;
}> {
  const tmp = await tempDir();
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${"5e".repeat(32)}\n`, { mode: 0o400 });
  const created: Created[] = [];
  const ensured: string[] = [];
  const listed: string[] = [];
  const asked: string[] = [];
  const frame = (text: string): Buffer => {
    const head = Buffer.alloc(8);
    head[0] = 1;
    head.writeUInt32BE(Buffer.byteLength(text), 4);
    return Buffer.concat([head, Buffer.from(text)]);
  };
  const summary = JSON.stringify({
    message_type: "summary",
    snapshot_id: "5b".repeat(32),
    data_added: 1,
    total_bytes_processed: 1,
    files_new: 1,
    files_changed: 0,
    files_unmodified: 0,
    total_duration: 1,
  });
  const request: DockerRequest = async (method, urlPath, body) => {
    const url = new URL(`http://docker${urlPath}`);
    const json = (statusCode: number, value?: unknown) => ({
      statusCode,
      body: Buffer.from(value === undefined ? "" : JSON.stringify(value)),
    });
    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      created.push({ name, body: body as { Image?: string } });
      return json(201, { Id: name });
    }
    const m = /^\/containers\/([^/]+)\/(start|wait|logs)$/.exec(url.pathname);
    if (m?.[2] === "start") return json(204);
    if (m?.[2] === "wait") return json(200, { StatusCode: 0 });
    if (m?.[2] === "logs") {
      const out = m[1]!.endsWith("_rs_fetch") ? "4096\n" : m[1]!.endsWith("_up") ? `${summary}\n` : "";
      return { statusCode: 200, body: url.searchParams.get("stdout") === "1" && out ? frame(out) : Buffer.alloc(0) };
    }
    if (method === "DELETE") return json(204);
    if (method === "POST" && url.pathname === "/volumes/create") return json(201, {});
    if (method === "GET" && url.pathname.startsWith("/volumes/")) return json(200, {});
    if (method === "GET" && url.pathname === "/volumes") return json(200, { Volumes: [] });
    if (method === "GET" && url.pathname === "/containers/json") return json(200, []);
    return json(500, { message: "refused by the seam fake" });
  };
  const runner = new BackupRunner({
    request,
    ensureImage: async (image) => {
      ensured.push(image);
    },
    ensureBackupNetwork: async () => undefined,
    listSiteDatabases: async (siteId) => {
      listed.push(siteId);
      return [];
    },
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile: path.join(tmp, "absent-root.key"),
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: "990:990",
    backupWorkDir: path.join(tmp, "work"),
    sharedDbDataDir: path.join(tmp, "absent-db-data"),
    statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") return new Response("<ListBucketResult/>", { status: 200 });
      return new Response(null, { status: method === "DELETE" ? 204 : 200 });
    }) as typeof globalThis.fetch,
    resolveSiteType: (key) => {
      asked.push(key);
      return T;
    },
  });
  return { runner, created, ensured, listed, asked, restoresDir: path.join(tmp, "work", "restores") };
}

async function settle(runner: BackupRunner, jobId: string): Promise<unknown> {
  const until = performance.now() + 5_000;
  for (;;) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    if (performance.now() > until) throw new Error(`job ${jobId} did not settle`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("the files script of a type without a database removes the work dir", () => {
  const H = "c3".repeat(16);
  /** Runs the test type's files script on a temp copy of its mount: old.txt live, new.txt fetched. */
  async function siteWithFetch(): Promise<{ w: string; step: (name: string) => number | null }> {
    const w = await tempDir();
    const files = path.join(w, `.hp_rs_${H}`, "c", "files");
    await mkdir(files, { recursive: true });
    await writeFile(path.join(w, "old.txt"), "old");
    await writeFile(path.join(files, "new.txt"), "new");
    const script = buildRestoreFilesScript(T).replace(`W=${T.def.files.mountPath};`, `W=${w};`);
    const step = (name: string) =>
      spawnSync("sh", ["-c", script], { env: { ...process.env, HP_STEP: name, HP_H: H }, encoding: "utf8" }).status;
    return { w, step };
  }

  it("after switch and finish the new files are live and the work dir is gone", async () => {
    const { w, step } = await siteWithFetch();
    expect(step("switch")).toBe(0);
    expect(step("finish")).toBe(0);
    expect((await readdir(w)).sort()).toEqual(["new.txt"]);
  });

  it("after switch, undo and finish the old files are back and the work dir is gone", async () => {
    const { w, step } = await siteWithFetch();
    expect(step("switch")).toBe(0);
    expect(step("undo")).toBe(0);
    expect(step("finish")).toBe(0);
    expect((await readdir(w)).sort()).toEqual(["old.txt"]);
  });
});

describe("BackupRunner with a type without a database", () => {
  it("a backup lists no database, ensures no MariaDB image and runs no dump", async () => {
    const { runner, created, ensured, listed } = await setupRunner();
    const req: BackupsIpcRequest = { action: "start", ...ids, target: TARGET };
    await runner.run(req);
    expect(await settle(runner, JOB)).toMatchObject({ state: "succeeded" });
    expect(listed).toEqual([]);
    expect(ensured).not.toContain(SHARED_MARIADB_IMAGE);
    expect(created.map((c) => c.name.slice(JOB.length + 7))).toEqual(["repo", "up"]);
    expect(created.find((c) => c.name.endsWith("_up"))?.body).toMatchObject({ User: "1000:1000" });
  });

  it("a restore runs fetch, files and the files finish only, and its note carries siteType", async () => {
    const { runner, created, ensured, restoresDir } = await setupRunner();
    const req: BackupsIpcRequest = { action: "restore", ...ids, target: TARGET, snapshotId: "5a".repeat(32) };
    await runner.run(req);
    expect(await settle(runner, JOB)).toMatchObject({ state: "succeeded", failure: null });
    expect(created.map((c) => c.name.slice(JOB.length + 7))).toEqual(["rs_fetch", "rs_fetch_files", "rs_files", "rs_finish"]);
    expect(created.every((c) => c.body.Image !== SHARED_MARIADB_IMAGE)).toBe(true);
    expect(ensured).not.toContain(SHARED_MARIADB_IMAGE);
    expect(ensured).toContain("hp-test-static-files:1");
    const note = JSON.parse(await readFile(path.join(restoresDir, `${JOB}.json`), "utf8"));
    expect(note).toMatchObject({ stage: "ended", state: "succeeded", siteType: "teststatic" });
  });

  it("a settle reads the type from the note and undoes or finishes without a database", async () => {
    const { runner, created, ensured, asked, restoresDir } = await setupRunner();
    const jPrepare = `op_${"e1".repeat(16)}`;
    const jSwitched = `op_${"e2".repeat(16)}`;
    await writeRestoreNote(restoresDir, { v: 1, jobId: jPrepare, siteId: "site_a", serviceInstanceId: "svc_a", stage: "prepare", siteType: "teststatic" });
    await writeRestoreNote(restoresDir, { v: 1, jobId: jSwitched, siteId: "site_b", serviceInstanceId: "svc_b", stage: "switched", siteType: "teststatic" });
    await runner.settleRestores();
    expect(await settle(runner, jPrepare)).toMatchObject({ state: "failed", failure: "interrupted" });
    expect(await settle(runner, jSwitched)).toMatchObject({ state: "succeeded", failure: null });
    expect(asked).toEqual(["teststatic", "teststatic"]);
    expect(created.map((c) => c.name).sort()).toEqual([`hp_bk_${jPrepare}_rs_finish`, `hp_bk_${jSwitched}_rs_finish`]);
    expect(ensured).not.toContain(SHARED_MARIADB_IMAGE);
    expect(await readRestoreNote(restoresDir, jSwitched)).toMatchObject({ stage: "ended", siteType: "teststatic" });
  });
});
