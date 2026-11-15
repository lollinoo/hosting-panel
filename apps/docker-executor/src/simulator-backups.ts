import { createHash, randomBytes } from "node:crypto";
import {
  BackupsIpcRequestSchema,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

const MAX_RUNNING_JOBS = 2;
const SIM_ARCHIVE_SIZE_BYTES = 1_048_577;
const SIM_ARCHIVE_TTL_MS = 60 * 60 * 1000;
const EMPTY_ZIP_EOCD = Buffer.from([
  0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

type SimJobSnapshot = NonNullable<BackupJobStatus["snapshot"]>;
type SimJobArchive = NonNullable<BackupJobStatus["archive"]>;

interface SimBackupJob {
  readonly action: "start" | "forget" | "restore" | "archive";
  readonly jobId: string;
  readonly siteId: string;
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

/** In-memory simulator for backup jobs and per-site snapshot repositories. */
export class SimulatedBackups {
  private readonly jobs = new Map<string, SimBackupJob>();
  private readonly snapshotsBySite = new Map<string, string[]>();
  private readonly readyArchives = new Map<string, string>();
  private readonly archiveBySite = new Map<string, string>();
  private readonly pendingFailures: BackupFailureClass[] = [];
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
      case "test": {
        if (this.testInFlight) {
          throw new ExecutorCodedError("A storage test is already running", "RESOURCE_LOCKED");
        }
        this.testInFlight = true;
        try {
          // Yield a turn so concurrent test calls hit the single-test lock like the real runner.
          await new Promise<void>((resolve) => setImmediate(resolve));
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
        ) as BackupsResultByAction[R["action"]];

      case "forget":
        return this.enqueueJob("forget", req.jobId, req.siteId, {
          snapshotIdsToForget: req.snapshotIds,
        }) as BackupsResultByAction[R["action"]];

      case "restore":
        return this.enqueueJob("restore", req.jobId, req.siteId, {
          requiredSnapshotId: req.snapshotId,
        }) as BackupsResultByAction[R["action"]];

      case "archive":
        return this.enqueueJob("archive", req.jobId, req.siteId, {
          requiredSnapshotId: req.snapshotId,
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

  /** Lists snapshot ids currently recorded for a site. */
  public snapshots(siteId: string): readonly string[] {
    return [...(this.snapshotsBySite.get(siteId) ?? [])];
  }

  /** Checks whether a snapshot id exists in the site's recorded snapshot list. */
  private hasSnapshot(siteId: string, snapshotId: string): boolean {
    return this.snapshotsBySite.get(siteId)?.includes(snapshotId) ?? false;
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
    options: { snapshotIdsToForget?: readonly string[]; requiredSnapshotId?: string } = {},
  ): BackupJobStatus {
    const existing = this.jobs.get(jobId);
    if (existing) {
      return cloneJobStatus(existing);
    }
    this.assertCanStartJob(siteId);
    if (action === "archive") {
      this.removeSiteArchive(siteId);
    }
    const queuedFailure = this.pendingFailures.shift() ?? null;
    const missingSnapshot =
      options.requiredSnapshotId !== undefined &&
      !this.hasSnapshot(siteId, options.requiredSnapshotId);
    const job: SimBackupJob = {
      action,
      jobId,
      siteId,
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
    if (job.plannedFailure !== null) {
      job.state = "failed";
      job.failure = job.plannedFailure;
      job.snapshot = null;
      job.archive = null;
      return;
    }
    if (job.action === "start") {
      const snapshot = createSimulatedSnapshot();
      const siteSnapshots = this.snapshotsBySite.get(job.siteId) ?? [];
      siteSnapshots.push(snapshot.snapshotId);
      this.snapshotsBySite.set(job.siteId, siteSnapshots);
      job.state = "succeeded";
      job.failure = null;
      job.snapshot = snapshot;
      job.archive = null;
      return;
    }
    if (job.action === "forget") {
      const existing = this.snapshotsBySite.get(job.siteId);
      if (existing) {
        const toRemove = new Set(job.snapshotIdsToForget);
        const remaining = existing.filter((id) => !toRemove.has(id));
        if (remaining.length > 0) {
          this.snapshotsBySite.set(job.siteId, remaining);
        } else {
          this.snapshotsBySite.delete(job.siteId);
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
