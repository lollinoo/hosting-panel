import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESTIC_IMAGE, type BackupDispatchTarget, type BackupTarget } from "@hosting-panel/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  APP_STACK_BACKUP_COPY_CAPABILITIES,
  APP_STACK_BACKUP_OF_LABEL,
  APP_STACK_JOB_USER,
  APP_STACK_RESTORE_CAPABILITIES,
  appStackBackupDataPath,
  buildAppStackBackupCopyContainerPayload,
  buildAppStackForgetContainerPayload,
  buildAppStackJobLabels,
  buildAppStackPartialSnapshotDropContainerPayload,
  buildAppStackRepoContainerPayload,
  buildAppStackRestoreContainerPayload,
} from "../src/app-stack-backup-jobs.js";
import {
  BACKUP_HOSTNAME,
  BACKUP_REPO_JOB_SCRIPT,
  BACKUP_REPO_LOCAL_JOB_SCRIPT,
  backupRepoSegments,
  buildResticRepositoryUrl,
  resolveBackupRepository,
  type BackupContainerSpec,
  type GuardedLocalRepo,
} from "../src/backup-jobs.js";
import {
  guardLocalTarget,
  LOCAL_TARGET_MARKER_NAME,
  localTargetMarkerContent,
  type LocalStatfs,
  type LocalTargetGuardDeps,
} from "../src/local-target-guard.js";

const S3: BackupTarget = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod/cluster1",
  accessKeyId: "AKIASENTINEL999",
  secretAccessKey: "sentinel-s3-secret-999",
};
const TARGET_ID = `bkt_${"a".repeat(32)}`;
const LOCAL: BackupDispatchTarget = { kind: "local", targetId: TARGET_ID };
const STACK = "stk_0123456789abcdef01234567";
const OTHER_STACK = "stk_fedcba9876543210fedcba98";
const JOB = `op_${"d".repeat(32)}`;
const RESTORE_JOB = `${JOB}-apply`;
const FORGET_JOB = `${JOB}-forget`;
const SNAPSHOT = "ab".repeat(32);
const NET = "hp_backup_net";
const SECRET_BINDS = ["/run/secrets/job/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro"];
const SECRET_FILE_ENV = ["RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD"];

const guarded = (stackId: string): GuardedLocalRepo => ({
  hostDir: `/var/lib/hosting-panel/local-repos/${TARGET_ID}/stacks/${stackId}`,
  containerPath: `/backup/repository/stacks/${stackId}`,
  executorGid: 987,
  availableBytes: 5_000_000_000,
  totalBytes: 9_000_000_000,
});
const localRepo = (stackId = STACK, readOnly = false) =>
  resolveBackupRepository(LOCAL, { kind: "stack", stackId }, { backupNetworkName: NET, local: guarded(stackId), readOnly });
const s3Repo = (stackId = STACK) => resolveBackupRepository(S3, { kind: "stack", stackId }, { backupNetworkName: NET });
const base = (repo = localRepo(), jobId = JOB) => ({
  jobId,
  stackId: STACK,
  repo,
  secretBinds: SECRET_BINDS,
  secretFileEnv: SECRET_FILE_ENV,
});
const coded = (code: string) => expect.objectContaining({ code });

describe("the repository of an application (ADR-0038 K3)", () => {
  it("lives under stacks/<stackId>, next to the unchanged site and panel locations", () => {
    expect(backupRepoSegments({ kind: "panel" })).toEqual(["panel"]);
    expect(backupRepoSegments({ kind: "site", siteId: "site_1" })).toEqual(["sites", "site_1"]);
    expect(backupRepoSegments({ kind: "stack", stackId: STACK })).toEqual(["stacks", STACK]);

    expect(buildResticRepositoryUrl(S3, { kind: "stack", stackId: STACK })).toBe(
      `s3:https://s3.example.com:9000/panel-backups/prod/cluster1/stacks/${STACK}`,
    );
    expect(buildResticRepositoryUrl({ ...S3, prefix: "" }, { kind: "stack", stackId: STACK })).toBe(
      `s3:https://s3.example.com:9000/panel-backups/stacks/${STACK}`,
    );
    expect(buildResticRepositoryUrl(S3, { kind: "site", siteId: "site_1" })).toBe(
      "s3:https://s3.example.com:9000/panel-backups/prod/cluster1/sites/site_1",
    );
    expect(buildResticRepositoryUrl(S3, { kind: "panel" })).toBe(
      "s3:https://s3.example.com:9000/panel-backups/prod/cluster1/panel",
    );
  });

  it.each(["", "../etc", "stk-1", "Stk_1", "stk_1/x", "stk 1", `s${"a".repeat(64)}`, "1stk"])(
    "refuses the malformed application id %j before it becomes part of a location",
    (stackId) => {
      expect(() => backupRepoSegments({ kind: "stack", stackId })).toThrow(coded("VALIDATION_ERROR"));
      expect(() => buildResticRepositoryUrl(S3, { kind: "stack", stackId })).toThrow(coded("VALIDATION_ERROR"));
    },
  );

  it("resolves an S3 repository on the backup network and a local one with no network", () => {
    expect(s3Repo()).toEqual({
      kind: "s3",
      repository: `s3:https://s3.example.com:9000/panel-backups/prod/cluster1/stacks/${STACK}`,
      resticOptions: ["-o", "s3.bucket-lookup=path", "-o", "s3.region=eu-central-1"],
      env: ["HP_REGION=eu-central-1"],
      mounts: [],
      groupAdd: [],
      networkMode: NET,
    });
    expect(localRepo()).toEqual({
      kind: "local",
      repository: `/backup/repository/stacks/${STACK}`,
      resticOptions: [],
      env: [],
      mounts: [
        {
          Type: "bind",
          Source: `/var/lib/hosting-panel/local-repos/${TARGET_ID}/stacks/${STACK}`,
          Target: `/backup/repository/stacks/${STACK}`,
          ReadOnly: false,
        },
      ],
      groupAdd: ["987"],
      networkMode: "none",
    });
    expect(localRepo(STACK, true).mounts).toEqual([expect.objectContaining({ ReadOnly: true })]);
  });

  it("refuses a local directory guarded for another repository", () => {
    for (const local of [
      guarded(OTHER_STACK),
      { ...guarded(STACK), containerPath: "/backup/repository/sites/site_1" },
      { ...guarded(STACK), containerPath: "/backup/repository/panel" },
    ]) {
      expect(() =>
        resolveBackupRepository(LOCAL, { kind: "stack", stackId: STACK }, { backupNetworkName: NET, local }),
      ).toThrow(coded("VALIDATION_ERROR"));
    }
  });
});

describe("the local folder of an application's repository", () => {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const GIB = 1_073_741_824n;
  let tmp: string;
  let root: string;
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
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "hp-stack-guard-"));
    root = path.join(tmp, "root");
    await mkdir(root, { mode: 0o770 });
    await chmod(root, 0o2770);
    const target = path.join(root, TARGET_ID);
    await mkdir(target, { mode: 0o770 });
    await chmod(target, 0o2770);
    await writeFile(path.join(target, LOCAL_TARGET_MARKER_NAME), localTargetMarkerContent(TARGET_ID), { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });
  const statfs = async (): Promise<LocalStatfs> => ({ bsize: 1n, blocks: 200n * GIB, bavail: 100n * GIB, files: 1000n, ffree: 900n });
  const deps = (): LocalTargetGuardDeps => ({ root, executorUid: uid, executorGid: gid, statfs });
  const guard = (intent: "backup" | "forget" | "restore", stackId = STACK) =>
    guardLocalTarget(deps(), { targetId: TARGET_ID, scope: { kind: "stack", stackId }, intent, requiredExtraBytes: 0 });

  it("is created by a copy as <root>/<targetId>/stacks/<stackId>, closed to everyone but the executor's group", async () => {
    const result = await guard("backup");
    const hostDir = path.join(root, TARGET_ID, "stacks", STACK);
    expect(result).toMatchObject({
      ok: true,
      repo: { hostDir, containerPath: `/backup/repository/stacks/${STACK}`, executorGid: gid },
    });
    expect(((await stat(hostDir)).mode & 0o7777).toString(8)).toBe("2770");
    expect(((await stat(path.dirname(hostDir))).mode & 0o7777).toString(8)).toBe("2770");
    // Nothing but the marker and the application's own branch: no site or panel folder appears.
    expect((await readdir(path.join(root, TARGET_ID))).sort()).toEqual([LOCAL_TARGET_MARKER_NAME, "stacks"]);
    expect(await readdir(path.join(root, TARGET_ID, "stacks"))).toEqual([STACK]);
  });

  it("is never created by a restore: a missing folder is a refusal", async () => {
    await expect(guard("restore")).resolves.toEqual({ ok: false, problem: "other" });
    expect(await readdir(path.join(root, TARGET_ID))).toEqual([LOCAL_TARGET_MARKER_NAME]);

    await guard("backup");
    await expect(guard("restore")).resolves.toMatchObject({ ok: true });
    // Another application's folder is not this one's.
    await expect(guard("restore", OTHER_STACK)).resolves.toEqual({ ok: false, problem: "other" });
  });

  it("refuses a malformed application id before it touches the disk", async () => {
    await expect(guard("backup", "../../outside")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(guard("backup", "stk/../x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readdir(path.join(root, TARGET_ID))).toEqual([LOCAL_TARGET_MARKER_NAME]);
    expect(await readdir(tmp)).toEqual(["root"]);
  });
});

describe("job containers of application backups (ADR-0038 K4)", () => {
  const everyJob = (repo = localRepo()): Record<string, BackupContainerSpec> => ({
    repo: buildAppStackRepoContainerPayload({ ...base(repo), init: true }),
    copy: buildAppStackBackupCopyContainerPayload({ ...base(repo), volumeKeys: ["data", "db"] }),
    drop: buildAppStackPartialSnapshotDropContainerPayload({ ...base(repo), snapshotId: SNAPSHOT }),
    restore: buildAppStackRestoreContainerPayload({ ...base(repo, RESTORE_JOB), volumeKey: "data", snapshotId: SNAPSHOT }),
    forget: buildAppStackForgetContainerPayload({ ...base(repo, FORGET_JOB), snapshotIds: [SNAPSHOT] }),
  });
  const capAdd = (spec: BackupContainerSpec): unknown =>
    (spec.payload.HostConfig as unknown as { CapAdd?: unknown }).CapAdd;

  it("run as 0:0 with every capability dropped and only the listed ones added back", () => {
    expect(APP_STACK_JOB_USER).toBe("0:0");
    expect(APP_STACK_BACKUP_COPY_CAPABILITIES).toEqual(["DAC_READ_SEARCH"]);
    expect(APP_STACK_RESTORE_CAPABILITIES).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"]);
    for (const repo of [localRepo(), s3Repo()]) {
      const jobs = everyJob(repo);
      for (const spec of Object.values(jobs)) {
        expect(spec.payload.User).toBe("0:0");
        expect(spec.payload.HostConfig.CapDrop).toEqual(["ALL"]);
      }
      expect(capAdd(jobs.repo!)).toBeUndefined();
      expect(capAdd(jobs.drop!)).toBeUndefined();
      expect(capAdd(jobs.forget!)).toBeUndefined();
      expect(capAdd(jobs.copy!)).toEqual(["DAC_READ_SEARCH"]);
      expect(capAdd(jobs.restore!)).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"]);
    }
  });

  it("keep the hardening of the site jobs", () => {
    for (const repo of [localRepo(), s3Repo()]) {
      for (const spec of Object.values(everyJob(repo))) {
        const { payload } = spec;
        expect(payload.Image).toBe(RESTIC_IMAGE);
        expect(payload.Hostname).toBe(BACKUP_HOSTNAME);
        expect(payload.HostConfig).toMatchObject({
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 128,
          RestartPolicy: { Name: "no" },
          NetworkMode: repo.kind === "local" ? "none" : NET,
        });
        expect(Object.keys(payload.HostConfig.Tmpfs)).toEqual(["/tmp"]);
        expect(JSON.stringify(payload)).not.toContain("docker.sock");
        // No host path but the guarded repository folder: every other bind is a named volume or a secret file.
        const mounts = (payload.HostConfig.Mounts ?? []).map((m) => m.Source);
        expect(mounts).toEqual(repo.kind === "local" ? [guarded(STACK).hostDir] : []);
        expect(payload.HostConfig.GroupAdd).toEqual(repo.kind === "local" ? ["987"] : undefined);
        // Secrets reach a job as files only.
        expect(payload.Env.filter((e) => /PASSWORD|SECRET|ACCESS_KEY/i.test(e))).toEqual(SECRET_FILE_ENV);
        expect(JSON.stringify(payload)).not.toContain(S3.secretAccessKey);
        expect(JSON.stringify(payload)).not.toContain(S3.accessKeyId);
      }
    }
  });

  it("are jobs, never resources of the stack: no stack_id label, the role of the site jobs", () => {
    expect(buildAppStackJobLabels(STACK, JOB)).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "site_job",
      "io.hostingpanel.job_id": JOB,
      [APP_STACK_BACKUP_OF_LABEL]: STACK,
    });
    expect(APP_STACK_BACKUP_OF_LABEL).toBe("io.hostingpanel.app_backup_of");
    for (const [name, spec] of Object.entries(everyJob())) {
      const jobId = name === "restore" ? RESTORE_JOB : name === "forget" ? FORGET_JOB : JOB;
      expect(spec.payload.Labels).toEqual(buildAppStackJobLabels(STACK, jobId));
      expect(Object.keys(spec.payload.Labels)).not.toContain("io.hostingpanel.stack_id");
      expect(Object.keys(spec.payload.Labels)).not.toContain("io.hostingpanel.site_id");
      expect(Object.keys(spec.payload.Labels)).not.toContain("io.hostingpanel.organization_id");
    }
  });

  it("prepares the repository with the scripts of the site jobs and reads no volume", () => {
    const local = buildAppStackRepoContainerPayload({ ...base(), init: true });
    expect(local.containerName).toBe(`hp_bk_${JOB}_repo`);
    expect(local.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_LOCAL_JOB_SCRIPT]);
    expect(local.payload.Cmd).toBeUndefined();
    expect(local.payload.Env).toContain("HP_INIT=1");
    expect(local.payload.Env).toContain(`RESTIC_REPOSITORY=/backup/repository/stacks/${STACK}`);
    expect(local.payload.HostConfig.Binds).toEqual(SECRET_BINDS);

    const s3 = buildAppStackRepoContainerPayload({ ...base(s3Repo()), init: false });
    expect(s3.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_JOB_SCRIPT]);
    expect(s3.payload.Env).toContain("HP_INIT=0");
    expect(s3.payload.Env).toContain("HP_REGION=eu-central-1");
    expect(s3.payload.Env).toContain(
      `RESTIC_REPOSITORY=s3:https://s3.example.com:9000/panel-backups/prod/cluster1/stacks/${STACK}`,
    );
    expect(s3.payload.HostConfig.Binds).toEqual(SECRET_BINDS);
  });

  it("copies every asked volume read-only into one snapshot, each under /data/<volumeKey>", () => {
    expect(appStackBackupDataPath("data")).toBe("/data/data");
    const copy = buildAppStackBackupCopyContainerPayload({ ...base(), volumeKeys: ["data", "db-files"] });
    expect(copy.containerName).toBe(`hp_bk_${JOB}_up`);
    expect(copy.payload.HostConfig.Binds).toEqual([
      `hp_appvol_${STACK}_data:/data/data:ro`,
      `hp_appvol_${STACK}_db-files:/data/db-files:ro`,
      ...SECRET_BINDS,
    ]);
    expect(copy.payload.Entrypoint).toBeUndefined();
    expect(copy.payload.Cmd).toEqual([
      "backup",
      "-q",
      "--json",
      "--host",
      BACKUP_HOSTNAME,
      "--tag",
      JOB,
      "/data/data",
      "/data/db-files",
    ]);
    expect(buildAppStackBackupCopyContainerPayload({ ...base(s3Repo()), volumeKeys: ["data"] }).payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "backup",
      "-q",
      "--json",
      "--host",
      BACKUP_HOSTNAME,
      "--tag",
      JOB,
      "/data/data",
    ]);
  });

  it("restores one volume per container, its own folder included, deleting what the backup does not hold, without locking the repository", () => {
    const restore = buildAppStackRestoreContainerPayload({
      ...base(localRepo(STACK, true), RESTORE_JOB),
      volumeKey: "db-files",
      snapshotId: SNAPSHOT,
    });
    expect(restore.containerName).toBe(`hp_bk_${RESTORE_JOB}_rs_db-files`);
    expect(restore.payload.HostConfig.Binds).toEqual([`hp_appvol_${STACK}_db-files:/data/db-files`, ...SECRET_BINDS]);
    expect(restore.payload.HostConfig.Mounts).toEqual([expect.objectContaining({ ReadOnly: true })]);
    // The snapshot's /data onto /data, taking only this volume's folder: its owner and mode come back with the files.
    expect(restore.payload.Cmd).toEqual([
      "restore",
      `${SNAPSHOT}:/data`,
      "--target",
      "/data",
      "--include",
      "/db-files",
      "--delete",
      "--no-lock",
      "--json",
    ]);
    // Only the job of a restore operation may write to a volume.
    for (const jobId of [JOB, FORGET_JOB, `${JOB}-t2`]) {
      expect(() =>
        buildAppStackRestoreContainerPayload({ ...base(localRepo(), jobId), volumeKey: "data", snapshotId: SNAPSHOT }),
      ).toThrow(coded("VALIDATION_ERROR"));
    }
  });

  it("removes snapshots with forget, and the leftover of an unreadable copy without prune", () => {
    const second = "cd".repeat(32);
    const forget = buildAppStackForgetContainerPayload({ ...base(localRepo(), FORGET_JOB), snapshotIds: [SNAPSHOT, second] });
    expect(forget.containerName).toBe(`hp_bk_${FORGET_JOB}_forget`);
    expect(forget.payload.Cmd).toEqual(["forget", "--prune", SNAPSHOT, second]);
    expect(forget.payload.HostConfig.Binds).toEqual(SECRET_BINDS);

    const drop = buildAppStackPartialSnapshotDropContainerPayload({ ...base(), snapshotId: SNAPSHOT });
    expect(drop.containerName).toBe(`hp_bk_${JOB}_drop`);
    expect(drop.payload.Cmd).toEqual(["forget", SNAPSHOT]);
    expect(drop.payload.HostConfig.Binds).toEqual(SECRET_BINDS);
  });

  it("refuses a repository that is not this application's own", () => {
    const foreign = [
      localRepo(OTHER_STACK),
      s3Repo(OTHER_STACK),
      resolveBackupRepository(S3, { kind: "site", siteId: STACK }, { backupNetworkName: NET }),
      resolveBackupRepository(S3, { kind: "panel" }, { backupNetworkName: NET }),
    ];
    for (const repo of foreign) {
      expect(() => buildAppStackRepoContainerPayload({ ...base(repo), init: true })).toThrow(coded("HOST_POLICY_DENIED"));
      expect(() => buildAppStackBackupCopyContainerPayload({ ...base(repo), volumeKeys: ["data"] })).toThrow(
        coded("HOST_POLICY_DENIED"),
      );
      expect(() =>
        buildAppStackRestoreContainerPayload({ ...base(repo, RESTORE_JOB), volumeKey: "data", snapshotId: SNAPSHOT }),
      ).toThrow(coded("HOST_POLICY_DENIED"));
      expect(() => buildAppStackForgetContainerPayload({ ...base(repo, FORGET_JOB), snapshotIds: [SNAPSHOT] })).toThrow(
        coded("HOST_POLICY_DENIED"),
      );
      expect(() => buildAppStackPartialSnapshotDropContainerPayload({ ...base(repo), snapshotId: SNAPSHOT })).toThrow(
        coded("HOST_POLICY_DENIED"),
      );
    }
  });

  it("refuses volume keys, snapshot ids, job ids and application ids it could not have minted", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `v${String(i)}`);
    for (const volumeKeys of [[], ["../etc"], ["Data"], ["data", "data"], ["data:/host"], [""], nine]) {
      expect(() => buildAppStackBackupCopyContainerPayload({ ...base(), volumeKeys })).toThrow(coded("VALIDATION_ERROR"));
    }
    for (const volumeKey of ["../etc", "Data", "", "data:ro"]) {
      expect(() =>
        buildAppStackRestoreContainerPayload({ ...base(localRepo(), RESTORE_JOB), volumeKey, snapshotId: SNAPSHOT }),
      ).toThrow(coded("VALIDATION_ERROR"));
      expect(() => appStackBackupDataPath(volumeKey)).toThrow(coded("VALIDATION_ERROR"));
    }
    for (const snapshotId of ["", "latest", SNAPSHOT.slice(1), `${SNAPSHOT}:/etc`, SNAPSHOT.toUpperCase()]) {
      expect(() =>
        buildAppStackRestoreContainerPayload({ ...base(localRepo(), RESTORE_JOB), volumeKey: "data", snapshotId }),
      ).toThrow(coded("VALIDATION_ERROR"));
      expect(() => buildAppStackPartialSnapshotDropContainerPayload({ ...base(), snapshotId })).toThrow(
        coded("VALIDATION_ERROR"),
      );
      expect(() => buildAppStackForgetContainerPayload({ ...base(localRepo(), FORGET_JOB), snapshotIds: [snapshotId] })).toThrow(
        coded("VALIDATION_ERROR"),
      );
    }
    for (const snapshotIds of [[], Array.from({ length: 101 }, () => SNAPSHOT)]) {
      expect(() => buildAppStackForgetContainerPayload({ ...base(localRepo(), FORGET_JOB), snapshotIds })).toThrow(
        coded("VALIDATION_ERROR"),
      );
    }
    for (const jobId of ["", "op_1", `${JOB}; rm -rf /`, `x${JOB}`]) {
      expect(() => buildAppStackRepoContainerPayload({ ...base(localRepo(), jobId), init: true })).toThrow(
        coded("VALIDATION_ERROR"),
      );
      expect(() => buildAppStackJobLabels(STACK, jobId)).toThrow(coded("VALIDATION_ERROR"));
    }
    for (const stackId of ["", "../x", "stk-1"]) {
      expect(() => buildAppStackRepoContainerPayload({ ...base(), stackId, init: true })).toThrow(coded("VALIDATION_ERROR"));
      expect(() => buildAppStackJobLabels(stackId, JOB)).toThrow(coded("VALIDATION_ERROR"));
    }
  });
});
