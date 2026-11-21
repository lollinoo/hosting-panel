import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rm, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import {
  BackupsIpcRequestSchema,
  LEGACY_SITE_TYPE,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  SITE_DATABASE_NAME_PATTERN,
  SITE_FILE_CHUNK_BYTES,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupSiteState,
  type BackupsIpcRequest,
  type BackupsResultByAction,
  type BackupRepositoryTarget,
  type BackupTestResult,
  type SiteTypeKey,
  isLocalBackupTarget,
} from "@hosting-panel/contracts";
import {
  BACKUP_DISK_FREE_FLOOR_BYTES,
  BACKUP_FORGET_TIMEOUT_MS,
  BACKUP_DUMP_TIMEOUT_MS,
  BACKUP_MAX_RUNNING_JOBS,
  BACKUP_REPO_STEP_TIMEOUT_MS,
  BACKUP_STAGING_VOLUME_ROLE,
  BACKUP_STATUS_MAX,
  BACKUP_STATUS_TTL_MS,
  BACKUP_TEST_BUDGET_MS,
  BACKUP_UPLOAD_TIMEOUT_MS,
  type BackupContainerSpec,
  type BackupResticRepoKind,
  type GuardedLocalRepo,
  type ResolvedBackupRepository,
  buildAwsSharedCredentials,
  buildBackupDumpContainerPayload,
  buildBackupForgetContainerPayload,
  buildBackupRepoContainerPayload,
  buildBackupStagingVolumePayload,
  buildBackupUploadContainerPayload,
  buildPartialSnapshotDropContainerPayload,
  classifyDumpExitCode,
  classifyResticExitCode,
  parseBackupKeyFileContent,
  parseResticSummary,
  resolveBackupRepository,
} from "./backup-jobs.js";
import {
  BACKUP_ARCHIVE_TIMEOUT_MS,
  BACKUP_ARCHIVE_TTL_MS,
  BACKUP_RESTORE_FETCH_TIMEOUT_MS,
  BACKUP_RESTORE_FILES_TIMEOUT_MS,
  BACKUP_RESTORE_FINISH_TIMEOUT_MS,
  BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
  BACKUP_RESTORE_SETTLE_START_MS,
  BACKUP_RESTORE_SWITCH_TIMEOUT_MS,
  BACKUP_RESTORE_UNDO_TIMEOUT_MS,
  RESTORE_EXIT_INVALID_OBJECT_NAME,
  RESTORE_JOB_ID_PATTERN,
  buildArchiveContainerPayload,
  buildRestoreFetchContainerPayload,
  buildRestoreFetchFilesContainerPayload,
  buildRestoreGateContainerPayload,
  buildRestoreFilesContainerPayload,
  buildRestoreFilesFinishContainerPayload,
  buildRestoreFinishContainerPayload,
  buildRestoreOwnContainerPayload,
  buildRestorePrepareContainerPayload,
  buildRestoreSwitchContainerPayload,
  buildRestoreUndoDbContainerPayload,
  buildRestoreUndoFilesContainerPayload,
  classifyArchiveExitCode,
  classifyRestoreFetchExitCode,
  classifyRestoreFinishExitCode,
  classifyRestorePrepareExitCode,
  classifyRestoreUndoExitCode,
  readRestoreNote,
  writeRestoreNote,
  type RestoreNote,
} from "./restore-jobs.js";
import { purgeServiceSecrets, writeServiceSecrets } from "./docker-engine-adapter.js";
import {
  PANEL_DUMP_MAGIC,
  PANEL_FETCH_EXIT_NO_COPY,
  PANEL_FETCH_EXIT_NO_SPACE,
  PANEL_KEY_FILE_PATTERN,
  PANEL_LANE,
  PANEL_MASTER_KEY_SECRET,
  PANEL_RESTORE_DUMP_NAME,
  PANEL_RESTORE_KEY_NAME,
  buildPanelDropContainerPayload,
  buildPanelFetchContainerPayload,
  buildPanelFetchLocalContainerPayload,
  buildPanelKeepContainerPayload,
  buildPanelRepoContainerPayload,
  buildPanelUploadContainerPayload,
} from "./panel-jobs.js";
import { demuxDockerLogStream } from "./docker-logs.js";
import {
  guardLocalTarget,
  initLocalTarget,
  type LocalTargetGuardDeps,
  type LocalTargetIntent,
  type LocalTargetResult,
} from "./local-target-guard.js";
import { probeS3, S3_PROBE_BUDGET_MS } from "./s3-probe.js";
import { DEFAULT_SHARED_DB_DATA_DIR } from "./shared-database.js";
import { resolveExecutorSiteType, type ExecutorSiteType } from "./site-types/index.js";
import {
  ExecutorCodedError,
  assertContainedPath,
  assertSafeIdentifier,
  getManagedVolumeName,
} from "./traefik-config.js";

export const DEFAULT_BACKUP_KEY_FILE = "/etc/hosting-panel/backup.key" as const;
export const DEFAULT_BACKUP_NETWORK_NAME = "hp_backup_net" as const;
export const DEFAULT_BACKUP_WORK_DIR = "/var/lib/hosting-panel/backups" as const;
export const DEFAULT_PANEL_DUMP_DIR = "/var/lib/hosting-panel/panel-dump" as const;
export const DEFAULT_BACKUP_LOCAL_ROOT = "/var/lib/hosting-panel/local-repos" as const;

/** Directories a disaster-recovery repository (`--local-repo`) may never live in or above. */
const LOCAL_REPO_DENYLIST = ["/etc", "/proc", "/sys", "/dev", "/run", "/boot", "/root", "/var/lib/docker"] as const;
const LOCAL_REPO_DIR_CHARS = /^\/[A-Za-z0-9._@+/-]+$/;

export type DockerRequest = (
  method: string,
  path: string,
  body?: unknown,
  options?: { readonly timeoutMs?: number },
) => Promise<{ readonly statusCode: number; readonly body: Buffer }>;

export interface BackupRunnerDeps {
  readonly request: DockerRequest;
  readonly ensureImage: (image: string) => Promise<void>;
  readonly ensureBackupNetwork: () => Promise<void>;
  readonly listSiteDatabases: (
    siteId: string,
  ) => Promise<readonly { name: string; sizeBytes: number }[]>;
  readonly secretsRootDir: string;
  readonly backupKeyFile: string;
  readonly sharedDbRootKeyFile: string;
  readonly sharedDbNetworkName: string;
  readonly backupNetworkName: string;
  readonly executorUser: string;
  readonly backupWorkDir?: string;
  readonly panelDumpDir?: string;
  readonly sharedDbDataDir?: string;
  readonly statfs?: (targetPath: string) => Promise<{
    readonly bavail: number | bigint;
    readonly bsize: number | bigint;
  }>;
  /** HP_BACKUP_LOCAL_ROOT, already validated. Absent/null: every local request answers local_target_unsafe. */
  readonly localRepoRoot?: string | null;
  /** Test seam of the local target guard (free space). */
  readonly localTargetStatfs?: LocalTargetGuardDeps["statfs"];
  /** Test seam of the local target guard (write probe). */
  readonly localTargetOpen?: LocalTargetGuardDeps["open"];
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolveSiteType?: (key: SiteTypeKey) => ExecutorSiteType;
}

type StartBackupRequest = Extract<BackupsIpcRequest, { action: "start" }>;
type ForgetBackupRequest = Extract<BackupsIpcRequest, { action: "forget" }>;
type TestBackupRequest = Extract<BackupsIpcRequest, { action: "test" }>;
type LocalInitRequest = Extract<BackupsIpcRequest, { action: "localInit" }>;
type RestoreBackupRequest = Extract<BackupsIpcRequest, { action: "restore" }>;
type ArchiveBackupRequest = Extract<BackupsIpcRequest, { action: "archive" }>;
type PanelStartRequest = Extract<BackupsIpcRequest, { action: "panelStart" }>;
type SiteStateRequest = Extract<BackupsIpcRequest, { action: "siteState" }>;

export type PanelFetchProblem = BackupFailureClass | "no_copy" | "refused";

/** A panel repository directory taken from the command line (`hp-restore-panel --local-repo`); never an IPC input. */
export interface LocalPanelRepoSource {
  readonly kind: "local_repo";
  readonly repoDir: string;
}
const isLocalPanelRepoSource = (source: BackupRepositoryTarget | LocalPanelRepoSource): source is LocalPanelRepoSource =>
  "kind" in source && source.kind === "local_repo";
export type PanelFetchResult =
  | { readonly ok: true; readonly snapshotId: string; readonly time: string }
  | { readonly ok: false; readonly problem: PanelFetchProblem };

/** Identity of the dump file: any change between the check and the upload fails the job. */
interface PanelDumpIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

const PANEL_KEY_BYTES = 64n;
const PANEL_FETCH_SNAP_LINE = /^HP_SNAP ([0-9a-f]{64}) (\S+)$/m;

interface JobRecord {
  status: BackupJobStatus;
  settledAtMs: number | null;
  readonly seq: number;
}

interface ReadyArchiveRecord {
  readonly jobId: string;
  readonly siteId: string;
  readonly sizeBytes: number;
  readonly readyAtMs: number;
  readonly expiresAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface SecretMounts {
  readonly secretBinds: readonly string[];
  readonly secretFileEnv: readonly string[];
}

type ContainerOutcome =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };

type StepOutcome = ContainerOutcome | { readonly kind: "error" };

type PreparedRepository =
  | { readonly ok: true; readonly repo: ResolvedBackupRepository; readonly local?: GuardedLocalRepo }
  | { readonly ok: false; readonly problem: BackupFailureClass };

interface RestoreIds {
  readonly jobId: string;
  readonly siteId: string;
  readonly serviceInstanceId: string;
}

/** The note's siteType field: absent for the legacy type (R205 2.3). */
const noteSiteType = (key: string | undefined): { readonly siteType?: string } =>
  key === undefined || key === LEGACY_SITE_TYPE ? {} : { siteType: key };

const cloneJobStatus = (status: BackupJobStatus): BackupJobStatus => {
  const cloned: BackupJobStatus = {
    jobId: status.jobId,
    state: status.state,
    failure: status.failure,
    snapshot: status.snapshot ? { ...status.snapshot } : null,
  };
  if (status.archive) {
    cloned.archive = { ...status.archive };
  }
  return cloned;
};

function toEngineError(err: unknown, fallbackMessage: string): ExecutorCodedError {
  if (err instanceof ExecutorCodedError) {
    return err;
  }
  return new ExecutorCodedError(fallbackMessage, "DOCKER_ENGINE_UNAVAILABLE");
}

/** Coordinates backup target tests, site backup jobs, snapshot forgets, and orphan cleanup. */
export class BackupRunner {
  private readonly deps: BackupRunnerDeps;
  private readonly resolveSiteType: (key: SiteTypeKey) => ExecutorSiteType;
  private readonly backupWorkDir: string;
  private readonly restoresDir: string;
  private readonly archivesDir: string;
  private readonly sharedDbDataDir: string;
  private readonly panelDumpDir: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeSiteIds = new Set<string>();
  private readonly activeArchiveJobIds = new Set<string>();
  private readonly readyArchives = new Map<string, ReadyArchiveRecord>();
  private readonly archiveBySite = new Map<string, string>();
  private readonly pendingArchiveDeletes = new Map<string, Promise<void>>();
  private readonly settlingJobIds = new Set<string>();
  private readonly siteSettlePendingCount = new Map<string, number>();
  private activeJobCount = 0;
  private testInFlight = false;
  private nextSeq = 0;

  public constructor(deps: BackupRunnerDeps) {
    this.deps = deps;
    this.resolveSiteType = deps.resolveSiteType ?? resolveExecutorSiteType;
    this.backupWorkDir = path.resolve(deps.backupWorkDir ?? DEFAULT_BACKUP_WORK_DIR);
    this.restoresDir = path.join(this.backupWorkDir, "restores");
    this.archivesDir = path.join(this.backupWorkDir, "archives");
    this.sharedDbDataDir = path.resolve(deps.sharedDbDataDir ?? DEFAULT_SHARED_DB_DATA_DIR);
    this.panelDumpDir = path.resolve(deps.panelDumpDir ?? DEFAULT_PANEL_DUMP_DIR);
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  private logRunnerError(event: string, fields: Record<string, string | number>): void {
    console.error(
      JSON.stringify({
        component: "hp-docker-executor",
        event,
        ...fields,
        timestamp: new Date(this.nowMs()).toISOString(),
      }),
    );
  }

  private logInvalidObjectNameIfPresent(
    jobId: string,
    siteId: string,
    step: "prepare" | "switch" | "undo",
    outcome: StepOutcome,
  ): void {
    if (outcome.kind !== "exited" || outcome.exitCode !== RESTORE_EXIT_INVALID_OBJECT_NAME) {
      return;
    }
    // The script prints kind\tdb last, after any client error lines.
    const line = outcome.stderr.trim().split(/\r?\n/).at(-1) ?? "";
    const [rawKind, rawDb] = line.split("\t", 2);
    const objectKind =
      rawKind === "TABLE" ||
      rawKind === "VIEW" ||
      rawKind === "TRIGGER" ||
      rawKind === "ROUTINE" ||
      rawKind === "EVENT"
        ? rawKind
        : "unknown";
    const database =
      rawDb !== undefined && SITE_DATABASE_NAME_PATTERN.test(rawDb) ? rawDb : "unknown";
    this.logRunnerError("restore_invalid_object_name", {
      jobId,
      siteId,
      step,
      objectKind,
      database,
    });
  }

  private async ensureDir0700(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await chmod(dirPath, 0o700);
    const st = await lstat(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new ExecutorCodedError("Backup work directory must be a regular directory", "HOST_POLICY_DENIED");
    }
  }

  private async ensureBackupWorkDirs(): Promise<void> {
    await this.ensureDir0700(this.backupWorkDir);
    await this.ensureDir0700(this.restoresDir);
    await this.ensureDir0700(this.archivesDir);
  }

  private async readSharedDbRootKey(): Promise<string | null> {
    try {
      const raw = await readFile(this.deps.sharedDbRootKeyFile, "utf8");
      const trimmed = raw.replace(/[\r\n]+$/, "");
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /** The only writer of restic secrets: AWS credentials only for an S3 target, the repository password always. */
  private async writeResticSecrets(
    secretInstanceId: string,
    target: BackupRepositoryTarget | LocalPanelRepoSource,
    backupKey: string,
    trackedSecretIds: string[],
  ): Promise<SecretMounts> {
    trackedSecretIds.push(secretInstanceId);
    return writeServiceSecrets(this.deps.secretsRootDir, secretInstanceId, {
      // The frozen S3 object is the only target without a `kind`.
      ...("kind" in target
        ? {}
        : { AWS_SHARED_CREDENTIALS: buildAwsSharedCredentials(target.accessKeyId, target.secretAccessKey) }),
      RESTIC_PASSWORD: backupKey,
    });
  }

  /** Guard deps of the local targets; the executor ids come from `executorUser` (`uid:gid`). */
  private localGuardDeps(): LocalTargetGuardDeps {
    const ids = /^(\d+):(\d+)$/.exec(this.deps.executorUser);
    return {
      root: ids === null ? null : (this.deps.localRepoRoot ?? null),
      executorUid: ids === null ? -1 : Number(ids[1]),
      executorGid: ids === null ? -1 : Number(ids[2]),
      ...(this.deps.localTargetStatfs ? { statfs: this.deps.localTargetStatfs } : {}),
      ...(this.deps.localTargetOpen ? { open: this.deps.localTargetOpen } : {}),
    };
  }

  /**
   * The repository of one job: S3 targets are probed (exact existing call), local targets pass the guard right before
   * the first container that binds them. Either way the result is the resolved repository the builders take.
   */
  private async prepareRepository(
    target: BackupRepositoryTarget,
    scope: BackupResticRepoKind,
    intent: LocalTargetIntent,
    extraBytes: number,
    s3BudgetMs?: number,
  ): Promise<PreparedRepository> {
    if (isLocalBackupTarget(target)) {
      return this.resolveGuarded(
        target,
        scope,
        await guardLocalTarget(this.localGuardDeps(), {
          targetId: target.targetId,
          scope,
          intent,
          requiredExtraBytes: extraBytes,
        }),
      );
    }
    const probe = await probeS3(target, {
      fetch: this.deps.fetch,
      now: () => new Date(this.nowMs()),
      ...(s3BudgetMs === undefined ? {} : { budgetMs: s3BudgetMs }),
    });
    if (probe.problem !== null) return { ok: false, problem: probe.problem };
    return {
      ok: true,
      repo: resolveBackupRepository(target, scope, { backupNetworkName: this.deps.backupNetworkName }),
    };
  }

  private resolveGuarded(
    target: BackupRepositoryTarget,
    scope: BackupResticRepoKind,
    guarded: LocalTargetResult<GuardedLocalRepo>,
  ): PreparedRepository {
    if (!guarded.ok) return { ok: false, problem: guarded.problem };
    return {
      ok: true,
      repo: resolveBackupRepository(target, scope, {
        backupNetworkName: this.deps.backupNetworkName,
        local: guarded.repo,
      }),
      local: guarded.repo,
    };
  }

  /** Only an S3 repository needs the backup network; a local one runs with none. */
  private async ensureNetworkFor(repo: ResolvedBackupRepository): Promise<void> {
    if (repo.kind === "s3") await this.deps.ensureBackupNetwork();
  }

  private async writeDbSecrets(
    secretInstanceId: string,
    trackedSecretIds: string[],
  ): Promise<SecretMounts | null> {
    const dbRootKey = await this.readSharedDbRootKey();
    if (dbRootKey === null) {
      return null;
    }
    trackedSecretIds.push(secretInstanceId);
    return writeServiceSecrets(this.deps.secretsRootDir, secretInstanceId, {
      MARIADB_ROOT: dbRootKey,
    });
  }

  private evictJobs(): void {
    const now = this.nowMs();
    const settled: Array<[string, JobRecord]> = [];
    for (const [id, entry] of this.jobs) {
      if (entry.settledAtMs === null) continue;
      if (now - entry.settledAtMs > BACKUP_STATUS_TTL_MS) {
        this.jobs.delete(id);
      } else {
        settled.push([id, entry]);
      }
    }
    if (this.jobs.size <= BACKUP_STATUS_MAX) return;
    settled.sort(
      (a, b) => (a[1].settledAtMs ?? 0) - (b[1].settledAtMs ?? 0) || a[1].seq - b[1].seq,
    );
    let excess = this.jobs.size - BACKUP_STATUS_MAX;
    for (const [id] of settled) {
      if (excess <= 0) break;
      this.jobs.delete(id);
      excess -= 1;
    }
  }

  private async readBackupKey(): Promise<string | null> {
    try {
      const raw = await readFile(this.deps.backupKeyFile, "utf8");
      return parseBackupKeyFileContent(raw);
    } catch {
      return null;
    }
  }

  private async callDocker(
    method: string,
    path: string,
    body?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<{ readonly statusCode: number; readonly body: Buffer }> {
    try {
      return await this.deps.request(method, path, body, options);
    } catch (err) {
      throw toEngineError(err, `Docker request failed (${method} ${path})`);
    }
  }

  private async tryEnsureImage(
    image: string,
    timeoutMs?: number,
  ): Promise<"ok" | "tool_unavailable" | "timeout"> {
    if (timeoutMs === undefined) {
      try {
        await this.deps.ensureImage(image);
        return "ok";
      } catch {
        return "tool_unavailable";
      }
    }
    if (timeoutMs <= 0) {
      return "timeout";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.deps.ensureImage(image).then(
          () => "ok" as const,
          () => "tool_unavailable" as const,
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readContainerLogStream(
    containerRef: string,
    stream: "stdout" | "stderr",
    tail: number,
  ): Promise<string> {
    const qs = `stdout=${stream === "stdout" ? "1" : "0"}&stderr=${stream === "stderr" ? "1" : "0"}&tail=${String(tail)}`;
    const res = await this.callDocker(
      "GET",
      `/containers/${encodeURIComponent(containerRef)}/logs?${qs}`,
    );
    if (res.statusCode !== 200) return "";
    return demuxDockerLogStream(res.body)
      .map((line) => line.text)
      .join("\n");
  }

  private async runContainer(
    spec: BackupContainerSpec,
    createdRefs: string[],
    timeoutMs: number,
    options?: {
      readonly captureStdout?: boolean;
      readonly captureStderr?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<ContainerOutcome> {
    const containerName = spec.containerName;
    let createRes: Awaited<ReturnType<DockerRequest>>;
    try {
      createRes = await this.callDocker(
        "POST",
        `/containers/create?name=${encodeURIComponent(containerName)}`,
        spec.payload,
      );
    } catch (err) {
      // Remove by name right away in case the engine created the container before failing.
      await this.deps
        .request("DELETE", `/containers/${encodeURIComponent(containerName)}?force=true&v=true`)
        .catch(() => undefined);
      throw err;
    }
    if (createRes.statusCode === 404) {
      return { kind: "not_found" };
    }
    if (createRes.statusCode !== 201) {
      throw new ExecutorCodedError("Failed to create backup container", "DOCKER_ENGINE_UNAVAILABLE");
    }

    let containerRef = containerName;
    try {
      const parsed = JSON.parse(createRes.body.toString("utf8")) as { Id?: unknown };
      if (typeof parsed.Id === "string" && parsed.Id.length > 0) {
        containerRef = parsed.Id;
      }
    } catch {
      containerRef = spec.containerName;
    }
    createdRefs.push(containerRef);

    const startRes = await this.callDocker(
      "POST",
      `/containers/${encodeURIComponent(containerRef)}/start`,
    );
    if (startRes.statusCode !== 204 && startRes.statusCode !== 304) {
      throw new ExecutorCodedError("Failed to start backup container", "DOCKER_ENGINE_UNAVAILABLE");
    }

    const waitMs = Math.max(1, Math.floor(timeoutMs));
    const waitPromise = this.callDocker(
      "POST",
      `/containers/${encodeURIComponent(containerRef)}/wait`,
      undefined,
      { timeoutMs: waitMs + 15_000 },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
      // An abort (the fetch CLI stopped) ends the wait the same way as the timeout.
      if (options?.signal?.aborted) resolve("timeout");
      options?.signal?.addEventListener("abort", () => resolve("timeout"), { once: true });
    });

    try {
      const raced = await Promise.race([waitPromise, timeoutPromise]);
      if (raced === "timeout") {
        // Attach a rejection sink before kill so a late wait failure cannot leak unhandled.
        waitPromise.catch(() => undefined);
        await this.deps
          .request("POST", `/containers/${encodeURIComponent(containerRef)}/kill`)
          .catch(() => undefined);
        return { kind: "exited", exitCode: 124, stdout: "", stderr: "" };
      }

      if (raced.statusCode !== 200) {
        throw new ExecutorCodedError("Backup container wait failed", "DOCKER_ENGINE_UNAVAILABLE");
      }
      let exitCode: unknown;
      try {
        exitCode = (JSON.parse(raced.body.toString("utf8")) as { StatusCode?: unknown }).StatusCode;
      } catch {
        throw new ExecutorCodedError("Invalid backup container wait response", "DOCKER_ENGINE_UNAVAILABLE");
      }
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
        throw new ExecutorCodedError("Invalid backup container exit code", "DOCKER_ENGINE_UNAVAILABLE");
      }

      const stdout = options?.captureStdout
        ? await this.readContainerLogStream(containerRef, "stdout", 20)
        : "";
      const stderr =
        options?.captureStderr && exitCode !== 0
          ? await this.readContainerLogStream(containerRef, "stderr", 50)
          : "";
      return { kind: "exited", exitCode, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async tryRunContainer(
    spec: BackupContainerSpec,
    createdRefs: string[],
    timeoutMs: number,
    options?: { readonly captureStdout?: boolean; readonly captureStderr?: boolean },
  ): Promise<StepOutcome> {
    try {
      return await this.runContainer(spec, createdRefs, timeoutMs, options);
    } catch {
      return { kind: "error" };
    }
  }

  private async cleanupContainersAndSecrets(
    createdRefs: readonly string[],
    stagingVolumeName: string | null,
    secretInstanceIds: string | readonly string[] | null,
  ): Promise<void> {
    for (const ref of createdRefs) {
      await this.deps
        .request("DELETE", `/containers/${encodeURIComponent(ref)}?force=true&v=true`)
        .catch(() => undefined);
    }
    if (stagingVolumeName !== null) {
      await this.deps
        .request("DELETE", `/volumes/${encodeURIComponent(stagingVolumeName)}`)
        .catch(() => undefined);
    }
    const ids =
      secretInstanceIds === null
        ? []
        : typeof secretInstanceIds === "string"
          ? [secretInstanceIds]
          : secretInstanceIds;
    for (const secretId of ids) {
      await purgeServiceSecrets(this.deps.secretsRootDir, secretId).catch(() => undefined);
    }
  }

  /** `test` (any target) and `localInit` (creates the local target first, then tests it like `test`). */
  private async executeTest(req: TestBackupRequest | LocalInitRequest): Promise<BackupTestResult> {
    if (this.testInFlight) {
      throw new ExecutorCodedError("A storage test is already running", "RESOURCE_LOCKED");
    }
    this.testInFlight = true;
    const deadline = this.nowMs() + BACKUP_TEST_BUDGET_MS;
    const createdRefs: string[] = [];
    const secretIds: string[] = [];

    try {
      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        return { outcome: "failed", problem: "key_file_missing" };
      }

      const remainingBeforeS3 = deadline - this.nowMs();
      if (remainingBeforeS3 <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      const panelScope: BackupResticRepoKind = { kind: "panel" };
      const prepared =
        req.action === "localInit"
          ? this.resolveGuarded(
              req.target,
              panelScope,
              await initLocalTarget(this.localGuardDeps(), req.target.targetId),
            )
          : await this.prepareRepository(
              req.target,
              panelScope,
              "test",
              0,
              Math.min(S3_PROBE_BUDGET_MS, remainingBeforeS3),
            );
      if (!prepared.ok) {
        return { outcome: "failed", problem: prepared.problem };
      }
      const { repo } = prepared;

      if (deadline - this.nowMs() <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      const pullOutcome = await this.tryEnsureImage(RESTIC_IMAGE, deadline - this.nowMs());
      if (pullOutcome !== "ok") {
        return { outcome: "failed", problem: pullOutcome };
      }
      if (deadline - this.nowMs() <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      try {
        await this.ensureNetworkFor(repo);
      } catch (err) {
        throw toEngineError(err, "Docker engine is unavailable for backup test");
      }

      const remainingAfterPrep = deadline - this.nowMs();
      if (remainingAfterPrep <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      const testId = randomBytes(8).toString("hex");
      const { secretBinds, secretFileEnv } = await this.writeResticSecrets(
        `job_bk_test_${testId}`,
        req.target,
        backupKey,
        secretIds,
      );

      const spec = buildBackupRepoContainerPayload({
        mode: "test",
        testId,
        repo,
        // A local repository belongs to the executor's group: its test runs as the executor, an S3 one keeps the default.
        ...(repo.kind === "local" ? { user: this.deps.executorUser } : {}),
        secretBinds,
        secretFileEnv,
      });

      const outcome = await this.runContainer(spec, createdRefs, remainingAfterPrep, {
        captureStderr: true,
      });
      if (outcome.kind === "not_found") {
        return { outcome: "failed", problem: "tool_unavailable" };
      }

      const problem = classifyResticExitCode(outcome.exitCode, outcome.stderr, repo.kind);
      if (problem !== null) {
        return { outcome: "failed", problem };
      }
      return prepared.local === undefined
        ? { outcome: "ok", problem: null }
        : {
            outcome: "ok",
            problem: null,
            availableBytes: prepared.local.availableBytes,
            totalBytes: prepared.local.totalBytes,
            ...(this.deps.localRepoRoot ? { localRoot: this.deps.localRepoRoot } : {}),
          };
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, null, secretIds);
      this.testInFlight = false;
    }
  }

  private startBackgroundJob(
    siteId: string,
    jobId: string,
    runner: (entry: JobRecord) => Promise<void>,
  ): BackupJobStatus {
    this.evictJobs();
    const existing = this.jobs.get(jobId);
    if (existing) {
      return cloneJobStatus(existing.status);
    }
    if (this.activeSiteIds.has(siteId) || this.activeJobCount >= BACKUP_MAX_RUNNING_JOBS) {
      throw new ExecutorCodedError(
        "Another backup job is already in progress",
        "RESOURCE_LOCKED",
      );
    }

    this.activeSiteIds.add(siteId);
    this.activeJobCount += 1;
    const initial: BackupJobStatus = {
      jobId,
      state: "running",
      failure: null,
      snapshot: null,
    };
    this.nextSeq += 1;
    const entry: JobRecord = { status: initial, settledAtMs: null, seq: this.nextSeq };
    this.jobs.set(jobId, entry);

    void runner(entry);
    return cloneJobStatus(initial);
  }

  private settleEntry(
    entry: JobRecord,
    state: "succeeded" | "failed",
    failure: BackupJobStatus["failure"],
    snapshot: BackupJobStatus["snapshot"],
    archive?: BackupJobStatus["archive"],
  ): void {
    const next: BackupJobStatus = {
      jobId: entry.status.jobId,
      state,
      failure,
      snapshot: snapshot ? { ...snapshot } : null,
    };
    if (archive) {
      next.archive = { ...archive };
    }
    entry.status = next;
    entry.settledAtMs = this.nowMs();
  }

  private async runBackupJob(req: StartBackupRequest, t: ExecutorSiteType, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    const secretIds: string[] = [];
    let stagingVolumeName: string | null = null;
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "other";
    let finalSnapshot: BackupJobStatus["snapshot"] = null;
    const scope: BackupResticRepoKind = { kind: "site", siteId: req.siteId };
    const setOutcome = (
      state: "succeeded" | "failed",
      failure: BackupJobStatus["failure"],
      snapshot: BackupJobStatus["snapshot"],
    ): void => {
      finalState = state;
      finalFailure = failure;
      finalSnapshot = snapshot;
    };

    try {
      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        setOutcome("failed", "key_file_missing", null);
        return;
      }

      // S3 is probed first as ever; a local target is guarded once the database sizes are known (below).
      let prepared: PreparedRepository | null = null;
      if (!isLocalBackupTarget(req.target)) {
        prepared = await this.prepareRepository(req.target, scope, "backup", 0);
        if (!prepared.ok) {
          setOutcome("failed", prepared.problem, null);
          return;
        }
      }

      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }
      if (prepared !== null) await this.ensureNetworkFor(prepared.repo);

      const siteVolume = getManagedVolumeName(req.serviceInstanceId, t.def.files.volumeSuffix);
      const siteVolRes = await this.callDocker(
        "GET",
        `/volumes/${encodeURIComponent(siteVolume)}`,
      );
      if (siteVolRes.statusCode !== 200) {
        setOutcome("failed", "other", null);
        return;
      }

      let databases: readonly { name: string; sizeBytes: number }[];
      try {
        databases = t.def.database === null ? [] : await this.deps.listSiteDatabases(req.siteId);
      } catch {
        setOutcome("failed", "database_dump_failed", null);
        return;
      }
      if (databases.length > 0 && (await this.tryEnsureImage(SHARED_MARIADB_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }

      if (prepared === null) {
        const dumpBytes = databases.reduce(
          (sum, db) => sum + (Number.isFinite(db.sizeBytes) && db.sizeBytes > 0 ? Math.ceil(db.sizeBytes) : 0),
          0,
        );
        prepared = await this.prepareRepository(req.target, scope, "backup", dumpBytes);
        if (!prepared.ok) {
          setOutcome("failed", prepared.problem, null);
          return;
        }
      }
      const { repo } = prepared;

      const { secretBinds, secretFileEnv } = await this.writeResticSecrets(
        `job_bk_${req.jobId}`,
        req.target,
        backupKey,
        secretIds,
      );

      const repoSpec = buildBackupRepoContainerPayload({
        mode: "job",
        jobId: req.jobId,
        siteId: req.siteId,
        init: true,
        repo,
        secretBinds,
        secretFileEnv,
      });
      const repoOutcome = await this.runContainer(
        repoSpec,
        createdRefs,
        BACKUP_REPO_STEP_TIMEOUT_MS,
        { captureStderr: true },
      );
      if (repoOutcome.kind === "not_found") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }
      const repoProblem = classifyResticExitCode(repoOutcome.exitCode, repoOutcome.stderr, repo.kind);
      if (repoProblem !== null) {
        setOutcome("failed", repoProblem, null);
        return;
      }

      if (databases.length > 0) {
        const volPayload = buildBackupStagingVolumePayload({
          jobId: req.jobId,
          siteId: req.siteId,
        });
        const volName = volPayload.Name;
        let volCreate: Awaited<ReturnType<DockerRequest>>;
        try {
          volCreate = await this.callDocker("POST", "/volumes/create", volPayload);
        } catch (err) {
          // Remove by name right away in case the engine created the volume before failing.
          await this.deps
            .request("DELETE", `/volumes/${encodeURIComponent(volName)}`)
            .catch(() => undefined);
          throw err;
        }
        if (volCreate.statusCode !== 201) {
          setOutcome("failed", "other", null);
          return;
        }
        stagingVolumeName = volName;

        const dumpSpec = buildBackupDumpContainerPayload({
          jobId: req.jobId,
          siteId: req.siteId,
          databases,
          executorUser: this.deps.executorUser,
          sharedDbRootKeyFile: this.deps.sharedDbRootKeyFile,
          sharedDbNetworkName: this.deps.sharedDbNetworkName,
          stagingVolumeName,
        });
        const dumpOutcome = await this.runContainer(dumpSpec, createdRefs, BACKUP_DUMP_TIMEOUT_MS);
        if (dumpOutcome.kind === "not_found") {
          setOutcome("failed", "tool_unavailable", null);
          return;
        }
        const dumpProblem = classifyDumpExitCode(dumpOutcome.exitCode);
        if (dumpProblem !== null) {
          setOutcome("failed", dumpProblem, null);
          return;
        }
      }

      const uploadSpec = buildBackupUploadContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        serviceInstanceId: req.serviceInstanceId,
        siteType: t,
        repo,
        secretBinds,
        secretFileEnv,
        stagingVolumeName,
      });
      const uploadOutcome = await this.runContainer(
        uploadSpec,
        createdRefs,
        BACKUP_UPLOAD_TIMEOUT_MS,
        { captureStdout: true, captureStderr: true },
      );
      if (uploadOutcome.kind === "not_found") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }

      if (uploadOutcome.exitCode === 0) {
        const summary = parseResticSummary(uploadOutcome.stdout);
        if (summary === null) {
          setOutcome("failed", "other", null);
          return;
        }
        setOutcome("succeeded", null, summary);
        return;
      }

      if (uploadOutcome.exitCode === 3) {
        const partial = parseResticSummary(uploadOutcome.stdout);
        if (partial !== null) {
          try {
            const dropSpec = buildPartialSnapshotDropContainerPayload({
              jobId: req.jobId,
              siteId: req.siteId,
              snapshotId: partial.snapshotId,
              repo,
              secretBinds,
              secretFileEnv,
            });
            await this.runContainer(dropSpec, createdRefs, BACKUP_REPO_STEP_TIMEOUT_MS);
          } catch {
            // Partial snapshot forget is best-effort before reporting files_unreadable.
          }
        }
        setOutcome("failed", "files_unreadable", null);
        return;
      }

      const uploadProblem =
        classifyResticExitCode(uploadOutcome.exitCode, uploadOutcome.stderr, repo.kind) ?? "other";
      setOutcome("failed", uploadProblem, null);
    } catch {
      setOutcome("failed", "other", null);
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, stagingVolumeName, secretIds);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      // Settle only after cleanup and locks are released so status polls never observe pre-release state.
      this.settleEntry(entry, finalState, finalFailure, finalSnapshot);
    }
  }

  private async runForgetJob(req: ForgetBackupRequest, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    const secretIds: string[] = [];
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "other";
    const setOutcome = (
      state: "succeeded" | "failed",
      failure: BackupJobStatus["failure"],
    ): void => {
      finalState = state;
      finalFailure = failure;
    };

    try {
      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        setOutcome("failed", "key_file_missing");
        return;
      }

      const prepared = await this.prepareRepository(req.target, { kind: "site", siteId: req.siteId }, "forget", 0);
      if (!prepared.ok) {
        setOutcome("failed", prepared.problem);
        return;
      }
      const { repo } = prepared;

      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable");
        return;
      }
      await this.ensureNetworkFor(repo);

      const { secretBinds, secretFileEnv } = await this.writeResticSecrets(
        `job_bk_${req.jobId}`,
        req.target,
        backupKey,
        secretIds,
      );

      const repoSpec = buildBackupRepoContainerPayload({
        mode: "job",
        jobId: req.jobId,
        siteId: req.siteId,
        init: false,
        repo,
        secretBinds,
        secretFileEnv,
      });
      const repoOutcome = await this.runContainer(
        repoSpec,
        createdRefs,
        BACKUP_REPO_STEP_TIMEOUT_MS,
        { captureStderr: true },
      );
      if (repoOutcome.kind === "not_found") {
        setOutcome("failed", "tool_unavailable");
        return;
      }
      if (repoOutcome.exitCode === 10) {
        // Missing site repository means no remote snapshots remain to remove.
        setOutcome("succeeded", null);
        return;
      }
      const repoProblem = classifyResticExitCode(repoOutcome.exitCode, repoOutcome.stderr, repo.kind);
      if (repoProblem !== null) {
        setOutcome("failed", repoProblem);
        return;
      }

      const forgetSpec = buildBackupForgetContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        snapshotIds: req.snapshotIds,
        repo,
        secretBinds,
        secretFileEnv,
      });
      const forgetOutcome = await this.runContainer(
        forgetSpec,
        createdRefs,
        BACKUP_FORGET_TIMEOUT_MS,
        { captureStderr: true },
      );
      if (forgetOutcome.kind === "not_found") {
        setOutcome("failed", "tool_unavailable");
        return;
      }
      const forgetProblem = classifyResticExitCode(forgetOutcome.exitCode, forgetOutcome.stderr, repo.kind);
      if (forgetProblem !== null) {
        setOutcome("failed", forgetProblem);
        return;
      }
      setOutcome("succeeded", null);
    } catch {
      setOutcome("failed", "other");
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, null, secretIds);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, null);
    }
  }

  private async createStagingVolume(jobId: string, siteId: string): Promise<string | null> {
    const volPayload = buildBackupStagingVolumePayload({ jobId, siteId });
    const volName = volPayload.Name;
    let volCreate: Awaited<ReturnType<DockerRequest>>;
    try {
      volCreate = await this.callDocker("POST", "/volumes/create", volPayload);
    } catch (err) {
      // Remove by name right away in case the engine created the volume before failing.
      await this.deps
        .request("DELETE", `/volumes/${encodeURIComponent(volName)}`)
        .catch(() => undefined);
      throw err;
    }
    return volCreate.statusCode === 201 ? volName : null;
  }

  private async deleteStagingVolume(volumeName: string): Promise<void> {
    const delRes = await this.callDocker("DELETE", `/volumes/${encodeURIComponent(volumeName)}`);
    if (delRes.statusCode !== 204 && delRes.statusCode !== 404) {
      throw new ExecutorCodedError(
        "Failed to delete backup staging volume",
        "DOCKER_ENGINE_UNAVAILABLE",
      );
    }
  }

  private parseFetchDumpKiB(stdout: string): number | null {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const candidate = lines[i]!;
      if (/^\d+$/.test(candidate)) {
        const parsed = Number(candidate);
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
          return parsed;
        }
      }
    }
    return null;
  }

  private async checkDbDiskSpace(dumpKiB: number): Promise<"ok" | "no_space" | "error"> {
    try {
      const stats = await (this.deps.statfs ?? statfs)(this.sharedDbDataDir);
      const freeBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
      const needBytes = BigInt(dumpKiB) * 1024n + BigInt(BACKUP_DISK_FREE_FLOOR_BYTES);
      return freeBytes >= needBytes ? "ok" : "no_space";
    } catch {
      return "error";
    }
  }

  /** The step that removes the restore dir: the database finish, or the files finish of a type without a database. */
  private restoreFinishSpec(t: ExecutorSiteType, ids: RestoreIds, dbSecret: SecretMounts | null): BackupContainerSpec {
    const base = { jobId: ids.jobId, siteId: ids.siteId, serviceInstanceId: ids.serviceInstanceId, siteType: t };
    if (t.def.database === null) return buildRestoreFilesFinishContainerPayload(base);
    if (dbSecret === null) throw new ExecutorCodedError("Database secret missing", "INTERNAL_ERROR");
    return buildRestoreFinishContainerPayload({
      ...base,
      sharedDbNetworkName: this.deps.sharedDbNetworkName,
      secretBinds: dbSecret.secretBinds,
      secretFileEnv: dbSecret.secretFileEnv,
    });
  }

  private async runPreSwitchUndoDb(
    t: ExecutorSiteType,
    input: RestoreIds & { readonly stagingVolumeName: string },
    dbSecret: SecretMounts | null,
    createdRefs: string[],
  ): Promise<void> {
    if (t.def.database === null) {
      await this.tryRunContainer(this.restoreFinishSpec(t, input, null), createdRefs, BACKUP_RESTORE_UNDO_TIMEOUT_MS);
      return;
    }
    if (dbSecret === null) return;
    const undoDbSpec = buildRestoreUndoDbContainerPayload({
      jobId: input.jobId,
      siteId: input.siteId,
      siteType: t,
      stagingVolumeName: input.stagingVolumeName,
      sharedDbNetworkName: this.deps.sharedDbNetworkName,
      secretBinds: dbSecret.secretBinds,
      secretFileEnv: dbSecret.secretFileEnv,
    });
    const undo = await this.tryRunContainer(undoDbSpec, createdRefs, BACKUP_RESTORE_UNDO_TIMEOUT_MS);
    if (undo.kind === "exited" && classifyRestoreUndoExitCode(undo.exitCode) === null) {
      await this.tryRunContainer(this.restoreGateSpec(t, input, "end"), createdRefs, BACKUP_RESTORE_UNDO_TIMEOUT_MS);
    }
  }

  /** The type's maintenance gate in its own container: the site volume only (C2). */
  private restoreGateSpec(t: ExecutorSiteType, ids: RestoreIds, step: "on" | "undo" | "end"): BackupContainerSpec {
    return buildRestoreGateContainerPayload({ step, jobId: ids.jobId, siteId: ids.siteId, serviceInstanceId: ids.serviceInstanceId, siteType: t });
  }

  private async runSwitchUndoSequence(
    t: ExecutorSiteType,
    input: RestoreIds & { readonly stagingVolumeName: string },
    dbSecret: SecretMounts | null,
    createdRefs: string[],
  ): Promise<"switch_undone" | "undo_incomplete"> {
    const undoFilesSpec = buildRestoreUndoFilesContainerPayload({
      jobId: input.jobId,
      siteId: input.siteId,
      siteType: t,
      serviceInstanceId: input.serviceInstanceId,
    });
    const filesOutcome = await this.tryRunContainer(
      undoFilesSpec,
      createdRefs,
      BACKUP_RESTORE_UNDO_TIMEOUT_MS,
    );
    if (
      filesOutcome.kind !== "exited" ||
      classifyRestoreUndoExitCode(filesOutcome.exitCode) !== null
    ) {
      return "undo_incomplete";
    }

    if (t.def.database === null) {
      const finish = await this.tryRunContainer(
        this.restoreFinishSpec(t, input, null),
        createdRefs,
        BACKUP_RESTORE_UNDO_TIMEOUT_MS,
      );
      return finish.kind === "exited" && classifyRestoreFinishExitCode(finish.exitCode) === null
        ? "switch_undone"
        : "undo_incomplete";
    }
    if (dbSecret === null) return "undo_incomplete";
    const gateOn = await this.tryRunContainer(this.restoreGateSpec(t, input, "undo"), createdRefs, BACKUP_RESTORE_UNDO_TIMEOUT_MS);
    if (gateOn.kind !== "exited" || gateOn.exitCode !== 0) return "undo_incomplete";
    const undoDbSpec = buildRestoreUndoDbContainerPayload({
      jobId: input.jobId,
      siteId: input.siteId,
      siteType: t,
      stagingVolumeName: input.stagingVolumeName,
      sharedDbNetworkName: this.deps.sharedDbNetworkName,
      secretBinds: dbSecret.secretBinds,
      secretFileEnv: dbSecret.secretFileEnv,
    });
    const dbOutcome = await this.tryRunContainer(
      undoDbSpec,
      createdRefs,
      BACKUP_RESTORE_UNDO_TIMEOUT_MS,
      { captureStderr: true },
    );
    this.logInvalidObjectNameIfPresent(input.jobId, input.siteId, "undo", dbOutcome);
    if (
      dbOutcome.kind !== "exited" ||
      classifyRestoreUndoExitCode(dbOutcome.exitCode) !== null
    ) {
      return "undo_incomplete";
    }
    const gateEnd = await this.tryRunContainer(this.restoreGateSpec(t, input, "end"), createdRefs, BACKUP_RESTORE_UNDO_TIMEOUT_MS);
    return gateEnd.kind === "exited" && gateEnd.exitCode === 0 ? "switch_undone" : "undo_incomplete";
  }

  private async listRestoreNotesSafe(opts: {
    readonly logErrors: boolean;
  }): Promise<readonly RestoreNote[]> {
    let entries;
    try {
      entries = await readdir(this.restoresDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const notes: RestoreNote[] = [];
    for (const entry of sorted) {
      if (!entry.name.endsWith(".json")) continue;
      const stem = entry.name.slice(0, -".json".length);
      if (!RESTORE_JOB_ID_PATTERN.test(stem)) {
        if (opts.logErrors) {
          this.logRunnerError("restore_note_unreadable", { noteName: entry.name.slice(0, 48) });
        }
        continue;
      }
      try {
        const note = await readRestoreNote(this.restoresDir, stem);
        if (note) {
          notes.push(note);
        }
      } catch (err) {
        if (opts.logErrors) {
          this.logRunnerError("restore_note_unreadable", {
            jobId: stem,
            code: (err as { code?: string } | null)?.code ?? "VALIDATION_ERROR",
          });
        }
      }
    }
    return notes;
  }

  private notePathForJob(jobId: string): string {
    return assertContainedPath(this.restoresDir, path.join(this.restoresDir, `${jobId}.json`));
  }

  private endedRestoreNote(
    meta: RestoreIds & { readonly siteType?: string },
    state: "succeeded" | "failed",
    failure: BackupFailureClass | null,
  ): RestoreNote {
    return {
      v: 1,
      jobId: meta.jobId,
      siteId: meta.siteId,
      serviceInstanceId: meta.serviceInstanceId,
      ...noteSiteType(meta.siteType),
      stage: "ended",
      state,
      failure,
      endedAt: new Date(this.nowMs()).toISOString(),
    };
  }

  /** True when the note is now ended or gone: a failed write deletes it, so a stale note never outlives the job (R124), then retries once in the freed room (R125). */
  private async writeEndedRestoreNote(ended: RestoreNote): Promise<boolean> {
    const log = (event: string) => (err: unknown) => {
      this.logRunnerError(event, {
        jobId: ended.jobId,
        code: (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR",
      });
      return false;
    };
    if (await writeRestoreNote(this.restoresDir, ended).then(() => true, log("restore_note_write_failed"))) return true;
    const removed = await unlink(this.notePathForJob(ended.jobId)).then(
      () => true,
      (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT" || log("restore_note_remove_failed")(err),
    );
    if (removed) await writeRestoreNote(this.restoresDir, ended).catch(log("restore_note_write_failed"));
    return removed;
  }

  /** Creates the missing site files volume and gives it to the type's owner; false when either step fails. */
  private async createSiteVolume(
    req: RestoreBackupRequest,
    t: ExecutorSiteType,
    createdRefs: string[],
  ): Promise<boolean> {
    const res = await this.callDocker("POST", "/volumes/create", {
      Name: getManagedVolumeName(req.serviceInstanceId, t.def.files.volumeSuffix),
      Labels: {
        "io.hostingpanel.managed": "true",
        "io.hostingpanel.site_id": req.siteId,
        "io.hostingpanel.service_instance_id": req.serviceInstanceId,
      },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) return false;
    const own = await this.tryRunContainer(
      buildRestoreOwnContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        siteType: t,
        serviceInstanceId: req.serviceInstanceId,
      }),
      createdRefs,
      BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
    );
    return own.kind === "exited" && own.exitCode === 0;
  }

  /** Removes the site files volume this restore created; a failure leaves it empty (R122: no retry). */
  private async removeCreatedVolume(ended: RestoreNote, t: ExecutorSiteType): Promise<void> {
    const volume = getManagedVolumeName(ended.serviceInstanceId, t.def.files.volumeSuffix);
    const res = await this.deps
      .request("DELETE", `/volumes/${encodeURIComponent(volume)}`)
      .catch(() => null);
    if (res !== null && (res.statusCode === 204 || res.statusCode === 404)) return;
    this.logRunnerError("restore_created_volume_remove_failed", { jobId: ended.jobId });
  }

  private async readStatusFromNote(jobId: string): Promise<BackupJobStatus | null> {
    if (!RESTORE_JOB_ID_PATTERN.test(jobId)) return null;
    try {
      const note = await readRestoreNote(this.restoresDir, jobId);
      if (!note) return null;
      if (note.stage === "ended") {
        const isUndoIncomplete = note.state === "failed" && note.failure === "undo_incomplete";
        const endedMs = Date.parse(note.endedAt ?? "");
        if (
          !isUndoIncomplete &&
          (!Number.isFinite(endedMs) || this.nowMs() - endedMs > BACKUP_STATUS_TTL_MS)
        ) {
          return null;
        }
        return {
          jobId: note.jobId,
          state: note.state!,
          failure: note.failure ?? null,
          snapshot: null,
        };
      }
      if (note.stage === "switched") {
        return {
          jobId: note.jobId,
          state: "succeeded",
          failure: null,
          snapshot: null,
        };
      }
      return {
        jobId: note.jobId,
        state: "running",
        failure: null,
        snapshot: null,
      };
    } catch (err) {
      this.logRunnerError("restore_note_unreadable", {
        jobId,
        code: (err as { code?: string } | null)?.code ?? "VALIDATION_ERROR",
      });
      return null;
    }
  }

  private async cleanupSameSiteUndoIncomplete(
    siteId: string,
    currentJobId: string,
    dbSecret: SecretMounts | null,
  ): Promise<void> {
    const notes = await this.listRestoreNotesSafe({ logErrors: false }).catch(() => []);
    for (const note of notes) {
      if (
        note.siteId !== siteId ||
        note.jobId === currentJobId ||
        note.stage !== "ended" ||
        note.state !== "failed" ||
        note.failure !== "undo_incomplete"
      ) {
        continue;
      }
      const cleanupRefs: string[] = [];
      try {
        const t = this.resolveSiteType((note.siteType ?? LEGACY_SITE_TYPE) as SiteTypeKey);
        const finishOutcome = await this.tryRunContainer(
          this.restoreFinishSpec(t, note, dbSecret),
          cleanupRefs,
          BACKUP_RESTORE_FINISH_TIMEOUT_MS,
        );
        if (
          finishOutcome.kind !== "exited" ||
          (finishOutcome.exitCode !== 0 &&
            classifyRestoreFinishExitCode(finishOutcome.exitCode) !== null)
        ) {
          this.logRunnerError("undo_incomplete_cleanup_failed", {
            jobId: note.jobId,
            siteId,
            reason: "finish_failed",
          });
          continue;
        }
        await this.deleteStagingVolume(`hp_bk_${note.jobId}`);
        await unlink(this.notePathForJob(note.jobId)).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
      } catch (err) {
        this.logRunnerError("undo_incomplete_cleanup_failed", {
          jobId: note.jobId,
          siteId,
          code: (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR",
        });
      } finally {
        await this.cleanupContainersAndSecrets(cleanupRefs, null, null);
      }
    }
  }

  private async runRestoreJob(req: RestoreBackupRequest, t: ExecutorSiteType, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    const secretInstanceIds: string[] = [];
    let stagingVolumeName: string | null = null;
    let noteCreated = false;
    let createdVolume = false;
    let keepOnUndoIncomplete = false;
    let leaveNoteSwitched = false;
    let filesSwitched = false;
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "restore_prepare_failed";
    const setOutcome = (
      state: "succeeded" | "failed",
      failure: BackupJobStatus["failure"],
    ): void => {
      finalState = state;
      finalFailure = failure;
    };

    try {
      await this.ensureBackupWorkDirs();
      await writeRestoreNote(this.restoresDir, {
        v: 1,
        jobId: req.jobId,
        siteId: req.siteId,
        serviceInstanceId: req.serviceInstanceId,
        ...noteSiteType(t.def.key),
        stage: "prepare",
      });
      noteCreated = true;

      stagingVolumeName = await this.createStagingVolume(req.jobId, req.siteId);
      if (stagingVolumeName === null) {
        setOutcome("failed", "restore_prepare_failed");
        return;
      }

      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        setOutcome("failed", "key_file_missing");
        return;
      }

      const prepared = await this.prepareRepository(req.target, { kind: "site", siteId: req.siteId }, "restore", 0);
      if (!prepared.ok) {
        setOutcome("failed", prepared.problem);
        return;
      }
      const { repo } = prepared;

      if (
        (await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok" ||
        (t.def.database !== null && (await this.tryEnsureImage(SHARED_MARIADB_IMAGE)) !== "ok") ||
        (await this.tryEnsureImage(t.restore.filesImage)) !== "ok"
      ) {
        setOutcome("failed", "restore_prepare_failed");
        return;
      }

      await this.ensureNetworkFor(repo);

      const siteVolume = getManagedVolumeName(req.serviceInstanceId, t.def.files.volumeSuffix);
      const siteVolRes = await this.callDocker(
        "GET",
        `/volumes/${encodeURIComponent(siteVolume)}`,
      );
      if (siteVolRes.statusCode === 404 && req.createVolume) {
        // The flag goes on disk before the volume exists, so a crash never leaves an unknown volume.
        await writeRestoreNote(this.restoresDir, {
          v: 1,
          jobId: req.jobId,
          siteId: req.siteId,
          serviceInstanceId: req.serviceInstanceId,
          ...noteSiteType(t.def.key),
          stage: "prepare",
          createdVolume: true,
        });
        createdVolume = true;
        if (!(await this.createSiteVolume(req, t, createdRefs))) {
          setOutcome("failed", "restore_prepare_failed");
          return;
        }
      } else if (siteVolRes.statusCode !== 200) {
        setOutcome("failed", "restore_prepare_failed");
        return;
      }

      // Null exactly when the type has no database.
      const dbSecret =
        t.def.database === null ? null : await this.writeDbSecrets(`job_bk_db_${req.jobId}`, secretInstanceIds);
      if (t.def.database !== null && dbSecret === null) {
        setOutcome("failed", "restore_prepare_failed");
        return;
      }

      const resticSecret = await this.writeResticSecrets(
        `job_bk_rs_${req.jobId}`,
        req.target,
        backupKey,
        secretInstanceIds,
      );

      const fetchInput = {
        jobId: req.jobId,
        siteId: req.siteId,
        serviceInstanceId: req.serviceInstanceId,
        siteType: t,
        snapshotId: req.snapshotId,
        repo,
        secretBinds: resticSecret.secretBinds,
        secretFileEnv: resticSecret.secretFileEnv,
      };
      // C2: the dumps (staging only) first, so that the files fetch sees the space they took on a shared disk.
      const dumpsOutcome = await this.tryRunContainer(
        buildRestoreFetchContainerPayload({ ...fetchInput, stagingVolumeName }),
        createdRefs,
        BACKUP_RESTORE_FETCH_TIMEOUT_MS,
        { captureStdout: true, captureStderr: true },
      );
      const fetchOutcome =
        dumpsOutcome.kind === "exited" && dumpsOutcome.exitCode === 0
          ? await this.tryRunContainer(
              buildRestoreFetchFilesContainerPayload(fetchInput),
              createdRefs,
              BACKUP_RESTORE_FETCH_TIMEOUT_MS,
              { captureStderr: true },
            )
          : dumpsOutcome;
      if (fetchOutcome.kind !== "exited" || fetchOutcome.exitCode !== 0) {
        const problem =
          fetchOutcome.kind === "exited"
            ? ((repo.kind === "local" && fetchOutcome.exitCode === 1
                ? classifyResticExitCode(1, fetchOutcome.stderr, "local")
                : classifyRestoreFetchExitCode(fetchOutcome.exitCode, fetchOutcome.stderr)) ??
              "restore_prepare_failed")
            : "restore_prepare_failed";
        await this.runPreSwitchUndoDb(
          t,
          {
            jobId: req.jobId,
            siteId: req.siteId,
            serviceInstanceId: req.serviceInstanceId,
            stagingVolumeName,
          },
          dbSecret,
          createdRefs,
        );
        setOutcome("failed", problem);
        return;
      }

      const dumpKiB = this.parseFetchDumpKiB(dumpsOutcome.kind === "exited" ? dumpsOutcome.stdout : "");
      if (dumpKiB === null) {
        await this.runPreSwitchUndoDb(
          t,
          {
            jobId: req.jobId,
            siteId: req.siteId,
            serviceInstanceId: req.serviceInstanceId,
            stagingVolumeName,
          },
          dbSecret,
          createdRefs,
        );
        setOutcome("failed", "restore_prepare_failed");
        return;
      }

      const diskCheck = dbSecret === null ? "ok" : await this.checkDbDiskSpace(dumpKiB);
      if (diskCheck !== "ok") {
        await this.runPreSwitchUndoDb(
          t,
          {
            jobId: req.jobId,
            siteId: req.siteId,
            serviceInstanceId: req.serviceInstanceId,
            stagingVolumeName,
          },
          dbSecret,
          createdRefs,
        );
        setOutcome("failed", diskCheck === "no_space" ? "no_space" : "restore_prepare_failed");
        return;
      }

      if (dbSecret !== null) {
        const prepareSpec = buildRestorePrepareContainerPayload({
          jobId: req.jobId,
          siteId: req.siteId,
          siteType: t,
          stagingVolumeName,
          sharedDbNetworkName: this.deps.sharedDbNetworkName,
          secretBinds: dbSecret.secretBinds,
          secretFileEnv: dbSecret.secretFileEnv,
        });
        const prepareOutcome = await this.tryRunContainer(
          prepareSpec,
          createdRefs,
          BACKUP_RESTORE_PREPARE_TIMEOUT_MS,
          { captureStderr: true },
        );
        if (prepareOutcome.kind !== "exited" || prepareOutcome.exitCode !== 0) {
          this.logInvalidObjectNameIfPresent(req.jobId, req.siteId, "prepare", prepareOutcome);
          const problem =
            prepareOutcome.kind === "exited"
              ? (classifyRestorePrepareExitCode(prepareOutcome.exitCode) ?? "restore_prepare_failed")
              : "restore_prepare_failed";
          await this.runPreSwitchUndoDb(
            t,
            {
              jobId: req.jobId,
              siteId: req.siteId,
              serviceInstanceId: req.serviceInstanceId,
              stagingVolumeName,
            },
            dbSecret,
            createdRefs,
          );
          setOutcome("failed", problem);
          return;
        }
      }

      await writeRestoreNote(this.restoresDir, {
        v: 1,
        jobId: req.jobId,
        siteId: req.siteId,
        serviceInstanceId: req.serviceInstanceId,
        ...noteSiteType(t.def.key),
        stage: "switch",
        ...(createdVolume ? { createdVolume: true as const } : {}),
      });

      if (dbSecret !== null) {
        const gateOutcome = await this.tryRunContainer(
          this.restoreGateSpec(t, req, "on"),
          createdRefs,
          BACKUP_RESTORE_SWITCH_TIMEOUT_MS,
        );
        const switchSpec = buildRestoreSwitchContainerPayload({
          jobId: req.jobId,
          siteId: req.siteId,
          siteType: t,
          stagingVolumeName,
          sharedDbNetworkName: this.deps.sharedDbNetworkName,
          secretBinds: dbSecret.secretBinds,
          secretFileEnv: dbSecret.secretFileEnv,
        });
        const switchOutcome =
          gateOutcome.kind === "exited" && gateOutcome.exitCode === 0
            ? await this.tryRunContainer(switchSpec, createdRefs, BACKUP_RESTORE_SWITCH_TIMEOUT_MS, { captureStderr: true })
            : gateOutcome;
        if (switchOutcome.kind !== "exited" || switchOutcome.exitCode !== 0) {
          this.logInvalidObjectNameIfPresent(req.jobId, req.siteId, "switch", switchOutcome);
          const undoOutcome = await this.runSwitchUndoSequence(
            t,
            {
              jobId: req.jobId,
              siteId: req.siteId,
              serviceInstanceId: req.serviceInstanceId,
              stagingVolumeName,
            },
            dbSecret,
            createdRefs,
          );
          keepOnUndoIncomplete = undoOutcome === "undo_incomplete";
          setOutcome("failed", undoOutcome);
          return;
        }
      }

      const filesSpec = buildRestoreFilesContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        siteType: t,
        serviceInstanceId: req.serviceInstanceId,
      });
      const filesOutcome = await this.tryRunContainer(
        filesSpec,
        createdRefs,
        BACKUP_RESTORE_FILES_TIMEOUT_MS,
      );
      if (filesOutcome.kind !== "exited" || filesOutcome.exitCode !== 0) {
        const undoOutcome = await this.runSwitchUndoSequence(
          t,
          {
            jobId: req.jobId,
            siteId: req.siteId,
            serviceInstanceId: req.serviceInstanceId,
            stagingVolumeName,
          },
          dbSecret,
          createdRefs,
        );
        keepOnUndoIncomplete = undoOutcome === "undo_incomplete";
        setOutcome("failed", undoOutcome);
        return;
      }
      filesSwitched = true;

      await writeRestoreNote(this.restoresDir, {
        v: 1,
        jobId: req.jobId,
        siteId: req.siteId,
        serviceInstanceId: req.serviceInstanceId,
        ...noteSiteType(t.def.key),
        stage: "switched",
        ...(createdVolume ? { createdVolume: true as const } : {}),
      });

      const finishOutcome = await this.tryRunContainer(
        this.restoreFinishSpec(t, req, dbSecret),
        createdRefs,
        BACKUP_RESTORE_FINISH_TIMEOUT_MS,
      );
      if (finishOutcome.kind !== "exited") {
        keepOnUndoIncomplete = true;
        setOutcome("failed", "undo_incomplete");
        return;
      }
      const finishProblem = classifyRestoreFinishExitCode(finishOutcome.exitCode);
      if (finishProblem !== null) {
        keepOnUndoIncomplete = true;
        setOutcome("failed", finishProblem);
        return;
      }

      if (finishOutcome.exitCode !== 0) {
        // R79: post-gate cleanup failure keeps note at `switched` while reporting succeeded.
        leaveNoteSwitched = true;
      }
      setOutcome("succeeded", null);
      await this.cleanupSameSiteUndoIncomplete(req.siteId, req.jobId, dbSecret);
    } catch {
      // H10: once the files are switched the site runs the restored content: keep everything, never "nothing changed".
      // Cast: the outcome is set through a closure TypeScript does not follow.
      if (!filesSwitched) {
        setOutcome("failed", "restore_prepare_failed");
      } else if ((finalState as string) !== "succeeded") {
        keepOnUndoIncomplete = true;
        setOutcome("failed", "undo_incomplete");
      }
    } finally {
      const removeCreated =
        createdVolume &&
        finalState === "failed" &&
        // Cast: TypeScript narrows the variable to its initial value inside `finally`.
        (finalFailure as BackupJobStatus["failure"]) !== "undo_incomplete" &&
        !keepOnUndoIncomplete;
      const ended = this.endedRestoreNote({ ...req, siteType: t.def.key }, finalState, finalFailure);
      const noteSettled = noteCreated && !leaveNoteSwitched ? await this.writeEndedRestoreNote(ended) : true;
      await this.cleanupContainersAndSecrets(
        createdRefs,
        keepOnUndoIncomplete ? null : stagingVolumeName,
        secretInstanceIds,
      );
      // Only after the job's containers are gone, so the volume is no longer in use.
      if (removeCreated && noteSettled) await this.removeCreatedVolume(ended, t);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, null);
    }
  }

  private async runSettleWorker(note: RestoreNote, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    const secretInstanceIds: string[] = [];
    const stagingVolumeName = `hp_bk_${note.jobId}`;
    let keepVolume = false;
    let leaveNoteSwitched = false;
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] =
      note.stage === "prepare" ? "interrupted" : "undo_incomplete";
    let t: ExecutorSiteType | null = null;

    try {
      t = this.resolveSiteType((note.siteType ?? LEGACY_SITE_TYPE) as SiteTypeKey);
      const noDb = t.def.database === null;
      if (note.stage === "prepare") {
        // A type with a database also needs the files image: its gate step removes the restore dir.
        if (
          (await this.tryEnsureImage(t.restore.filesImage)) === "ok" &&
          (noDb || (await this.tryEnsureImage(SHARED_MARIADB_IMAGE)) === "ok")
        ) {
          const dbSecret = noDb
            ? null
            : await this.writeDbSecrets(`job_bk_db_${note.jobId}`, secretInstanceIds);
          if (noDb || dbSecret) {
            await this.runPreSwitchUndoDb(
              t,
              {
                jobId: note.jobId,
                siteId: note.siteId,
                serviceInstanceId: note.serviceInstanceId,
                stagingVolumeName,
              },
              dbSecret,
              createdRefs,
            );
          }
        }
        finalState = "failed";
        finalFailure = "interrupted";
      } else if (note.stage === "switch") {
        const imagesReady =
          (await this.tryEnsureImage(t.restore.filesImage)) === "ok" &&
          (noDb || (await this.tryEnsureImage(SHARED_MARIADB_IMAGE)) === "ok");
        const dbSecret = imagesReady && !noDb
          ? await this.writeDbSecrets(`job_bk_db_${note.jobId}`, secretInstanceIds)
          : null;
        if (!imagesReady || (!noDb && !dbSecret)) {
          keepVolume = true;
          finalState = "failed";
          finalFailure = "undo_incomplete";
        } else {
          const undoOutcome = await this.runSwitchUndoSequence(
            t,
            {
              jobId: note.jobId,
              siteId: note.siteId,
              serviceInstanceId: note.serviceInstanceId,
              stagingVolumeName,
            },
            dbSecret,
            createdRefs,
          );
          keepVolume = undoOutcome === "undo_incomplete";
          finalState = "failed";
          finalFailure = undoOutcome;
        }
      } else if (note.stage === "switched") {
        const dbReady = (await this.tryEnsureImage(noDb ? t.restore.filesImage : SHARED_MARIADB_IMAGE)) === "ok";
        const dbSecret = dbReady && !noDb
          ? await this.writeDbSecrets(`job_bk_db_${note.jobId}`, secretInstanceIds)
          : null;
        if (!dbReady || (!noDb && !dbSecret)) {
          keepVolume = true;
          finalState = "failed";
          finalFailure = "undo_incomplete";
        } else {
          const finishOutcome = await this.tryRunContainer(
            this.restoreFinishSpec(t, note, dbSecret),
            createdRefs,
            BACKUP_RESTORE_FINISH_TIMEOUT_MS,
          );
          if (finishOutcome.kind !== "exited") {
            keepVolume = true;
            finalState = "failed";
            finalFailure = "undo_incomplete";
          } else {
            const finishProblem = classifyRestoreFinishExitCode(finishOutcome.exitCode);
            if (finishProblem !== null) {
              keepVolume = true;
              finalState = "failed";
              finalFailure = finishProblem;
            } else {
              if (finishOutcome.exitCode !== 0) {
                leaveNoteSwitched = true;
              }
              finalState = "succeeded";
              finalFailure = null;
              await this.cleanupSameSiteUndoIncomplete(note.siteId, note.jobId, dbSecret);
            }
          }
        }
      }
    } catch {
      if (note.stage === "prepare") {
        finalState = "failed";
        finalFailure = "interrupted";
      } else {
        keepVolume = true;
        finalState = "failed";
        finalFailure = "undo_incomplete";
      }
    } finally {
      const removeCreated =
        note.createdVolume === true &&
        finalState === "failed" &&
        finalFailure !== "undo_incomplete" &&
        !keepVolume;
      const ended = this.endedRestoreNote(note, finalState, finalFailure);
      const noteSettled = leaveNoteSwitched || (await this.writeEndedRestoreNote(ended));
      await this.cleanupContainersAndSecrets(
        createdRefs,
        keepVolume ? null : stagingVolumeName,
        secretInstanceIds,
      );
      // An unknown type names no volume, so a created one stays.
      if (removeCreated && noteSettled && t !== null) await this.removeCreatedVolume(ended, t);
      this.settlingJobIds.delete(note.jobId);
      const pending = (this.siteSettlePendingCount.get(note.siteId) ?? 1) - 1;
      if (pending <= 0) {
        this.siteSettlePendingCount.delete(note.siteId);
        this.activeSiteIds.delete(note.siteId);
      } else {
        this.siteSettlePendingCount.set(note.siteId, pending);
      }
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, null);
    }
  }

  private createRunningEntry(jobId: string): JobRecord {
    const initial: BackupJobStatus = {
      jobId,
      state: "running",
      failure: null,
      snapshot: null,
    };
    this.nextSeq += 1;
    const entry: JobRecord = { status: initial, settledAtMs: null, seq: this.nextSeq };
    this.jobs.set(jobId, entry);
    return entry;
  }

  private async handleSettleRequest(jobId: string): Promise<BackupJobStatus> {
    this.evictJobs();
    if (this.settlingJobIds.has(jobId)) {
      const active = this.jobs.get(jobId);
      return active
        ? cloneJobStatus(active.status)
        : { jobId, state: "running", failure: null, snapshot: null };
    }
    const existing = this.jobs.get(jobId);
    if (existing?.status.state === "running") {
      return cloneJobStatus(existing.status);
    }

    let note: RestoreNote | null;
    try {
      note = await readRestoreNote(this.restoresDir, jobId);
    } catch (err) {
      this.logRunnerError("restore_note_unreadable", {
        jobId,
        code: (err as { code?: string } | null)?.code ?? "VALIDATION_ERROR",
      });
      return { jobId, state: "unknown", failure: null, snapshot: null };
    }
    if (!note) {
      // R125: a job whose ended note could not be written still tells its result while in memory.
      return existing ? cloneJobStatus(existing.status) : { jobId, state: "unknown", failure: null, snapshot: null };
    }
    if (note.stage === "ended") {
      const status: BackupJobStatus = {
        jobId: note.jobId,
        state: note.state!,
        failure: note.failure ?? null,
        snapshot: null,
      };
      if (!this.jobs.has(note.jobId)) {
        const endedMs = Date.parse(note.endedAt ?? "");
        const isUndoIncomplete = note.state === "failed" && note.failure === "undo_incomplete";
        if (isUndoIncomplete || (Number.isFinite(endedMs) && this.nowMs() - endedMs <= BACKUP_STATUS_TTL_MS)) {
          this.nextSeq += 1;
          this.jobs.set(note.jobId, {
            status,
            settledAtMs: Number.isFinite(endedMs) ? endedMs : this.nowMs(),
            seq: this.nextSeq,
          });
        }
      }
      return cloneJobStatus(status);
    }

    if (this.activeSiteIds.has(note.siteId) || this.activeJobCount >= BACKUP_MAX_RUNNING_JOBS) {
      throw new ExecutorCodedError(
        "Another backup job is already in progress",
        "RESOURCE_LOCKED",
      );
    }

    this.settlingJobIds.add(note.jobId);
    this.siteSettlePendingCount.set(
      note.siteId,
      (this.siteSettlePendingCount.get(note.siteId) ?? 0) + 1,
    );
    this.activeSiteIds.add(note.siteId);
    this.activeJobCount += 1;
    const entry = this.createRunningEntry(note.jobId);
    void this.runSettleWorker(note, entry);
    return cloneJobStatus(entry.status);
  }

  private archivePaths(jobId: string): { readonly zipPath: string; readonly partPath: string } {
    return {
      zipPath: assertContainedPath(this.archivesDir, path.join(this.archivesDir, `${jobId}.zip`)),
      partPath: assertContainedPath(this.archivesDir, path.join(this.archivesDir, `${jobId}.part`)),
    };
  }

  private detachSiteArchiveRecord(siteId: string): string | null {
    const oldJobId = this.archiveBySite.get(siteId);
    if (!oldJobId) return null;
    this.archiveBySite.delete(siteId);
    const oldRecord = this.readyArchives.get(oldJobId);
    if (oldRecord) {
      if (oldRecord.timer !== null) clearTimeout(oldRecord.timer);
      this.readyArchives.delete(oldJobId);
    }
    return oldJobId;
  }

  private async removeArchiveFiles(jobId: string): Promise<void> {
    const { zipPath, partPath } = this.archivePaths(jobId);
    await unlink(partPath).catch(() => undefined);
    await unlink(zipPath).catch(() => undefined);
  }

  private async expireReadyArchive(jobId: string): Promise<void> {
    const rec = this.readyArchives.get(jobId);
    if (!rec) {
      await this.pendingArchiveDeletes.get(jobId);
      return;
    }
    if (rec.timer !== null) clearTimeout(rec.timer);
    this.readyArchives.delete(jobId);
    if (this.archiveBySite.get(rec.siteId) === jobId) {
      this.archiveBySite.delete(rec.siteId);
    }
    const delPromise = this.removeArchiveFiles(jobId).finally(() => {
      if (this.pendingArchiveDeletes.get(jobId) === delPromise) {
        this.pendingArchiveDeletes.delete(jobId);
      }
    });
    this.pendingArchiveDeletes.set(jobId, delPromise);
    await delPromise;
  }

  private startArchiveJob(req: ArchiveBackupRequest): BackupJobStatus {
    this.evictJobs();
    const existing = this.jobs.get(req.jobId);
    if (existing) {
      return cloneJobStatus(existing.status);
    }
    if (this.activeSiteIds.has(req.siteId) || this.activeJobCount >= BACKUP_MAX_RUNNING_JOBS) {
      throw new ExecutorCodedError(
        "Another backup job is already in progress",
        "RESOURCE_LOCKED",
      );
    }

    const evictedJobId = this.detachSiteArchiveRecord(req.siteId);
    this.activeSiteIds.add(req.siteId);
    this.activeArchiveJobIds.add(req.jobId);
    this.activeJobCount += 1;
    const entry = this.createRunningEntry(req.jobId);
    void this.runArchiveJob(req, entry, evictedJobId);
    return cloneJobStatus(entry.status);
  }

  private async runArchiveJob(
    req: ArchiveBackupRequest,
    entry: JobRecord,
    evictedArchiveJobId: string | null,
  ): Promise<void> {
    const createdRefs: string[] = [];
    const secretInstanceIds: string[] = [];
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "other";
    let finalArchive: BackupJobStatus["archive"] | undefined;

    try {
      await this.ensureBackupWorkDirs();
      if (evictedArchiveJobId !== null) {
        await this.removeArchiveFiles(evictedArchiveJobId);
      }
      await this.removeArchiveFiles(req.jobId);

      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        finalFailure = "key_file_missing";
        return;
      }

      const prepared = await this.prepareRepository(req.target, { kind: "site", siteId: req.siteId }, "archive", 0);
      if (!prepared.ok) {
        finalFailure = prepared.problem;
        return;
      }
      const { repo } = prepared;

      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") {
        finalFailure = "tool_unavailable";
        return;
      }
      await this.ensureNetworkFor(repo);

      const resticSecret = await this.writeResticSecrets(
        `job_bk_${req.jobId}`,
        req.target,
        backupKey,
        secretInstanceIds,
      );

      const zipSpec = buildArchiveContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        snapshotId: req.snapshotId,
        repo,
        executorUser: this.deps.executorUser,
        archivesHostDir: this.archivesDir,
        secretBinds: resticSecret.secretBinds,
        secretFileEnv: resticSecret.secretFileEnv,
      });
      const outcome = await this.tryRunContainer(
        zipSpec,
        createdRefs,
        BACKUP_ARCHIVE_TIMEOUT_MS,
        { captureStderr: true },
      );
      if (outcome.kind === "not_found") {
        finalFailure = "tool_unavailable";
        return;
      }
      if (outcome.kind === "error") {
        finalFailure = "other";
        return;
      }
      if (outcome.exitCode !== 0) {
        finalFailure =
          (repo.kind === "local" && outcome.exitCode === 1
            ? classifyResticExitCode(1, outcome.stderr, "local")
            : classifyArchiveExitCode(outcome.exitCode, outcome.stderr)) ?? "other";
        return;
      }

      const { zipPath, partPath } = this.archivePaths(req.jobId);
      await unlink(partPath).catch(() => undefined);
      const st = await lstat(zipPath).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isFile()) {
        finalFailure = "other";
        return;
      }

      const readyAtMs = this.nowMs();
      const expiresAtMs = readyAtMs + BACKUP_ARCHIVE_TTL_MS;
      const timer = setTimeout(() => {
        void this.expireReadyArchive(req.jobId);
      }, BACKUP_ARCHIVE_TTL_MS);
      timer.unref?.();

      const prevForSite = this.detachSiteArchiveRecord(req.siteId);
      if (prevForSite !== null) {
        await this.removeArchiveFiles(prevForSite);
      }

      this.readyArchives.set(req.jobId, {
        jobId: req.jobId,
        siteId: req.siteId,
        sizeBytes: st.size,
        readyAtMs,
        expiresAtMs,
        timer,
      });
      this.archiveBySite.set(req.siteId, req.jobId);
      finalState = "succeeded";
      finalFailure = null;
      finalArchive = {
        sizeBytes: st.size,
        readyAt: new Date(readyAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    } catch {
      finalState = "failed";
      finalFailure = "other";
      finalArchive = undefined;
    } finally {
      if (finalState === "failed") {
        await this.removeArchiveFiles(req.jobId).catch(() => undefined);
      }
      await this.cleanupContainersAndSecrets(createdRefs, null, secretInstanceIds);
      this.activeArchiveJobIds.delete(req.jobId);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, null, finalArchive);
    }
  }

  private async readArchiveChunk(
    jobId: string,
    offset: number,
    length: number,
  ): Promise<BackupsResultByAction["readArchive"]> {
    if (this.activeArchiveJobIds.has(jobId)) {
      throw new ExecutorCodedError("archive_preparing", "RESOURCE_LOCKED");
    }
    const rec = this.readyArchives.get(jobId);
    if (!rec) {
      await this.pendingArchiveDeletes.get(jobId);
      throw new ExecutorCodedError("archive_gone", "NOT_FOUND");
    }
    if (this.nowMs() >= rec.expiresAtMs) {
      await this.expireReadyArchive(jobId);
      throw new ExecutorCodedError("archive_gone", "NOT_FOUND");
    }

    const { zipPath } = this.archivePaths(jobId);
    const st = await lstat(zipPath).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      await this.expireReadyArchive(jobId);
      throw new ExecutorCodedError("archive_gone", "NOT_FOUND");
    }

    let fh;
    try {
      fh = await open(zipPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
      await this.expireReadyArchive(jobId);
      throw new ExecutorCodedError("archive_gone", "NOT_FOUND");
    }

    try {
      const fileStat = await fh.stat();
      const size = fileStat.size;
      if (offset >= size) {
        return { dataBase64: "", size, eof: true };
      }
      const targetLen = Math.min(Math.min(length, SITE_FILE_CHUNK_BYTES), size - offset);
      const buf = Buffer.allocUnsafe(targetLen);
      let totalRead = 0;
      while (totalRead < targetLen) {
        const res = await fh.read(buf, totalRead, targetLen - totalRead, offset + totalRead);
        if (res.bytesRead === 0) break;
        totalRead += res.bytesRead;
      }
      return {
        dataBase64: buf.subarray(0, totalRead).toString("base64"),
        size,
        eof: offset + totalRead >= size,
      };
    } finally {
      await fh.close();
    }
  }

  private async discardReadyArchive(jobId: string): Promise<BackupsResultByAction["discardArchive"]> {
    const rec = this.readyArchives.get(jobId);
    if (!rec) {
      return { discarded: false };
    }
    const expired = this.nowMs() >= rec.expiresAtMs;
    await this.expireReadyArchive(jobId);
    return { discarded: !expired };
  }

  /** Executes a validated backup, restore, settle, or archive IPC request. */
  public async run<R extends BackupsIpcRequest>(
    req: R,
  ): Promise<BackupsResultByAction[R["action"]]> {
    const parsed = BackupsIpcRequestSchema.safeParse(req);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "request"}: ${issue.code}`)
        .join("; ");
      throw new ExecutorCodedError(`Invalid backup request (${detail})`, "VALIDATION_ERROR");
    }

    const request = parsed.data;
    switch (request.action) {
      case "test":
      case "localInit":
        return (await this.executeTest(request)) as BackupsResultByAction[R["action"]];
      case "start": {
        const t = this.resolveSiteType(request.siteType ?? LEGACY_SITE_TYPE);
        return this.startBackgroundJob(request.siteId, request.jobId, (entry) =>
          this.runBackupJob(request, t, entry),
        ) as BackupsResultByAction[R["action"]];
      }
      case "forget":
        return this.startBackgroundJob(request.siteId, request.jobId, (entry) =>
          this.runForgetJob(request, entry),
        ) as BackupsResultByAction[R["action"]];
      case "panelStart":
        return this.startBackgroundJob(PANEL_LANE, request.jobId, (entry) =>
          this.runPanelJob(request, entry),
        ) as BackupsResultByAction[R["action"]];
      case "siteState":
        return (await this.readSiteState(
          request,
          this.resolveSiteType(request.siteType ?? LEGACY_SITE_TYPE),
        )) as BackupsResultByAction[R["action"]];
      case "restore": {
        const t = this.resolveSiteType(request.siteType ?? LEGACY_SITE_TYPE);
        this.evictJobs();
        if (!this.jobs.has(request.jobId)) {
          const recovered = await this.readStatusFromNote(request.jobId);
          if (recovered) {
            return recovered as BackupsResultByAction[R["action"]];
          }
        }
        return this.startBackgroundJob(request.siteId, request.jobId, (entry) =>
          this.runRestoreJob(request, t, entry),
        ) as BackupsResultByAction[R["action"]];
      }
      case "archive":
        return this.startArchiveJob(request) as BackupsResultByAction[R["action"]];
      case "readArchive":
        return (await this.readArchiveChunk(
          request.jobId,
          request.offset,
          request.length,
        )) as BackupsResultByAction[R["action"]];
      case "discardArchive":
        return (await this.discardReadyArchive(
          request.jobId,
        )) as BackupsResultByAction[R["action"]];
      case "settle":
        return (await this.handleSettleRequest(
          request.jobId,
        )) as BackupsResultByAction[R["action"]];
      case "status": {
        this.evictJobs();
        const found = this.jobs.get(request.jobId);
        if (found) {
          return cloneJobStatus(found.status) as BackupsResultByAction[R["action"]];
        }
        const fromNote = await this.readStatusFromNote(request.jobId);
        return (fromNote ?? {
          jobId: request.jobId,
          state: "unknown",
          failure: null,
          snapshot: null,
        }) as BackupsResultByAction[R["action"]];
      }
    }
  }

  /** Read-only: does the site's files volume exist, and is there a site container (not a job)? */
  private async readSiteState(req: SiteStateRequest, t: ExecutorSiteType): Promise<BackupSiteState> {
    const volume = getManagedVolumeName(req.serviceInstanceId, t.def.files.volumeSuffix);
    const volRes = await this.callDocker("GET", `/volumes/${encodeURIComponent(volume)}`);
    if (volRes.statusCode !== 200 && volRes.statusCode !== 404) {
      throw new ExecutorCodedError("Docker volume inspect failed", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const filters = JSON.stringify({
      label: [
        "io.hostingpanel.managed=true",
        `io.hostingpanel.site_id=${req.siteId}`,
        `io.hostingpanel.service_instance_id=${req.serviceInstanceId}`,
      ],
    });
    const listRes = await this.callDocker(
      "GET",
      `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    let list: unknown;
    try {
      list = listRes.statusCode === 200 ? JSON.parse(listRes.body.toString("utf8")) : null;
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      throw new ExecutorCodedError("Docker container list failed", "DOCKER_ENGINE_UNAVAILABLE");
    }
    const container = list.some((item: unknown) => {
      if (typeof item !== "object" || item === null) return false;
      const labels = (item as { Labels?: unknown }).Labels;
      return (
        typeof labels !== "object" ||
        labels === null ||
        (labels as Record<string, unknown>)["io.hostingpanel.role"] === undefined
      );
    });
    return { filesVolume: volRes.statusCode === 200, container };
  }

  /** Checks the panel dump without following links: a regular file starting with PGDMP. */
  private async inspectPanelDump(
    jobId: string,
  ): Promise<{ dumpPath: string; dirGid: number; identity: PanelDumpIdentity } | null> {
    const dumpPath = path.join(this.panelDumpDir, `${jobId}.dump`);
    try {
      const dir = await lstat(this.panelDumpDir);
      if (!dir.isDirectory() || dir.gid === 0) return null;
      // O_NONBLOCK so a FIFO planted at the path cannot hang the job.
      const fh = await open(
        dumpPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        const st = await fh.stat({ bigint: true });
        if (!st.isFile() || st.size < BigInt(PANEL_DUMP_MAGIC.length)) return null;
        const head = Buffer.alloc(PANEL_DUMP_MAGIC.length);
        await fh.read(head, 0, head.length, 0);
        if (head.toString("latin1") !== PANEL_DUMP_MAGIC) return null;
        return {
          dumpPath,
          dirGid: dir.gid,
          identity: { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs },
        };
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  /** True when the dump file is still the one inspected before the upload. */
  private async panelDumpUnchanged(dumpPath: string, before: PanelDumpIdentity): Promise<boolean> {
    try {
      const st = await lstat(dumpPath, { bigint: true });
      return (
        st.isFile() &&
        st.dev === before.dev &&
        st.ino === before.ino &&
        st.size === before.size &&
        st.mtimeNs === before.mtimeNs
      );
    } catch {
      return false;
    }
  }

  /** Uploads the panel dump and the master key to `<prefix>/panel`, then applies retention. */
  private async runPanelJob(req: PanelStartRequest, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    const secretIds: string[] = [];
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "other";
    let finalSnapshot: BackupJobStatus["snapshot"] = null;
    const fail = (failure: BackupJobStatus["failure"]): void => {
      finalState = "failed";
      finalFailure = failure;
    };

    try {
      const backupKey = await this.readBackupKey();
      if (backupKey === null) return fail("key_file_missing");
      const dump = await this.inspectPanelDump(req.jobId);
      if (dump === null) return fail("panel_dump_missing");
      const prepared = await this.prepareRepository(
        req.target,
        { kind: "panel" },
        "panelBackup",
        Number(dump.identity.size),
      );
      if (!prepared.ok) return fail(prepared.problem);
      const { repo: panelRepo } = prepared;
      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") return fail("tool_unavailable");
      await this.ensureNetworkFor(panelRepo);

      const restic = {
        repo: panelRepo,
        // Local panel steps all run as the executor (primary gid = the repository group).
        executorUser: this.deps.executorUser,
        ...(await this.writeResticSecrets(`job_bk_pn_${req.jobId}`, req.target, backupKey, secretIds)),
      };
      const masterKeyId = `job_bk_mk_${req.jobId}`;
      secretIds.push(masterKeyId);
      await writeServiceSecrets(this.deps.secretsRootDir, masterKeyId, {
        [PANEL_MASTER_KEY_SECRET]: req.masterKey,
      });
      const masterKeyPath = path.resolve(
        this.deps.secretsRootDir,
        masterKeyId,
        PANEL_MASTER_KEY_SECRET,
      );

      const repo = await this.runContainer(
        buildPanelRepoContainerPayload({ ...restic, jobId: req.jobId }),
        createdRefs,
        BACKUP_REPO_STEP_TIMEOUT_MS,
        { captureStderr: true },
      );
      if (repo.kind === "not_found") return fail("tool_unavailable");
      const repoProblem = classifyResticExitCode(repo.exitCode, repo.stderr, panelRepo.kind);
      if (repoProblem !== null) return fail(repoProblem);

      const upload = await this.runContainer(
        buildPanelUploadContainerPayload({
          ...restic,
          jobId: req.jobId,
          dumpPath: dump.dumpPath,
          masterKeyPath,
          dirGid: dump.dirGid,
        }),
        createdRefs,
        BACKUP_UPLOAD_TIMEOUT_MS,
        { captureStdout: true, captureStderr: true },
      );
      if (upload.kind === "not_found") return fail("tool_unavailable");
      if (upload.exitCode !== 0 && upload.exitCode !== 3) {
        return fail(classifyResticExitCode(upload.exitCode, upload.stderr, panelRepo.kind) ?? "other");
      }

      const summary = parseResticSummary(upload.stdout);
      const complete =
        upload.exitCode === 0 &&
        summary !== null &&
        summary.fileCount === 2 &&
        BigInt(summary.totalBytes) === dump.identity.size + PANEL_KEY_BYTES &&
        (await this.panelDumpUnchanged(dump.dumpPath, dump.identity));
      if (!complete) {
        if (summary !== null) {
          // Best effort: a snapshot that does not hold this exact dump must not stay as the newest copy.
          await this.tryRunContainer(
            buildPanelDropContainerPayload({ ...restic, jobId: req.jobId, snapshotId: summary.snapshotId }),
            createdRefs,
            BACKUP_REPO_STEP_TIMEOUT_MS,
          );
        }
        return fail(upload.exitCode === 0 && summary === null ? "other" : "panel_dump_missing");
      }

      finalState = "succeeded";
      finalFailure = null;
      finalSnapshot = summary;
      const keep = await this.tryRunContainer(
        buildPanelKeepContainerPayload({ ...restic, jobId: req.jobId, retentionDays: req.retentionDays }),
        createdRefs,
        BACKUP_FORGET_TIMEOUT_MS,
      );
      if (keep.kind !== "exited" || keep.exitCode !== 0) {
        this.logRunnerError("panel_keep_failed", { jobId: req.jobId });
      }
    } catch {
      if (finalState !== "succeeded") fail("other");
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, null, secretIds);
      this.activeSiteIds.delete(PANEL_LANE);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, finalSnapshot);
    }
  }

  /** Reads the start of a hand-over file without following links; null when unreadable. */
  private async readPanelCopyHead(filePath: string, bytes: number): Promise<Buffer | null> {
    try {
      const fh = await open(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      try {
        if (!(await fh.stat()).isFile()) return null;
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * Re-validates a `--local-repo` directory (the CLI is not trusted to have done it): canonical absolute path, outside
   * the executor's own directories and the system denylist, no symlink in it or above it, a directory owned by a
   * non-root user and not writable by others. Returns the owner ids the fetch container runs as.
   */
  private async validateLocalPanelRepoDir(
    repoDir: string,
  ): Promise<
    | { readonly ok: true; readonly uid: number; readonly gid: number }
    | { readonly ok: false; readonly problem: "local_target_unmounted" | "local_target_unsafe" }
  > {
    const unsafe = { ok: false, problem: "local_target_unsafe" } as const;
    const own = [this.backupWorkDir, this.panelDumpDir, path.resolve(this.deps.secretsRootDir)];
    const within = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}/`);
    if (
      !LOCAL_REPO_DIR_CHARS.test(repoDir) ||
      path.normalize(repoDir) !== repoDir ||
      repoDir === "/" ||
      repoDir.endsWith("/") ||
      LOCAL_REPO_DENYLIST.some((d) => within(repoDir, d)) ||
      own.some((d) => within(repoDir, d) || within(d, repoDir))
    ) {
      return unsafe;
    }
    try {
      const st = await lstat(repoDir);
      if (st.isSymbolicLink() || !st.isDirectory() || st.uid === 0 || (st.mode & 0o002) !== 0) return unsafe;
      if ((await realpath(repoDir)) !== repoDir) return unsafe;
      return { ok: true, uid: st.uid, gid: st.gid };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? { ok: false, problem: "local_target_unmounted" } : unsafe;
    }
  }

  /** Writes the newest panel copy (dump and master key) into `panelDumpDir` for a panel restore. */
  public async fetchPanelCopy(
    source: BackupRepositoryTarget | LocalPanelRepoSource,
    panelDumpDir: string,
    signal?: AbortSignal,
  ): Promise<PanelFetchResult> {
    const outDir = path.resolve(panelDumpDir);
    const createdRefs: string[] = [];
    const secretIds: string[] = [];
    let touched = false;
    let result: PanelFetchResult = { ok: false, problem: "other" };
    try {
      const dir = await lstat(outDir).catch(() => null);
      if (dir === null || !dir.isDirectory() || dir.gid === 0) {
        return (result = { ok: false, problem: "refused" });
      }
      const backupKey = await this.readBackupKey();
      if (backupKey === null) return (result = { ok: false, problem: "key_file_missing" });
      // R124: these steps write nothing, so a stop ends them at once (the catch below) with nothing to clean.
      const stopped = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
      stopped.catch(() => undefined);
      const untilStopped = <T>(step: Promise<T>): Promise<T> => Promise.race([step, stopped]);
      signal?.throwIfAborted();
      // A repository directory from the CLI is validated here; a target goes through the probe or the local guard.
      let repoDir: { readonly uid: number; readonly gid: number } | null = null;
      let repo: ResolvedBackupRepository | null = null;
      if (isLocalPanelRepoSource(source)) {
        const checked = await this.validateLocalPanelRepoDir(source.repoDir);
        if (!checked.ok) return (result = { ok: false, problem: checked.problem });
        repoDir = checked;
      } else {
        const prepared = await untilStopped(this.prepareRepository(source, { kind: "panel" }, "restore", 0));
        if (!prepared.ok) return (result = { ok: false, problem: prepared.problem });
        repo = prepared.repo;
      }
      if ((await untilStopped(this.tryEnsureImage(RESTIC_IMAGE))) !== "ok") {
        return (result = { ok: false, problem: "tool_unavailable" });
      }
      if (repo !== null) await untilStopped(this.ensureNetworkFor(repo));
      signal?.throwIfAborted();

      const fetchId = randomBytes(16).toString("hex");
      const secrets = await this.writeResticSecrets(
        `job_bk_pf_${fetchId}`,
        source,
        backupKey,
        secretIds,
      );
      touched = true;
      const outcome = await this.runContainer(
        isLocalPanelRepoSource(source) && repoDir !== null
          ? buildPanelFetchLocalContainerPayload({
              fetchId,
              repoDir: source.repoDir,
              user: `${repoDir.uid}:${repoDir.gid}`,
              outDir,
              groupAdd: [dir.gid],
              ...secrets,
            })
          : buildPanelFetchContainerPayload({
              repo: repo!,
              ...secrets,
              fetchId,
              executorUser: this.deps.executorUser,
              outDir,
              dirGid: dir.gid,
            }),
        createdRefs,
        BACKUP_RESTORE_FETCH_TIMEOUT_MS,
        { captureStdout: true, captureStderr: true, signal },
      );
      if (outcome.kind === "not_found") return (result = { ok: false, problem: "tool_unavailable" });
      if (outcome.exitCode === PANEL_FETCH_EXIT_NO_COPY || outcome.exitCode === 10) {
        return (result = { ok: false, problem: "no_copy" });
      }
      if (outcome.exitCode === PANEL_FETCH_EXIT_NO_SPACE) {
        return (result = { ok: false, problem: "no_space" });
      }
      if (outcome.exitCode !== 0) {
        return (result = {
          ok: false,
          problem:
            classifyResticExitCode(outcome.exitCode, outcome.stderr, repo?.kind ?? (repoDir === null ? "s3" : "local")) ??
            "other",
        });
      }

      const snap = PANEL_FETCH_SNAP_LINE.exec(outcome.stdout);
      const ms = snap ? Date.parse(snap[2]!) : Number.NaN;
      const dumpHead = await this.readPanelCopyHead(path.join(outDir, PANEL_RESTORE_DUMP_NAME), 5);
      const keyHead = await this.readPanelCopyHead(path.join(outDir, PANEL_RESTORE_KEY_NAME), 65);
      if (
        snap === null ||
        !Number.isFinite(ms) ||
        dumpHead?.toString("latin1") !== PANEL_DUMP_MAGIC ||
        keyHead === null ||
        !PANEL_KEY_FILE_PATTERN.test(keyHead.toString("latin1"))
      ) {
        return (result = { ok: false, problem: "other" });
      }
      return (result = { ok: true, snapshotId: snap[1]!, time: new Date(ms).toISOString() });
    } catch {
      return (result = { ok: false, problem: "other" });
    } finally {
      // Container first: one whose kill failed could still write a file deleted before it (R124).
      await this.cleanupContainersAndSecrets(createdRefs, null, secretIds);
      if (touched && (!result.ok || signal?.aborted)) {
        for (const name of [
          PANEL_RESTORE_DUMP_NAME,
          PANEL_RESTORE_KEY_NAME,
          `.${PANEL_RESTORE_DUMP_NAME}.part`,
          `.${PANEL_RESTORE_KEY_NAME}.part`,
        ]) {
          await unlink(path.join(outDir, name)).catch(() => undefined);
        }
      }
    }
  }

  /** Settles leftover restore crash notes at startup within the bounded startup wait window. */
  public async settleRestores(): Promise<void> {
    await this.ensureBackupWorkDirs();
    const notes = await this.listRestoreNotesSafe({ logErrors: true });
    const now = this.nowMs();
    const unsettled: RestoreNote[] = [];

    for (const note of notes) {
      if (note.stage === "ended") {
        const isUndoIncomplete = note.state === "failed" && note.failure === "undo_incomplete";
        const endedMs = Date.parse(note.endedAt ?? "");
        if (!isUndoIncomplete && (!Number.isFinite(endedMs) || now - endedMs > BACKUP_STATUS_TTL_MS)) {
          await unlink(this.notePathForJob(note.jobId)).catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              this.logRunnerError("restore_note_prune_failed", {
                jobId: note.jobId,
                code: (err as { code?: string } | null)?.code ?? "INTERNAL_ERROR",
              });
            }
          });
          continue;
        }
        if (!this.jobs.has(note.jobId)) {
          this.nextSeq += 1;
          this.jobs.set(note.jobId, {
            status: {
              jobId: note.jobId,
              state: note.state!,
              failure: note.failure ?? null,
              snapshot: null,
            },
            settledAtMs: Number.isFinite(endedMs) ? endedMs : now,
            seq: this.nextSeq,
          });
        }
        continue;
      }

      if (this.settlingJobIds.has(note.jobId) || this.jobs.get(note.jobId)?.status.state === "running") {
        continue;
      }
      unsettled.push(note);
    }

    if (unsettled.length === 0) return;

    const queue: Array<{ readonly note: RestoreNote; readonly entry: JobRecord }> = [];
    for (const note of unsettled) {
      this.settlingJobIds.add(note.jobId);
      this.siteSettlePendingCount.set(
        note.siteId,
        (this.siteSettlePendingCount.get(note.siteId) ?? 0) + 1,
      );
      this.activeSiteIds.add(note.siteId);
      queue.push({ note, entry: this.createRunningEntry(note.jobId) });
    }

    const runningSites = new Set<string>();
    const workerPromises: Array<Promise<void>> = [];
    let resolveAll!: () => void;
    const allDone = new Promise<void>((resolve) => {
      resolveAll = resolve;
    });

    const pumpQueue = (): void => {
      while (this.activeJobCount < BACKUP_MAX_RUNNING_JOBS) {
        const nextIdx = queue.findIndex((item) => !runningSites.has(item.note.siteId));
        if (nextIdx === -1) break;
        const item = queue.splice(nextIdx, 1)[0]!;
        runningSites.add(item.note.siteId);
        this.activeJobCount += 1;
        const p = this.runSettleWorker(item.note, item.entry).finally(() => {
          runningSites.delete(item.note.siteId);
          pumpQueue();
          if (queue.length === 0 && runningSites.size === 0) {
            resolveAll();
          }
        });
        workerPromises.push(p);
      }
      if (queue.length === 0 && runningSites.size === 0) {
        resolveAll();
      }
    };

    pumpQueue();
    void workerPromises;

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      allDone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BACKUP_RESTORE_SETTLE_START_MS);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Deletes all files left in the archives staging directory at executor startup. */
  public async emptyArchives(): Promise<void> {
    for (const [jobId, rec] of this.readyArchives) {
      if (rec.timer !== null) clearTimeout(rec.timer);
      this.readyArchives.delete(jobId);
    }
    this.archiveBySite.clear();

    let entries;
    try {
      entries = await readdir(this.archivesDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const targetPath = assertContainedPath(
        this.archivesDir,
        path.join(this.archivesDir, entry.name),
      );
      await rm(targetPath, { recursive: true, force: true });
    }
  }

  /** Clears a purged site's archive and ended restore notes/staging volumes, refusing unsettled restores. */
  public async forgetSite(siteId: string): Promise<void> {
    assertSafeIdentifier(siteId, "siteId");
    if (this.activeSiteIds.has(siteId)) {
      throw new ExecutorCodedError(
        "A backup or restore job is already running for this site",
        "RESOURCE_LOCKED",
      );
    }

    const notes = await this.listRestoreNotesSafe({ logErrors: false });
    const siteNotes = notes.filter((note) => note.siteId === siteId);
    if (siteNotes.some((note) => note.stage !== "ended")) {
      throw new ExecutorCodedError(
        "Site has an unsettled restore operation",
        "RESOURCE_LOCKED",
      );
    }

    const archiveJobId = this.detachSiteArchiveRecord(siteId);
    if (archiveJobId !== null) {
      await this.removeArchiveFiles(archiveJobId);
    }

    for (const note of siteNotes) {
      await this.deleteStagingVolume(`hp_bk_${note.jobId}`);
      await unlink(this.notePathForJob(note.jobId)).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      this.jobs.delete(note.jobId);
    }
  }

  /** Deletes dangling `hp_bk_*` backup staging volumes that do not correspond to a restore note. */
  public async removeOrphans(): Promise<void> {
    const notedJobIds = new Set(
      (await this.listRestoreNotesSafe({ logErrors: false })).map((note) => note.jobId),
    );
    const filters = JSON.stringify({
      label: [`io.hostingpanel.role=${BACKUP_STAGING_VOLUME_ROLE}`],
    });
    const listRes = await this.callDocker("GET", `/volumes?filters=${encodeURIComponent(filters)}`);
    if (listRes.statusCode !== 200) {
      throw new ExecutorCodedError("Failed to list backup staging volumes", "DOCKER_ENGINE_UNAVAILABLE");
    }

    let volumes: unknown;
    try {
      volumes = (JSON.parse(listRes.body.toString("utf8")) as { Volumes?: unknown }).Volumes;
    } catch {
      throw new ExecutorCodedError("Invalid Docker volume list response", "DOCKER_ENGINE_UNAVAILABLE");
    }
    if (!Array.isArray(volumes)) return;

    for (const item of volumes) {
      const name = (item as { Name?: unknown } | null)?.Name;
      if (typeof name !== "string" || !name.startsWith("hp_bk_")) continue;
      const suffixJobId = name.slice("hp_bk_".length);
      if (notedJobIds.has(suffixJobId)) continue;
      await this.deleteStagingVolume(name);
    }
  }
}
