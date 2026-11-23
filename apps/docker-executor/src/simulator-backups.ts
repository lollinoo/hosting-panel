import { createHash, randomBytes } from "node:crypto";
import {
  BackupsIpcRequestSchema,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupSiteState,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

const MAX_RUNNING_JOBS = 2;
// Site ids never contain ":", so the panel lane never collides with a site.
const PANEL_LANE = "panel:db";
/** The lane of an application, the same string the real runner uses. */
const stackLane = (stackId: string): string => `stack:${stackId}`;
const SIM_ARCHIVE_SIZE_BYTES = 1_048_577;
const SIM_ARCHIVE_TTL_MS = 60 * 60 * 1000;
const GIB = 1024 ** 3;
const SIM_LOCAL_AVAILABLE_BYTES = 50 * GIB;
const SIM_LOCAL_TOTAL_BYTES = 100 * GIB;
const SIM_LOCAL_ROOT = "/var/lib/hosting-panel/local-repos";
// Target ids ending in this suffix model a volume that is not mounted (no Docker needed).
const SIM_UNMOUNTED_TARGET_SUFFIX = "dead";
const EMPTY_ZIP_EOCD = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

type SimJobSnapshot = NonNullable<BackupJobStatus["snapshot"]>;
type SimJobArchive = NonNullable<BackupJobStatus["archive"]>;

interface SimBackupJob {
  readonly action: "start" | "forget" | "restore" | "archive" | "panelStart" | "stackRestore";
  readonly jobId: string;
  readonly siteId: string;
  /** Repository the job is pinned to (see repoKey): snapshots live per (target, site) like the real repositories. */
  readonly targetKey: string;
  // Service instance whose files volume this restore creates, if any.
  readonly createsVolumeFor: string | null;
  readonly snapshotIdsToForget: readonly string[];
  readonly plannedFailure: BackupFailureClass | null;
  state: "running" | "succeeded" | "failed";
  failure: BackupFailureClass | null;
  snapshot: SimJobSnapshot | null;
  archive: SimJobArchive | null;
}

/** Returns an immutable copy of a simulated job status. */
function cloneJobStatus(job: SimBackupJob): BackupJobStatus {
  const status: BackupJobStatus = {
    jobId: job.jobId,
    state: job.state,
    failure: job.failure,
    snapshot: job.snapshot ? { ...job.snapshot } : null,
  };
  if (job.archive) {
    status.archive = { ...job.archive };
  }
  return status;
}

/** Returns a deterministic byte slice for a job's archive ending in an empty-zip record. */
function buildArchiveSlice(jobId: string, offset: number, length: number): Buffer {
  const start = Math.min(offset, SIM_ARCHIVE_SIZE_BYTES);
  const end = Math.min(start + length, SIM_ARCHIVE_SIZE_BYTES);
  if (end <= start) {
    return Buffer.alloc(0);
  }
  const out = Buffer.allocUnsafe(end - start);
  const prefixEnd = SIM_ARCHIVE_SIZE_BYTES - EMPTY_ZIP_EOCD.length;

  if (start < prefixEnd) {
    const pattern = Buffer.from(createHash("sha256").update(jobId).digest("hex"), "ascii");
    const prefixStop = Math.min(end, prefixEnd);
    let cursor = start;
    let outOffset = 0;
    while (cursor < prefixStop) {
      const patternOffset = cursor % pattern.length;
      const chunkLen = Math.min(pattern.length - patternOffset, prefixStop - cursor);
      pattern.copy(out, outOffset, patternOffset, patternOffset + chunkLen);
      cursor += chunkLen;
      outOffset += chunkLen;
    }
  }

  if (end > prefixEnd) {
    const eocdStart = Math.max(start, prefixEnd) - prefixEnd;
    const eocdEnd = end - prefixEnd;
    EMPTY_ZIP_EOCD.copy(out, Math.max(prefixEnd - start, 0), eocdStart, eocdEnd);
  }

  return out;
}

/** Builds a synthetic snapshot summary with a 64-hex identifier. */
function createSimulatedSnapshot(): SimJobSnapshot {
  return {
    snapshotId: randomBytes(32).toString("hex"),
    bytesAdded: 1024,
    totalBytes: 4096,
    fileCount: 12,
    durationMs: 250,
  };
}

/** Answers a local test/init: fixed bytes and root, or the deterministic unmounted seam. */
function localTestResult(
  targetId: string,
  nextQueuedFailure: () => BackupFailureClass | null,
): BackupsResultByAction["test"] {
  const problem = targetId.endsWith(SIM_UNMOUNTED_TARGET_SUFFIX)
    ? "local_target_unmounted"
    : nextQueuedFailure();
  if (problem !== null) {
    return { outcome: "failed", problem };
  }
  return {
    outcome: "ok",
    problem: null,
    availableBytes: SIM_LOCAL_AVAILABLE_BYTES,
    totalBytes: SIM_LOCAL_TOTAL_BYTES,
    localRoot: SIM_LOCAL_ROOT,
  };
}

type SimTarget = BackupsIpcRequest extends infer R ? (R extends { target: infer T } ? T : never) : never;

/** One key per repository: a local target by id, an S3 target by endpoint/bucket/prefix. */
function targetKeyOf(target: SimTarget): string {
  if ("kind" in target) return `local:${target.targetId}`;
  return `s3:${target.endpoint}/${target.bucket}/${target.prefix ?? ""}`;
}

const snapKey = (targetKey: string, siteId: string): string => `${targetKey}|${siteId}`;

/** What the simulated Docker says about an application before a copy or a restore of its volumes. */
export type SimulatedAppStackReadiness = "ready" | "running" | "volume_missing" | "foreign";

export interface SimulatedBackupsOptions {
  /** Absent: every application is at rest with every volume (a test that only cares about the jobs). */
  readonly appStackReadiness?: (
    stackId: string,
    organizationId: string,
    volumeKeys: readonly string[],
  ) => SimulatedAppStackReadiness;
}

/** A copy or a restore of an application the simulator accepted. */
export interface SimulatedAppStackBackupJob {
  readonly action: "stackStart" | "stackRestore";
  readonly jobId: string;
  readonly stackId: string;
  readonly organizationId: string;
  readonly volumeKeys: readonly string[];
  readonly snapshotId: string | null;
}

/** In-memory simulator for backup jobs and per-site snapshot repositories. */
export class SimulatedBackups {
  private readonly appStackJobLog: SimulatedAppStackBackupJob[] = [];

  public constructor(private readonly options: SimulatedBackupsOptions = {}) {}

  private readonly jobs = new Map<string, SimBackupJob>();
  private readonly snapshotsByRepo = new Map<string, string[]>();
  private readonly readyArchives = new Map<string, string>();
  private readonly archiveBySite = new Map<string, string>();
  private readonly pendingFailures: BackupFailureClass[] = [];
  private readonly siteStates = new Map<string, BackupSiteState>();
  private readonly panelJobs: string[] = [];
  /** Lanes of applications the simulated stack engine holds (see holdAppStackLane). */
  private readonly engineLanes = new Set<string>();
  private held = false;
  private testInFlight = false;

  /** Handles a validated backup IPC request against in-memory state. */
  public async handle<R extends BackupsIpcRequest>(
    rawReq: R,
  ): Promise<BackupsResultByAction[R["action"]]> {
    const parsed = BackupsIpcRequestSchema.safeParse(rawReq);
    if (!parsed.success) {
      throw new ExecutorCodedError("Invalid backups request", "VALIDATION_ERROR");
    }
    const req = parsed.data;

    switch (req.action) {
      case "test":
      case "localInit": {
        if (this.testInFlight) {
          throw new ExecutorCodedError("A storage test is already running", "RESOURCE_LOCKED");
        }
        this.testInFlight = true;
        try {
          // Yield a turn so concurrent test calls hit the single-test lock like the real runner.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if ("kind" in req.target) {
            return localTestResult(
              req.target.targetId,
              () => this.pendingFailures.shift() ?? null,
            ) as BackupsResultByAction[R["action"]];
          }
          const problem = this.pendingFailures.shift() ?? null;
          return (
            problem !== null ? { outcome: "failed", problem } : { outcome: "ok", problem: null }
          ) as BackupsResultByAction[R["action"]];
        } finally {
          this.testInFlight = false;
        }
      }

      case "start":
        return this.enqueueJob(
          "start",
          req.jobId,
          req.siteId,
          { target: req.target },
        ) as BackupsResultByAction[R["action"]];

      case "forget":
        return this.enqueueJob("forget", req.jobId, req.siteId, {
          snapshotIdsToForget: req.snapshotIds,
          target: req.target,
        }) as BackupsResultByAction[R["action"]];

      case "stackStart":
      case "stackRestore": {
        const known = this.jobs.has(req.jobId);
        // The real runner takes the lane, then checks the application; never for a request sent twice.
        if (!known) {
          this.assertCanStartJob(stackLane(req.stackId));
          this.assertAppStackAtRest(req.stackId, req.organizationId, req.volumeKeys);
          if (req.action === "stackRestore") this.assertAppStackSafetyCopy(req.jobId, req.stackId);
        }
        const status =
          req.action === "stackStart"
            ? this.enqueueJob("start", req.jobId, stackLane(req.stackId), { target: req.target })
            : this.enqueueJob("stackRestore", req.jobId, stackLane(req.stackId), {
                requiredSnapshotId: req.snapshotId,
                target: req.target,
              });
        if (!known) {
          this.appStackJobLog.push({
            action: req.action,
            jobId: req.jobId,
            stackId: req.stackId,
            organizationId: req.organizationId,
            volumeKeys: [...req.volumeKeys],
            snapshotId: req.action === "stackRestore" ? req.snapshotId : null,
          });
        }
        return status as BackupsResultByAction[R["action"]];
      }

      case "stackForget":
        return this.enqueueJob("forget", req.jobId, stackLane(req.stackId), {
          snapshotIdsToForget: req.snapshotIds,
          target: req.target,
        }) as BackupsResultByAction[R["action"]];

      case "panelStart": {
        // The master key is dropped here: only the job id reaches the simulator's state.
        const known = this.jobs.has(req.jobId);
        const status = this.enqueueJob("panelStart", req.jobId, PANEL_LANE, { target: req.target });
        if (!known) {
          this.panelJobs.push(req.jobId);
        }
        return status as BackupsResultByAction[R["action"]];
      }

      case "siteState":
        return { ...this.siteStateOf(req.serviceInstanceId) } as BackupsResultByAction[R["action"]];

      case "restore": {
        const volumeMissing = !this.siteStateOf(req.serviceInstanceId).filesVolume;
        return this.enqueueJob("restore", req.jobId, req.siteId, {
          requiredSnapshotId: req.snapshotId,
          target: req.target,
          failure: volumeMissing && !req.createVolume ? "restore_prepare_failed" : undefined,
          createsVolumeFor: volumeMissing && req.createVolume ? req.serviceInstanceId : null,
        }) as BackupsResultByAction[R["action"]];
      }

      case "archive":
        return this.enqueueJob("archive", req.jobId, req.siteId, {
          requiredSnapshotId: req.snapshotId,
          target: req.target,
        }) as BackupsResultByAction[R["action"]];

      case "status":
      case "settle":
        return this.queryJobStatus(req.jobId) as BackupsResultByAction[R["action"]];

      case "readArchive":
        return this.readArchiveChunk(
          req.jobId,
          req.offset,
          req.length,
        ) as BackupsResultByAction[R["action"]];

      case "discardArchive": {
        const siteId = this.readyArchives.get(req.jobId);
        if (siteId === undefined) {
          return { discarded: false } as BackupsResultByAction[R["action"]];
        }
        this.readyArchives.delete(req.jobId);
        if (this.archiveBySite.get(siteId) === req.jobId) {
          this.archiveBySite.delete(siteId);
        }
        return { discarded: true } as BackupsResultByAction[R["action"]];
      }
    }
  }

  /** Queues a failure problem for the next test or newly started job. */
  public failNext(problem: BackupFailureClass): void {
    this.pendingFailures.push(problem);
  }

  /** Keeps started jobs running across status polls while hold is true. */
  public holdJobs(hold = true): void {
    this.held = hold;
  }

  /** Clears the hold flag and settles every currently running job. */
  public finishHeld(): void {
    this.held = false;
    for (const job of this.jobs.values()) {
      if (job.state === "running") {
        this.settleJob(job);
      }
    }
  }

  /** Simulates executor restart by clearing backups/archives and marking running restores interrupted. */
  public simulateRestart(): void {
    this.readyArchives.clear();
    this.archiveBySite.clear();
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.action === "restore") {
        if (job.state === "running") {
          job.state = "failed";
          job.failure = "interrupted";
          job.snapshot = null;
          job.archive = null;
        }
      } else {
        this.jobs.delete(jobId);
      }
    }
  }

  /** Drops every ready archive immediately as if its 60-minute window had elapsed. */
  public expireArchives(): void {
    this.readyArchives.clear();
    this.archiveBySite.clear();
  }

  /** Sets what siteState answers for a service instance. */
  public setSiteState(serviceInstanceId: string, state: BackupSiteState): void {
    this.siteStates.set(serviceInstanceId, { ...state });
  }

  /** The real runner's holdAppStackLane: null while a job of the application runs, else held until released. */
  public holdAppStackLane(stackId: string): (() => void) | null {
    const lane = stackLane(stackId);
    if (this.engineLanes.has(lane) || [...this.jobs.values()].some((job) => job.state === "running" && job.siteId === lane)) {
      return null;
    }
    this.engineLanes.add(lane);
    let held = true;
    return () => {
      if (held) this.engineLanes.delete(lane);
      held = false;
    };
  }

  /** Lists every accepted copy or restore of an application, in order. */
  public appStackJobs(): readonly SimulatedAppStackBackupJob[] {
    return this.appStackJobLog.map((job) => ({ ...job, volumeKeys: [...job.volumeKeys] }));
  }

  /** Lists the snapshots of an application: in one target's repository when given, else across all targets. */
  public appStackSnapshots(stackId: string, target?: SimTarget): readonly string[] {
    return this.snapshots(stackLane(stackId), target);
  }

  /** Lists the job ids of every accepted panelStart, in order. */
  public panelJobIds(): readonly string[] {
    return [...this.panelJobs];
  }

  /** Lists snapshot ids recorded for a site: in one target's repository when given, else across all targets. */
  public snapshots(siteId: string, target?: SimTarget): readonly string[] {
    if (target !== undefined) {
      return [...(this.snapshotsByRepo.get(snapKey(targetKeyOf(target), siteId)) ?? [])];
    }
    return [...this.snapshotsByRepo.entries()].filter(([k]) => k.endsWith(`|${siteId}`)).flatMap(([, ids]) => ids);
  }

  /** The refusals of the real runner's check: same codes, nothing read or written. */
  private assertAppStackAtRest(stackId: string, organizationId: string, volumeKeys: readonly string[]): void {
    const readiness = this.options.appStackReadiness?.(stackId, organizationId, volumeKeys) ?? "ready";
    if (readiness === "running") {
      throw new ExecutorCodedError("The application is running", "RESOURCE_LOCKED");
    }
    if (readiness === "volume_missing") {
      throw new ExecutorCodedError("A volume of the application is missing", "NOT_FOUND");
    }
    if (readiness === "foreign") {
      throw new ExecutorCodedError("A volume with the name of this application is not its own", "HOST_POLICY_DENIED");
    }
  }

  /** The real runner's rule: a write-back needs a good copy of the same application as `<op>` or `<op>-t2`. */
  private assertAppStackSafetyCopy(jobId: string, stackId: string): void {
    const op = jobId.slice(0, -"-apply".length);
    const saved = [op, `${op}-t2`].some((id) => {
      const copy = this.jobs.get(id);
      return copy?.action === "start" && copy.siteId === stackLane(stackId) && copy.state === "succeeded" && copy.snapshot !== null;
    });
    if (!saved) {
      throw new ExecutorCodedError("No good safety copy of this application's data was taken first", "VALIDATION_ERROR");
    }
  }

  /** Returns the site state of a service instance, {true, true} unless set. */
  private siteStateOf(serviceInstanceId: string): BackupSiteState {
    return this.siteStates.get(serviceInstanceId) ?? { filesVolume: true, container: true };
  }

  /** Checks whether a snapshot id exists in the site's repository on this target. */
  private hasSnapshot(targetKey: string, siteId: string, snapshotId: string): boolean {
    return this.snapshotsByRepo.get(snapKey(targetKey, siteId))?.includes(snapshotId) ?? false;
  }

  /** Removes any ready archive currently associated with a site. */
  private removeSiteArchive(siteId: string): void {
    const previousJobId = this.archiveBySite.get(siteId);
    if (previousJobId !== undefined) {
      this.readyArchives.delete(previousJobId);
      this.archiveBySite.delete(siteId);
    }
  }

  /** Registers a newly completed archive and replaces any earlier one on the same site. */
  private installSiteArchive(jobId: string, siteId: string): void {
    this.removeSiteArchive(siteId);
    this.readyArchives.set(jobId, siteId);
    this.archiveBySite.set(siteId, jobId);
  }

  /** Records a new job or returns the existing status for an idempotent jobId. */
  private enqueueJob(
    action: SimBackupJob["action"],
    jobId: string,
    siteId: string,
    options: {
      snapshotIdsToForget?: readonly string[];
      requiredSnapshotId?: string;
      failure?: BackupFailureClass | undefined;
      createsVolumeFor?: string | null;
      target: SimTarget;
    },
  ): BackupJobStatus {
    const existing = this.jobs.get(jobId);
    if (existing) {
      return cloneJobStatus(existing);
    }
    this.assertCanStartJob(siteId);
    if (action === "archive") {
      this.removeSiteArchive(siteId);
    }
    // A forced failure leaves failNext queued for the next job.
    const targetKey = targetKeyOf(options.target);
    // A dead (unmounted) local target fails every job on it before restic would run; failNext stays queued.
    const dead = "kind" in options.target && options.target.targetId.endsWith(SIM_UNMOUNTED_TARGET_SUFFIX);
    const queuedFailure = dead ? "local_target_unmounted" : (options.failure ?? this.pendingFailures.shift() ?? null);
    const missingSnapshot =
      options.requiredSnapshotId !== undefined &&
      !this.hasSnapshot(targetKey, siteId, options.requiredSnapshotId);
    const job: SimBackupJob = {
      action,
      jobId,
      siteId,
      targetKey,
      createsVolumeFor: options.createsVolumeFor ?? null,
      snapshotIdsToForget: options.snapshotIdsToForget ? [...options.snapshotIdsToForget] : [],
      plannedFailure: queuedFailure ?? (missingSnapshot ? "other" : null),
      state: "running",
      failure: null,
      snapshot: null,
      archive: null,
    };
    this.jobs.set(jobId, job);
    return cloneJobStatus(job);
  }

  /** Returns the current status of a job, settling it when not held. */
  private queryJobStatus(jobId: string): BackupJobStatus {
    const job = this.jobs.get(jobId);
    if (!job) {
      return {
        jobId,
        state: "unknown",
        failure: null,
        snapshot: null,
      };
    }
    if (job.state === "running" && !this.held) {
      this.settleJob(job);
    }
    return cloneJobStatus(job);
  }

  /** Reads a deterministic chunk from a ready archive or throws its coded state error. */
  private readArchiveChunk(
    jobId: string,
    offset: number,
    length: number,
  ): BackupsResultByAction["readArchive"] {
    const job = this.jobs.get(jobId);
    if (job?.action === "archive" && job.state === "running") {
      throw new ExecutorCodedError("archive_preparing", "RESOURCE_LOCKED");
    }
    if (!this.readyArchives.has(jobId)) {
      throw new ExecutorCodedError("archive_gone", "NOT_FOUND");
    }
    if (offset >= SIM_ARCHIVE_SIZE_BYTES) {
      return {
        dataBase64: "",
        size: SIM_ARCHIVE_SIZE_BYTES,
        eof: true,
      };
    }
    const slice = buildArchiveSlice(jobId, offset, length);
    return {
      dataBase64: slice.toString("base64"),
      size: SIM_ARCHIVE_SIZE_BYTES,
      eof: offset + slice.length >= SIM_ARCHIVE_SIZE_BYTES,
    };
  }

  private assertCanStartJob(siteId: string): void {
    if (this.engineLanes.has(siteId)) {
      throw new ExecutorCodedError("Another backup job is already in progress", "RESOURCE_LOCKED");
    }
    let runningTotal = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== "running") {
        continue;
      }
      if (job.siteId === siteId) {
        throw new ExecutorCodedError(
          "A backup job is already running for this site",
          "RESOURCE_LOCKED",
        );
      }
      runningTotal += 1;
    }
    if (runningTotal >= MAX_RUNNING_JOBS) {
      throw new ExecutorCodedError(
        "Maximum concurrent backup jobs reached",
        "RESOURCE_LOCKED",
      );
    }
  }

  private settleJob(job: SimBackupJob): void {
    // The real runner keeps a volume it created on success and on undo_incomplete only.
    if (
      job.createsVolumeFor !== null &&
      (job.plannedFailure === null || job.plannedFailure === "undo_incomplete")
    ) {
      const state = this.siteStateOf(job.createsVolumeFor);
      this.siteStates.set(job.createsVolumeFor, { ...state, filesVolume: true });
    }
    if (job.plannedFailure !== null) {
      job.state = "failed";
      job.failure = job.plannedFailure;
      job.snapshot = null;
      job.archive = null;
      return;
    }
    if (job.action === "panelStart") {
      job.state = "succeeded";
      job.failure = null;
      job.snapshot = createSimulatedSnapshot();
      job.archive = null;
      return;
    }
    if (job.action === "start") {
      const snapshot = createSimulatedSnapshot();
      const key = snapKey(job.targetKey, job.siteId);
      const siteSnapshots = this.snapshotsByRepo.get(key) ?? [];
      siteSnapshots.push(snapshot.snapshotId);
      this.snapshotsByRepo.set(key, siteSnapshots);
      job.state = "succeeded";
      job.failure = null;
      job.snapshot = snapshot;
      job.archive = null;
      return;
    }
    if (job.action === "forget") {
      const key = snapKey(job.targetKey, job.siteId);
      const existing = this.snapshotsByRepo.get(key);
      if (existing) {
        const toRemove = new Set(job.snapshotIdsToForget);
        const remaining = existing.filter((id) => !toRemove.has(id));
        if (remaining.length > 0) {
          this.snapshotsByRepo.set(key, remaining);
        } else {
          this.snapshotsByRepo.delete(key);
        }
      }
      job.state = "succeeded";
      job.failure = null;
      job.snapshot = null;
      job.archive = null;
      return;
    }
    if (job.action === "archive") {
      const readyAtMs = Date.now();
      job.state = "succeeded";
      job.failure = null;
      job.snapshot = null;
      job.archive = {
        sizeBytes: SIM_ARCHIVE_SIZE_BYTES,
        readyAt: new Date(readyAtMs).toISOString(),
        expiresAt: new Date(readyAtMs + SIM_ARCHIVE_TTL_MS).toISOString(),
      };
      this.installSiteArchive(job.jobId, job.siteId);
      return;
    }
    job.state = "succeeded";
    job.failure = null;
    job.snapshot = null;
    job.archive = null;
  }
}
