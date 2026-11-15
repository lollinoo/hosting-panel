import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  BACKUP_FAILURE_CLASSES,
  DEFAULT_BACKUP_RETENTION_DAYS,
  ERROR_CODES,
  canTransitionOperation,
  isTerminalOperationStatus,
  type BackupJobStatus,
  type BackupProblem,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  and,
  asc,
  deleteSiteBackups,
  eq,
  getBackupSettingsPublic,
  getBackupTarget,
  listSiteBackups,
  operationSteps,
  operations,
  renewOperationLease,
  settleSiteBackup,
  siteBackups,
  sites,
  transitionOperation,
  updateOperationStepTransactional,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { resolveSiteFilesServiceId } from "../sites/site-files.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { selectExpired } from "./backup-retention.js";
import { SiteRestoreApplier } from "./site-restore-applier.js";

export const BACKUP_LEASE_MS = 120_000;
export const BACKUP_POLL_MS = 5_000;
export const BACKUP_POLL_GIVE_UP_MS = 120_000;
export const SITE_BACKUPS_INTERRUPTED = "This backup was interrupted before it finished.";

export type BackupOperationRef = Pick<
  typeof operations.$inferSelect,
  "id" | "organizationId" | "kind" | "resourceId"
>;

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(BACKUP_FAILURE_CLASSES);
const MAX_FORGET_BATCH = 100;

/** Accepts only known executor failure classes, falling back to 'other'. @internal */
export function normalizeBackupProblem(failure: unknown): BackupProblem {
  return typeof failure === "string" && FAILURE_CLASS_SET.has(failure)
    ? (failure as BackupProblem)
    : "other";
}

/** @internal */
export class BackupSettledFailure extends Error {
  public constructor(public readonly causeError: ControlPlaneError) {
    super(causeError.message);
  }
}

/** @internal */
export function isTerminalStepStatus(status: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}

/** @internal */
export function isAmbiguousError(err: unknown): boolean {
  if (err instanceof ControlPlaneError && err.code === "OPERATION_AMBIGUOUS") {
    return true;
  }
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const obj = err as { code?: unknown; ambiguousOutcome?: unknown };
  return obj.code === "OPERATION_AMBIGUOUS" || obj.ambiguousOutcome === true;
}

/** @internal */
export function extractKnownErrorCode(err: unknown): ErrorCode | null {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return null;
  }
  const candidate = (err as { code?: unknown }).code;
  return typeof candidate === "string" && ERROR_CODE_SET.has(candidate)
    ? (candidate as ErrorCode)
    : null;
}

/** Executes and recovers site backup and prune operations against the executor. */
@Injectable()
export class SiteBackupsApplier {
  readonly #logger = new Logger(SiteBackupsApplier.name);
  readonly #restore: SiteRestoreApplier;
  public leaseMs = BACKUP_LEASE_MS;
  public pollMs = BACKUP_POLL_MS;
  public pollGiveUpMs = BACKUP_POLL_GIVE_UP_MS;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {
    this.#restore = new SiteRestoreApplier(this, dbClient, dockerExecutor, config);
  }

  /** Applies one queued backup, prune, restore, or archive download operation. */
  public async apply(op: BackupOperationRef): Promise<void> {
    if (op.kind === "site.backups.restore" || op.kind === "site.backups.download") {
      await this.#restore.apply(op);
      return;
    }
    if (op.kind === "site.backups.create") {
      await this.#applyCreate(op);
      return;
    }
    if (op.kind === "site.backups.prune") {
      await this.#applyPrune(op);
      return;
    }
    throw new ControlPlaneError("NOT_SUPPORTED", `Unsupported backup operation kind '${op.kind}'`);
  }

  /** Reconciles an expired backup, prune, restore, or download operation without blindly replaying mutations. */
  public async recover(op: BackupOperationRef): Promise<"settled" | "pending"> {
    if (op.kind === "site.backups.restore" || op.kind === "site.backups.download") {
      return this.#restore.recover(op);
    }
    const db = this.dbClient.db;
    const steps = await db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op.id))
      .orderBy(asc(operationSteps.id));

    const backupStep = steps.find((step) => step.key === "backup");
    const retentionStep = steps.find((step) => step.key === "retention");

    if (op.kind === "site.backups.prune" || backupStep?.status === "succeeded") {
      if (retentionStep && !isTerminalStepStatus(retentionStep.status)) {
        await updateOperationStepTransactional(
          db,
          op.id,
          "retention",
          "succeeded",
          "Will retry next night",
        );
      }
      await this.succeedOperation(op.id);
      return "settled";
    }

    let statusRes: BackupJobStatus;
    try {
      statusRes = await this.dockerExecutor.backups({ action: "status", jobId: op.id });
    } catch {
      return "pending";
    }

    if (statusRes.state === "running") {
      return "pending";
    }

    if (statusRes.state === "succeeded") {
      await settleSiteBackup(db, op.id, {
        status: "succeeded",
        snapshotId: statusRes.snapshot?.snapshotId ?? null,
        sizeBytes: statusRes.snapshot?.totalBytes ?? null,
        problem: null,
      });
      await this.safeUpdateStep(op.id, "backup", "succeeded", "Backup uploaded");
      await this.safeUpdateStep(
        op.id,
        "retention",
        "skipped",
        "Skipped after recovery; will run next night",
      );
      await this.succeedOperation(op.id);
      return "settled";
    }

    if (statusRes.state === "failed") {
      const problem = normalizeBackupProblem(statusRes.failure);
      const code: ErrorCode =
        problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR";
      await settleSiteBackup(db, op.id, { status: "failed", problem });
      await this.#failStepAndOperation(op.id, "Backup did not finish", code, "Backup did not finish.");
      return "settled";
    }

    await settleSiteBackup(db, op.id, { status: "failed", problem: "interrupted" });
    await this.#failStepAndOperation(
      op.id,
      SITE_BACKUPS_INTERRUPTED,
      "OPERATION_INTERRUPTED",
      SITE_BACKUPS_INTERRUPTED,
    );
    return "settled";
  }

  async #applyCreate(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    await renewOperationLease(db, op.id, this.leaseMs);
    await this.safeUpdateStep(op.id, "backup", "running", "Backing up site files and databases");

    try {
      await this.#ensureBackupRowStillRunning(op.id);

      const [site] = await db
        .select({
          id: sites.id,
          organizationId: sites.organizationId,
          status: sites.status,
        })
        .from(sites)
        .where(eq(sites.id, op.resourceId))
        .limit(1);
      if (!site) {
        await settleSiteBackup(db, op.id, { status: "failed", problem: "other" });
        const err = new ControlPlaneError("NOT_FOUND", "Site not found for backup");
        await this.#failStepAndOperation(op.id, err.message, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      const target = await getBackupTarget(db, this.config.secretsMasterKey);
      if (!target) {
        await settleSiteBackup(db, op.id, { status: "failed", problem: "other" });
        const err = new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
          details: [{ message: "not_configured" }],
        });
        await this.#failStepAndOperation(op.id, "Backup target is not configured", err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      const serviceInstanceId = await resolveSiteFilesServiceId(
        db,
        this.dockerExecutor,
        this.config,
        site,
      );

      await this.#ensureBackupRowStillRunning(op.id);

      const startRes = await this.dockerExecutor.backups({
        action: "start",
        jobId: op.id,
        siteId: site.id,
        serviceInstanceId,
        target,
      });

      const statusRes = await this.pollJobStatus(op.id, op.id, startRes);

      if (statusRes.state === "succeeded") {
        await settleSiteBackup(db, op.id, {
          status: "succeeded",
          snapshotId: statusRes.snapshot?.snapshotId ?? null,
          sizeBytes: statusRes.snapshot?.totalBytes ?? null,
          problem: null,
        });
        await this.safeUpdateStep(op.id, "backup", "succeeded", "Backup uploaded");
      } else if (statusRes.state === "failed") {
        const problem = normalizeBackupProblem(statusRes.failure);
        const code: ErrorCode =
          problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR";
        await settleSiteBackup(db, op.id, { status: "failed", problem });
        const err = new ControlPlaneError(code, "Backup did not finish.");
        await this.#failStepAndOperation(op.id, "Backup did not finish", code, err.message);
        throw new BackupSettledFailure(err);
      } else {
        await settleSiteBackup(db, op.id, { status: "failed", problem: "interrupted" });
        const err = new ControlPlaneError("OPERATION_INTERRUPTED", SITE_BACKUPS_INTERRUPTED);
        await this.#failStepAndOperation(
          op.id,
          SITE_BACKUPS_INTERRUPTED,
          err.code,
          SITE_BACKUPS_INTERRUPTED,
        );
        throw new BackupSettledFailure(err);
      }
    } catch (err) {
      if (err instanceof BackupSettledFailure) {
        throw err.causeError;
      }
      if (isAmbiguousError(err)) {
        // Leave site_backups running so OutboxWorker moves the op to unknown for recover().
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Backup outcome is unknown; recovery will check job status.",
        );
      }
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      const problem: BackupProblem = code === "RESOURCE_LOCKED" ? "site_busy" : "other";
      await settleSiteBackup(db, op.id, { status: "failed", problem });
      const safeMessage =
        err instanceof ControlPlaneError ? err.message : "Backup did not finish.";
      await this.#failStepAndOperation(op.id, safeMessage, code, safeMessage);
      throw err instanceof ControlPlaneError ? err : new ControlPlaneError(code, safeMessage);
    }

    await this.#runRetentionStep(op);
    await this.succeedOperation(op.id);
  }

  /** Fails the operation as interrupted when its backup row is gone or no longer running. */
  async #ensureBackupRowStillRunning(operationId: string): Promise<void> {
    const [backupRow] = await this.dbClient.db
      .select({ status: siteBackups.status })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, operationId))
      .limit(1);
    if (backupRow?.status !== "running") {
      const err = new ControlPlaneError("OPERATION_INTERRUPTED", SITE_BACKUPS_INTERRUPTED);
      await this.#failStepAndOperation(operationId, SITE_BACKUPS_INTERRUPTED, err.code, err.message);
      throw new BackupSettledFailure(err);
    }
  }

  async #applyPrune(op: BackupOperationRef): Promise<void> {
    await renewOperationLease(this.dbClient.db, op.id, this.leaseMs);
    await this.#runRetentionStep(op);
    await this.succeedOperation(op.id);
  }

  async #runRetentionStep(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    await renewOperationLease(db, op.id, this.leaseMs);
    await this.safeUpdateStep(op.id, "retention", "running", "Removing old backups");

    try {
      const settings = await getBackupSettingsPublic(db);
      const retentionDays = settings?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
      const [siteRow] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.id, op.resourceId))
        .limit(1);
      const rows = await listSiteBackups(db, op.resourceId);
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const { forget, drop } = selectExpired(rows, new Date(), retentionDays, Boolean(siteRow));

      await this.#discardAndDeleteBackupRows(
        drop.map((row) => row.id),
        rowsById,
      );

      if (forget.length > 0) {
        const batch = forget.slice(0, MAX_FORGET_BATCH);
        const snapshotIds = batch
          .map((row) => row.snapshotId)
          .filter((id): id is string => typeof id === "string" && id.length > 0);

        if (snapshotIds.length > 0) {
          const target = await getBackupTarget(db, this.config.secretsMasterKey);
          if (!target) {
            throw new ControlPlaneError("VALIDATION_ERROR", "not_configured");
          }
          const forgetJobId = `${op.id}-forget`;
          const startForget = await this.dockerExecutor.backups({
            action: "forget",
            jobId: forgetJobId,
            siteId: op.resourceId,
            target,
            snapshotIds,
          });
          const forgetStatus = await this.pollJobStatus(op.id, forgetJobId, startForget);
          if (forgetStatus.state !== "succeeded") {
            throw new ControlPlaneError("INTERNAL_ERROR", "retention_forget_failed");
          }
          await this.#discardAndDeleteBackupRows(
            batch.map((row) => row.id),
            rowsById,
          );
        }
      }

      await this.safeUpdateStep(op.id, "retention", "succeeded", "Old backups checked");
    } catch (err) {
      if (isAmbiguousError(err)) {
        throw err;
      }
      const code = extractKnownErrorCode(err) ?? "RETENTION_ERROR";
      // Never log secrets, snapshot IDs, or host paths from retention failures.
      this.#logger.warn(`Retention step skipped for ${op.id} (${code}); will retry next night`);
      await this.safeUpdateStep(op.id, "retention", "succeeded", "Will retry next night");
    }
  }

  /** @internal */
  public async pollJobStatus(
    operationId: string,
    jobId: string,
    initial: BackupJobStatus,
  ): Promise<BackupJobStatus> {
    let statusRes = initial;
    let pollErrorSinceMs: number | null = null;
    let firstPoll = true;

    while (statusRes.state === "running") {
      await this.#renewLeaseOrAmbiguous(operationId);
      // First status poll executes without waiting so synchronous executors finish at once.
      if (!firstPoll && this.pollMs > 0) {
        await this.#delay(this.pollMs);
        await this.#renewLeaseOrAmbiguous(operationId);
      }
      firstPoll = false;

      try {
        statusRes = await this.dockerExecutor.backups({ action: "status", jobId });
        pollErrorSinceMs = null;
      } catch {
        const nowMs = Date.now();
        pollErrorSinceMs ??= nowMs;
        if (nowMs - pollErrorSinceMs >= this.pollGiveUpMs) {
          throw new ControlPlaneError(
            "OPERATION_AMBIGUOUS",
            "Backup status polling timed out while executor was unreachable",
          );
        }
        if (this.pollMs <= 0) {
          await this.#delay(1);
        }
      }
    }

    return statusRes;
  }

  /** @internal */
  public async safeUpdateStep(
    operationId: string,
    stepKey: string,
    status: "running" | "succeeded" | "failed" | "skipped",
    message: string,
  ): Promise<void> {
    const db = this.dbClient.db;
    const [existing] = await db
      .select({ status: operationSteps.status })
      .from(operationSteps)
      .where(
        and(
          eq(operationSteps.operationId, operationId),
          eq(operationSteps.key, stepKey),
        ),
      )
      .limit(1);

    if (!existing || isTerminalStepStatus(existing.status)) {
      return;
    }

    await updateOperationStepTransactional(db, operationId, stepKey, status, message);
  }

  async #failStepAndOperation(
    operationId: string,
    stepMessage: string,
    errorCode: ErrorCode,
    errorMessage: string,
  ): Promise<void> {
    await this.safeUpdateStep(operationId, "backup", "failed", stepMessage);
    await this.safeUpdateStep(
      operationId,
      "retention",
      "skipped",
      "Skipped because backup did not finish",
    );
    await this.failOperation(operationId, errorCode, errorMessage);
  }

  /** @internal */
  public async succeedOperation(operationId: string): Promise<void> {
    const db = this.dbClient.db;
    const [op] = await db
      .select({ status: operations.status })
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);

    if (!op || isTerminalOperationStatus(op.status)) {
      return;
    }

    // Recovered unknown ops must pass through reconciling before succeeding.
    if (op.status !== "reconciling" && canTransitionOperation(op.status, "reconciling")) {
      await transitionOperation(db, operationId, "reconciling", {
        leaseDurationMs: this.leaseMs,
      });
    }
    await transitionOperation(db, operationId, "succeeded", {
      errorCode: null,
      errorMessage: null,
    });
  }

  /** @internal */
  public async failOperation(
    operationId: string,
    errorCode: ErrorCode,
    errorMessage: string,
  ): Promise<void> {
    const db = this.dbClient.db;
    const [op] = await db
      .select({ status: operations.status })
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);

    if (!op || isTerminalOperationStatus(op.status) || !canTransitionOperation(op.status, "failed")) {
      return;
    }

    await transitionOperation(db, operationId, "failed", {
      errorCode,
      errorMessage,
    });
  }

  async #discardAndDeleteBackupRows(
    ids: readonly string[],
    rowsById: ReadonlyMap<string, typeof siteBackups.$inferSelect>,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      const row = rowsById.get(id);
      if (row && row.archiveStatus !== null && row.archiveOperationId !== null) {
        try {
          await this.dockerExecutor.backups({
            action: "discardArchive",
            jobId: row.archiveOperationId,
          });
        } catch {
          // Executor expires uncollected archives after 60 minutes anyway; do not block retention.
        }
      }
    }
    await deleteSiteBackups(this.dbClient.db, [...ids]);
  }

  /** Converts lease-renewal failures during polling into ambiguous operation errors. */
  async #renewLeaseOrAmbiguous(operationId: string): Promise<void> {
    try {
      await renewOperationLease(this.dbClient.db, operationId, this.leaseMs);
    } catch {
      throw new ControlPlaneError(
        "OPERATION_AMBIGUOUS",
        "Could not renew backup operation lease while polling",
      );
    }
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
