import type { BackupTarget } from "@hosting-panel/contracts";
import {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BACKUP_HOSTNAME,
  BACKUP_REPO_JOB_SCRIPT,
  BACKUP_REPO_LOCAL_JOB_SCRIPT,
  assertSafeBindPath,
  assertSafeSecretBinds,
  buildResticBasePayload,
  localizeResticScript,
  resolveBackupRepository,
  type BackupBindMount,
  type BackupContainerCreatePayload,
  type ResolvedBackupRepository,
} from "./backup-jobs.js";
import { ExecutorCodedError, SITE_JOB_ROLE } from "./traefik-config.js";

export const PANEL_LANE = "panel:db" as const;
export const PANEL_DUMP_MAGIC = "PGDMP" as const;
export const PANEL_KEEP_LAST = 3 as const;
export const PANEL_REPO_DUMP_PATH = "/backup/panel/panel.dump" as const;
export const PANEL_REPO_KEY_PATH = "/backup/panel/secrets-master.key" as const;
export const PANEL_KEY_FILE_PATTERN = /^[0-9a-f]{64}$/;
export const PANEL_MASTER_KEY_SECRET = "SECRETS_MASTER_KEY" as const;
export const PANEL_RESTORE_DUMP_NAME = "restore.pgdump" as const;
export const PANEL_RESTORE_KEY_NAME = "restore.key" as const;
export const PANEL_FETCH_EXIT_NO_COPY = 79 as const;
export const PANEL_FETCH_EXIT_NO_SPACE = 75 as const;
export const PANEL_FETCH_ID_PATTERN = /^[0-9a-f]{32}$/;

const PANEL_JOB_ID_PATTERN = /^op_[0-9a-f]{32}(?:-t2)?$/;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;
const PANEL_LOCAL_REPO_PATH = "/backup/repository/panel" as const;

export const PANEL_FETCH_SCRIPT = [
  "set -eu",
  "umask 077",
  'RO="-o s3.bucket-lookup=path -o s3.region=$HP_REGION"',
  "rm -f /o/restore.pgdump /o/restore.key /o/.restore.pgdump.part /o/.restore.key.part",
  "snap=$(restic $RO snapshots --json --host hosting-panel --path /backup/panel --latest 1)",
  `id=$(printf '%s' "$snap" | sed -n 's/.*"id":"\\([0-9a-f]\\{64\\}\\)".*/\\1/p' | head -n1)`,
  `[ -n "$id" ] || exit ${String(PANEL_FETCH_EXIT_NO_COPY)}`,
  `time=$(printf '%s' "$snap" | sed -n 's/.*"time":"\\([^"]*\\)".*/\\1/p' | head -n1)`,
  "printf 'HP_SNAP %s %s\\n' \"$id\" \"$time\"",
  'st=$(restic $RO stats --json --mode restore-size "$id")',
  `need=$(printf '%s' "$st" | sed -n 's/.*"total_size":\\([0-9]*\\).*/\\1/p')`,
  "free=$(df -Pk /o | awk 'NR==2{print $4}')",
  `[ $((free*1024)) -ge $((\${need:-0}+HP_FLOOR)) ] || exit ${String(PANEL_FETCH_EXIT_NO_SPACE)}`,
  'restic $RO dump "$id" /backup/panel/panel.dump > /o/.restore.pgdump.part',
  'restic $RO dump "$id" /backup/panel/secrets-master.key > /o/.restore.key.part',
  "mv -f /o/.restore.pgdump.part /o/restore.pgdump",
  "mv -f /o/.restore.key.part /o/restore.key",
  "sync /o",
].join("\n");

/**
 * Disaster-recovery fetch from a local panel repository: no S3, read without taking a lock (the repository is mounted
 * read-only), and group-readable hand-over files (`umask 007`) because the container runs as the repository's owner.
 */
export const PANEL_FETCH_LOCAL_SCRIPT = localizeResticScript(PANEL_FETCH_SCRIPT)
  .replace('RO=""', 'RO="--no-lock"')
  .replace("umask 077", "umask 007");

export type PanelBindMount = BackupBindMount;

/** The hardened restic payload plus the two fields only the panel containers need. */
export type PanelContainerCreatePayload = BackupContainerCreatePayload & {
  readonly HostConfig: {
    readonly GroupAdd?: readonly string[];
    readonly Mounts?: readonly PanelBindMount[];
  };
};

export interface PanelContainerSpec {
  readonly containerName: string;
  readonly payload: PanelContainerCreatePayload;
}

/** The panel repository comes resolved (S3 or guarded local), or as the legacy S3 pair (resolved here as S3). */
type PanelResticInput = {
  /** `uid:gid` of the executor: every container of a local panel repository runs as it. */
  readonly executorUser?: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
} & (
  | { readonly repo: ResolvedBackupRepository }
  | { readonly target: BackupTarget; readonly backupNetworkName: string }
);

function panelRepoOf(input: PanelResticInput): ResolvedBackupRepository {
  return "repo" in input
    ? input.repo
    : resolveBackupRepository(input.target, { kind: "panel" }, { backupNetworkName: input.backupNetworkName });
}

/** Local panel steps run as the executor (primary gid = the repository group); S3 steps keep the image default. */
function panelStepUser(input: PanelResticInput, repo: ResolvedBackupRepository): string | undefined {
  return repo.kind === "local" ? assertUidGid(input.executorUser ?? "") : undefined;
}

/** Group ids of a step: the dump directory's, then the repository's own (deduplicated). */
const mergeGroups = (...groups: readonly (readonly string[])[]): string[] => [...new Set(groups.flat())];

function assertPanelJobId(jobId: string): string {
  if (!PANEL_JOB_ID_PATTERN.test(jobId)) {
    throw new ExecutorCodedError("Invalid panel jobId", "VALIDATION_ERROR");
  }
  return jobId;
}

function assertUidGid(executorUser: string): string {
  if (!/^\d+:\d+$/.test(executorUser)) {
    throw new ExecutorCodedError("Invalid executor user uid:gid", "VALIDATION_ERROR");
  }
  return executorUser;
}

function assertDirGid(dirGid: number): string {
  if (!Number.isSafeInteger(dirGid) || dirGid <= 0) {
    throw new ExecutorCodedError("Panel dump directory group must not be root", "HOST_POLICY_DENIED");
  }
  return String(dirGid);
}

function assertAbsolutePath(hostPath: string, field: string): string {
  assertSafeBindPath(hostPath, field);
  if (!hostPath.startsWith("/")) {
    throw new ExecutorCodedError(`Invalid ${field}`, "HOST_POLICY_DENIED");
  }
  return hostPath;
}

/** Labels of a panel job container: the test-mode shape, without a site id. */
export function buildPanelJobLabels(jobId: string): Readonly<Record<string, string>> {
  return {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": SITE_JOB_ROLE,
    "io.hostingpanel.job_id": jobId,
  };
}

function panelRestic(
  input: PanelResticInput,
  repo: ResolvedBackupRepository,
  jobId: string,
  extra: Omit<Parameters<typeof buildResticBasePayload>[0], "repo" | "repoKind" | "target" | "backupNetworkName" | "secretBinds" | "secretFileEnv" | "labels">,
): BackupContainerCreatePayload {
  const user = panelStepUser(input, repo);
  return buildResticBasePayload({
    repo,
    secretBinds: input.secretBinds,
    secretFileEnv: input.secretFileEnv,
    labels: buildPanelJobLabels(jobId),
    ...(user !== undefined ? { user } : {}),
    ...extra,
  });
}

/** `_prepo`: unlock, or init when missing, the `<prefix>/panel` repository. */
export function buildPanelRepoContainerPayload(
  input: PanelResticInput & { readonly jobId: string },
): PanelContainerSpec {
  const jobId = assertPanelJobId(input.jobId);
  const repo = panelRepoOf(input);
  return {
    containerName: `hp_bk_${jobId}_prepo`,
    payload: panelRestic(input, repo, jobId, {
      extraEnv: [...repo.env, "HP_INIT=1"],
      entrypoint: [
        "/bin/sh",
        "-c",
        repo.kind === "local" ? BACKUP_REPO_LOCAL_JOB_SCRIPT : BACKUP_REPO_JOB_SCRIPT,
      ],
    }),
  };
}

/** `_pup`: backs up the dump and the master key file, read through GroupAdd and read-only Mounts. */
export function buildPanelUploadContainerPayload(
  input: PanelResticInput & {
    readonly jobId: string;
    readonly executorUser: string;
    readonly dumpPath: string;
    readonly masterKeyPath: string;
    readonly dirGid: number;
  },
): PanelContainerSpec {
  const jobId = assertPanelJobId(input.jobId);
  const repo = panelRepoOf(input);
  const user = assertUidGid(input.executorUser);
  const groupAdd = assertDirGid(input.dirGid);
  const dumpPath = assertAbsolutePath(input.dumpPath, "dumpPath");
  const masterKeyPath = assertAbsolutePath(input.masterKeyPath, "masterKeyPath");
  const base = panelRestic(input, repo, jobId, {
    user,
    cmd: [
      ...repo.resticOptions,
      "backup",
      "-q",
      "--json",
      "--host",
      BACKUP_HOSTNAME,
      "--tag",
      jobId,
      "/backup/panel",
    ],
  });
  return {
    containerName: `hp_bk_${jobId}_pup`,
    payload: {
      ...base,
      HostConfig: {
        ...base.HostConfig,
        GroupAdd: mergeGroups([groupAdd], repo.groupAdd),
        Mounts: [
          ...repo.mounts,
          { Type: "bind", Source: dumpPath, Target: PANEL_REPO_DUMP_PATH, ReadOnly: true },
          { Type: "bind", Source: masterKeyPath, Target: PANEL_REPO_KEY_PATH, ReadOnly: true },
        ],
      },
    },
  };
}

/** `_pdrop`: forgets the one snapshot a failed upload left behind. */
export function buildPanelDropContainerPayload(
  input: PanelResticInput & { readonly jobId: string; readonly snapshotId: string },
): PanelContainerSpec {
  const jobId = assertPanelJobId(input.jobId);
  const repo = panelRepoOf(input);
  if (!SNAPSHOT_ID_PATTERN.test(input.snapshotId)) {
    throw new ExecutorCodedError("Invalid snapshot id", "VALIDATION_ERROR");
  }
  return {
    containerName: `hp_bk_${jobId}_pdrop`,
    payload: panelRestic(input, repo, jobId, {
      cmd: [...repo.resticOptions, "forget", input.snapshotId],
    }),
  };
}

/** `_pkeep`: applies the retention days, always keeping the newest three copies. */
export function buildPanelKeepContainerPayload(
  input: PanelResticInput & { readonly jobId: string; readonly retentionDays: number },
): PanelContainerSpec {
  const jobId = assertPanelJobId(input.jobId);
  const repo = panelRepoOf(input);
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 365) {
    throw new ExecutorCodedError("Invalid retentionDays", "VALIDATION_ERROR");
  }
  return {
    containerName: `hp_bk_${jobId}_pkeep`,
    payload: panelRestic(input, repo, jobId, {
      cmd: [
        ...repo.resticOptions,
        "forget",
        "--host",
        BACKUP_HOSTNAME,
        "--group-by",
        "host",
        "--keep-within",
        `${String(input.retentionDays)}d`,
        "--keep-last",
        String(PANEL_KEEP_LAST),
        "--prune",
      ],
    }),
  };
}

/** `pf_<hex>_fetch`: writes the newest panel copy into the hand-over directory at `/o`. */
export function buildPanelFetchContainerPayload(
  input: PanelResticInput & {
    readonly fetchId: string;
    readonly executorUser: string;
    readonly outDir: string;
    readonly dirGid: number;
  },
): PanelContainerSpec {
  if (!PANEL_FETCH_ID_PATTERN.test(input.fetchId)) {
    throw new ExecutorCodedError("Invalid fetch id", "VALIDATION_ERROR");
  }
  const jobId = `pf_${input.fetchId}`;
  const repo = panelRepoOf(input);
  const user = assertUidGid(input.executorUser);
  const groupAdd = assertDirGid(input.dirGid);
  const outDir = assertAbsolutePath(input.outDir, "outDir");
  const base = panelRestic(input, repo, jobId, {
    user,
    extraEnv: [...repo.env, `HP_FLOOR=${String(BACKUP_DISK_FREE_FLOOR_BYTES)}`],
    entrypoint: ["/bin/sh", "-c", repo.kind === "local" ? localizeResticScript(PANEL_FETCH_SCRIPT) : PANEL_FETCH_SCRIPT],
  });
  return {
    containerName: `hp_bk_${jobId}_fetch`,
    payload: {
      ...base,
      HostConfig: {
        ...base.HostConfig,
        GroupAdd: mergeGroups([groupAdd], repo.groupAdd),
        Mounts: [...repo.mounts, { Type: "bind", Source: outDir, Target: "/o", ReadOnly: false }],
      },
    },
  };
}

/**
 * `pf_<hex>_fetch` for disaster recovery from a local panel repository (`hp-restore-panel --local-repo`): the
 * repository directory is mounted read-only, there is no network and no S3 credential, and the container runs as the
 * directory's owner (the old executor ids may differ on a new host) with the hand-over directory's group added.
 */
export function buildPanelFetchLocalContainerPayload(input: {
  readonly fetchId: string;
  readonly repoDir: string;
  /** `uid:gid` of the repository directory owner. */
  readonly user: string;
  readonly outDir: string;
  /** Group ids of the hand-over directory (never root). */
  readonly groupAdd: readonly number[];
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): PanelContainerSpec {
  if (!PANEL_FETCH_ID_PATTERN.test(input.fetchId)) {
    throw new ExecutorCodedError("Invalid fetch id", "VALIDATION_ERROR");
  }
  const jobId = `pf_${input.fetchId}`;
  const user = assertUidGid(input.user);
  const repoDir = assertAbsolutePath(input.repoDir, "repoDir");
  const outDir = assertAbsolutePath(input.outDir, "outDir");
  const groupAdd = mergeGroups(input.groupAdd.map(assertDirGid));
  assertSafeSecretBinds(input.secretBinds);
  const repo: ResolvedBackupRepository = {
    kind: "local",
    repository: PANEL_LOCAL_REPO_PATH,
    resticOptions: [],
    env: [],
    mounts: [{ Type: "bind", Source: repoDir, Target: PANEL_LOCAL_REPO_PATH, ReadOnly: true }],
    groupAdd,
    networkMode: "none",
  };
  const base = buildResticBasePayload({
    repo,
    secretBinds: input.secretBinds,
    secretFileEnv: input.secretFileEnv,
    labels: buildPanelJobLabels(jobId),
    user,
    extraEnv: [`HP_FLOOR=${String(BACKUP_DISK_FREE_FLOOR_BYTES)}`],
    entrypoint: ["/bin/sh", "-c", PANEL_FETCH_LOCAL_SCRIPT],
  });
  return {
    containerName: `hp_bk_${jobId}_fetch`,
    payload: {
      ...base,
      HostConfig: {
        ...base.HostConfig,
        Mounts: [...repo.mounts, { Type: "bind", Source: outDir, Target: "/o", ReadOnly: false }],
      },
    },
  };
}
