import { randomBytes } from "node:crypto";
import {
  BackupsIpcRequestSchema,
  type BackupFailureClass,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import { ExecutorCodedError } from "./traefik-config.js";

const MAX_RUNNING_JOBS = 2;

type SimJobSnapshot = NonNullable<BackupJobStatus["snapshot"]>;

interface SimBackupJob {
  readonly action: "start" | "forget";
  readonly jobId: string;
  readonly siteId: string;
  readonly snapshotIdsToForget: readonly string[];
  readonly plannedFailure: BackupFailureClass | null;
  state: "running" | "succeeded" | "failed";
  failure: BackupFailureClass | null;
  snapshot: SimJobSnapshot | null;
}

/** Returns an immutable copy of a simulated job status. */
function cloneJobStatus(job: SimBackupJob): BackupJobStatus {
  return {
    jobId: job.jobId,
    state: job.state,
    failure: job.failure,
    snapshot: job.snapshot ? { ...job.snapshot } : null,
  };
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

      case "start": {
        const existing = this.jobs.get(req.jobId);
        if (existing) {
          return cloneJobStatus(existing) as BackupsResultByAction[R["action"]];
        }
        this.assertCanStartJob(req.siteId);
        const job: SimBackupJob = {
          action: "start",
          jobId: req.jobId,
          siteId: req.siteId,
          snapshotIdsToForget: [],
          plannedFailure: this.pendingFailures.shift() ?? null,
          state: "running",
          failure: null,
          snapshot: null,
        };
        this.jobs.set(req.jobId, job);
        return cloneJobStatus(job) as BackupsResultByAction[R["action"]];
      }

      case "forget": {
        const existing = this.jobs.get(req.jobId);
        if (existing) {
          return cloneJobStatus(existing) as BackupsResultByAction[R["action"]];
        }
        this.assertCanStartJob(req.siteId);
        const job: SimBackupJob = {
          action: "forget",
          jobId: req.jobId,
          siteId: req.siteId,
          snapshotIdsToForget: [...req.snapshotIds],
          plannedFailure: this.pendingFailures.shift() ?? null,
          state: "running",
          failure: null,
          snapshot: null,
        };
        this.jobs.set(req.jobId, job);
        return cloneJobStatus(job) as BackupsResultByAction[R["action"]];
      }

      case "status": {
        const job = this.jobs.get(req.jobId);
        if (!job) {
          return {
            jobId: req.jobId,
            state: "unknown",
            failure: null,
            snapshot: null,
          } as BackupsResultByAction[R["action"]];
        }
        if (job.state === "running" && !this.held) {
          this.settleJob(job);
        }
        return cloneJobStatus(job) as BackupsResultByAction[R["action"]];
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

  /** Clears all recorded jobs so subsequent status queries answer unknown. */
  public simulateRestart(): void {
    this.jobs.clear();
  }

  /** Lists snapshot ids currently recorded for a site. */
  public snapshots(siteId: string): readonly string[] {
    return [...(this.snapshotsBySite.get(siteId) ?? [])];
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
      return;
    }
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
  }
}
