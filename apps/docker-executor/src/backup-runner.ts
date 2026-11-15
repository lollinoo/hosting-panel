import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BackupsIpcRequestSchema,
  RESTIC_IMAGE,
  SHARED_MARIADB_IMAGE,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
  type BackupTestResult,
} from "@hosting-panel/contracts";
import {
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
} from "./backup-jobs.js";
import { purgeServiceSecrets, writeServiceSecrets } from "./docker-engine-adapter.js";
import { demuxDockerLogStream } from "./docker-logs.js";
import { probeS3, S3_PROBE_BUDGET_MS } from "./s3-probe.js";
import { ExecutorCodedError, getManagedVolumeName } from "./traefik-config.js";

export const DEFAULT_BACKUP_KEY_FILE = "/etc/hosting-panel/backup.key" as const;
export const DEFAULT_BACKUP_NETWORK_NAME = "hp_backup_net" as const;

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
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

type StartBackupRequest = Extract<BackupsIpcRequest, { action: "start" }>;
type ForgetBackupRequest = Extract<BackupsIpcRequest, { action: "forget" }>;
type TestBackupRequest = Extract<BackupsIpcRequest, { action: "test" }>;

interface JobRecord {
  status: BackupJobStatus;
  settledAtMs: number | null;
  readonly seq: number;
}

type ContainerOutcome =
  | { readonly kind: "not_found" }
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };

const cloneJobStatus = (status: BackupJobStatus): BackupJobStatus => ({
  jobId: status.jobId,
  state: status.state,
  failure: status.failure,
  snapshot: status.snapshot ? { ...status.snapshot } : null,
});

function toEngineError(err: unknown, fallbackMessage: string): ExecutorCodedError {
  if (err instanceof ExecutorCodedError) {
    return err;
  }
  return new ExecutorCodedError(fallbackMessage, "DOCKER_ENGINE_UNAVAILABLE");
}

/** Coordinates backup target tests, site backup jobs, snapshot forgets, and orphan cleanup. */
export class BackupRunner {
  private readonly deps: BackupRunnerDeps;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly activeSiteIds = new Set<string>();
  private activeJobCount = 0;
  private testInFlight = false;
  private nextSeq = 0;

  public constructor(deps: BackupRunnerDeps) {
    this.deps = deps;
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
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
    options?: { readonly captureStdout?: boolean; readonly captureStderr?: boolean },
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
        options?.captureStderr && exitCode === 1
          ? await this.readContainerLogStream(containerRef, "stderr", 50)
          : "";
      return { kind: "exited", exitCode, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async cleanupContainersAndSecrets(
    createdRefs: readonly string[],
    stagingVolumeName: string | null,
    secretInstanceId: string | null,
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
    if (secretInstanceId !== null) {
      await purgeServiceSecrets(this.deps.secretsRootDir, secretInstanceId).catch(() => undefined);
    }
  }

  private async executeTest(req: TestBackupRequest): Promise<BackupTestResult> {
    if (this.testInFlight) {
      throw new ExecutorCodedError("A storage test is already running", "RESOURCE_LOCKED");
    }
    this.testInFlight = true;
    const deadline = this.nowMs() + BACKUP_TEST_BUDGET_MS;
    const createdRefs: string[] = [];
    let secretInstanceId: string | null = null;

    try {
      const backupKey = await this.readBackupKey();
      if (backupKey === null) {
        return { outcome: "failed", problem: "key_file_missing" };
      }

      const remainingBeforeS3 = deadline - this.nowMs();
      if (remainingBeforeS3 <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      const probe = await probeS3(req.target, {
        fetch: this.deps.fetch,
        now: () => new Date(this.nowMs()),
        budgetMs: Math.min(S3_PROBE_BUDGET_MS, remainingBeforeS3),
      });
      if (probe.problem !== null) {
        return { outcome: "failed", problem: probe.problem };
      }

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
        await this.deps.ensureBackupNetwork();
      } catch (err) {
        throw toEngineError(err, "Docker engine is unavailable for backup test");
      }

      const remainingAfterPrep = deadline - this.nowMs();
      if (remainingAfterPrep <= 0) {
        return { outcome: "failed", problem: "timeout" };
      }

      const testId = randomBytes(8).toString("hex");
      secretInstanceId = `job_bk_test_${testId}`;
      const { secretBinds, secretFileEnv } = await writeServiceSecrets(
        this.deps.secretsRootDir,
        secretInstanceId,
        {
          AWS_SHARED_CREDENTIALS: buildAwsSharedCredentials(
            req.target.accessKeyId,
            req.target.secretAccessKey,
          ),
          RESTIC_PASSWORD: backupKey,
        },
      );

      const spec = buildBackupRepoContainerPayload({
        mode: "test",
        testId,
        target: req.target,
        backupNetworkName: this.deps.backupNetworkName,
        secretBinds,
        secretFileEnv,
      });

      const outcome = await this.runContainer(spec, createdRefs, remainingAfterPrep, {
        captureStderr: true,
      });
      if (outcome.kind === "not_found") {
        return { outcome: "failed", problem: "tool_unavailable" };
      }

      const problem = classifyResticExitCode(outcome.exitCode, outcome.stderr);
      return problem === null
        ? { outcome: "ok", problem: null }
        : { outcome: "failed", problem };
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, null, secretInstanceId);
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
  ): void {
    entry.status = {
      jobId: entry.status.jobId,
      state,
      failure,
      snapshot: snapshot ? { ...snapshot } : null,
    };
    entry.settledAtMs = this.nowMs();
  }

  private async runBackupJob(req: StartBackupRequest, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    let stagingVolumeName: string | null = null;
    let secretInstanceId: string | null = null;
    let finalState: "succeeded" | "failed" = "failed";
    let finalFailure: BackupJobStatus["failure"] = "other";
    let finalSnapshot: BackupJobStatus["snapshot"] = null;
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

      const probe = await probeS3(req.target, {
        fetch: this.deps.fetch,
        now: () => new Date(this.nowMs()),
      });
      if (probe.problem !== null) {
        setOutcome("failed", probe.problem, null);
        return;
      }

      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }
      await this.deps.ensureBackupNetwork();

      const siteVolume = getManagedVolumeName(req.serviceInstanceId, "html");
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
        databases = await this.deps.listSiteDatabases(req.siteId);
      } catch {
        setOutcome("failed", "database_dump_failed", null);
        return;
      }
      if (databases.length > 0 && (await this.tryEnsureImage(SHARED_MARIADB_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable", null);
        return;
      }

      secretInstanceId = `job_bk_${req.jobId}`;
      const { secretBinds, secretFileEnv } = await writeServiceSecrets(
        this.deps.secretsRootDir,
        secretInstanceId,
        {
          AWS_SHARED_CREDENTIALS: buildAwsSharedCredentials(
            req.target.accessKeyId,
            req.target.secretAccessKey,
          ),
          RESTIC_PASSWORD: backupKey,
        },
      );

      const repoSpec = buildBackupRepoContainerPayload({
        mode: "job",
        jobId: req.jobId,
        siteId: req.siteId,
        init: true,
        target: req.target,
        backupNetworkName: this.deps.backupNetworkName,
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
      const repoProblem = classifyResticExitCode(repoOutcome.exitCode, repoOutcome.stderr);
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
        target: req.target,
        backupNetworkName: this.deps.backupNetworkName,
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
              target: req.target,
              backupNetworkName: this.deps.backupNetworkName,
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
        classifyResticExitCode(uploadOutcome.exitCode, uploadOutcome.stderr) ?? "other";
      setOutcome("failed", uploadProblem, null);
    } catch {
      setOutcome("failed", "other", null);
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, stagingVolumeName, secretInstanceId);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      // Settle only after cleanup and locks are released so status polls never observe pre-release state.
      this.settleEntry(entry, finalState, finalFailure, finalSnapshot);
    }
  }

  private async runForgetJob(req: ForgetBackupRequest, entry: JobRecord): Promise<void> {
    const createdRefs: string[] = [];
    let secretInstanceId: string | null = null;
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

      const probe = await probeS3(req.target, {
        fetch: this.deps.fetch,
        now: () => new Date(this.nowMs()),
      });
      if (probe.problem !== null) {
        setOutcome("failed", probe.problem);
        return;
      }

      if ((await this.tryEnsureImage(RESTIC_IMAGE)) !== "ok") {
        setOutcome("failed", "tool_unavailable");
        return;
      }
      await this.deps.ensureBackupNetwork();

      secretInstanceId = `job_bk_${req.jobId}`;
      const { secretBinds, secretFileEnv } = await writeServiceSecrets(
        this.deps.secretsRootDir,
        secretInstanceId,
        {
          AWS_SHARED_CREDENTIALS: buildAwsSharedCredentials(
            req.target.accessKeyId,
            req.target.secretAccessKey,
          ),
          RESTIC_PASSWORD: backupKey,
        },
      );

      const repoSpec = buildBackupRepoContainerPayload({
        mode: "job",
        jobId: req.jobId,
        siteId: req.siteId,
        init: false,
        target: req.target,
        backupNetworkName: this.deps.backupNetworkName,
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
      const repoProblem = classifyResticExitCode(repoOutcome.exitCode, repoOutcome.stderr);
      if (repoProblem !== null) {
        setOutcome("failed", repoProblem);
        return;
      }

      const forgetSpec = buildBackupForgetContainerPayload({
        jobId: req.jobId,
        siteId: req.siteId,
        snapshotIds: req.snapshotIds,
        target: req.target,
        backupNetworkName: this.deps.backupNetworkName,
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
      const forgetProblem = classifyResticExitCode(forgetOutcome.exitCode, forgetOutcome.stderr);
      if (forgetProblem !== null) {
        setOutcome("failed", forgetProblem);
        return;
      }
      setOutcome("succeeded", null);
    } catch {
      setOutcome("failed", "other");
    } finally {
      await this.cleanupContainersAndSecrets(createdRefs, null, secretInstanceId);
      this.activeSiteIds.delete(req.siteId);
      this.activeJobCount = Math.max(0, this.activeJobCount - 1);
      this.settleEntry(entry, finalState, finalFailure, null);
    }
  }

  /** Executes a validated backup IPC request (`test`, `start`, `status`, or `forget`). */
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
        return (await this.executeTest(request)) as BackupsResultByAction[R["action"]];
      case "start":
        return this.startBackgroundJob(request.siteId, request.jobId, (entry) =>
          this.runBackupJob(request, entry),
        ) as BackupsResultByAction[R["action"]];
      case "forget":
        return this.startBackgroundJob(request.siteId, request.jobId, (entry) =>
          this.runForgetJob(request, entry),
        ) as BackupsResultByAction[R["action"]];
      case "status": {
        this.evictJobs();
        const found = this.jobs.get(request.jobId);
        return (found
          ? cloneJobStatus(found.status)
          : {
              jobId: request.jobId,
              state: "unknown",
              failure: null,
              snapshot: null,
            }) as BackupsResultByAction[R["action"]];
      }
    }
  }

  /** Deletes dangling `hp_bk_*` backup staging volumes left over from a prior executor process. */
  public async removeOrphans(): Promise<void> {
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
      const delRes = await this.callDocker("DELETE", `/volumes/${encodeURIComponent(name)}`);
      if (delRes.statusCode !== 204 && delRes.statusCode !== 404) {
        throw new ExecutorCodedError(
          "Failed to delete orphan backup staging volume",
          "DOCKER_ENGINE_UNAVAILABLE",
        );
      }
    }
  }
}
