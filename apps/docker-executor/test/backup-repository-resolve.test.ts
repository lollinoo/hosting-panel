import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESTIC_IMAGE, type BackupDispatchTarget, type BackupTarget } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_REPO_JOB_SCRIPT,
  BACKUP_REPO_LOCAL_JOB_SCRIPT,
  BACKUP_REPO_LOCAL_TEST_SCRIPT,
  BACKUP_REPO_TEST_SCRIPT,
  buildBackupForgetContainerPayload,
  buildBackupHostConfig,
  buildBackupRepoContainerPayload,
  buildBackupUploadContainerPayload,
  buildPartialSnapshotDropContainerPayload,
  buildResticRepositoryUrl,
  classifyLocalResticStderr,
  classifyResticExitCode,
  localRepoStepScript,
  localizeResticScript,
  resolveBackupRepository,
  type GuardedLocalRepo,
} from "../src/backup-jobs.js";
import { PANEL_FETCH_SCRIPT } from "../src/panel-jobs.js";
import { ARCHIVE_SCRIPT, buildRestoreFetchScript } from "../src/restore-jobs.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "../src/site-types/index.js";

const S3: BackupTarget = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod/cluster1",
  accessKeyId: "AKIASENTINEL999",
  secretAccessKey: "sentinel-s3-secret-999",
};
const LOCAL: BackupDispatchTarget = { kind: "local", targetId: `bkt_${"a".repeat(32)}` };
const SITE_ID = "site_1";
const JOB_ID = `op_${"d".repeat(32)}`;
const HOST_DIR = `/var/lib/hosting-panel/local-repos/${LOCAL.kind === "local" ? LOCAL.targetId : ""}/sites/${SITE_ID}`;
const GUARDED_SITE: GuardedLocalRepo = {
  hostDir: HOST_DIR,
  containerPath: `/backup/repository/sites/${SITE_ID}`,
  executorGid: 987,
  availableBytes: 5_000_000_000,
  totalBytes: 9_000_000_000,
};
const GUARDED_PANEL: GuardedLocalRepo = {
  ...GUARDED_SITE,
  hostDir: "/var/lib/hosting-panel/local-repos/bkt_x/panel",
  containerPath: "/backup/repository/panel",
};
const NET = "hp_backup_net";
const SECRET_BINDS = ["/run/secrets/job/RESTIC_PASSWORD:/run/secrets/RESTIC_PASSWORD:ro"];
const SECRET_FILE_ENV = ["RESTIC_PASSWORD_FILE=/run/secrets/RESTIC_PASSWORD"];
const common = { secretBinds: SECRET_BINDS, secretFileEnv: SECRET_FILE_ENV };

const localSite = resolveBackupRepository(LOCAL, { kind: "site", siteId: SITE_ID }, { backupNetworkName: NET, local: GUARDED_SITE });
const localPanel = resolveBackupRepository(LOCAL, { kind: "panel" }, { backupNetworkName: NET, local: GUARDED_PANEL });

describe("resolveBackupRepository", () => {
  it("s3: same bytes as buildResticRepositoryUrl and the pinned option tokens", () => {
    for (const scope of [{ kind: "panel" }, { kind: "site", siteId: SITE_ID }] as const) {
      expect(resolveBackupRepository(S3, scope, { backupNetworkName: NET })).toEqual({
        kind: "s3",
        repository: buildResticRepositoryUrl(S3, scope),
        resticOptions: ["-o", "s3.bucket-lookup=path", "-o", "s3.region=eu-central-1"],
        env: ["HP_REGION=eu-central-1"],
        mounts: [],
        groupAdd: [],
        networkMode: NET,
      });
    }
  });

  it("s3: rejects an unsafe region", () => {
    expect(() => resolveBackupRepository({ ...S3, region: "eu west" }, { kind: "panel" }, { backupNetworkName: NET })).toThrow();
  });

  it("local: leaf mount at the narrow container path, no network, executor group", () => {
    expect(localSite).toEqual({
      kind: "local",
      repository: "/backup/repository/sites/site_1",
      resticOptions: [],
      env: [],
      mounts: [{ Type: "bind", Source: HOST_DIR, Target: "/backup/repository/sites/site_1", ReadOnly: false }],
      groupAdd: ["987"],
      networkMode: "none",
    });
    expect(localPanel.repository).toBe("/backup/repository/panel");
    expect(localPanel.mounts[0]?.Target).toBe("/backup/repository/panel");
  });

  it("local: readOnly flag only flips the mount", () => {
    const ro = resolveBackupRepository(LOCAL, { kind: "panel" }, { backupNetworkName: NET, local: GUARDED_PANEL, readOnly: true });
    expect(ro.mounts[0]?.ReadOnly).toBe(true);
  });

  it("local: refuses a missing, mismatched or malformed guard result", () => {
    const site = { kind: "site", siteId: SITE_ID } as const;
    expect(() => resolveBackupRepository(LOCAL, site, { backupNetworkName: NET })).toThrow(/not guarded/);
    expect(() => resolveBackupRepository(LOCAL, site, { backupNetworkName: NET, local: GUARDED_PANEL })).toThrow(/not guarded/);
    expect(() => resolveBackupRepository(LOCAL, { kind: "site", siteId: "site_2" }, { backupNetworkName: NET, local: GUARDED_SITE })).toThrow();
    expect(() => resolveBackupRepository(LOCAL, site, { backupNetworkName: NET, local: { ...GUARDED_SITE, executorGid: -1 } })).toThrow();
    expect(() => resolveBackupRepository(LOCAL, site, { backupNetworkName: NET, local: { ...GUARDED_SITE, hostDir: "/x/docker.sock" } })).toThrow();
  });
});

describe("buildBackupHostConfig extras", () => {
  it("emits GroupAdd/Mounts only when non-empty and never a docker.sock source", () => {
    const base = buildBackupHostConfig("none", []);
    expect("GroupAdd" in base).toBe(false);
    expect("Mounts" in base).toBe(false);
    expect("GroupAdd" in buildBackupHostConfig("none", [], { groupAdd: [], mounts: [] })).toBe(false);
    const withExtra = buildBackupHostConfig("none", [], { groupAdd: ["987"], mounts: localSite.mounts });
    expect(withExtra.GroupAdd).toEqual(["987"]);
    expect(withExtra.Mounts).toEqual(localSite.mounts);
    expect(() => buildBackupHostConfig("none", [], { groupAdd: ["root"] })).toThrow();
    expect(() => buildBackupHostConfig("none", [], { mounts: [{ Type: "bind", Source: "/run/docker.sock", Target: "/x", ReadOnly: false }] })).toThrow();
  });
});

describe("local payloads", () => {
  const specs = [
    buildBackupRepoContainerPayload({ mode: "test", testId: "0123456789abcdef", repo: localPanel, user: "990:987", ...common }),
    buildBackupRepoContainerPayload({ mode: "job", jobId: JOB_ID, siteId: SITE_ID, init: true, repo: localSite, ...common }),
    buildBackupUploadContainerPayload({
      jobId: JOB_ID,
      siteId: SITE_ID,
      serviceInstanceId: "svc_1",
      siteType: WORDPRESS_EXECUTOR_SITE_TYPE,
      repo: localSite,
      stagingVolumeName: "hp_bk_staging",
      ...common,
    }),
    buildPartialSnapshotDropContainerPayload({ jobId: JOB_ID, siteId: SITE_ID, snapshotId: "b".repeat(64), repo: localSite, ...common }),
    buildBackupForgetContainerPayload({ jobId: `${JOB_ID}-forget`, siteId: SITE_ID, snapshotIds: ["b".repeat(64)], repo: localSite, ...common }),
  ];

  it("never carries an s3 token, AWS env, region or network, and binds only the leaf via Mounts", () => {
    for (const spec of specs) {
      const json = JSON.stringify(spec.payload);
      expect(json).not.toMatch(/s3\./);
      expect(json).not.toMatch(/AWS_|HP_REGION/);
      expect(spec.payload.Image).toBe(RESTIC_IMAGE);
      expect(spec.payload.Env.some((e) => e.startsWith("RESTIC_REPOSITORY=/backup/repository/"))).toBe(true);
      expect(spec.payload.HostConfig.NetworkMode).toBe("none");
      expect(spec.payload.HostConfig.GroupAdd).toEqual(["987"]);
      expect(spec.payload.HostConfig.Mounts).toHaveLength(1);
      expect(spec.payload.HostConfig.Mounts?.[0]?.ReadOnly).toBe(false);
      expect(spec.payload.HostConfig.Binds.every((b) => b.endsWith(":ro"))).toBe(true);
      expect(spec.payload.HostConfig.Binds.some((b) => b.includes("/local-repos"))).toBe(false);
    }
  });

  it("repo steps use the local script (no s3, no region env) and the test step runs as the given user", () => {
    expect(specs[0]!.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_LOCAL_TEST_SCRIPT]);
    expect(specs[0]!.payload.User).toBe("990:987");
    expect(specs[0]!.payload.Env).toContain("HP_INIT=1");
    expect(specs[0]!.payload.Env).toContain("RESTIC_REPOSITORY=/backup/repository/panel");
    expect(specs[1]!.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_LOCAL_JOB_SCRIPT]);
    expect(specs[1]!.payload.User).toBe("33:33");
    expect(specs[1]!.payload.Env).toContain("HP_INIT=1");
    expect(specs[1]!.payload.Env).toContain("RESTIC_REPOSITORY=/backup/repository/sites/site_1");
  });

  it("restic commands carry no repository options", () => {
    expect((specs[2]!.payload.Cmd as string[]).slice(0, 2)).toEqual(["backup", "-q"]);
    expect(specs[3]!.payload.Cmd).toEqual(["forget", "b".repeat(64)]);
    expect(specs[4]!.payload.Cmd).toEqual(["forget", "--prune", "b".repeat(64)]);
  });

  it("the S3 steps of the same builders keep the pinned scripts", () => {
    const s3 = resolveBackupRepository(S3, { kind: "site", siteId: SITE_ID }, { backupNetworkName: NET });
    const job = buildBackupRepoContainerPayload({ mode: "job", jobId: JOB_ID, siteId: SITE_ID, init: false, repo: s3, ...common });
    const legacy = buildBackupRepoContainerPayload({ mode: "job", jobId: JOB_ID, siteId: SITE_ID, init: false, target: S3, backupNetworkName: NET, ...common });
    expect(job).toEqual(legacy);
    expect(job.payload.Entrypoint).toEqual(["/bin/sh", "-c", BACKUP_REPO_JOB_SCRIPT]);
    expect(job.payload.Env).toContain("HP_REGION=eu-central-1");
    expect("GroupAdd" in job.payload.HostConfig).toBe(false);
    expect("Mounts" in job.payload.HostConfig).toBe(false);
  });
});

describe("local scripts", () => {
  it("pins the local repo step text", () => {
    expect(BACKUP_REPO_LOCAL_JOB_SCRIPT).toBe(
      'R="$RESTIC_REPOSITORY"; restic unlock --remove-all; rc=$?; if [ "$rc" -eq 10 ] && [ "$HP_INIT" = 1 ]; then restic init; rc=$?; fi; if [ "$rc" -eq 0 ] && [ -O "$R/config" ] && [ -z "$(find "$R/config" -perm -040)" ]; then chmod -R g+rwX,o= "$R"/* || rc=1; fi; exit $rc',
    );
    expect(BACKUP_REPO_LOCAL_TEST_SCRIPT).toBe(localRepoStepScript("cat config --no-lock"));
    expect(BACKUP_REPO_LOCAL_TEST_SCRIPT).toContain("restic cat config --no-lock;");
  });

  it("S3 step scripts are unchanged", () => {
    expect(BACKUP_REPO_TEST_SCRIPT).toContain('restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" cat config --no-lock');
  });

  it("localizeResticScript leaves no s3 token in any S3 script", () => {
    for (const script of [
      BACKUP_REPO_JOB_SCRIPT,
      BACKUP_REPO_TEST_SCRIPT,
      buildRestoreFetchScript(),
      ARCHIVE_SCRIPT,
      PANEL_FETCH_SCRIPT,
    ]) {
      const local = localizeResticScript(script);
      expect(local).not.toContain("s3.");
      expect(local).not.toContain("HP_REGION");
      expect(local).toContain("restic");
    }
    expect(localizeResticScript('RO="-o s3.bucket-lookup=path"\nrestic $RO -o "s3.region=$HP_REGION" ls')).toBe('RO=""\nrestic $RO ls');
    expect(() => localizeResticScript("restic -o s3.endpoint=x ls")).toThrow();
  });

  describe("executed with a fake restic", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const run = (script: string, repoMode: number, fake: string, env: Record<string, string>) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "hp-localscript-"));
      dirs.push(root);
      const repo = path.join(root, "repo");
      mkdirSync(path.join(repo, "data"), { recursive: true });
      writeFileSync(path.join(repo, "config"), "x");
      chmodSync(path.join(repo, "config"), repoMode);
      mkdirSync(path.join(root, "bin"));
      writeFileSync(path.join(root, "bin", "restic"), `#!/bin/sh\n${fake}\n`, { mode: 0o755 });
      let rc = 0;
      try {
        execFileSync("/bin/sh", ["-c", script], { env: { PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, RESTIC_REPOSITORY: repo, ...env } });
      } catch (e) {
        rc = (e as { status: number }).status;
      }
      return { rc, repo, config: statSync(path.join(repo, "config")).mode & 0o777, data: statSync(path.join(repo, "data")).mode & 0o777 };
    };

    it("widens a freshly initialised repo to the group and self-heals a 0400 config", () => {
      const r = run(BACKUP_REPO_LOCAL_JOB_SCRIPT, 0o400, "exit 0", { HP_INIT: "0" });
      expect(r.rc).toBe(0);
      expect(r.config & 0o070).toBe(0o060);
      expect(r.config & 0o007).toBe(0);
      expect(r.data & 0o070).toBe(0o070);
    });

    it("leaves an already group-readable repo alone", () => {
      const r = run(BACKUP_REPO_LOCAL_JOB_SCRIPT, 0o460, "exit 0", { HP_INIT: "0" });
      expect(r.rc).toBe(0);
      expect(r.config).toBe(0o460);
    });

    it("inits on rc=10 only with HP_INIT=1, and passes a failure through untouched", () => {
      const fake = 'echo "$@" >> "$RESTIC_REPOSITORY/calls"; [ "$1" = init ] && exit 0; exit 10';
      const withInit = run(BACKUP_REPO_LOCAL_JOB_SCRIPT, 0o400, fake, { HP_INIT: "1" });
      expect(withInit.rc).toBe(0);
      const without = run(BACKUP_REPO_LOCAL_JOB_SCRIPT, 0o400, fake, { HP_INIT: "0" });
      expect(without.rc).toBe(10);
      expect(without.config).toBe(0o400);
    });
  });
});

describe("local failure classification", () => {
  it("maps filesystem errors and falls back to the shared classifier", () => {
    expect(classifyLocalResticStderr("unable to create lock: open ...: read-only file system")).toBe("local_target_readonly");
    expect(classifyLocalResticStderr("open /backup/repository/keys: Permission denied")).toBe("local_target_unsafe");
    expect(classifyLocalResticStderr("write: no space left on device")).toBe("no_space");
    expect(classifyLocalResticStderr("something odd")).toBe("other");
    expect(classifyResticExitCode(1, "read-only file system", "local")).toBe("local_target_readonly");
    expect(classifyResticExitCode(1, "read-only file system")).toBe("other");
    expect(classifyResticExitCode(1, "AccessDenied")).toBe("write_denied");
    expect(classifyResticExitCode(12, "", "local")).toBe("wrong_key");
    expect(classifyResticExitCode(0, "", "local")).toBeNull();
  });
});
