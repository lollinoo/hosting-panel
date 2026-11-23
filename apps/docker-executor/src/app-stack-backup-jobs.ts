import {
  APP_STACK_KEY_PATTERN,
  APP_STACK_RESTORE_JOB_ID_PATTERN,
  APP_TEMPLATE_LIMITS,
  BACKUP_JOB_ID_PATTERN,
} from "@hosting-panel/contracts";
import { appStackVolumeName } from "./app-stacks/names.js";
import {
  BACKUP_HOSTNAME,
  BACKUP_REPO_JOB_SCRIPT,
  BACKUP_REPO_LOCAL_JOB_SCRIPT,
  type BackupContainerCreatePayload,
  type BackupContainerSpec,
  type ResolvedBackupRepository,
  assertAppStackRepoId,
  buildResticBasePayload,
} from "./backup-jobs.js";
import { ExecutorCodedError, SITE_JOB_ROLE } from "./traefik-config.js";

/**
 * Job containers of application backups (ADR-0038 K4). The files of a volume belong to any user and may be closed
 * to everyone else, so these jobs run as `0:0` with every capability dropped and only the listed ones added back.
 * Everything else is the hardening of the site jobs: the shared base payload is called, never changed.
 */
export const APP_STACK_JOB_USER = "0:0" as const;
/** Read files that are not the user's. */
export const APP_STACK_BACKUP_COPY_CAPABILITIES = ["DAC_READ_SEARCH"] as const;
/** Write back owners, modes and special bits. */
export const APP_STACK_RESTORE_CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"] as const;
/**
 * Names the application a job works for. Deliberately not `io.hostingpanel.stack_id`: the stack engine treats any
 * resource carrying that label and not created by it as a namespace conflict.
 */
export const APP_STACK_BACKUP_OF_LABEL = "io.hostingpanel.app_backup_of" as const;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FORGET_SNAPSHOTS = 100;

type WithCapabilities = BackupContainerSpec & {
  readonly payload: { readonly HostConfig: { readonly CapAdd: readonly string[] } };
};

interface JobIds {
  readonly jobId: string;
  readonly stackId: string;
  readonly repo: ResolvedBackupRepository;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}

function assertJobId(jobId: string): string {
  if (typeof jobId !== "string" || !BACKUP_JOB_ID_PATTERN.test(jobId)) {
    throw new ExecutorCodedError("Invalid backup jobId", "VALIDATION_ERROR");
  }
  return jobId;
}

function assertSnapshotId(snapshotId: string): string {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new ExecutorCodedError("Invalid snapshot id", "VALIDATION_ERROR");
  }
  return snapshotId;
}

function assertVolumeKey(volumeKey: string): string {
  if (typeof volumeKey !== "string" || !APP_STACK_KEY_PATTERN.test(volumeKey)) {
    throw new ExecutorCodedError("Invalid volume key", "VALIDATION_ERROR");
  }
  return volumeKey;
}

/** The repository of a job must be the application's own: `stacks/<stackId>` and nothing else. */
function assertOwnRepository(repo: ResolvedBackupRepository, stackId: string): void {
  if (!repo.repository.endsWith(`/stacks/${stackId}`)) {
    throw new ExecutorCodedError("The repository does not belong to this application", "HOST_POLICY_DENIED");
  }
}

function ids(input: JobIds): { readonly jobId: string; readonly stackId: string } {
  const jobId = assertJobId(input.jobId);
  const stackId = assertAppStackRepoId(input.stackId);
  assertOwnRepository(input.repo, stackId);
  return { jobId, stackId };
}

function withCapabilities(payload: BackupContainerCreatePayload, capabilities: readonly string[]): WithCapabilities["payload"] {
  return { ...payload, HostConfig: { ...payload.HostConfig, CapAdd: [...capabilities] } };
}

/** Labels of a job container: a job like the sites' (removed at executor start), never a stack resource. */
export function buildAppStackJobLabels(stackId: string, jobId: string): Readonly<Record<string, string>> {
  return {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": SITE_JOB_ROLE,
    "io.hostingpanel.job_id": assertJobId(jobId),
    [APP_STACK_BACKUP_OF_LABEL]: assertAppStackRepoId(stackId),
  };
}

/** The folder of a job container that holds the volumes, one folder per volume key. */
const APP_STACK_BACKUP_DATA_ROOT = "/data";

/** Where a volume is mounted in a job container; the same path is the folder of that volume inside a snapshot. */
export const appStackBackupDataPath = (volumeKey: string): string =>
  `${APP_STACK_BACKUP_DATA_ROOT}/${assertVolumeKey(volumeKey)}`;

/** The volumes of one job, in the order asked: 1..8 keys, each once. */
function volumeBinds(stackId: string, volumeKeys: readonly string[], readOnly: boolean): { binds: string[]; paths: string[] } {
  if (
    volumeKeys.length === 0 ||
    volumeKeys.length > APP_TEMPLATE_LIMITS.volumes ||
    new Set(volumeKeys).size !== volumeKeys.length
  ) {
    throw new ExecutorCodedError("Invalid volume key list", "VALIDATION_ERROR");
  }
  const paths = volumeKeys.map(appStackBackupDataPath);
  const binds = volumeKeys.map(
    (key, i) => `${appStackVolumeName(stackId, key)}:${paths[i] ?? ""}${readOnly ? ":ro" : ""}`,
  );
  return { binds, paths };
}

/** Unlock (and for a backup create) the application's repository. No capability: it never reads a volume. */
export function buildAppStackRepoContainerPayload(input: JobIds & { readonly init: boolean }): BackupContainerSpec {
  const { jobId, stackId } = ids(input);
  return {
    containerName: `hp_bk_${jobId}_repo`,
    payload: buildResticBasePayload({
      repo: input.repo,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildAppStackJobLabels(stackId, jobId),
      user: APP_STACK_JOB_USER,
      extraEnv: [...input.repo.env, `HP_INIT=${input.init ? "1" : "0"}`],
      entrypoint: [
        "/bin/sh",
        "-c",
        input.repo.kind === "local" ? BACKUP_REPO_LOCAL_JOB_SCRIPT : BACKUP_REPO_JOB_SCRIPT,
      ],
    }),
  };
}

/** Copies every asked volume, mounted read-only, into one snapshot tagged with the job id. */
export function buildAppStackBackupCopyContainerPayload(
  input: JobIds & { readonly volumeKeys: readonly string[] },
): WithCapabilities {
  const { jobId, stackId } = ids(input);
  const { binds, paths } = volumeBinds(stackId, input.volumeKeys, true);
  return {
    containerName: `hp_bk_${jobId}_up`,
    payload: withCapabilities(
      buildResticBasePayload({
        repo: input.repo,
        secretBinds: input.secretBinds,
        secretFileEnv: input.secretFileEnv,
        labels: buildAppStackJobLabels(stackId, jobId),
        user: APP_STACK_JOB_USER,
        binds,
        cmd: [...input.repo.resticOptions, "backup", "-q", "--json", "--host", BACKUP_HOSTNAME, "--tag", jobId, ...paths],
      }),
      APP_STACK_BACKUP_COPY_CAPABILITIES,
    ),
  };
}

/** Forgets the incomplete snapshot a copy left behind when some file could not be read. */
export function buildAppStackPartialSnapshotDropContainerPayload(
  input: JobIds & { readonly snapshotId: string },
): BackupContainerSpec {
  const { jobId, stackId } = ids(input);
  return {
    containerName: `hp_bk_${jobId}_drop`,
    payload: buildResticBasePayload({
      repo: input.repo,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildAppStackJobLabels(stackId, jobId),
      user: APP_STACK_JOB_USER,
      cmd: [...input.repo.resticOptions, "forget", assertSnapshotId(input.snapshotId)],
    }),
  };
}

/**
 * Writes one volume back from a snapshot, deleting what the backup does not hold. restic restores the snapshot's
 * `/data` onto the container's `/data` and takes only the folder of this volume (`--include`): that folder is the
 * volume's own, so its owner, mode and time come back with the files (`<snapshot>:/data/<key>` would restore only what
 * is inside it; real-Docker check: infra/linux/accept-app-stack-backups.mjs). With `--include`, `--delete` removes
 * only what is under that folder. One container per volume, so a job never mounts more data than it writes. The
 * repository is only read (`--no-lock`; a local one is mounted read-only by the caller).
 */
export function buildAppStackRestoreContainerPayload(
  input: JobIds & { readonly volumeKey: string; readonly snapshotId: string },
): WithCapabilities {
  const { jobId, stackId } = ids(input);
  if (!APP_STACK_RESTORE_JOB_ID_PATTERN.test(jobId)) {
    throw new ExecutorCodedError("Invalid restore jobId", "VALIDATION_ERROR");
  }
  const snapshotId = assertSnapshotId(input.snapshotId);
  const { binds } = volumeBinds(stackId, [input.volumeKey], false);
  return {
    containerName: `hp_bk_${jobId}_rs_${input.volumeKey}`,
    payload: withCapabilities(
      buildResticBasePayload({
        repo: input.repo,
        secretBinds: input.secretBinds,
        secretFileEnv: input.secretFileEnv,
        labels: buildAppStackJobLabels(stackId, jobId),
        user: APP_STACK_JOB_USER,
        binds,
        cmd: [
          ...input.repo.resticOptions,
          "restore",
          `${snapshotId}:${APP_STACK_BACKUP_DATA_ROOT}`,
          "--target",
          APP_STACK_BACKUP_DATA_ROOT,
          "--include",
          `/${input.volumeKey}`,
          "--delete",
          "--no-lock",
          "--json",
        ],
      }),
      APP_STACK_RESTORE_CAPABILITIES,
    ),
  };
}

/** Forgets and prunes the listed snapshots of the application's repository. */
export function buildAppStackForgetContainerPayload(
  input: JobIds & { readonly snapshotIds: readonly string[] },
): BackupContainerSpec {
  const { jobId, stackId } = ids(input);
  if (input.snapshotIds.length === 0 || input.snapshotIds.length > MAX_FORGET_SNAPSHOTS) {
    throw new ExecutorCodedError("Invalid snapshot id list", "VALIDATION_ERROR");
  }
  return {
    containerName: `hp_bk_${jobId}_forget`,
    payload: buildResticBasePayload({
      repo: input.repo,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildAppStackJobLabels(stackId, jobId),
      user: APP_STACK_JOB_USER,
      cmd: [...input.repo.resticOptions, "forget", "--prune", ...input.snapshotIds.map(assertSnapshotId)],
    }),
  };
}
