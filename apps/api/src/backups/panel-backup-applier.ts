import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Logger } from "@nestjs/common";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  canTransitionOperation,
  isTerminalOperationStatus,
  type BackupJobStatus,
  type BackupsIpcRequest,
  type BackupProblem,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  aggregateCopyStatuses,
  and,
  appendAuditEvent,
  eq,
  getPolicy,
  insertPanelBackupCopies,
  listPanelBackupCopies,
  operationSteps,
  operations,
  recordPanelBackupOutcome,
  renewOperationLease,
  resolveDispatchTarget,
  resolvePanelTargets,
  settlePanelBackupCopy,
  transitionOperation,
  type DatabaseClient,
  type HostingPanelDatabase,
  type PanelCopyRow,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";
import { PanelDumpError, buildPanelDumpCommand, runPanelDump, type PanelDumpCommand } from "./panel-dump.js";
import {
  extractKnownErrorCode,
  isAmbiguousError,
  isTerminalStepStatus,
  normalizeBackupProblem,
  type BackupOperationRef,
  type SiteBackupsApplier,
} from "./site-backups-applier.js";

/** Ordered step definitions for the nightly panel copy. */
export const PANEL_BACKUP_STEPS = [
  { key: "dump", label: "Copy the panel database" },
  { key: "upload", label: "Send the copy to the backup storage" },
] as const satisfies readonly { key: string; label: string }[];

/**
 * The executor runs two backup jobs at a time: the nightly clean-ups of applications, queued in the same run, and a
 * customer's application backup can hold both. A copy refused as busy is asked again this often, under the same
 * operation, so the date keeps its one panel copy (ADR-0038)...
 */
export const PANEL_BUSY_RETRY_MS = 60_000;
/**
 * ...for at most this long after its first refusal, one wait for every destination of the copy together; then it fails
 * like any other refusal.
 */
export const PANEL_BUSY_WAIT_MS = 2 * 3_600_000;

/** A wait for a free job slot: its end is set by its first refusal. */
interface BusyWait {
  until: number | null;
}

const DUMP_FILE = /^(op_[0-9a-f]{32})\.dump$/;
const FAILED_MSG = "Panel copy did not finish.";
const INTERRUPTED_MSG = "This panel copy was interrupted before it finished.";

class PanelSettled extends Error {
  public constructor(public readonly causeError: ControlPlaneError) {
    super(causeError.message);
  }
}

/** Runs and recovers the nightly copy of the panel database (panel.backups.create). */
export class PanelBackupApplier {
  readonly #logger = new Logger(PanelBackupApplier.name);
  /** Replaceable by tests: no test needs pg_dump on the machine. */
  public dump: (cmd: PanelDumpCommand) => Promise<void> = (cmd) => runPanelDump(cmd);
  public busyRetryMs = PANEL_BUSY_RETRY_MS;
  public busyWaitMs = PANEL_BUSY_WAIT_MS;

  public constructor(
    private readonly parent: SiteBackupsApplier,
    private readonly dbClient: DatabaseClient,
    private readonly dockerExecutor: DockerExecutorPort,
    private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Dumps the panel database, hands it to the executor, and settles the outcome. */
  public async apply(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    const file = this.#file(op.id);
    let keepFile = false;
    try {
      await renewOperationLease(db, op.id, this.parent.leaseMs);
      await this.parent.safeUpdateStep(op.id, "dump", "running", "Copying the panel database");

      const copies = await this.#ensureCopies(op.id);
      if (copies.length === 0) {
        await this.#fail(op, "other", "VALIDATION_ERROR", "not_configured");
      }
      if (!this.config.panelDump || !file) {
        await this.#fail(op, "panel_dump_failed", "INTERNAL_ERROR", FAILED_MSG);
      }

      try {
        await this.#withLeaseRenewal(op.id, () =>
          this.dump(buildPanelDumpCommand(this.config.panelDump!.databaseUrl, file!)),
        );
      } catch (err) {
        const problem = err instanceof PanelDumpError ? err.problem : "panel_dump_failed";
        // Only a reason code: pg_dump's own output names the host and the user.
        this.#logger.warn(
          JSON.stringify({
            event: "panel_dump_failed",
            reason: err instanceof PanelDumpError ? err.reason : "exit",
            exitCode: err instanceof PanelDumpError ? err.exitCode : null,
          }),
        );
        await this.#fail(op, problem, "INTERNAL_ERROR", FAILED_MSG);
      }
      await this.parent.safeUpdateStep(op.id, "dump", "succeeded", "Panel database copied");
      await this.parent.safeUpdateStep(op.id, "upload", "running", "Sending the copy to the backup storage");

      const retentionDays = (await getPolicy(db, "panel")).retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
      // One wait for a free job slot for the whole copy: a second destination does not get one of its own.
      const busyWait: BusyWait = { until: null };
      // One dump, one copy per target (at most two), in priority order and one after the other: the panel lane runs a single
      // job at a time. The second job (`<op>-t2`) reads the first one's dump, so the file stays until every copy settled.
      // A copy that fails does not stop the next one; an unknown outcome stops the run and keeps the file for recovery.
      for (const copy of copies.filter((c) => c.status === "running")) {
        const jobId = copy.jobId ?? op.id;
        try {
          const target = await resolveDispatchTarget(db, this.config.secretsMasterKey, copy.targetId);
          if (!target) {
            await this.#settleCopy(copy, "failed", "other");
            continue;
          }
          const startRes = await this.#startWhenFree(
            op.id,
            {
              action: "panelStart",
              jobId,
              ...(jobId === op.id ? {} : { dumpId: op.id }),
              target,
              masterKey: this.config.secretsMasterKey.toString("hex"),
              retentionDays,
            },
            busyWait,
          );
          await this.#settleCopyFromStatus(copy, await this.parent.pollJobStatus(op.id, jobId, startRes));
        } catch (err) {
          if (isAmbiguousError(err)) throw err;
          await this.#settleCopy(copy, "failed", "other");
        }
      }
      await this.#finish(op);
    } catch (err) {
      if (err instanceof PanelSettled) {
        throw err.causeError;
      }
      if (isAmbiguousError(err)) {
        // The job may still read the file: recover() or the start sweep removes it.
        keepFile = true;
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Panel copy outcome is unknown; recovery will check job status.",
        );
      }
      await this.#fail(op, "other", "INTERNAL_ERROR", FAILED_MSG).catch((e: unknown) => {
        if (!(e instanceof PanelSettled)) throw e;
      });
      throw new ControlPlaneError("INTERNAL_ERROR", FAILED_MSG);
    } finally {
      if (!keepFile && file) {
        await rm(file, { force: true });
      }
    }
  }

  /** Asks the executor for the status of each unfinished copy's job; never starts a copy again. */
  public async recover(op: BackupOperationRef): Promise<"settled" | "pending"> {
    // Only the copies recorded when the run started: a policy change since then must not add a never-run copy.
    const copies = await listPanelBackupCopies(this.dbClient.db, op.id);
    for (const copy of copies.filter((c) => c.status === "running")) {
      let statusRes: BackupJobStatus;
      try {
        statusRes = await this.dockerExecutor.backups({ action: "status", jobId: copy.jobId ?? op.id });
      } catch {
        return "pending";
      }
      if (statusRes.state === "running") {
        if (!(await this.parent.isPastPollDeadline(op.id))) {
          return "pending";
        }
        statusRes = { ...statusRes, state: "failed", failure: "timeout" };
      }
      await this.#settleCopyFromStatus(copy, statusRes);
    }
    try {
      if (copies.length === 0) {
        await this.#fail(op, "interrupted", "OPERATION_INTERRUPTED", INTERRUPTED_MSG);
      }
      await this.#finish(op);
    } catch (err) {
      if (!(err instanceof PanelSettled)) throw err;
    }
    const file = this.#file(op.id);
    if (file) {
      await rm(file, { force: true });
    }
    return "settled";
  }

  /** Removes dump files left by operations that are no longer active. */
  public async sweepStaleDumps(): Promise<void> {
    const dir = this.config.panelDump?.dir;
    if (!dir) {
      return;
    }
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const id = DUMP_FILE.exec(name)?.[1];
      if (!id) {
        continue;
      }
      const [row] = await this.dbClient.db
        .select({ status: operations.status })
        .from(operations)
        .where(eq(operations.id, id))
        .limit(1);
      if (!row || !(ACTIVE_OPERATION_LOCK_STATUSES as readonly string[]).includes(row.status)) {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  /** panelStart, asked again under a renewed lease while the executor refuses it as busy, until the wait is over. */
  async #startWhenFree(
    operationId: string,
    req: Extract<BackupsIpcRequest, { action: "panelStart" }>,
    wait: BusyWait,
  ): Promise<BackupJobStatus> {
    for (;;) {
      try {
        return await this.dockerExecutor.backups(req);
      } catch (err) {
        if (extractKnownErrorCode(err) !== "RESOURCE_LOCKED") throw err;
        wait.until ??= Date.now() + this.busyWaitMs;
        if (Date.now() >= wait.until) throw err;
      }
      await renewOperationLease(this.dbClient.db, operationId, this.parent.leaseMs);
      await sleep(this.busyRetryMs);
    }
  }

  #file(operationId: string): string | null {
    const dir = this.config.panelDump?.dir;
    return dir ? join(dir, `${operationId}.dump`) : null;
  }

  async #withLeaseRenewal(operationId: string, fn: () => Promise<void>): Promise<void> {
    // pg_dump may run far longer than one lease; keep the operation from looking abandoned.
    const timer = setInterval(() => {
      void renewOperationLease(this.dbClient.db, operationId, this.parent.leaseMs).catch(() => undefined);
    }, Math.max(1_000, Math.floor(this.parent.leaseMs / 3)));
    timer.unref();
    try {
      await fn();
    } finally {
      clearInterval(timer);
    }
  }

  /** The copies of an operation: the ones already recorded, plus one per panel policy target that has none yet. */
  async #ensureCopies(operationId: string): Promise<PanelCopyRow[]> {
    const db = this.dbClient.db;
    const existing = await listPanelBackupCopies(db, operationId);
    const missing = (await resolvePanelTargets(db)).filter((t) => !existing.some((c) => c.targetId === t.targetId));
    if (missing.length === 0) {
      return existing;
    }
    await insertPanelBackupCopies(db, operationId, missing);
    return listPanelBackupCopies(db, operationId);
  }

  async #settleCopy(copy: PanelCopyRow, status: "failed", problem: BackupProblem): Promise<void> {
    await settlePanelBackupCopy(this.dbClient.db, copy.id, { status, problem });
  }

  async #settleCopyFromStatus(copy: PanelCopyRow, statusRes: BackupJobStatus): Promise<void> {
    const db = this.dbClient.db;
    if (statusRes.state === "succeeded" && statusRes.snapshot) {
      await settlePanelBackupCopy(db, copy.id, {
        status: "succeeded",
        snapshotId: statusRes.snapshot.snapshotId,
        sizeBytes: statusRes.snapshot.totalBytes,
      });
    } else if (statusRes.state === "failed") {
      await this.#settleCopy(copy, "failed", normalizeBackupProblem(statusRes.failure));
    } else {
      await this.#settleCopy(copy, "failed", statusRes.state === "succeeded" ? "other" : "interrupted");
    }
  }

  /** Settles the operation from its copies: every required copy stored → succeeded, otherwise failed (succeeded copies stay). */
  async #finish(op: BackupOperationRef): Promise<void> {
    const copies = await listPanelBackupCopies(this.dbClient.db, op.id);
    if (copies.length === 0 || aggregateCopyStatuses(copies) === "running") {
      return;
    }
    if (aggregateCopyStatuses(copies) === "succeeded") {
      await this.parent.safeUpdateStep(op.id, "dump", "succeeded", "Panel database copied");
      await this.parent.safeUpdateStep(op.id, "upload", "succeeded", "Copy stored");
      await this.#settle(op, "succeeded", null, null, null);
      return;
    }
    const problem = copies.find((c) => c.required && c.status !== "succeeded")?.problem ?? "other";
    if (problem === "interrupted") {
      await this.#fail(op, problem, "OPERATION_INTERRUPTED", INTERRUPTED_MSG);
    }
    await this.#fail(op, problem, problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR", FAILED_MSG);
  }

  /** Marks the steps failed, settles the unfinished copies and the operation failed, and throws PanelSettled. */
  async #fail(op: BackupOperationRef, problem: BackupProblem, code: ErrorCode, message: string): Promise<never> {
    for (const copy of await listPanelBackupCopies(this.dbClient.db, op.id)) {
      if (copy.status === "running") {
        await this.#settleCopy(copy, "failed", problem);
      }
    }
    const [dumpStep] = await this.dbClient.db
      .select({ status: operationSteps.status })
      .from(operationSteps)
      .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "dump")))
      .limit(1);
    if (dumpStep && !isTerminalStepStatus(dumpStep.status)) {
      await this.parent.safeUpdateStep(op.id, "dump", "failed", message);
      await this.parent.safeUpdateStep(op.id, "upload", "skipped", "Skipped because the copy did not finish");
    } else {
      await this.parent.safeUpdateStep(op.id, "upload", "failed", message);
    }
    await this.#settle(op, "failed", problem, code, message);
    throw new PanelSettled(new ControlPlaneError(code, message));
  }

  /** Writes the three columns, exactly one audit, and the operation's end in one transaction. */
  async #settle(
    op: BackupOperationRef,
    status: "succeeded" | "failed",
    problem: BackupProblem | null,
    code: ErrorCode | null,
    message: string | null,
  ): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: operations.status })
        .from(operations)
        .where(eq(operations.id, op.id))
        .for("update");
      if (!row || isTerminalOperationStatus(row.status)) {
        return;
      }
      const t = tx as unknown as HostingPanelDatabase;
      await recordPanelBackupOutcome(tx, { at: new Date(), status, problem });
      await appendAuditEvent(t, {
        actorId: null,
        actorType: "system",
        organizationId: null,
        action: status === "succeeded" ? "panel.backups.succeeded" : "panel.backups.failed",
        targetType: "backups",
        targetId: null,
        details: { operationId: op.id, problem },
      });
      if (status === "succeeded") {
        if (row.status !== "reconciling" && canTransitionOperation(row.status, "reconciling")) {
          await transitionOperation(t, op.id, "reconciling", { leaseDurationMs: this.parent.leaseMs });
        }
        await transitionOperation(t, op.id, "succeeded", { errorCode: null, errorMessage: null });
      } else if (canTransitionOperation(row.status, "failed")) {
        await transitionOperation(t, op.id, "failed", { errorCode: code, errorMessage: message });
      }
    });
  }
}
