import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  canTransitionOperation,
  isTerminalOperationStatus,
  type BackupJobStatus,
  type BackupProblem,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  ACTIVE_OPERATION_LOCK_STATUSES,
  and,
  appendAuditEvent,
  eq,
  getBackupSettingsPublic,
  getBackupTarget,
  operationSteps,
  operations,
  recordPanelBackupOutcome,
  renewOperationLease,
  transitionOperation,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";
import { PanelDumpError, buildPanelDumpCommand, runPanelDump, type PanelDumpCommand } from "./panel-dump.js";
import {
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

      const target = await getBackupTarget(db, this.config.secretsMasterKey);
      if (!target) {
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

      const settings = await getBackupSettingsPublic(db);
      const startRes = await this.dockerExecutor.backups({
        action: "panelStart",
        jobId: op.id,
        target: target!,
        masterKey: this.config.secretsMasterKey.toString("hex"),
        retentionDays: settings?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
      });
      const statusRes = await this.parent.pollJobStatus(op.id, op.id, startRes);
      await this.#settleFromStatus(op, statusRes);
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

  /** Asks the executor for the job's status; never starts the copy again. */
  public async recover(op: BackupOperationRef): Promise<"settled" | "pending"> {
    let statusRes: BackupJobStatus;
    try {
      statusRes = await this.dockerExecutor.backups({ action: "status", jobId: op.id });
    } catch {
      return "pending";
    }
    if (statusRes.state === "running") {
      if (!(await this.parent.isPastPollDeadline(op.id))) {
        return "pending";
      }
      statusRes = { ...statusRes, state: "failed", failure: "timeout" };
    }
    try {
      await this.#settleFromStatus(op, statusRes);
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

  async #settleFromStatus(op: BackupOperationRef, statusRes: BackupJobStatus): Promise<void> {
    if (statusRes.state === "succeeded") {
      await this.parent.safeUpdateStep(op.id, "dump", "succeeded", "Panel database copied");
      await this.parent.safeUpdateStep(op.id, "upload", "succeeded", "Copy stored");
      await this.#settle(op, "succeeded", null, null, null);
      return;
    }
    if (statusRes.state === "failed") {
      const problem = normalizeBackupProblem(statusRes.failure);
      await this.#fail(op, problem, problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR", FAILED_MSG);
    }
    await this.#fail(op, "interrupted", "OPERATION_INTERRUPTED", INTERRUPTED_MSG);
  }

  /** Marks the steps failed, settles the operation failed, and throws PanelSettled. */
  async #fail(op: BackupOperationRef, problem: BackupProblem, code: ErrorCode, message: string): Promise<never> {
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
