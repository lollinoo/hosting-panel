import {
  DEFAULT_PHP_VERSION,
  type BackupJobStatus,
  type BackupProblem,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  eq,
  getBackupTarget,
  listSiteDatabases,
  operationSteps,
  renewOperationLease,
  resolveDecryptedSecretRefs,
  serviceInstances,
  settleSiteArchive,
  settleSiteRestore,
  siteBackups,
  sites,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { buildApprovedServiceSpec, recordDeployedState } from "../runtime/service-spec.js";
import { SITE_STEP_LEASE_MS } from "../runtime/site-provisioner.js";
import { resolveSiteFilesServiceId } from "../sites/site-files.service.js";
import type { ControlPlaneRuntimeConfig } from "../tokens.js";
import {
  BackupSettledFailure,
  extractKnownErrorCode,
  isAmbiguousError,
  isTerminalStepStatus,
  normalizeBackupProblem,
  type BackupOperationRef,
  type SiteBackupsApplier,
} from "./site-backups-applier.js";

/** Ordered step definitions for site restore operations. */
export const SITE_RESTORE_STEPS = [
  { key: "restore", label: "Put the backup back" },
  { key: "update_address", label: "Update the site address" },
] as const satisfies readonly { key: string; label: string }[];

/** Ordered steps of an administrator's restore, which also works where nothing of the site exists. */
export const ADMIN_SITE_RESTORE_STEPS = [
  { key: "provision_database", label: "Create the site database" },
  { key: "restore", label: "Put the backup back" },
  { key: "start_site", label: "Start the site" },
  { key: "update_address", label: "Update the site address" },
  { key: "sftp", label: "Turn file access back on" },
] as const satisfies readonly { key: string; label: string }[];

/** Ordered step definitions for backup archive download preparation operations. */
export const SITE_ARCHIVE_STEPS = [
  { key: "prepare", label: "Prepare the download" },
] as const satisfies readonly { key: string; label: string }[];

const RESTORE_RUNNING_MSG = "Restoring site files and database";
const RESTORE_DONE_MSG = "Backup restored";
const RESTORE_FAILED_MSG = "Restore did not finish.";
const RESTORE_INTERRUPTED_MSG = "This restore was interrupted before it finished.";
const ADDRESS_RUNNING_MSG = "Updating site address";
const ADDRESS_DONE_MSG = "Site address updated";
const ADDRESS_SKIPPED_MSG = "Site has no address; skipped";
const ADDRESS_FAILED_MSG = "Could not update the site address";
const DB_RUNNING_MSG = "Creating the site database";
const DB_DONE_MSG = "Site database created";
const DB_FAILED_MSG = "Could not create the site database";
const START_RUNNING_MSG = "Starting the site";
const START_DONE_MSG = "Site started";
const START_SKIPPED_MSG = "The site is already running; skipped";
const START_STOPPED_MSG = "The site was stopped on purpose; skipped";
const START_FAILED_MSG = "The files are back but the site did not start. Redeploy the site.";
const SFTP_RUNNING_MSG = "Turning file access back on";
const SFTP_DONE_MSG = "File access is on";
const SFTP_SKIPPED_MSG = "File access is not available; skipped";
const SFTP_FAILED_MSG = "Could not turn file access back on";
const NOT_FINISHED_MSG = "Skipped because restore did not finish";
const ARCHIVE_RUNNING_MSG = "Preparing download archive";
const ARCHIVE_DONE_MSG = "Download archive is ready";
const ARCHIVE_FAILED_MSG = "Download preparation did not finish.";
const ARCHIVE_INTERRUPTED_MSG = "This download preparation was interrupted before it finished.";

interface RestoreSiteRef {
  readonly id: string;
  readonly organizationId: string;
  readonly status: string;
  readonly wordpressUrl: string | null;
  readonly phpVersion: typeof sites.$inferSelect.phpVersion;
}

interface RestoreContext {
  readonly siteUrl: string | null;
  readonly site: RestoreSiteRef;
  readonly serviceInstanceId: string;
}

/** Executes and recovers M3b site restore and backup download archive operations. */
export class SiteRestoreApplier {
  public constructor(
    private readonly parent: SiteBackupsApplier,
    private readonly dbClient: DatabaseClient,
    private readonly dockerExecutor: DockerExecutorPort,
    private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Dispatches queued restore or archive download operations. */
  public async apply(op: BackupOperationRef): Promise<void> {
    if (op.kind === "site.backups.restore") {
      await this.applyRestore(op);
      return;
    }
    if (op.kind === "site.backups.download") {
      await this.applyDownload(op);
      return;
    }
    const message = `Unsupported restore operation kind '${op.kind}'`;
    await this.parent.failOperation(op.id, "NOT_SUPPORTED", message);
    throw new ControlPlaneError("NOT_SUPPORTED", message);
  }

  /** Executes a queued site restore operation, runs E7 address reconciliation, and settles state/audit. */
  public async applyRestore(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    const admin = await this.#isAdminRun(op.id);
    if (!admin) {
      await this.parent.safeUpdateStep(op.id, "restore", "running", RESTORE_RUNNING_MSG);
    }
    await renewOperationLease(db, op.id, this.parent.leaseMs);

    let restored = false;
    try {
      await this.#ensureRestoreRowStillRunning(op.id);

      const site = await this.#findRestoreSite(op.resourceId);
      if (!site) {
        await this.#settleRestoreRowAndAudit(op, "failed", "other");
        const err = new ControlPlaneError("NOT_FOUND", "Site not found for restore");
        await this.#failRestoreStepsAndOp(op.id, err.message, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      const target = await getBackupTarget(db, this.config.secretsMasterKey);
      if (!target) {
        await this.#settleRestoreRowAndAudit(op, "failed", "other");
        const err = new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
          details: [{ message: "not_configured" }],
        });
        await this.#failRestoreStepsAndOp(
          op.id,
          "Backup target is not configured",
          err.code,
          err.message,
        );
        throw new BackupSettledFailure(err);
      }

      const serviceInstanceId = await resolveSiteFilesServiceId(
        db,
        this.dockerExecutor,
        this.config,
        site,
      );

      // Re-check row ownership as the last DB read before mutating the site via executor.
      const row = await this.#ensureRestoreRowStillRunning(op.id);
      if (!row.snapshotId) {
        await this.#settleRestoreRowAndAudit(op, "failed", "other");
        const err = new ControlPlaneError("VALIDATION_ERROR", "Backup snapshot is missing.");
        await this.#failRestoreStepsAndOp(op.id, err.message, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      let createVolume = false;
      if (admin) {
        createVolume = await this.#runProvisionStep(op, site, serviceInstanceId);
        await this.parent.safeUpdateStep(op.id, "restore", "running", RESTORE_RUNNING_MSG);
        await renewOperationLease(db, op.id, this.parent.leaseMs);
      }

      const startRes = await this.dockerExecutor.backups({
        action: "restore",
        jobId: op.id,
        siteId: site.id,
        serviceInstanceId,
        target,
        snapshotId: row.snapshotId,
        ...(createVolume ? { createVolume: true as const } : {}),
      });

      const statusRes = await this.parent.pollJobStatus(op.id, op.id, startRes);
      restored = statusRes.state === "succeeded";

      await this.#finishRestore(
        op,
        statusRes,
        { siteUrl: row.siteUrl, site, serviceInstanceId },
        { throwOnFailure: true },
      );
    } catch (err) {
      if (err instanceof BackupSettledFailure) {
        throw err.causeError;
      }
      // R104: after the executor restored, an error (DB) must not record "didn't happen"; recovery finishes.
      if (restored || isAmbiguousError(err)) {
        // Leave row running so OutboxWorker transitions to unknown and recover() calls settle.
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Restore outcome is unknown; recovery will settle job state.",
        );
      }
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      const problem: BackupProblem = code === "RESOURCE_LOCKED" ? "site_busy" : "other";
      const safeMessage =
        err instanceof ControlPlaneError ? err.message : RESTORE_FAILED_MSG;
      await this.#settleRestoreRowAndAudit(op, "failed", problem);
      await this.#failRestoreStepsAndOp(op.id, safeMessage, code, safeMessage);
      throw err instanceof ControlPlaneError ? err : new ControlPlaneError(code, safeMessage);
    }
  }

  /** Executes a queued backup archive download preparation operation. */
  public async applyDownload(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    await this.parent.safeUpdateStep(op.id, "prepare", "running", ARCHIVE_RUNNING_MSG);
    await renewOperationLease(db, op.id, this.parent.leaseMs);

    try {
      await this.#ensureArchiveRowPreparing(op.id);

      const target = await getBackupTarget(db, this.config.secretsMasterKey);
      if (!target) {
        await settleSiteArchive(db, op.id, {
          status: "failed",
          readyUntil: null,
          problem: "other",
        });
        const err = new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
          details: [{ message: "not_configured" }],
        });
        await this.parent.safeUpdateStep(
          op.id,
          "prepare",
          "failed",
          "Backup target is not configured",
        );
        await this.parent.failOperation(op.id, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      // Re-check row ownership as the last DB read before requesting archive creation.
      const row = await this.#ensureArchiveRowPreparing(op.id);
      if (!row.snapshotId) {
        await settleSiteArchive(db, op.id, {
          status: "failed",
          readyUntil: null,
          problem: "other",
        });
        const err = new ControlPlaneError("VALIDATION_ERROR", "Backup snapshot is missing.");
        await this.parent.safeUpdateStep(op.id, "prepare", "failed", err.message);
        await this.parent.failOperation(op.id, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      const startRes = await this.dockerExecutor.backups({
        action: "archive",
        jobId: op.id,
        siteId: op.resourceId,
        target,
        snapshotId: row.snapshotId,
      });

      const statusRes = await this.parent.pollJobStatus(op.id, op.id, startRes);

      await this.#finishDownload(op, statusRes, { throwOnFailure: true });
    } catch (err) {
      if (err instanceof BackupSettledFailure) {
        throw err.causeError;
      }
      if (isAmbiguousError(err)) {
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Download preparation outcome is unknown; recovery will check job status.",
        );
      }
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      const problem: BackupProblem = code === "RESOURCE_LOCKED" ? "site_busy" : "other";
      const safeMessage =
        err instanceof ControlPlaneError ? err.message : ARCHIVE_FAILED_MSG;
      await settleSiteArchive(db, op.id, {
        status: "failed",
        readyUntil: null,
        problem,
      });
      await this.parent.safeUpdateStep(op.id, "prepare", "failed", safeMessage);
      await this.parent.failOperation(op.id, code, safeMessage);
      throw err instanceof ControlPlaneError ? err : new ControlPlaneError(code, safeMessage);
    }
  }

  /** Reconciles an interrupted restore or download operation without restarting backup transfer. */
  public async recover(op: BackupOperationRef): Promise<"settled" | "pending"> {
    if (op.kind === "site.backups.restore") {
      return this.#recoverRestore(op);
    }
    if (op.kind === "site.backups.download") {
      return this.#recoverDownload(op);
    }
    await this.parent.failOperation(
      op.id,
      "NOT_SUPPORTED",
      `Unsupported restore operation kind '${op.kind}'`,
    );
    return "settled";
  }

  async #recoverRestore(op: BackupOperationRef): Promise<"settled" | "pending"> {
    const db = this.dbClient.db;
    const steps = await db
      .select()
      .from(operationSteps)
      .where(eq(operationSteps.operationId, op.id))
      .orderBy(asc(operationSteps.id));

    const restoreStep = steps.find((step) => step.key === "restore");
    if (restoreStep?.status === "pending") {
      // Stopped before the restore began: nothing was put back, so fail without asking the executor.
      await this.#settleRestoreRowAndAudit(op, "failed", "interrupted");
      await this.#failRestoreStepsAndOp(
        op.id,
        RESTORE_INTERRUPTED_MSG,
        "OPERATION_INTERRUPTED",
        RESTORE_INTERRUPTED_MSG,
      );
      return "settled";
    }
    if (restoreStep?.status === "succeeded") {
      // Restore already completed before crash; only run the idempotent E7 tail and settle.
      await this.#finishRestore(
        op,
        { jobId: op.id, state: "succeeded", failure: null, snapshot: null },
        undefined,
        { throwOnFailure: false },
      );
      return "settled";
    }

    let settleRes: BackupJobStatus;
    try {
      settleRes = await this.dockerExecutor.backups({ action: "settle", jobId: op.id });
    } catch {
      return "pending";
    }

    if (settleRes.state === "running") {
      return "pending";
    }

    await this.#finishRestore(op, settleRes, undefined, { throwOnFailure: false });
    return "settled";
  }

  async #recoverDownload(op: BackupOperationRef): Promise<"settled" | "pending"> {
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

    await this.#finishDownload(op, statusRes, { throwOnFailure: false });
    return "settled";
  }

  async #finishRestore(
    op: BackupOperationRef,
    statusRes: BackupJobStatus,
    ctx: RestoreContext | undefined,
    opts: { readonly throwOnFailure: boolean },
  ): Promise<void> {
    if (statusRes.state === "succeeded") {
      await this.parent.safeUpdateStep(op.id, "restore", "succeeded", RESTORE_DONE_MSG);
      const admin = await this.#isAdminRun(op.id);
      if (admin) {
        const startFailure = await this.#runStartSite(op, ctx);
        if (startFailure) {
          await this.parent.safeUpdateStep(op.id, "update_address", "skipped", START_FAILED_MSG);
          await this.parent.safeUpdateStep(op.id, "sftp", "skipped", START_FAILED_MSG);
          await this.#settleRestoreRowAndAudit(op, "succeeded", "site_not_started");
          await this.parent.failOperation(op.id, startFailure.code, START_FAILED_MSG);
          if (opts.throwOnFailure) {
            throw new BackupSettledFailure(startFailure);
          }
          return;
        }
      }
      const problem = await this.#runAddressStep(op, ctx);
      if (admin) {
        await this.#runSftpStep(op);
      }
      await this.#settleRestoreRowAndAudit(op, "succeeded", problem);
      await this.parent.succeedOperation(op.id);
      return;
    }

    if (statusRes.state === "failed") {
      const problem = normalizeBackupProblem(statusRes.failure);
      const code: ErrorCode =
        problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR";
      // R80: restore failures never change sites.status (including undo_incomplete).
      await this.#settleRestoreRowAndAudit(op, "failed", problem);
      await this.#failRestoreStepsAndOp(op.id, RESTORE_FAILED_MSG, code, RESTORE_FAILED_MSG);
      if (opts.throwOnFailure) {
        throw new BackupSettledFailure(new ControlPlaneError(code, RESTORE_FAILED_MSG));
      }
      return;
    }

    await this.#settleRestoreRowAndAudit(op, "failed", "interrupted");
    await this.#failRestoreStepsAndOp(
      op.id,
      RESTORE_INTERRUPTED_MSG,
      "OPERATION_INTERRUPTED",
      RESTORE_INTERRUPTED_MSG,
    );
    if (opts.throwOnFailure) {
      throw new BackupSettledFailure(
        new ControlPlaneError("OPERATION_INTERRUPTED", RESTORE_INTERRUPTED_MSG),
      );
    }
  }

  async #finishDownload(
    op: BackupOperationRef,
    statusRes: BackupJobStatus,
    opts: { readonly throwOnFailure: boolean },
  ): Promise<void> {
    const db = this.dbClient.db;

    if (statusRes.state === "succeeded") {
      const parsedExpiry = statusRes.archive?.expiresAt
        ? new Date(statusRes.archive.expiresAt)
        : null;
      const readyUntil =
        parsedExpiry && !Number.isNaN(parsedExpiry.getTime()) ? parsedExpiry : null;
      await settleSiteArchive(db, op.id, {
        status: "ready",
        readyUntil,
        problem: null,
      });
      await this.parent.safeUpdateStep(op.id, "prepare", "succeeded", ARCHIVE_DONE_MSG);
      await this.parent.succeedOperation(op.id);
      return;
    }

    if (statusRes.state === "failed") {
      const problem = normalizeBackupProblem(statusRes.failure);
      const code: ErrorCode =
        problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR";
      await settleSiteArchive(db, op.id, {
        status: "failed",
        readyUntil: null,
        problem,
      });
      await this.parent.safeUpdateStep(op.id, "prepare", "failed", ARCHIVE_FAILED_MSG);
      await this.parent.failOperation(op.id, code, ARCHIVE_FAILED_MSG);
      if (opts.throwOnFailure) {
        throw new BackupSettledFailure(new ControlPlaneError(code, ARCHIVE_FAILED_MSG));
      }
      return;
    }

    await settleSiteArchive(db, op.id, {
      status: "failed",
      readyUntil: null,
      problem: "interrupted",
    });
    await this.parent.safeUpdateStep(op.id, "prepare", "failed", ARCHIVE_INTERRUPTED_MSG);
    await this.parent.failOperation(op.id, "OPERATION_INTERRUPTED", ARCHIVE_INTERRUPTED_MSG);
    if (opts.throwOnFailure) {
      throw new BackupSettledFailure(
        new ControlPlaneError("OPERATION_INTERRUPTED", ARCHIVE_INTERRUPTED_MSG),
      );
    }
  }

  /** Runs E7 post-restore URL reconciliation; failures yield 'address_not_updated' without failing the restore. */
  async #runAddressStep(
    op: BackupOperationRef,
    ctx: RestoreContext | undefined,
  ): Promise<"address_not_updated" | null> {
    const db = this.dbClient.db;
    const [existingStep] = await db
      .select({ status: operationSteps.status })
      .from(operationSteps)
      .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "update_address")))
      .limit(1);

    if (existingStep && isTerminalStepStatus(existingStep.status)) {
      return existingStep.status === "failed" ? "address_not_updated" : null;
    }

    const site: RestoreSiteRef | undefined =
      ctx?.site ?? (await this.#findRestoreSite(op.resourceId));

    const currentUrl = site?.wordpressUrl ?? null;
    if (!site || currentUrl === null || currentUrl.length === 0) {
      await this.parent.safeUpdateStep(
        op.id,
        "update_address",
        "skipped",
        ADDRESS_SKIPPED_MSG,
      );
      return null;
    }

    const previousSiteUrl =
      ctx !== undefined
        ? ctx.siteUrl
        : (
            await db
              .select({ siteUrl: siteBackups.siteUrl })
              .from(siteBackups)
              .where(eq(siteBackups.restoreOperationId, op.id))
              .limit(1)
          )[0]?.siteUrl ?? null;

    const previousUrl = previousSiteUrl ?? currentUrl;

    await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
    await this.parent.safeUpdateStep(op.id, "update_address", "running", ADDRESS_RUNNING_MSG);

    let addressFailed = false;
    try {
      const serviceInstanceId =
        ctx?.serviceInstanceId ??
        (await resolveSiteFilesServiceId(db, this.dockerExecutor, this.config, site));

      const urlResult = await this.dockerExecutor.runSiteJob({
        jobId: `job_${op.id.replace(/^op_/, "")}_rurl`,
        kind: "wordpress.set-url",
        siteId: site.id,
        organizationId: site.organizationId,
        serviceInstanceId,
        params: {
          phpVersion: site.phpVersion ?? DEFAULT_PHP_VERSION,
          siteUrl: currentUrl,
          previousUrl,
        },
      });
      if (urlResult.exitCode !== 0) {
        addressFailed = true;
      }
    } catch {
      // Restore data is already on disk and DB; URL mismatch is non-fatal (E7).
      addressFailed = true;
    }

    if (addressFailed) {
      await this.parent.safeUpdateStep(op.id, "update_address", "failed", ADDRESS_FAILED_MSG);
      return "address_not_updated";
    }

    await this.parent.safeUpdateStep(op.id, "update_address", "succeeded", ADDRESS_DONE_MSG);
    return null;
  }

  /** Atomically settles a running restore row and writes the single system finished audit event. */
  async #settleRestoreRowAndAudit(
    op: BackupOperationRef,
    outcome: "succeeded" | "failed",
    problem: BackupProblem | null,
  ): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          id: siteBackups.id,
          restoreStatus: siteBackups.restoreStatus,
        })
        .from(siteBackups)
        .where(eq(siteBackups.restoreOperationId, op.id))
        .for("update");

      // Write the finished audit only when this transition settles the running row (never twice).
      if (row?.restoreStatus !== "running") {
        return;
      }

      await settleSiteRestore(tx, op.id, { status: outcome, problem });
      const admin = await this.#isAdminRun(op.id, tx as unknown as HostingPanelDatabase);
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: admin ? "admin.site.backups.restore.finished" : "site.backups.restore.finished",
        targetType: "site",
        targetId: op.resourceId,
        details: {
          operationId: op.id,
          backupId: row.id,
          outcome,
          problem,
        },
      });
    });
  }

  async #failRestoreStepsAndOp(
    operationId: string,
    stepMessage: string,
    errorCode: ErrorCode,
    errorMessage: string,
  ): Promise<void> {
    const open = await this.dbClient.db
      .select({ key: operationSteps.key, status: operationSteps.status })
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId))
      .orderBy(asc(operationSteps.id));
    for (const step of open) {
      if (isTerminalStepStatus(step.status)) continue;
      // The restore and any step cut off while running fail; steps never begun are skipped.
      const failed = step.key === "restore" || step.status === "running";
      await this.parent.safeUpdateStep(
        operationId,
        step.key,
        failed ? "failed" : "skipped",
        failed ? stepMessage : NOT_FINISHED_MSG,
      );
    }
    await this.parent.failOperation(operationId, errorCode, errorMessage);
  }

  /** An administrator's run is the one queued with a provision_database step. */
  async #isAdminRun(operationId: string, db: HostingPanelDatabase = this.dbClient.db): Promise<boolean> {
    const [step] = await db
      .select({ id: operationSteps.id })
      .from(operationSteps)
      .where(and(eq(operationSteps.operationId, operationId), eq(operationSteps.key, "provision_database")))
      .limit(1);
    return step !== undefined;
  }

  /** R119: asks what exists and always ensures the site database and user; returns createVolume. A known failure settles restore_prepare_failed. */
  async #runProvisionStep(
    op: BackupOperationRef,
    site: RestoreSiteRef,
    serviceInstanceId: string,
  ): Promise<boolean> {
    const db = this.dbClient.db;
    await this.parent.safeUpdateStep(op.id, "provision_database", "running", DB_RUNNING_MSG);
    await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
    let createVolume: boolean;
    try {
      const state = await this.dockerExecutor.backups({
        action: "siteState",
        siteId: site.id,
        serviceInstanceId,
      });
      createVolume = !state.filesVolume;
      const [siteDb] = await listSiteDatabases(db, {
        organizationId: site.organizationId,
        siteId: site.id,
      });
      if (!siteDb) {
        throw new ControlPlaneError("NOT_FOUND", DB_FAILED_MSG);
      }
      const res = await this.dockerExecutor.runSiteJob({
        jobId: `job_${op.id.replace(/^op_/, "")}_rdb`,
        kind: "db.provision",
        siteId: site.id,
        organizationId: site.organizationId,
        params: { dbName: siteDb.dbName, dbUser: siteDb.dbUser },
        resolvedSecrets: await resolveDecryptedSecretRefs(db, {
          organizationId: site.organizationId,
          siteId: site.id,
          secretRefs: { HP_DB_PASSWORD: "SITE_DB_PASSWORD" },
          masterKey: this.config.secretsMasterKey,
        }),
      });
      if (res.exitCode !== 0) {
        throw new ControlPlaneError("INTERNAL_ERROR", DB_FAILED_MSG);
      }
    } catch (err) {
      if (isAmbiguousError(err)) throw err;
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      await this.parent.safeUpdateStep(op.id, "provision_database", "failed", DB_FAILED_MSG);
      await this.parent.safeUpdateStep(op.id, "restore", "skipped", NOT_FINISHED_MSG);
      await this.#settleRestoreRowAndAudit(op, "failed", "restore_prepare_failed");
      await this.#failRestoreStepsAndOp(op.id, DB_FAILED_MSG, code, DB_FAILED_MSG);
      throw new BackupSettledFailure(new ControlPlaneError(code, DB_FAILED_MSG));
    }
    await this.parent.safeUpdateStep(op.id, "provision_database", "succeeded", DB_DONE_MSG);
    return createVolume;
  }

  /** CP-01: asks again right before deploying and deploys only when nothing runs; never installs or restarts. */
  async #runStartSite(
    op: BackupOperationRef,
    ctx: RestoreContext | undefined,
  ): Promise<ControlPlaneError | null> {
    const db = this.dbClient.db;
    const [existing] = await db
      .select({ status: operationSteps.status })
      .from(operationSteps)
      .where(and(eq(operationSteps.operationId, op.id), eq(operationSteps.key, "start_site")))
      .limit(1);
    if (existing && isTerminalStepStatus(existing.status)) {
      return existing.status === "failed"
        ? new ControlPlaneError("INTERNAL_ERROR", START_FAILED_MSG)
        : null;
    }

    await renewOperationLease(db, op.id, SITE_STEP_LEASE_MS);
    await this.parent.safeUpdateStep(op.id, "start_site", "running", START_RUNNING_MSG);
    try {
      const site = ctx?.site ?? (await this.#findRestoreSite(op.resourceId));
      if (!site) {
        throw new ControlPlaneError("NOT_FOUND", "Site not found for restore");
      }
      const serviceInstanceId =
        ctx?.serviceInstanceId ??
        (await resolveSiteFilesServiceId(db, this.dockerExecutor, this.config, site));
      const [svc] = await db
        .select({ desiredStatus: serviceInstances.desiredStatus })
        .from(serviceInstances)
        .where(eq(serviceInstances.id, serviceInstanceId))
        .limit(1);
      if (svc?.desiredStatus === "stopped") {
        await this.parent.safeUpdateStep(op.id, "start_site", "skipped", START_STOPPED_MSG);
        return null;
      }
      const state = await this.dockerExecutor.backups({
        action: "siteState",
        siteId: site.id,
        serviceInstanceId,
      });
      if (state.container) {
        await this.parent.safeUpdateStep(op.id, "start_site", "skipped", START_SKIPPED_MSG);
        return null;
      }
      const spec = await buildApprovedServiceSpec(db, this.config, {
        organizationId: site.organizationId,
        serviceInstanceId,
      });
      await recordDeployedState(db, this.dockerExecutor, spec, await this.dockerExecutor.deployService(spec));
      await db.update(sites).set({ status: "ready", updatedAt: new Date() }).where(eq(sites.id, site.id));
    } catch (err) {
      // R104: an unknown outcome is left to recovery, which asks again before any deploy.
      if (isAmbiguousError(err)) throw err;
      await this.parent.safeUpdateStep(op.id, "start_site", "failed", START_FAILED_MSG);
      await db.update(sites).set({ status: "degraded", updatedAt: new Date() }).where(eq(sites.id, op.resourceId));
      return new ControlPlaneError(extractKnownErrorCode(err) ?? "INTERNAL_ERROR", START_FAILED_MSG);
    }
    await this.parent.safeUpdateStep(op.id, "start_site", "succeeded", START_DONE_MSG);
    return null;
  }

  /** Re-applies file access after a restore; a failure is noted on the step only. */
  async #runSftpStep(op: BackupOperationRef): Promise<void> {
    const sftp = this.parent.sftp;
    if (!sftp) {
      await this.parent.safeUpdateStep(op.id, "sftp", "skipped", SFTP_SKIPPED_MSG);
      return;
    }
    await this.parent.safeUpdateStep(op.id, "sftp", "running", SFTP_RUNNING_MSG);
    try {
      await sftp.ensureApplied(true);
    } catch {
      await this.parent.safeUpdateStep(op.id, "sftp", "failed", SFTP_FAILED_MSG);
      return;
    }
    await this.parent.safeUpdateStep(op.id, "sftp", "succeeded", SFTP_DONE_MSG);
  }

  /** Aborts without touching any superseded/missing row if restore_status is no longer running. */
  async #ensureRestoreRowStillRunning(
    operationId: string,
  ): Promise<{ id: string; snapshotId: string | null; siteUrl: string | null }> {
    const [row] = await this.dbClient.db
      .select({
        id: siteBackups.id,
        restoreStatus: siteBackups.restoreStatus,
        snapshotId: siteBackups.snapshotId,
        siteUrl: siteBackups.siteUrl,
      })
      .from(siteBackups)
      .where(eq(siteBackups.restoreOperationId, operationId))
      .limit(1);

    if (!row || row.restoreStatus !== "running") {
      const err = new ControlPlaneError("OPERATION_INTERRUPTED", RESTORE_INTERRUPTED_MSG);
      await this.#failRestoreStepsAndOp(operationId, RESTORE_INTERRUPTED_MSG, err.code, err.message);
      throw new BackupSettledFailure(err);
    }

    return row;
  }

  /** Aborts without touching any superseded/missing row if archive_status is no longer preparing. */
  async #ensureArchiveRowPreparing(
    operationId: string,
  ): Promise<{ id: string; snapshotId: string | null }> {
    const [row] = await this.dbClient.db
      .select({
        id: siteBackups.id,
        archiveStatus: siteBackups.archiveStatus,
        snapshotId: siteBackups.snapshotId,
      })
      .from(siteBackups)
      .where(eq(siteBackups.archiveOperationId, operationId))
      .limit(1);

    if (!row || row.archiveStatus !== "preparing") {
      const err = new ControlPlaneError("OPERATION_INTERRUPTED", ARCHIVE_INTERRUPTED_MSG);
      await this.parent.safeUpdateStep(operationId, "prepare", "failed", ARCHIVE_INTERRUPTED_MSG);
      await this.parent.failOperation(operationId, err.code, err.message);
      throw new BackupSettledFailure(err);
    }

    return row;
  }

  async #findRestoreSite(siteId: string): Promise<RestoreSiteRef | undefined> {
    const [site] = await this.dbClient.db
      .select({
        id: sites.id,
        organizationId: sites.organizationId,
        status: sites.status,
        wordpressUrl: sites.wordpressUrl,
        phpVersion: sites.phpVersion,
      })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    return site;
  }
}
