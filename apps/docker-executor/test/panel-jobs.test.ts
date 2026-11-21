import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESTIC_IMAGE, type BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_REPO_LOCAL_JOB_SCRIPT, localizeResticScript, resolveBackupRepository } from "../src/backup-jobs.js";
import { BackupRunner, type BackupRunnerDeps, type DockerRequest } from "../src/index.js";
import {
  PANEL_DUMP_MAGIC,
  PANEL_FETCH_LOCAL_SCRIPT,
  PANEL_FETCH_SCRIPT,
  PANEL_KEEP_LAST,
  PANEL_KEY_FILE_PATTERN,
  PANEL_LANE,
  PANEL_REPO_DUMP_PATH,
  PANEL_REPO_KEY_PATH,
  buildPanelDropContainerPayload,
  buildPanelFetchContainerPayload,
  buildPanelFetchLocalContainerPayload,
  buildPanelKeepContainerPayload,
  buildPanelRepoContainerPayload,
  buildPanelUploadContainerPayload,
} from "../src/panel-jobs.js";

const ACCESS_KEY_SENTINEL = "HP_SENTINEL_ACCESS_KEY_991";
const SECRET_KEY_SENTINEL = "HP_SENTINEL_SECRET_KEY_882";
const MASTER_KEY_SENTINEL = "5e17ae11".repeat(8);
const JOB_ID = `op_${"1".repeat(32)}`;
const SNAPSHOT_ID = "a1b2c3d4".repeat(8);

const TARGET: BackupTarget = {
  endpoint: "https://storage.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: ACCESS_KEY_SENTINEL,
  secretAccessKey: SECRET_KEY_SENTINEL,
};

const RESTIC_SECRETS = {
  secretBinds: [
    "/run/hp/secrets/job_bk_pn_x/AWS_SHARED_CREDENTIALS:/run/secrets/AWS_SHARED_CREDENTIALS:ro",
    "/run/hp/secrets/job_bk_pn_x/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro",
  ],
  secretFileEnv: [
    "AWS_SHARED_CREDENTIALS_FILE=/run/secrets/AWS_SHARED_CREDENTIALS",
    "RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD",
  ],
};
const BASE = { target: TARGET, backupNetworkName: "hp_backup_net", ...RESTIC_SECRETS };
const RO = ["-o", "s3.bucket-lookup=path", "-o", "s3.region=eu-central-1"];

function expectHardened(hostConfig: Record<string, unknown>): void {
  expect(hostConfig).toMatchObject({
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 128,
    RestartPolicy: { Name: "no" },
  });
  expect(hostConfig).not.toHaveProperty("CapAdd");
}

describe("panel-jobs constants", () => {
  it("exposes the fixed panel values", () => {
    expect(PANEL_LANE).toBe("panel:db");
    expect(PANEL_DUMP_MAGIC).toBe("PGDMP");
    expect(PANEL_KEEP_LAST).toBe(3);
    expect(PANEL_REPO_DUMP_PATH).toBe("/backup/panel/panel.dump");
    expect(PANEL_REPO_KEY_PATH).toBe("/backup/panel/secrets-master.key");
    expect(PANEL_KEY_FILE_PATTERN.test(MASTER_KEY_SENTINEL)).toBe(true);
    expect(PANEL_KEY_FILE_PATTERN.test(`${MASTER_KEY_SENTINEL}\n`)).toBe(false);
    expect(PANEL_KEY_FILE_PATTERN.test(MASTER_KEY_SENTINEL.toUpperCase())).toBe(false);
  });
});

describe("panel-jobs builders", () => {
  const upload = () =>
    buildPanelUploadContainerPayload({
      ...BASE,
      jobId: JOB_ID,
      executorUser: "990:990",
      dumpPath: `/var/lib/hp/panel-dump/${JOB_ID}.dump`,
      masterKeyPath: `/run/hp/secrets/job_bk_mk_${JOB_ID}/SECRETS_MASTER_KEY`,
      dirGid: 4500,
    });

  it("repo step inits the panel repository with the shared repo script", () => {
    const spec = buildPanelRepoContainerPayload({ ...BASE, jobId: JOB_ID });
    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_prepo`);
    expect(spec.payload.Image).toBe(RESTIC_IMAGE);
    expect(spec.payload.Env).toContain("RESTIC_REPOSITORY=s3:https://storage.example.com:9000/panel-backups/prod/panel");
    expect(spec.payload.Env).toContain("HP_INIT=1");
    expect(spec.payload.Env).toContain("HP_REGION=eu-central-1");
    expect(spec.payload.Labels).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "site_job",
      "io.hostingpanel.job_id": JOB_ID,
    });
    expectHardened(spec.payload.HostConfig);
  });

  it("upload runs as the executor uid with GroupAdd and two read-only Mounts, not Binds", () => {
    const spec = upload();
    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_pup`);
    expect(spec.payload.User).toBe("990:990");
    expect(spec.payload.Hostname).toBe("hosting-panel");
    expectHardened(spec.payload.HostConfig);
    expect(spec.payload.HostConfig.GroupAdd).toEqual(["4500"]);
    expect(spec.payload.HostConfig.Mounts).toEqual([
      {
        Type: "bind",
        Source: `/var/lib/hp/panel-dump/${JOB_ID}.dump`,
        Target: PANEL_REPO_DUMP_PATH,
        ReadOnly: true,
      },
      {
        Type: "bind",
        Source: `/run/hp/secrets/job_bk_mk_${JOB_ID}/SECRETS_MASTER_KEY`,
        Target: PANEL_REPO_KEY_PATH,
        ReadOnly: true,
      },
    ]);
    expect(spec.payload.HostConfig.Binds).toEqual(RESTIC_SECRETS.secretBinds);
    expect(JSON.stringify(spec.payload.HostConfig.Binds)).not.toContain("panel-dump");
    expect(spec.payload.Cmd).toEqual([
      ...RO,
      "backup",
      "-q",
      "--json",
      "--host",
      "hosting-panel",
      "--tag",
      JOB_ID,
      "/backup/panel",
    ]);
    expect(spec.payload.Env.some((e) => e.startsWith("SECRETS_MASTER_KEY"))).toBe(false);
  });

  it("never carries the master key or S3 keys in any payload", () => {
    const payloads = [
      buildPanelRepoContainerPayload({ ...BASE, jobId: JOB_ID }),
      upload(),
      buildPanelDropContainerPayload({ ...BASE, jobId: JOB_ID, snapshotId: SNAPSHOT_ID }),
      buildPanelKeepContainerPayload({ ...BASE, jobId: JOB_ID, retentionDays: 7 }),
      buildPanelFetchContainerPayload({
        ...BASE,
        fetchId: "f".repeat(32),
        executorUser: "990:990",
        outDir: "/var/lib/hp/panel-dump",
        dirGid: 4500,
      }),
    ];
    for (const spec of payloads) {
      const text = JSON.stringify(spec);
      expect(text).not.toContain(MASTER_KEY_SENTINEL);
      expect(text).not.toContain(ACCESS_KEY_SENTINEL);
      expect(text).not.toContain(SECRET_KEY_SENTINEL);
    }
  });

  it("refuses directory gid 0, a bad executor user and relative mount paths", () => {
    const input = {
      ...BASE,
      jobId: JOB_ID,
      executorUser: "990:990",
      dumpPath: `/d/${JOB_ID}.dump`,
      masterKeyPath: "/s/SECRETS_MASTER_KEY",
      dirGid: 4500,
    };
    expect(() => buildPanelUploadContainerPayload({ ...input, dirGid: 0 })).toThrow();
    expect(() => buildPanelUploadContainerPayload({ ...input, dirGid: 1.5 })).toThrow();
    expect(() => buildPanelUploadContainerPayload({ ...input, executorUser: "root" })).toThrow();
    expect(() => buildPanelUploadContainerPayload({ ...input, dumpPath: "rel.dump" })).toThrow();
    expect(() => buildPanelUploadContainerPayload({ ...input, jobId: "op_bad" })).toThrow();
    expect(() => buildPanelUploadContainerPayload({ ...input, jobId: `${JOB_ID}-forget` })).toThrow();
    expect(() =>
      buildPanelFetchContainerPayload({
        ...BASE,
        fetchId: "f".repeat(32),
        executorUser: "990:990",
        outDir: "/d",
        dirGid: 0,
      }),
    ).toThrow();
  });

  it("drop forgets exactly one snapshot", () => {
    const spec = buildPanelDropContainerPayload({ ...BASE, jobId: JOB_ID, snapshotId: SNAPSHOT_ID });
    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_pdrop`);
    expect(spec.payload.Cmd).toEqual([...RO, "forget", SNAPSHOT_ID]);
    expect(() =>
      buildPanelDropContainerPayload({ ...BASE, jobId: JOB_ID, snapshotId: "x" }),
    ).toThrow();
  });

  it("keep applies keep-within and keep-last 3 with prune", () => {
    const spec = buildPanelKeepContainerPayload({ ...BASE, jobId: JOB_ID, retentionDays: 30 });
    expect(spec.containerName).toBe(`hp_bk_${JOB_ID}_pkeep`);
    expect(spec.payload.Cmd).toEqual([
      ...RO,
      "forget",
      "--host",
      "hosting-panel",
      "--group-by",
      "host",
      "--keep-within",
      "30d",
      "--keep-last",
      "3",
      "--prune",
    ]);
    expect(() =>
      buildPanelKeepContainerPayload({ ...BASE, jobId: JOB_ID, retentionDays: 0 }),
    ).toThrow();
  });

  it("fetch writes into the hand-over directory through one writable Mount", () => {
    const spec = buildPanelFetchContainerPayload({
      ...BASE,
      fetchId: "f".repeat(32),
      executorUser: "990:990",
      outDir: "/var/lib/hp/panel-dump",
      dirGid: 4500,
    });
    expect(spec.containerName).toBe(`hp_bk_pf_${"f".repeat(32)}_fetch`);
    expect(spec.payload.User).toBe("990:990");
    expect(spec.payload.Labels["io.hostingpanel.job_id"]).toBe(`pf_${"f".repeat(32)}`);
    expectHardened(spec.payload.HostConfig);
    expect(spec.payload.HostConfig.GroupAdd).toEqual(["4500"]);
    expect(spec.payload.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: "/var/lib/hp/panel-dump", Target: "/o", ReadOnly: false },
    ]);
    expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", PANEL_FETCH_SCRIPT]);
    expect(spec.payload.Env).toContain("HP_REGION=eu-central-1");
    expect(spec.payload.Env).toContain("HP_FLOOR=1073741824");
    expect(() =>
      buildPanelFetchContainerPayload({
        ...BASE,
        fetchId: "F".repeat(32),
        executorUser: "990:990",
        outDir: "/d",
        dirGid: 4500,
      }),
    ).toThrow();
  });

  it("fetch script selects the latest panel copy and writes through .part renames", () => {
    expect(PANEL_FETCH_SCRIPT).toBe(
      [
        "set -eu",
        "umask 077",
        'RO="-o s3.bucket-lookup=path -o s3.region=$HP_REGION"',
        "rm -f /o/restore.pgdump /o/restore.key /o/.restore.pgdump.part /o/.restore.key.part",
        "snap=$(restic $RO snapshots --json --host hosting-panel --path /backup/panel --latest 1)",
        `id=$(printf '%s' "$snap" | sed -n 's/.*"id":"\\([0-9a-f]\\{64\\}\\)".*/\\1/p' | head -n1)`,
        '[ -n "$id" ] || exit 79',
        `time=$(printf '%s' "$snap" | sed -n 's/.*"time":"\\([^"]*\\)".*/\\1/p' | head -n1)`,
        "printf 'HP_SNAP %s %s\\n' \"$id\" \"$time\"",
        'st=$(restic $RO stats --json --mode restore-size "$id")',
        `need=$(printf '%s' "$st" | sed -n 's/.*"total_size":\\([0-9]*\\).*/\\1/p')`,
        "free=$(df -Pk /o | awk 'NR==2{print $4}')",
        '[ $((free*1024)) -ge $((${need:-0}+HP_FLOOR)) ] || exit 75',
        'restic $RO dump "$id" /backup/panel/panel.dump > /o/.restore.pgdump.part',
        'restic $RO dump "$id" /backup/panel/secrets-master.key > /o/.restore.key.part',
        "mv -f /o/.restore.pgdump.part /o/restore.pgdump",
        "mv -f /o/.restore.key.part /o/restore.key",
        "sync /o",
      ].join("\n"),
    );
  });
});

// ---- Runner paths: panelStart, siteState, fetchPanelCopy, driven through a recorded fake Docker client.

interface Stage {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  onWait?: (name: string, body: unknown) => Promise<void> | void;
}

const BACKUP_KEY = "cafe1234".repeat(8);
const GOOD_SUMMARY_ID = "a1b2c3d4".repeat(8);
const PANEL_JOB = `op_${"2".repeat(32)}`;
const DUMP_BYTES = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(995, 7)]);

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanups.splice(0).reverse()) await task();
});

function logFrame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function summaryLine(totalBytes: number, fileCount = 2, snapshotId = GOOD_SUMMARY_ID): string {
  return JSON.stringify({
    message_type: "summary",
    snapshot_id: snapshotId,
    data_added: 10,
    total_bytes_processed: totalBytes,
    files_new: fileCount,
    files_changed: 0,
    files_unmodified: 0,
    total_duration: 0.5,
  });
}

const okFetch = (async () => new Response("<ListBucketResult/>", { status: 200 })) as unknown as typeof globalThis.fetch;

function fakeDocker(opts: {
  stages?: Record<string, Stage>;
  volumeStatus?: number;
  containersList?: { statusCode: number; body: unknown };
}) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const created: string[] = [];
  const payloads = new Map<string, unknown>();
  const json = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const stageOf = (name: string): Stage => {
    const key = Object.keys(opts.stages ?? {}).find((suffix) => name.endsWith(suffix));
    return key ? opts.stages![key]! : {};
  };
  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath, body });
    const url = new URL(`http://docker${reqPath}`);
    const p = url.pathname;
    if (method === "POST" && p === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      created.push(name);
      payloads.set(name, body);
      return json(201, { Id: name });
    }
    let m = /^\/containers\/([^/]+)\/(start|wait|logs)$/.exec(p);
    if (m) {
      const name = decodeURIComponent(m[1]!);
      const stage = stageOf(name);
      if (m[2] === "start") return { statusCode: 204, body: Buffer.alloc(0) };
      if (m[2] === "wait") {
        await stage.onWait?.(name, payloads.get(name));
        return json(200, { StatusCode: stage.exitCode ?? 0 });
      }
      const frames: Buffer[] = [];
      if (url.searchParams.get("stdout") === "1" && stage.stdout) frames.push(logFrame(1, stage.stdout));
      if (url.searchParams.get("stderr") === "1" && stage.stderr) frames.push(logFrame(2, stage.stderr));
      return { statusCode: 200, body: Buffer.concat(frames) };
    }
    m = /^\/containers\/([^/]+)$/.exec(p);
    if (method === "DELETE" && m) return { statusCode: 204, body: Buffer.alloc(0) };
    if (method === "GET" && p === "/containers/json") {
      const cfg = opts.containersList ?? { statusCode: 200, body: [] };
      return json(cfg.statusCode, cfg.body);
    }
    if (method === "GET" && /^\/volumes\/[^/]+$/.test(p)) {
      return json(opts.volumeStatus ?? 200, {});
    }
    throw new Error(`Unexpected Docker API call: ${method} ${reqPath}`);
  };

  /** CP-01: only the job's own containers are touched; no volume is created or removed. */
  const assertCp01 = (): void => {
    for (const call of requests) {
      expect(call.path).not.toMatch(/\/(stop|restart|kill|pause|unpause|exec)(?:\?|$)/);
      if (call.method === "DELETE" || /^\/containers\/[^/]+\/(start|wait)/.test(call.path)) {
        if (call.path.startsWith("/containers/")) {
          const ref = decodeURIComponent(call.path.slice("/containers/".length).split(/[/?]/)[0]!);
          expect(created).toContain(ref);
        }
      }
      expect(call.path.startsWith("/volumes/create")).toBe(false);
      expect(call.method === "DELETE" && call.path.startsWith("/volumes/")).toBe(false);
    }
  };
  return { request, requests, created, payloads, assertCp01 };
}

async function setupPanel(opts: Parameters<typeof fakeDocker>[0] & {
  dump?: Buffer | "missing" | "symlink";
  keyFile?: string | null;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-panel-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const secretsRootDir = path.join(root, "secrets");
  const panelDumpDir = path.join(root, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o2770 });
  const dumpPath = path.join(panelDumpDir, `${PANEL_JOB}.dump`);
  if (opts.dump === "symlink") {
    await writeFile(path.join(root, "real.dump"), DUMP_BYTES);
    await symlink(path.join(root, "real.dump"), dumpPath);
  } else if (opts.dump !== "missing") {
    await writeFile(dumpPath, opts.dump ?? DUMP_BYTES, { mode: 0o640 });
  }
  const backupKeyFile = path.join(root, "backup.key");
  if (opts.keyFile !== null) await writeFile(backupKeyFile, opts.keyFile ?? `${BACKUP_KEY}\n`);
  const docker = fakeDocker(opts);
  const lines: string[] = [];
  for (const level of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  const deps: BackupRunnerDeps = {
    request: docker.request,
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
    fetch: okFetch,
  };
  const runner = new BackupRunner(deps);
  /** R113: the master key appears in no log line, request, status or payload. */
  const assertNoLeaks = (...extra: unknown[]): void => {
    const text = JSON.stringify([lines, docker.requests, extra]);
    for (const secret of [MASTER_KEY_SENTINEL, ACCESS_KEY_SENTINEL, SECRET_KEY_SENTINEL, BACKUP_KEY]) {
      expect(text).not.toContain(secret);
    }
  };
  return { root, runner, docker, lines, secretsRootDir, panelDumpDir, dumpPath, assertNoLeaks };
}

const panelReq = (jobId = PANEL_JOB, retentionDays = 7) =>
  ({
    action: "panelStart",
    jobId,
    target: TARGET,
    masterKey: MASTER_KEY_SENTINEL,
    retentionDays,
  }) as const;

async function settled(runner: BackupRunner, jobId = PANEL_JOB) {
  for (let i = 0; i < 400; i += 1) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not settle");
}

describe("BackupRunner panelStart", () => {
  const size = DUMP_BYTES.length;

  it("uploads the dump and key, applies keep, and leaves no secrets behind", async () => {
    let seenKey = "";
    const ctx = await setupPanel({
      stages: {
        _pup: {
          stdout: summaryLine(size + 64),
          onWait: async () => {
            seenKey = await readFile(
              path.join(ctx.secretsRootDir, `job_bk_mk_${PANEL_JOB}`, "SECRETS_MASTER_KEY"),
              "utf8",
            );
          },
        },
      },
    });
    const first = await ctx.runner.run(panelReq());
    expect(first.state).toBe("running");
    const status = await settled(ctx.runner);
    expect(status).toMatchObject({ state: "succeeded", failure: null });
    expect(status.snapshot?.snapshotId).toBe(GOOD_SUMMARY_ID);
    expect(seenKey).toBe(MASTER_KEY_SENTINEL);
    expect(ctx.docker.created).toEqual([
      `hp_bk_${PANEL_JOB}_prepo`,
      `hp_bk_${PANEL_JOB}_pup`,
      `hp_bk_${PANEL_JOB}_pkeep`,
    ]);
    const up = ctx.docker.payloads.get(`hp_bk_${PANEL_JOB}_pup`) as {
      HostConfig: { GroupAdd: string[]; Mounts: Array<{ Source: string }> };
    };
    expect(up.HostConfig.GroupAdd).toEqual([String((await stat(ctx.panelDumpDir)).gid)]);
    expect(up.HostConfig.Mounts.map((m) => m.Source)).toEqual([
      ctx.dumpPath,
      path.join(ctx.secretsRootDir, `job_bk_mk_${PANEL_JOB}`, "SECRETS_MASTER_KEY"),
    ]);
    expect(await readdir(ctx.secretsRootDir)).toEqual([]);
    const deleted = ctx.docker.requests.filter((r) => r.method === "DELETE").map((r) => r.path);
    expect(deleted).toHaveLength(3);
    ctx.docker.assertCp01();
    ctx.assertNoLeaks(status);
  });

  it("ends succeeded and logs panel_keep_failed when the keep step fails", async () => {
    const ctx = await setupPanel({
      stages: { _pup: { stdout: summaryLine(size + 64) }, _pkeep: { exitCode: 1, stderr: "boom" } },
    });
    await ctx.runner.run(panelReq());
    expect((await settled(ctx.runner)).state).toBe("succeeded");
    const events = ctx.lines.map((l) => (JSON.parse(l) as { event?: string }).event);
    expect(events).toContain("panel_keep_failed");
    ctx.docker.assertCp01();
    ctx.assertNoLeaks();
  });

  it.each([
    ["missing", "missing" as const],
    ["symlink", "symlink" as const],
    ["bad magic", Buffer.from("PGDMX-not-a-dump")],
    ["too short", Buffer.from("PGDM")],
  ])("fails panel_dump_missing without any container when the dump is %s", async (_label, dump) => {
    const ctx = await setupPanel({ dump });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ state: "failed", failure: "panel_dump_missing" });
    expect(ctx.docker.created).toEqual([]);
    ctx.assertNoLeaks();
  });

  it("drops the snapshot when the dump changed during the upload", async () => {
    const ctx = await setupPanel({
      stages: {
        _pup: {
          stdout: summaryLine(size + 64),
          onWait: async () => {
            await writeFile(ctx.dumpPath, Buffer.concat([DUMP_BYTES, Buffer.from("more")]));
          },
        },
      },
    });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ state: "failed", failure: "panel_dump_missing" });
    expect(ctx.docker.created).toEqual([`hp_bk_${PANEL_JOB}_prepo`, `hp_bk_${PANEL_JOB}_pup`, `hp_bk_${PANEL_JOB}_pdrop`]);
    expect(
      (ctx.docker.payloads.get(`hp_bk_${PANEL_JOB}_pdrop`) as { Cmd: string[] }).Cmd.at(-1),
    ).toBe(GOOD_SUMMARY_ID);
    ctx.docker.assertCp01();
    ctx.assertNoLeaks();
  });

  it.each([
    ["one file stored", summaryLine(size + 64, 1)],
    ["wrong byte total", summaryLine(size)],
  ])("drops the snapshot when the summary shows %s", async (_label, stdout) => {
    const ctx = await setupPanel({ stages: { _pup: { stdout } } });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ failure: "panel_dump_missing" });
    expect(ctx.docker.created.at(-1)).toBe(`hp_bk_${PANEL_JOB}_pdrop`);
  });

  it("restic exit 3 drops the partial snapshot and fails panel_dump_missing", async () => {
    const ctx = await setupPanel({ stages: { _pup: { exitCode: 3, stdout: summaryLine(64, 1) } } });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ failure: "panel_dump_missing" });
    expect(ctx.docker.created.at(-1)).toBe(`hp_bk_${PANEL_JOB}_pdrop`);
    ctx.docker.assertCp01();
  });

  it("restic exit 12 is wrong_key, with no drop and no keep", async () => {
    const ctx = await setupPanel({ stages: { _pup: { exitCode: 12 } } });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ failure: "wrong_key" });
    expect(ctx.docker.created).toEqual([`hp_bk_${PANEL_JOB}_prepo`, `hp_bk_${PANEL_JOB}_pup`]);
    expect(await readdir(ctx.secretsRootDir)).toEqual([]);
    ctx.assertNoLeaks();
  });

  it("fails key_file_missing without a backup key", async () => {
    const ctx = await setupPanel({ keyFile: null });
    await ctx.runner.run(panelReq());
    expect(await settled(ctx.runner)).toMatchObject({ failure: "key_file_missing" });
    expect(ctx.docker.created).toEqual([]);
  });

  it("locks the panel lane: a second id is refused, the same id returns its status", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = await setupPanel({
      stages: { _pup: { stdout: summaryLine(size + 64), onWait: () => held } },
    });
    await ctx.runner.run(panelReq());
    await expect(ctx.runner.run(panelReq(`op_${"3".repeat(32)}`))).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
    expect(await ctx.runner.run(panelReq())).toMatchObject({ jobId: PANEL_JOB, state: "running" });
    release();
    expect((await settled(ctx.runner)).state).toBe("succeeded");
    ctx.assertNoLeaks();
  });
});

describe("BackupRunner siteState", () => {
  const siteLabels = {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.site_id": "site1",
    "io.hostingpanel.service_instance_id": "svc_site1",
  };
  it.each([
    [200, [{ Labels: siteLabels }], { filesVolume: true, container: true }],
    [404, [{ Labels: siteLabels }], { filesVolume: false, container: true }],
    [200, [{ Labels: { ...siteLabels, "io.hostingpanel.role": "site_job" } }], { filesVolume: true, container: false }],
    [404, [], { filesVolume: false, container: false }],
  ])("volume %i with containers %j", async (volumeStatus, list, expected) => {
    const ctx = await setupPanel({ volumeStatus, containersList: { statusCode: 200, body: list } });
    expect(
      await ctx.runner.run({ action: "siteState", siteId: "site1", serviceInstanceId: "svc_site1" }),
    ).toEqual(expected);
    expect(ctx.docker.requests.every((r) => r.method === "GET")).toBe(true);
    const listCall = ctx.docker.requests.find((r) => r.path.startsWith("/containers/json"))!;
    const url = new URL(`http://docker${listCall.path}`);
    expect(url.searchParams.get("all")).toBe("true");
    expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
      label: [
        "io.hostingpanel.managed=true",
        "io.hostingpanel.site_id=site1",
        "io.hostingpanel.service_instance_id=svc_site1",
      ],
    });
    expect(ctx.docker.requests[0]!.path).toBe("/volumes/hp_vol_svc_site1_html");
  });

  it.each([
    [500, 200],
    [200, 500],
  ])("an engine error (volume %i, list %i) is an error, not false", async (volumeStatus, listStatus) => {
    const ctx = await setupPanel({ volumeStatus, containersList: { statusCode: listStatus, body: [] } });
    await expect(
      ctx.runner.run({ action: "siteState", siteId: "site1", serviceInstanceId: "svc_site1" }),
    ).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });
});

describe("BackupRunner fetchPanelCopy", () => {
  const SNAP_TIME = "2026-11-15T10:00:00.123456789+01:00";
  const writeCopy = (dir: string, dump: Buffer | string, key: string) => async () => {
    await writeFile(path.join(dir, "restore.pgdump"), dump);
    await writeFile(path.join(dir, "restore.key"), key);
  };

  it("returns the snapshot and keeps both files when the copy is valid", async () => {
    const ctx = await setupPanel({});
    const ctx2 = await setupPanel({
      stages: {
        _fetch: {
          stdout: `HP_SNAP ${GOOD_SUMMARY_ID} ${SNAP_TIME}\n`,
          onWait: writeCopy(ctx.panelDumpDir, DUMP_BYTES, MASTER_KEY_SENTINEL),
        },
      },
    });
    const result = await ctx2.runner.fetchPanelCopy(TARGET, ctx.panelDumpDir);
    expect(result).toEqual({ ok: true, snapshotId: GOOD_SUMMARY_ID, time: "2026-11-15T09:00:00.123Z" });
    expect(await readFile(path.join(ctx.panelDumpDir, "restore.key"), "utf8")).toBe(MASTER_KEY_SENTINEL);
    expect(ctx2.docker.created).toHaveLength(1);
    expect(ctx2.docker.created[0]).toMatch(/^hp_bk_pf_[0-9a-f]{32}_fetch$/);
    const payload = ctx2.docker.payloads.get(ctx2.docker.created[0]!) as {
      User: string;
      HostConfig: { GroupAdd: string[]; Mounts: Array<{ Source: string; Target: string }> };
    };
    expect(payload.User).toBe("990:990");
    expect(payload.HostConfig.GroupAdd).toEqual([String((await stat(ctx.panelDumpDir)).gid)]);
    expect(payload.HostConfig.Mounts).toEqual([
      { Type: "bind", Source: ctx.panelDumpDir, Target: "/o", ReadOnly: false },
    ]);
    expect(await readdir(ctx2.secretsRootDir).catch(() => [])).toEqual([]);
    ctx2.docker.assertCp01();
    // The key is on disk by design; only logs and requests must not carry it.
    ctx2.assertNoLeaks(result);
  });

  it.each([
    ["bad magic", Buffer.from("NOTADUMP"), MASTER_KEY_SENTINEL],
    ["key with newline", DUMP_BYTES, `${MASTER_KEY_SENTINEL}\n`],
    ["uppercase key", DUMP_BYTES, MASTER_KEY_SENTINEL.toUpperCase()],
  ])("deletes both files and fails other on %s", async (_label, dump, key) => {
    const dirCtx = await setupPanel({});
    const ctx = await setupPanel({
      stages: { _fetch: { stdout: `HP_SNAP ${GOOD_SUMMARY_ID} ${SNAP_TIME}\n`, onWait: writeCopy(dirCtx.panelDumpDir, dump, key) } },
    });
    expect(await ctx.runner.fetchPanelCopy(TARGET, dirCtx.panelDumpDir)).toEqual({ ok: false, problem: "other" });
    const left = await readdir(dirCtx.panelDumpDir);
    expect(left.filter((n) => n.includes("restore"))).toEqual([]);
    ctx.assertNoLeaks();
  });

  it.each([
    [79, "no_copy"],
    [10, "no_copy"],
    [75, "no_space"],
    [12, "wrong_key"],
    [124, "timeout"],
  ])("maps exit %i to %s and removes partial files", async (exitCode, problem) => {
    const dirCtx = await setupPanel({});
    const ctx = await setupPanel({
      stages: {
        _fetch: {
          exitCode,
          onWait: async () => {
            await writeFile(path.join(dirCtx.panelDumpDir, ".restore.pgdump.part"), "PGDMP");
            await writeFile(path.join(dirCtx.panelDumpDir, ".restore.key.part"), "x");
          },
        },
      },
    });
    expect(await ctx.runner.fetchPanelCopy(TARGET, dirCtx.panelDumpDir)).toEqual({ ok: false, problem });
    expect((await readdir(dirCtx.panelDumpDir)).filter((n) => n.includes("restore"))).toEqual([]);
    expect(await readdir(ctx.secretsRootDir).catch(() => [])).toEqual([]);
  });

  it("refuses a missing directory and fails key_file_missing without a key, before any container", async () => {
    const ctx = await setupPanel({});
    expect(await ctx.runner.fetchPanelCopy(TARGET, path.join(ctx.root, "nope"))).toEqual({
      ok: false,
      problem: "refused",
    });
    const noKey = await setupPanel({ keyFile: null });
    expect(await noKey.runner.fetchPanelCopy(TARGET, noKey.panelDumpDir)).toEqual({
      ok: false,
      problem: "key_file_missing",
    });
    expect([...ctx.docker.created, ...noKey.docker.created]).toEqual([]);
  });
});

describe("index exports", () => {
  it("re-exports the panel names and the dump directory default", async () => {
    const index = await import("../src/index.js");
    expect(index.DEFAULT_PANEL_DUMP_DIR).toBe("/var/lib/hosting-panel/panel-dump");
    expect(index.PANEL_LANE).toBe("panel:db");
    expect(index.PANEL_FETCH_SCRIPT).toBe(PANEL_FETCH_SCRIPT);
    for (const name of [
      "buildPanelJobLabels",
      "buildPanelRepoContainerPayload",
      "buildPanelUploadContainerPayload",
      "buildPanelDropContainerPayload",
      "buildPanelKeepContainerPayload",
      "buildPanelFetchContainerPayload",
      "buildRestoreOwnContainerPayload",
    ] as const) {
      expect(typeof index[name]).toBe("function");
    }
  });
});

describe("panel-jobs local repository builders", () => {
  const HOST_DIR = `/var/lib/hosting-panel/local-repos/bkt_${"cd".repeat(16)}/panel`;
  const CONTAINER_DIR = "/backup/repository/panel";
  const LOCAL_SECRETS = { secretBinds: [RESTIC_SECRETS.secretBinds[1]!], secretFileEnv: [RESTIC_SECRETS.secretFileEnv[1]!] };
  const repo = resolveBackupRepository(
    { kind: "local", targetId: `bkt_${"cd".repeat(16)}` },
    { kind: "panel" },
    {
      backupNetworkName: "hp_backup_net",
      local: { hostDir: HOST_DIR, containerPath: CONTAINER_DIR, executorGid: 990, availableBytes: 1, totalBytes: 2 },
    },
  );
  const LOCAL = { repo, executorUser: "990:990", ...LOCAL_SECRETS };
  const REPO_MOUNT = { Type: "bind", Source: HOST_DIR, Target: CONTAINER_DIR, ReadOnly: false };

  function expectLocal(payload: { Env: readonly string[]; HostConfig: Record<string, unknown> }): void {
    expectHardened(payload.HostConfig);
    expect(payload.Env).toContain(`RESTIC_REPOSITORY=${CONTAINER_DIR}`);
    expect(payload.HostConfig.NetworkMode).toBe("none");
    expect(payload.Env.some((e) => e.startsWith("HP_REGION=") || e.startsWith("AWS_"))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("s3.");
    expect(JSON.stringify(payload)).not.toContain("AWS_SHARED");
  }

  it("repo step runs the local init script as the executor user", () => {
    const spec = buildPanelRepoContainerPayload({ ...LOCAL, jobId: JOB_ID });
    expect(spec.payload.User).toBe("990:990");
    expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_LOCAL_JOB_SCRIPT]);
    expect(spec.payload.Env).toContain("HP_INIT=1");
    expect(spec.payload.HostConfig.Mounts).toEqual([REPO_MOUNT]);
    expect(spec.payload.HostConfig.GroupAdd).toEqual(["990"]);
    expect(spec.payload.HostConfig.Binds).toEqual(LOCAL_SECRETS.secretBinds);
    expectLocal(spec.payload);
  });

  it("upload keeps its two read-only Mounts next to the repo Mount and merges the groups", () => {
    const spec = buildPanelUploadContainerPayload({
      ...LOCAL,
      jobId: JOB_ID,
      dumpPath: `/var/lib/hp/panel-dump/${JOB_ID}.dump`,
      masterKeyPath: `/run/hp/secrets/job_bk_mk_${JOB_ID}/SECRETS_MASTER_KEY`,
      dirGid: 4500,
    });
    expect(spec.payload.User).toBe("990:990");
    expect(spec.payload.HostConfig.GroupAdd).toEqual(["4500", "990"]);
    expect(spec.payload.HostConfig.Mounts).toEqual([
      REPO_MOUNT,
      { Type: "bind", Source: `/var/lib/hp/panel-dump/${JOB_ID}.dump`, Target: PANEL_REPO_DUMP_PATH, ReadOnly: true },
      {
        Type: "bind",
        Source: `/run/hp/secrets/job_bk_mk_${JOB_ID}/SECRETS_MASTER_KEY`,
        Target: PANEL_REPO_KEY_PATH,
        ReadOnly: true,
      },
    ]);
    expect(spec.payload.Cmd).toEqual(["backup", "-q", "--json", "--host", "hosting-panel", "--tag", JOB_ID, "/backup/panel"]);
    expectLocal(spec.payload);
  });

  it("drop and keep run as the executor user with no option tokens", () => {
    const drop = buildPanelDropContainerPayload({ ...LOCAL, jobId: JOB_ID, snapshotId: SNAPSHOT_ID });
    expect(drop.payload.User).toBe("990:990");
    expect(drop.payload.Cmd).toEqual(["forget", SNAPSHOT_ID]);
    expect(drop.payload.HostConfig.Mounts).toEqual([REPO_MOUNT]);
    expectLocal(drop.payload);
    const keep = buildPanelKeepContainerPayload({ ...LOCAL, jobId: JOB_ID, retentionDays: 30 });
    expect(keep.payload.User).toBe("990:990");
    expect(keep.payload.Cmd?.slice(0, 2)).toEqual(["forget", "--host"]);
    expect(keep.payload.Cmd).toContain("--prune");
    expectLocal(keep.payload);
  });

  it("fetch from a resolved local repo uses the localized script and keeps its /o Mount", () => {
    const spec = buildPanelFetchContainerPayload({
      ...LOCAL,
      fetchId: "f".repeat(32),
      outDir: "/var/lib/hp/panel-dump",
      dirGid: 4500,
    });
    expect(spec.payload.User).toBe("990:990");
    expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", localizeResticScript(PANEL_FETCH_SCRIPT)]);
    expect(spec.payload.HostConfig.Mounts).toEqual([
      REPO_MOUNT,
      { Type: "bind", Source: "/var/lib/hp/panel-dump", Target: "/o", ReadOnly: false },
    ]);
    expect(spec.payload.HostConfig.GroupAdd).toEqual(["4500", "990"]);
    expectLocal(spec.payload);
  });

  it("a local step without an executor user is refused", () => {
    expect(() => buildPanelRepoContainerPayload({ repo, ...LOCAL_SECRETS, jobId: JOB_ID })).toThrow();
    expect(() => buildPanelRepoContainerPayload({ ...LOCAL, executorUser: "root", jobId: JOB_ID })).toThrow();
  });

  it("an S3 repo resolved up front equals the legacy target input", () => {
    const s3 = resolveBackupRepository(TARGET, { kind: "panel" }, { backupNetworkName: "hp_backup_net" });
    expect(buildPanelKeepContainerPayload({ repo: s3, ...RESTIC_SECRETS, jobId: JOB_ID, retentionDays: 30 })).toEqual(
      buildPanelKeepContainerPayload({ ...BASE, jobId: JOB_ID, retentionDays: 30 }),
    );
    expect(buildPanelRepoContainerPayload({ repo: s3, ...RESTIC_SECRETS, jobId: JOB_ID })).toEqual(
      buildPanelRepoContainerPayload({ ...BASE, jobId: JOB_ID }),
    );
  });

  describe("PANEL_FETCH_LOCAL_SCRIPT and the disaster-recovery fetch", () => {
    it("is the localized fetch script with --no-lock and umask 007, and no s3", () => {
      expect(PANEL_FETCH_LOCAL_SCRIPT).toContain("umask 007");
      expect(PANEL_FETCH_LOCAL_SCRIPT).not.toContain("umask 077");
      expect(PANEL_FETCH_LOCAL_SCRIPT).toContain('RO="--no-lock"');
      expect(PANEL_FETCH_LOCAL_SCRIPT).not.toContain("s3.");
      expect(PANEL_FETCH_LOCAL_SCRIPT).not.toContain("HP_REGION");
      expect(PANEL_FETCH_LOCAL_SCRIPT).toContain("restic $RO snapshots --json --host hosting-panel");
      expect(PANEL_FETCH_LOCAL_SCRIPT).toContain('restic $RO dump "$id" /backup/panel/secrets-master.key');
    });

    it("mounts the repo read-only with no network, as the repo directory owner", () => {
      const spec = buildPanelFetchLocalContainerPayload({
        fetchId: "e".repeat(32),
        repoDir: "/mnt/old-disk/local-repos/bkt_x/panel",
        user: "1500:1500",
        outDir: "/var/lib/hp/panel-dump",
        groupAdd: [4500],
        ...LOCAL_SECRETS,
      });
      expect(spec.containerName).toBe(`hp_bk_pf_${"e".repeat(32)}_fetch`);
      expect(spec.payload.User).toBe("1500:1500");
      expect(spec.payload.Image).toBe(RESTIC_IMAGE);
      expect(spec.payload.Entrypoint).toEqual(["/bin/sh", "-c", PANEL_FETCH_LOCAL_SCRIPT]);
      expect(spec.payload.HostConfig.Mounts).toEqual([
        { Type: "bind", Source: "/mnt/old-disk/local-repos/bkt_x/panel", Target: CONTAINER_DIR, ReadOnly: true },
        { Type: "bind", Source: "/var/lib/hp/panel-dump", Target: "/o", ReadOnly: false },
      ]);
      expect(spec.payload.HostConfig.GroupAdd).toEqual(["4500"]);
      expect(spec.payload.HostConfig.Binds).toEqual(LOCAL_SECRETS.secretBinds);
      expect(spec.payload.Env).toContain(`RESTIC_REPOSITORY=${CONTAINER_DIR}`);
      expect(spec.payload.Env).toContain("HP_FLOOR=1073741824");
      expect(spec.payload.Labels["io.hostingpanel.job_id"]).toBe(`pf_${"e".repeat(32)}`);
      expectLocal(spec.payload);
    });

    it("refuses a bad fetch id, user, relative paths, root group and a docker.sock secret", () => {
      const ok = {
        fetchId: "e".repeat(32),
        repoDir: "/mnt/r/panel",
        user: "1500:1500",
        outDir: "/o-dir",
        groupAdd: [4500],
        ...LOCAL_SECRETS,
      };
      expect(() => buildPanelFetchLocalContainerPayload({ ...ok, fetchId: "E".repeat(32) })).toThrow();
      expect(() => buildPanelFetchLocalContainerPayload({ ...ok, user: "root" })).toThrow();
      expect(() => buildPanelFetchLocalContainerPayload({ ...ok, repoDir: "rel/panel" })).toThrow();
      expect(() => buildPanelFetchLocalContainerPayload({ ...ok, outDir: "rel" })).toThrow();
      expect(() => buildPanelFetchLocalContainerPayload({ ...ok, groupAdd: [0] })).toThrow();
      expect(() =>
        buildPanelFetchLocalContainerPayload({ ...ok, secretBinds: ["/var/run/docker.sock:/s:ro"] }),
      ).toThrow();
    });
  });
});
