import {
  BACKUP_JOB_ID_PATTERN,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  SITE_DATABASE_NAME_PATTERN,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupTarget,
} from "@hosting-panel/contracts";
import { S3_PROBE_BUDGET_MS, S3_PROBE_REQUEST_TIMEOUT_MS } from "./s3-probe.js";
import { SITE_JOB_ROLE } from "./site-jobs.js";
import { ExecutorCodedError, assertSafeIdentifier, getManagedVolumeName } from "./traefik-config.js";

export const BACKUP_HOSTNAME = "hosting-panel" as const;
export const BACKUP_REPO_STEP_TIMEOUT_MS = 60_000 as const;
export const BACKUP_DUMP_TIMEOUT_MS = 1_800_000 as const;
export const BACKUP_UPLOAD_TIMEOUT_MS = 7_200_000 as const;
export const BACKUP_FORGET_TIMEOUT_MS = 3_600_000 as const;
export const BACKUP_TEST_BUDGET_MS = 30_000 as const;
export { S3_PROBE_BUDGET_MS, S3_PROBE_REQUEST_TIMEOUT_MS };
export const BACKUP_JOB_MEMORY_BYTES = 536_870_912 as const;
export const BACKUP_TMPFS = "rw,nosuid,nodev,noexec,size=128m,mode=1777" as const;
export const BACKUP_DISK_FREE_FLOOR_BYTES = 1_073_741_824 as const;
export const BACKUP_DUMP_SIZE_FACTOR = 2 as const;
export const BACKUP_MAX_RUNNING_JOBS = 2 as const;
export const BACKUP_STATUS_TTL_MS = 86_400_000 as const;
export const BACKUP_STATUS_MAX = 500 as const;
export const BACKUP_STAGING_VOLUME_ROLE = "backup_staging" as const;
export const BACKUP_RESTIC_USER = "33:33" as const;
export const BACKUP_RESTIC_CACHE_DIR = "/tmp/cache" as const;

// Exclude backtick because buildAwsSharedCredentials quotes values with backticks for go-ini.
const CREDENTIAL_KEY_PATTERN = /^(?!.*`)[\x21-\x7e]{1,256}$/;
const BACKUP_KEY_PATTERN = /^[0-9a-f]{64}$/;
const REGION_PATTERN = /^[a-z0-9-]{1,64}$/;
const HEX_16_PATTERN = /^[0-9a-f]{16}$/;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;

const repoStepScript = (probeCmd: string): string =>
  `restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" ${probeCmd}; rc=$?; if [ "$rc" -eq 10 ] && [ "$HP_INIT" = 1 ]; then restic -o s3.bucket-lookup=path -o "s3.region=$HP_REGION" init; rc=$?; fi; exit $rc`;

export const BACKUP_REPO_JOB_SCRIPT = repoStepScript("unlock --remove-all");
export const BACKUP_REPO_TEST_SCRIPT = repoStepScript("cat config --no-lock");

export const BACKUP_DUMP_SCRIPT = [
  "set -eu",
  'free=$(df -Pk /run/mysqld | awk \'NR==2{print $4}\'); [ "$free" -ge "$HP_NEED_KB" ] || exit 75',
  'MYSQL_PWD="$(cat /run/secrets/mariadb-root)"; export MYSQL_PWD',
  "for db in $HP_DBS; do",
  '  mariadb-dump -h hp-mariadb -u root --default-character-set=utf8mb4 --single-transaction --skip-lock-tables --routines --triggers --events --hex-blob --skip-dump-date --result-file="/run/mysqld/$db.sql" "$db" 2>/tmp/err || { grep -q \'errno 28\' /tmp/err && exit 75; cat /tmp/err >&2; exit 76; }',
  "done",
].join("\n");

export interface BackupContainerCreatePayload {
  readonly Image: string;
  readonly Entrypoint?: readonly string[];
  readonly Cmd?: readonly string[];
  readonly User: string;
  readonly Hostname?: string;
  readonly Env: readonly string[];
  readonly Labels: Readonly<Record<string, string>>;
  readonly HostConfig: {
    readonly Privileged: false;
    readonly ReadonlyRootfs: true;
    readonly CapDrop: readonly ["ALL"];
    readonly SecurityOpt: readonly ["no-new-privileges:true"];
    readonly PidsLimit: 128;
    readonly NanoCpus: 1_000_000_000;
    readonly Memory: typeof BACKUP_JOB_MEMORY_BYTES;
    readonly MemorySwap: typeof BACKUP_JOB_MEMORY_BYTES;
    readonly RestartPolicy: { readonly Name: "no" };
    readonly Tmpfs: { readonly "/tmp": typeof BACKUP_TMPFS };
    readonly LogConfig: {
      readonly Type: "json-file";
      readonly Config: { readonly "max-size": "1m"; readonly "max-file": "1" };
    };
    readonly NetworkMode: string;
    readonly Binds: readonly string[];
  };
}

export interface BackupContainerSpec {
  readonly containerName: string;
  readonly payload: BackupContainerCreatePayload;
}

export type BackupResticRepoKind =
  | { readonly kind: "site"; readonly siteId: string }
  | { readonly kind: "panel" };

export type BackupSnapshotSummary = NonNullable<BackupJobStatus["snapshot"]>;

/** Validates that all job secret bind mounts are read-only and never target docker.sock. */
export function assertSafeSecretBinds(secretBinds: readonly string[]): void {
  if (secretBinds.some((b) => !b.endsWith(":ro") || b.includes("docker.sock"))) {
    throw new ExecutorCodedError("Job secret binds must be read-only tmpfs files", "HOST_POLICY_DENIED");
  }
}

/** Validates that secret environment entries pass file paths (*_FILE=) rather than raw values. */
export function assertSafeSecretFileEnv(secretFileEnv: readonly string[]): void {
  if (secretFileEnv.some((entry) => !entry.includes("_FILE="))) {
    throw new ExecutorCodedError("Secret env entries must reference files only", "HOST_POLICY_DENIED");
  }
}

/** Validates a host or volume bind source path before placing it in HostConfig.Binds. */
export function assertSafeBindPath(hostPath: string, field: string): string {
  if (
    typeof hostPath !== "string" ||
    hostPath.length === 0 ||
    /[\0\r\n:]/.test(hostPath) ||
    hostPath.includes("docker.sock")
  ) {
    throw new ExecutorCodedError(`Invalid ${field}`, "HOST_POLICY_DENIED");
  }
  return hostPath;
}

/** Validates an S3 region string for restic target options. */
export function assertRegion(region: string): string {
  if (!REGION_PATTERN.test(region)) {
    throw new ExecutorCodedError("Invalid storage region", "VALIDATION_ERROR");
  }
  return region;
}

function assertJobId(jobId: string): string {
  if (!BACKUP_JOB_ID_PATTERN.test(jobId)) {
    throw new ExecutorCodedError("Invalid backup jobId", "VALIDATION_ERROR");
  }
  return jobId;
}

/** Builds the standard hardened HostConfig shared across backup, restore, and archive job containers. */
export function buildBackupHostConfig(
  networkMode: string,
  binds: readonly string[],
): BackupContainerCreatePayload["HostConfig"] {
  assertSafeIdentifier(networkMode, "networkMode");
  if (binds.some((b) => b.includes("docker.sock"))) {
    throw new ExecutorCodedError("Forbidden docker.sock bind", "HOST_POLICY_DENIED");
  }
  return {
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: 128,
    NanoCpus: 1_000_000_000,
    Memory: BACKUP_JOB_MEMORY_BYTES,
    MemorySwap: BACKUP_JOB_MEMORY_BYTES,
    RestartPolicy: { Name: "no" },
    Tmpfs: { "/tmp": BACKUP_TMPFS },
    LogConfig: {
      Type: "json-file",
      Config: { "max-size": "1m", "max-file": "1" },
    },
    NetworkMode: networkMode,
    Binds: [...binds],
  };
}

/** Builds a hardened restic container create payload with S3 secret mounts and cache env. */
export function buildResticBasePayload(input: {
  readonly repoKind: BackupResticRepoKind;
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly user?: string;
  readonly extraEnv?: readonly string[];
  readonly binds?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly cmd?: readonly string[];
}): BackupContainerCreatePayload {
  assertSafeSecretBinds(input.secretBinds);
  assertSafeSecretFileEnv(input.secretFileEnv);
  const repoUrl = buildResticRepositoryUrl(input.target, input.repoKind);
  const env = [
    "GOMAXPROCS=1",
    "NICE=19",
    `RESTIC_CACHE_DIR=${BACKUP_RESTIC_CACHE_DIR}`,
    `RESTIC_REPOSITORY=${repoUrl}`,
    ...(input.extraEnv ?? []),
    ...input.secretFileEnv,
  ];
  return {
    Image: RESTIC_IMAGE,
    ...(input.entrypoint !== undefined ? { Entrypoint: input.entrypoint } : {}),
    ...(input.cmd !== undefined ? { Cmd: input.cmd } : {}),
    User: input.user ?? BACKUP_RESTIC_USER,
    Hostname: BACKUP_HOSTNAME,
    Env: env,
    Labels: input.labels,
    HostConfig: buildBackupHostConfig(input.backupNetworkName, [
      ...(input.binds ?? []),
      ...input.secretBinds,
    ]),
  };
}

/** Builds standard managed container labels for a site backup/restore/archive job. */
export function buildJobLabels(siteId: string, jobId: string): Readonly<Record<string, string>> {
  return {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": SITE_JOB_ROLE,
    "io.hostingpanel.site_id": siteId,
    "io.hostingpanel.job_id": jobId,
  };
}

/** Builds the S3 restic repository URI for a site or the panel repository. */
export function buildResticRepositoryUrl(target: BackupTarget, repo: BackupResticRepoKind): string {
  const prefixSegment = target.prefix ? `${target.prefix}/` : "";
  const suffix =
    repo.kind === "panel" ? "panel" : `sites/${assertSafeIdentifier(repo.siteId, "siteId")}`;
  return `s3:${target.endpoint}/${target.bucket}/${prefixSegment}${suffix}`;
}

/** Formats the AWS shared credentials INI file after re-checking credential characters. */
export function buildAwsSharedCredentials(accessKeyId: string, secretAccessKey: string): string {
  if (!CREDENTIAL_KEY_PATTERN.test(accessKeyId) || !CREDENTIAL_KEY_PATTERN.test(secretAccessKey)) {
    throw new ExecutorCodedError("Invalid storage credentials", "VALIDATION_ERROR");
  }
  return `[default]\naws_access_key_id = \`${accessKeyId}\`\naws_secret_access_key = \`${secretAccessKey}\`\n`;
}

/** Trims and validates the 64-hex-character backup encryption key file content. */
export function parseBackupKeyFileContent(raw: string): string | null {
  const trimmed = raw.trim();
  return BACKUP_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/** Computes the required staging volume free space in KiB rounded up. */
export function computeDumpNeedKb(
  databases: readonly { readonly sizeBytes: number }[],
  floorBytes: number = BACKUP_DISK_FREE_FLOOR_BYTES,
): number {
  let totalBytes = 0;
  for (const db of databases) {
    if (Number.isFinite(db.sizeBytes) && db.sizeBytes > 0) {
      totalBytes += Math.ceil(db.sizeBytes * BACKUP_DUMP_SIZE_FACTOR);
    }
  }
  return Math.ceil((totalBytes + floorBytes) / 1024);
}

/** Builds the Docker create payload for a backup job's staging volume. */
export function buildBackupStagingVolumePayload(input: {
  readonly jobId: string;
  readonly siteId: string;
}): { readonly Name: string; readonly Labels: Readonly<Record<string, string>> } {
  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  return {
    Name: `hp_bk_${jobId}`,
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": BACKUP_STAGING_VOLUME_ROLE,
      "io.hostingpanel.site_id": siteId,
      "io.hostingpanel.job_id": jobId,
    },
  };
}

/** Builds the container spec for the repository probe/unlock/init step of a test or job. */
export function buildBackupRepoContainerPayload(
  input:
    | {
        readonly mode: "test";
        readonly testId: string;
        readonly target: BackupTarget;
        readonly backupNetworkName: string;
        readonly secretBinds: readonly string[];
        readonly secretFileEnv: readonly string[];
      }
    | {
        readonly mode: "job";
        readonly jobId: string;
        readonly siteId: string;
        readonly init: boolean;
        readonly target: BackupTarget;
        readonly backupNetworkName: string;
        readonly secretBinds: readonly string[];
        readonly secretFileEnv: readonly string[];
      },
): BackupContainerSpec {
  const region = assertRegion(input.target.region);
  if (input.mode === "test") {
    if (!HEX_16_PATTERN.test(input.testId)) {
      throw new ExecutorCodedError("Invalid backup testId", "VALIDATION_ERROR");
    }
    const testJobId = `test_${input.testId}`;
    return {
      containerName: `hp_bk_${testJobId}`,
      payload: buildResticBasePayload({
        repoKind: { kind: "panel" },
        target: input.target,
        backupNetworkName: input.backupNetworkName,
        secretBinds: input.secretBinds,
        secretFileEnv: input.secretFileEnv,
        labels: {
          "io.hostingpanel.managed": "true",
          "io.hostingpanel.role": SITE_JOB_ROLE,
          "io.hostingpanel.job_id": testJobId,
        },
        extraEnv: [`HP_REGION=${region}`, "HP_INIT=1"],
        entrypoint: ["/bin/sh", "-c", BACKUP_REPO_TEST_SCRIPT],
      }),
    };
  }

  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  return {
    containerName: `hp_bk_${jobId}_repo`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      extraEnv: [`HP_REGION=${region}`, `HP_INIT=${input.init ? "1" : "0"}`],
      entrypoint: ["/bin/sh", "-c", BACKUP_REPO_JOB_SCRIPT],
    }),
  };
}

/** Builds the MariaDB container spec that dumps each site database into the staging volume. */
export function buildBackupDumpContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly databases: readonly { readonly name: string; readonly sizeBytes: number }[];
  readonly executorUser: string;
  readonly sharedDbRootKeyFile: string;
  readonly sharedDbNetworkName: string;
  readonly stagingVolumeName: string;
}): BackupContainerSpec {
  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  if (input.databases.length === 0) {
    throw new ExecutorCodedError("Dump container requires at least one database", "VALIDATION_ERROR");
  }
  const dbNames = input.databases.map((db) => {
    if (!SITE_DATABASE_NAME_PATTERN.test(db.name)) {
      throw new ExecutorCodedError("Invalid site database name", "VALIDATION_ERROR");
    }
    return db.name;
  });
  const rootKeyFile = assertSafeBindPath(input.sharedDbRootKeyFile, "sharedDbRootKeyFile");
  const stagingVolume = assertSafeIdentifier(input.stagingVolumeName, "stagingVolumeName");
  const needKb = computeDumpNeedKb(input.databases);

  return {
    containerName: `hp_bk_${jobId}_dump`,
    payload: {
      Image: SHARED_MARIADB_IMAGE,
      Cmd: ["sh", "-c", BACKUP_DUMP_SCRIPT],
      User: input.executorUser,
      Env: [`HP_DBS=${dbNames.join(" ")}`, `HP_NEED_KB=${String(needKb)}`],
      Labels: buildJobLabels(siteId, jobId),
      HostConfig: buildBackupHostConfig(input.sharedDbNetworkName, [
        `${rootKeyFile}:/run/secrets/mariadb-root:ro`,
        `${stagingVolume}:/run/mysqld`,
      ]),
    },
  };
}

/** Builds the restic upload container spec mounting site files and optional dumps read-only. */
export function buildBackupUploadContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly serviceInstanceId: string;
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
  readonly stagingVolumeName: string | null;
}): BackupContainerSpec {
  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const serviceInstanceId = assertSafeIdentifier(input.serviceInstanceId, "serviceInstanceId");
  const region = assertRegion(input.target.region);
  const siteVolume = getManagedVolumeName(serviceInstanceId, "html");
  const binds = [`${siteVolume}:/backup/files:ro`];
  const paths = ["/backup/files"];
  if (input.stagingVolumeName !== null) {
    const stagingVolume = assertSafeIdentifier(input.stagingVolumeName, "stagingVolumeName");
    binds.push(`${stagingVolume}:/backup/databases:ro`);
    paths.push("/backup/databases");
  }

  return {
    containerName: `hp_bk_${jobId}_up`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      binds,
      cmd: [
        "-o",
        "s3.bucket-lookup=path",
        "-o",
        `s3.region=${region}`,
        "backup",
        "-q",
        "--json",
        "--host",
        BACKUP_HOSTNAME,
        "--tag",
        jobId,
        "--exclude",
        "/backup/files/.hp_rs_*",
        "--exclude",
        "/backup/files/.htpanel-import",
        ...paths,
      ],
    }),
  };
}

/** Builds the container spec that forgets a single incomplete snapshot after restic exit 3. */
export function buildPartialSnapshotDropContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly snapshotId: string;
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const region = assertRegion(input.target.region);
  if (!SNAPSHOT_ID_PATTERN.test(input.snapshotId)) {
    throw new ExecutorCodedError("Invalid snapshot id", "VALIDATION_ERROR");
  }

  return {
    containerName: `hp_bk_${jobId}_drop`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      cmd: [
        "-o",
        "s3.bucket-lookup=path",
        "-o",
        `s3.region=${region}`,
        "forget",
        input.snapshotId,
      ],
    }),
  };
}

/** Builds the container spec that forgets and prunes specified snapshots for a site. */
export function buildBackupForgetContainerPayload(input: {
  readonly jobId: string;
  readonly siteId: string;
  readonly snapshotIds: readonly string[];
  readonly target: BackupTarget;
  readonly backupNetworkName: string;
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}): BackupContainerSpec {
  const jobId = assertJobId(input.jobId);
  const siteId = assertSafeIdentifier(input.siteId, "siteId");
  const region = assertRegion(input.target.region);
  if (
    input.snapshotIds.length === 0 ||
    input.snapshotIds.length > 100 ||
    input.snapshotIds.some((id) => !SNAPSHOT_ID_PATTERN.test(id))
  ) {
    throw new ExecutorCodedError("Invalid snapshot id list", "VALIDATION_ERROR");
  }

  return {
    containerName: `hp_bk_${jobId}_forget`,
    payload: buildResticBasePayload({
      repoKind: { kind: "site", siteId },
      target: input.target,
      backupNetworkName: input.backupNetworkName,
      secretBinds: input.secretBinds,
      secretFileEnv: input.secretFileEnv,
      labels: buildJobLabels(siteId, jobId),
      cmd: [
        "-o",
        "s3.bucket-lookup=path",
        "-o",
        `s3.region=${region}`,
        "forget",
        "--prune",
        ...input.snapshotIds,
      ],
    }),
  };
}

/** Maps a database dump container exit code to a backup failure class or null on success. */
export function classifyDumpExitCode(exitCode: number): BackupFailureClass | null {
  if (exitCode === 0) return null;
  if (exitCode === 75) return "no_space";
  if (exitCode === 124) return "timeout";
  if (exitCode === 137) return "other";
  return "database_dump_failed";
}

/** Maps restic stderr text on exit code 1 to a backup failure class (first match wins). */
export function classifyResticStderr(stderrText: string): BackupFailureClass {
  if (/SignatureDoesNotMatch|InvalidAccessKeyId/.test(stderrText)) return "auth_failed";
  if (/AccessDenied|Access Denied/.test(stderrText)) return "write_denied";
  if (/NoSuchBucket|bucket does not exist/i.test(stderrText)) return "bucket_missing";
  if (/x509|tls:/i.test(stderrText)) return "tls_failed";
  if (/no such host|connection refused|i\/o timeout|network is unreachable/i.test(stderrText)) {
    return "unreachable";
  }
  if (/no space left/i.test(stderrText)) return "no_space";
  return "other";
}

/** Maps a restic container exit code and optional stderr tail to a backup failure class or null. */
export function classifyResticExitCode(
  exitCode: number,
  stderrText = "",
): BackupFailureClass | null {
  if (exitCode === 0) return null;
  if (exitCode === 124) return "timeout";
  if (exitCode === 12) return "wrong_key";
  if (exitCode === 11) return "repository_locked";
  if (exitCode === 3) return "files_unreadable";
  if (exitCode === 10) return "other";
  if (exitCode === 1) return classifyResticStderr(stderrText);
  return "other";
}

const isNonNegSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Extracts and validates the restic JSON summary line from stdout text. */
export function parseResticSummary(stdoutText: string): BackupSnapshotSummary | null {
  const lines = stdoutText.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.message_type !== "summary") {
      continue;
    }
    if (typeof obj.snapshot_id !== "string" || !SNAPSHOT_ID_PATTERN.test(obj.snapshot_id)) {
      return null;
    }
    if (
      !isNonNegSafeInt(obj.data_added) ||
      !isNonNegSafeInt(obj.total_bytes_processed) ||
      !isNonNegSafeInt(obj.files_new) ||
      !isNonNegSafeInt(obj.files_changed) ||
      !isNonNegSafeInt(obj.files_unmodified) ||
      typeof obj.total_duration !== "number" ||
      !Number.isFinite(obj.total_duration) ||
      obj.total_duration < 0
    ) {
      return null;
    }
    const fileCount = obj.files_new + obj.files_changed + obj.files_unmodified;
    const durationMs = Math.round(obj.total_duration * 1000);
    if (!Number.isSafeInteger(fileCount) || !Number.isSafeInteger(durationMs)) {
      return null;
    }
    return {
      snapshotId: obj.snapshot_id,
      bytesAdded: obj.data_added,
      totalBytes: obj.total_bytes_processed,
      fileCount,
      durationMs,
    };
  }
  return null;
}
