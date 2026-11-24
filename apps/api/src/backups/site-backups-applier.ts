import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  BACKUP_FAILURE_CLASSES,
  DEFAULT_BACKUP_RETENTION_DAYS,
  ERROR_CODES,
  siteTypeKeyOf,
  type BackupJobStatus,
  type BackupKind,
  type BackupProblem,
  type BackupsIpcRequest,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  asc,
  backupPolicies,
  deleteEmptySiteBackups,
  deleteSiteBackupCopies,
  eq,
  getPolicy,
  isNull,
  listRetentionCopies,
  listSiteBackupCopies,
  listSiteBackups,
  listTargetsWithCopiesForSite,
  operationSteps,
  operations,
  renewOperationLease,
  repairLegacyBackupCopies,
  resolveDispatchTarget,
  settleOperation,
  settleSiteBackup,
  settleSiteBackupAggregate,
  settleSiteBackupCopy,
  siteBackups,
  sites,
  updateOperationStepTransactional,
  type CopyRow,
  type CopySettlement,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import { resolveSiteFilesServiceId } from "../sites/site-files.service.js";
import { SiteSftpService } from "../sites/site-sftp.service.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { selectExpired, type RetentionRow } from "./backup-retention.js";
import { PanelBackupApplier } from "./panel-backup-applier.js";
import { SiteRestoreApplier } from "./site-restore-applier.js";

export const BACKUP_LEASE_MS = 120_000;
export const BACKUP_POLL_MS = 5_000;
export const BACKUP_POLL_GIVE_UP_MS = 120_000;
/**
 * R120: past the summed executor limits of a backup (backup-jobs.ts repo+dump+upload+forget ≈ 3h31m) and of a
 * restore (backup-runner.ts 3 image pulls 12m + volume owner 1h + restore-jobs.ts fetch 2h + prepare 1h + switch 2m
 * + files 1m + finish 30m = 4h45m; a failed path with both undos ≤ 4h25m). A restore also runs finish (30m) once per
 * same-site undo_incomplete leftover, so from 3 leftovers it can pass this and turns unknown (R120 c accepts it).
 */
export const BACKUP_POLL_DEADLINE_MS = 6 * 3_600_000;
export const SITE_BACKUPS_INTERRUPTED = "This backup was interrupted before it finished.";
/**
 * The executor runs two backup jobs at a time for the whole server: the nightly clean-ups of applications and the
 * backups and restores customers ask for can hold both. A nightly copy (of a site, or of the panel) refused as busy is
 * asked again this often, under the same operation, so its night keeps its one backup (ADR-0038)...
 */
export const BACKUP_BUSY_RETRY_MS = 60_000;
/**
 * ...for at most this long after the first refusal of its wait, then the refusal stands like any other. One wait for
 * every destination of the panel copy, one for all the nightly backups of the sites in a run: twenty sites refused one
 * after the other hold the backup lane two hours, not forty.
 */
export const BACKUP_BUSY_WAIT_MS = 2 * 3_600_000;

/** A wait for a free job slot of the executor: its end is set by its first refusal. */
export interface BusyWait {
  until: number | null;
}

export type BackupOperationRef = Pick<
  typeof operations.$inferSelect,
  "id" | "organizationId" | "kind" | "resourceId"
>;

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);
const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(BACKUP_FAILURE_CLASSES);
const MAX_FORGET_BATCH = 100;
/** Job ids -forget and -forget-t2 … -forget-t9 (BACKUP_JOB_ID_PATTERN). */
const MAX_RETENTION_TARGETS = 9;

/** Accepts only known executor failure classes, falling back to 'other'. @internal */
export function normalizeBackupProblem(failure: unknown): BackupProblem {
  return typeof failure === "string" && FAILURE_CLASS_SET.has(failure)
    ? (failure as BackupProblem)
    : "other";
}

interface CopyFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly stepMessage: string;
}

const INTERRUPTED_FAILURE: CopyFailure = {
  code: "OPERATION_INTERRUPTED",
  message: SITE_BACKUPS_INTERRUPTED,
  stepMessage: SITE_BACKUPS_INTERRUPTED,
};

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
  public pollDeadlineMs = BACKUP_POLL_DEADLINE_MS;
  public busyRetryMs = BACKUP_BUSY_RETRY_MS;
  public busyWaitMs = BACKUP_BUSY_WAIT_MS;
  /** The wait the nightly backups of the sites share, and the run (its date) it belongs to. */
  #nightlyWait: { run: string | null; wait: BusyWait } | null = null;
  public readonly sftp: SiteSftpService | null;
  public readonly panel: PanelBackupApplier;

  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Optional() @Inject(SiteSftpService) sftp?: SiteSftpService,
  ) {
    this.sftp = sftp ?? null;
    this.#restore = new SiteRestoreApplier(this, dbClient, dockerExecutor, config);
    this.panel = new PanelBackupApplier(this, dbClient, dockerExecutor, config);
  }

  /** Applies one queued backup, prune, restore, archive download, or panel copy operation. */
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
    if (op.kind === "panel.backups.create") {
      await this.panel.apply(op);
      return;
    }
    throw new ControlPlaneError("NOT_SUPPORTED", `Unsupported backup operation kind '${op.kind}'`);
  }

  /** Reconciles an expired backup, prune, restore, or download operation without blindly replaying mutations. */
  public async recover(op: BackupOperationRef): Promise<"settled" | "pending"> {
    if (op.kind === "site.backups.restore" || op.kind === "site.backups.download") {
      return this.#restore.recover(op);
    }
    if (op.kind === "panel.backups.create") {
      return this.panel.recover(op);
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

    const settled = await this.settleBackupJob(op.id);
    if (settled === "pending") {
      return "pending";
    }
    if (settled === "succeeded") {
      await this.succeedOperation(op.id);
    } else {
      await this.failOperation(op.id, settled.code, settled.message);
    }
    return "settled";
  }

  /**
   * Settles the copies, the backup row and the steps of an interrupted backup; the error is what the operation fails
   * with. Reads executor status per open copy job id and never starts anything (BKP-14): a copy whose job the
   * executor does not know (never started, or lost) fails as interrupted.
   */
  public async settleBackupJob(opId: string): Promise<"pending" | "succeeded" | ControlPlaneError> {
    const db = this.dbClient.db;
    const [backup] = await db
      .select({ id: siteBackups.id })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, opId))
      .limit(1);
    const [op] = await db
      .select({ organizationId: operations.organizationId, kind: operations.kind, resourceId: operations.resourceId })
      .from(operations)
      .where(eq(operations.id, opId))
      .limit(1);
    const copies = backup ? await this.#copiesOf(backup.id) : [];
    if (!backup || !op || copies.length === 0) {
      await settleSiteBackup(db, opId, { status: "failed", problem: "interrupted" });
      await this.#failSteps(opId, SITE_BACKUPS_INTERRUPTED);
      return new ControlPlaneError("OPERATION_INTERRUPTED", SITE_BACKUPS_INTERRUPTED);
    }

    let interrupted = false;
    let settledHere = false;
    // Copies run one after another: each gets its own deadline, counted from when the previous one finished.
    let copyStart: Date | null = null;
    for (const copy of copies) {
      if (copy.status !== "running") {
        copyStart = copy.finishedAt ?? copyStart;
        continue;
      }
      let statusRes: BackupJobStatus;
      try {
        statusRes = await this.dockerExecutor.backups({ action: "status", jobId: copy.jobId ?? opId });
      } catch {
        return "pending";
      }
      if (statusRes.state === "running") {
        if (!(await this.isPastPollDeadline(opId, copyStart ?? undefined))) {
          return "pending";
        }
        statusRes = { ...statusRes, state: "failed", failure: "timeout" };
      }
      const outcome = this.#copyOutcome(statusRes);
      interrupted ||= outcome.interrupted;
      await this.#settleCopy(op, backup.id, copy, outcome.settlement);
      settledHere = true;
      copyStart = new Date();
    }

    const aggregate = await settleSiteBackupAggregate(db, backup.id);
    if (aggregate === "partial" && settledHere) {
      await this.#audit(op, "site.backups.partial", { backupId: backup.id });
    }
    const settled = (await listSiteBackupCopies(db, [backup.id])).get(backup.id) ?? [];
    if (aggregate === "succeeded" || (aggregate === "partial" && op.kind === "site.backups.create")) {
      await this.safeUpdateStep(opId, "backup", "succeeded", "Backup uploaded");
      await this.safeUpdateStep(opId, "retention", "skipped", "Skipped after recovery; will run next night");
      return "succeeded";
    }
    const failedCopy = settled.find((c) => c.status !== "succeeded");
    const problem = failedCopy?.problem ?? "other";
    await this.#failSteps(opId, interrupted ? SITE_BACKUPS_INTERRUPTED : "Backup did not finish");
    if (interrupted) {
      return new ControlPlaneError("OPERATION_INTERRUPTED", SITE_BACKUPS_INTERRUPTED);
    }
    return new ControlPlaneError(
      problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR",
      "Backup did not finish.",
    );
  }

  /**
   * The copies of a backup. A row an older release wrote has none: it is given its legacy-target copy here, as the boot
   * repair does, so an operation in flight across a rollback still runs and recovers.
   */
  async #copiesOf(backupId: string): Promise<CopyRow[]> {
    const db = this.dbClient.db;
    const read = async () => (await listSiteBackupCopies(db, [backupId])).get(backupId) ?? [];
    const copies = await read();
    if (copies.length > 0) {
      return copies;
    }
    await repairLegacyBackupCopies(db);
    return read();
  }

  /** Maps an executor answer for one copy to what the ledger records. */
  #copyOutcome(statusRes: BackupJobStatus): { settlement: CopySettlement; interrupted: boolean } {
    if (statusRes.state === "succeeded") {
      return {
        interrupted: false,
        settlement: {
          status: "succeeded",
          snapshotId: statusRes.snapshot?.snapshotId ?? null,
          sizeBytes: statusRes.snapshot?.totalBytes ?? null,
          problem: null,
        },
      };
    }
    if (statusRes.state === "failed") {
      return {
        interrupted: false,
        settlement: { status: "failed", problem: normalizeBackupProblem(statusRes.failure) },
      };
    }
    return { interrupted: true, settlement: { status: "failed", problem: "interrupted" } };
  }

  /** Settles one running copy and records it in the audit log in the same transaction; a copy already settled changes nothing. */
  async #settleCopy(
    op: Pick<BackupOperationRef, "organizationId" | "resourceId">,
    backupId: string,
    copy: CopyRow,
    settlement: CopySettlement,
  ): Promise<void> {
    await this.dbClient.db.transaction(async (tx) => {
      if (!(await settleSiteBackupCopy(tx, copy.id, settlement))) {
        return;
      }
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId: null,
        actorType: "system",
        organizationId: op.organizationId,
        action: settlement.status === "succeeded" ? "site.backups.copy_succeeded" : "site.backups.copy_failed",
        targetType: "site",
        targetId: op.resourceId,
        details: {
          backupId,
          targetId: copy.targetId,
          targetKind: copy.targetKind,
          problem: settlement.problem ?? null,
        },
      });
    });
  }

  /** Fails every still-running copy of the operation's backup and settles the row (a backup without copies directly). */
  async #failOpenCopies(op: BackupOperationRef, problem: BackupProblem): Promise<void> {
    const db = this.dbClient.db;
    const [backup] = await db
      .select({ id: siteBackups.id })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, op.id))
      .limit(1);
    if (!backup) {
      return;
    }
    const copies = (await listSiteBackupCopies(db, [backup.id])).get(backup.id) ?? [];
    for (const copy of copies.filter((c) => c.status === "running")) {
      await this.#settleCopy(op, backup.id, copy, { status: "failed", problem });
    }
    if (copies.length === 0) {
      await settleSiteBackup(db, op.id, { status: "failed", problem });
    } else {
      await settleSiteBackupAggregate(db, backup.id);
    }
  }

  async #applyCreate(op: BackupOperationRef): Promise<void> {
    await this.runBackupStep(op);
    await this.#runRetentionStep(op);
    await this.succeedOperation(op.id);
  }

  /**
   * Takes the backup of the operation's site, copy by copy, each against the target pinned at enqueue (never the
   * current settings); then settles the row from its copies. A failed backup fails the operation and throws; a partial
   * one only for the kinds that gate a change (pre_update), a requested backup keeps what it saved.
   */
  public async runBackupStep(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    await renewOperationLease(db, op.id, this.leaseMs);
    await this.safeUpdateStep(op.id, "backup", "running", "Backing up site files and databases");

    try {
      const { id: backupId, kind } = await this.#ensureBackupRowStillRunning(op.id);

      const [site] = await db
        .select({
          id: sites.id,
          organizationId: sites.organizationId,
          status: sites.status,
          siteType: sites.siteType,
        })
        .from(sites)
        .where(eq(sites.id, op.resourceId))
        .limit(1);
      const siteType = siteTypeKeyOf(site?.siteType);
      if (!site || !siteType) {
        await this.#failOpenCopies(op, "other");
        const err = new ControlPlaneError("NOT_FOUND", "Site not found for backup");
        await this.#failStepAndOperation(op.id, err.message, err.code, err.message);
        throw new BackupSettledFailure(err);
      }

      const serviceInstanceId = await resolveSiteFilesServiceId(
        db,
        this.dockerExecutor,
        this.config,
        site,
      );

      // A nightly backup refused because the executor's job slots are taken is asked again within the one wait of its
      // run; one a person asked for, or the one before a WordPress update, is refused at once.
      const busyWait = kind === "nightly" ? await this.#nightlyBusyWait() : null;
      const failures: CopyFailure[] = [];
      for (const copy of (await this.#copiesOf(backupId)).filter((c) => c.status === "running")) {
        await this.#ensureBackupRowStillRunning(op.id);
        const failure = await this.#runCopy(
          op,
          backupId,
          copy,
          {
            siteId: site.id,
            serviceInstanceId,
            siteType,
          },
          busyWait,
        );
        if (failure) {
          failures.push(failure);
        }
      }

      const aggregate = await settleSiteBackupAggregate(db, backupId);
      if (aggregate === "succeeded") {
        await this.safeUpdateStep(op.id, "backup", "succeeded", "Backup uploaded");
      } else if (aggregate === "partial") {
        await this.#audit(op, "site.backups.partial", { backupId });
        if (op.kind !== "site.backups.create") {
          const err = new ControlPlaneError("INTERNAL_ERROR", "Backup did not finish.");
          await this.#failStepAndOperation(op.id, "Backup did not finish", err.code, err.message);
          throw new BackupSettledFailure(err);
        }
        await this.safeUpdateStep(op.id, "backup", "succeeded", "Backup saved on some destinations");
      } else {
        if (aggregate !== "failed") {
          await this.#failOpenCopies(op, "interrupted");
        }
        const failure = failures[0] ?? INTERRUPTED_FAILURE;
        const err = new ControlPlaneError(failure.code, failure.message);
        await this.#failStepAndOperation(op.id, failure.stepMessage, failure.code, failure.message);
        throw new BackupSettledFailure(err);
      }
    } catch (err) {
      if (err instanceof BackupSettledFailure) {
        throw err.causeError;
      }
      if (isAmbiguousError(err)) {
        // Leave the copies running so OutboxWorker moves the op to unknown for recover().
        throw new ControlPlaneError(
          "OPERATION_AMBIGUOUS",
          "Backup outcome is unknown; recovery will check job status.",
        );
      }
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      const problem: BackupProblem = code === "RESOURCE_LOCKED" ? "site_busy" : "other";
      await this.#failOpenCopies(op, problem);
      const safeMessage =
        err instanceof ControlPlaneError ? err.message : "Backup did not finish.";
      await this.#failStepAndOperation(op.id, safeMessage, code, safeMessage);
      throw err instanceof ControlPlaneError ? err : new ControlPlaneError(code, safeMessage);
    }
  }

  /** Runs one copy against its own target and settles it; null when it succeeded. An ambiguous outcome is rethrown. */
  async #runCopy(
    op: BackupOperationRef,
    backupId: string,
    copy: CopyRow,
    job: { siteId: string; serviceInstanceId: string; siteType: NonNullable<ReturnType<typeof siteTypeKeyOf>> },
    busyWait: BusyWait | null,
  ): Promise<CopyFailure | null> {
    const target = await resolveDispatchTarget(this.dbClient.db, this.config.secretsMasterKey, copy.targetId);
    if (!target) {
      await this.#settleCopy(op, backupId, copy, { status: "failed", problem: "other" });
      return {
        code: "VALIDATION_ERROR",
        message: "not_configured",
        stepMessage: "Backup target is not configured",
      };
    }
    let statusRes: BackupJobStatus;
    try {
      const jobId = copy.jobId ?? op.id;
      const req: Extract<BackupsIpcRequest, { action: "start" }> = { action: "start", jobId, ...job, target };
      const startRes = busyWait === null ? await this.dockerExecutor.backups(req) : await this.startWhenFree(op.id, req, busyWait);
      statusRes = await this.pollJobStatus(op.id, jobId, startRes);
    } catch (err) {
      if (isAmbiguousError(err)) {
        throw err;
      }
      const code = extractKnownErrorCode(err) ?? "INTERNAL_ERROR";
      const message = err instanceof ControlPlaneError ? err.message : "Backup did not finish.";
      await this.#settleCopy(op, backupId, copy, {
        status: "failed",
        problem: code === "RESOURCE_LOCKED" ? "site_busy" : "other",
      });
      return { code, message, stepMessage: message };
    }
    const { settlement, interrupted } = this.#copyOutcome(statusRes);
    await this.#settleCopy(op, backupId, copy, settlement);
    if (settlement.status === "succeeded") {
      return null;
    }
    if (interrupted) {
      return INTERRUPTED_FAILURE;
    }
    const code: ErrorCode =
      settlement.problem === "unreachable" ? "DOCKER_ENGINE_UNAVAILABLE" : "INTERNAL_ERROR";
    return { code, message: "Backup did not finish.", stepMessage: "Backup did not finish" };
  }

  async #audit(op: Pick<BackupOperationRef, "organizationId" | "resourceId">, action: string, details: Record<string, unknown>): Promise<void> {
    await appendAuditEvent(this.dbClient.db, {
      actorId: null,
      actorType: "system",
      organizationId: op.organizationId,
      action,
      targetType: "site",
      targetId: op.resourceId,
      details,
    });
  }

  /** Fails the operation as interrupted when its backup row is gone or no longer running; returns the row's id and kind. */
  async #ensureBackupRowStillRunning(operationId: string): Promise<{ id: string; kind: BackupKind }> {
    const [backupRow] = await this.dbClient.db
      .select({ id: siteBackups.id, status: siteBackups.status, kind: siteBackups.kind })
      .from(siteBackups)
      .where(eq(siteBackups.operationId, operationId))
      .limit(1);
    if (backupRow?.status !== "running") {
      const err = new ControlPlaneError("OPERATION_INTERRUPTED", SITE_BACKUPS_INTERRUPTED);
      await this.#failStepAndOperation(operationId, SITE_BACKUPS_INTERRUPTED, err.code, err.message);
      throw new BackupSettledFailure(err);
    }
    return { id: backupRow.id, kind: backupRow.kind };
  }

  /** The one wait of the nightly backups of the sites in a run; the run is named by its date (the default_site policy's). */
  async #nightlyBusyWait(): Promise<BusyWait> {
    const [policy] = await this.dbClient.db
      .select({ run: backupPolicies.lastNightlyRunOn })
      .from(backupPolicies)
      .where(and(eq(backupPolicies.scope, "default_site"), isNull(backupPolicies.siteId)))
      .limit(1);
    const run = policy?.run ?? null;
    if (this.#nightlyWait === null || this.#nightlyWait.run !== run) this.#nightlyWait = { run, wait: { until: null } };
    return this.#nightlyWait.wait;
  }

  /** @internal A job start, asked again under a renewed lease while the executor refuses it as busy, until the wait is over. */
  public async startWhenFree(
    operationId: string,
    req: Extract<BackupsIpcRequest, { action: "start" | "panelStart" }>,
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
      await renewOperationLease(this.dbClient.db, operationId, this.leaseMs);
      await this.#delay(this.busyRetryMs);
    }
  }

  async #applyPrune(op: BackupOperationRef): Promise<void> {
    await renewOperationLease(this.dbClient.db, op.id, this.leaseMs);
    await this.#runRetentionStep(op);
    await this.succeedOperation(op.id);
  }

  /**
   * Retention runs once per target that holds copies of the site, over that target's copies only: it never forgets
   * the last good copies on a target because another target has newer ones, and forgets only on the target that
   * holds the snapshot. A logical backup goes only when its last copy is gone (BKP-09).
   */
  async #runRetentionStep(op: BackupOperationRef): Promise<void> {
    const db = this.dbClient.db;
    await renewOperationLease(db, op.id, this.leaseMs);
    await this.safeUpdateStep(op.id, "retention", "running", "Removing old backups");

    let retry = false;
    try {
      const retentionDays =
        (await getPolicy(db, "default_site")).retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
      const [siteRow] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(eq(sites.id, op.resourceId))
        .limit(1);
      // A release rolled back by hp-update can leave copy-less rows: give them their legacy copy first, so their
      // snapshots are forgotten on the legacy target instead of being orphaned (idempotent, never deletes).
      await repairLegacyBackupCopies(db);
      const rows = await listSiteBackups(db, op.resourceId);
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const siteExists = Boolean(siteRow);

      // Every target of the run needs its own executor job id (a repeated id answers the cached status): -forget,
      // -forget-t2 … -forget-t9. The targets past the ninth wait for the next run.
      const targetIds = (await listTargetsWithCopiesForSite(db, op.resourceId)).slice(0, MAX_RETENTION_TARGETS);
      for (const [index, targetId] of targetIds.entries()) {
        try {
          await this.#retainTarget(op, targetId, index === 0 ? "-forget" : `-forget-t${String(index + 1)}`, {
            retentionDays,
            siteExists,
            rowsById,
          });
        } catch (err) {
          if (isAmbiguousError(err)) {
            throw err;
          }
          retry = true;
          const code = extractKnownErrorCode(err) ?? "RETENTION_ERROR";
          // Never log secrets, snapshot IDs, or host paths from retention failures.
          this.#logger.warn(`Retention step skipped for ${op.id} (${code}); will retry next night`);
        }
      }

      // Rows with no copy (written by an older release, nothing to forget) expire like failed ones.
      const withCopies = await listSiteBackupCopies(db, [...rowsById.keys()]);
      const copyless = rows.filter((row) => !withCopies.has(row.id) && row.status !== "running");
      const { drop } = selectExpired(
        copyless.map((row) => ({ ...row, snapshotId: null })),
        new Date(),
        retentionDays,
        siteExists,
      );
      await this.#removeCopies(
        [],
        drop.map((row) => row.id),
        rowsById,
      );
    } catch (err) {
      if (isAmbiguousError(err)) {
        throw err;
      }
      retry = true;
      const code = extractKnownErrorCode(err) ?? "RETENTION_ERROR";
      this.#logger.warn(`Retention step skipped for ${op.id} (${code}); will retry next night`);
    }
    await this.safeUpdateStep(
      op.id,
      "retention",
      "succeeded",
      retry ? "Will retry next night" : "Old backups checked",
    );
  }

  async #retainTarget(
    op: BackupOperationRef,
    targetId: string,
    forgetSuffix: string,
    ctx: {
      retentionDays: number;
      siteExists: boolean;
      rowsById: ReadonlyMap<string, typeof siteBackups.$inferSelect>;
    },
  ): Promise<void> {
    const db = this.dbClient.db;
    const copies = await listRetentionCopies(db, op.resourceId, targetId);
    const byCopyId = new Map(copies.map((copy) => [copy.copyId, copy]));
    // A running or unknown copy is never touched; a missing one is dropped, its snapshot is not in the repository.
    const rows: RetentionRow[] = copies.map((copy) => ({
      id: copy.copyId,
      kind: copy.kind as BackupKind,
      status:
        copy.status === "succeeded"
          ? "succeeded"
          : copy.status === "running" || copy.status === "unknown"
            ? "running"
            : "failed",
      snapshotId: copy.status === "missing" ? null : copy.snapshotId,
      startedAt: copy.startedAt,
    }));
    const { forget, drop } = selectExpired(rows, new Date(), ctx.retentionDays, ctx.siteExists);
    const backupIdsOf = (list: readonly RetentionRow[]): string[] =>
      list.map((row) => byCopyId.get(row.id)!.backupId);

    await this.#removeCopies(drop.map((row) => row.id), backupIdsOf(drop), ctx.rowsById);

    const batch = forget.slice(0, MAX_FORGET_BATCH);
    const snapshotIds = batch
      .map((row) => row.snapshotId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (snapshotIds.length === 0) {
      return;
    }
    const target = await resolveDispatchTarget(db, this.config.secretsMasterKey, targetId);
    if (!target) {
      throw new ControlPlaneError("VALIDATION_ERROR", "not_configured");
    }
    const forgetJobId = `${op.id}${forgetSuffix}`;
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
    await this.#removeCopies(batch.map((row) => row.id), backupIdsOf(batch), ctx.rowsById);
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
    const startedMs = Date.now();

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
      if (statusRes.state === "running" && Date.now() - startedMs >= this.pollDeadlineMs) {
        throw new ControlPlaneError("OPERATION_AMBIGUOUS", "Backup job is still running past the poll deadline");
      }
    }

    return statusRes;
  }

  /** @internal R120: true when the operation (or `since`, when a later copy started after it) began longer ago than the poll deadline. */
  public async isPastPollDeadline(operationId: string, since?: Date): Promise<boolean> {
    const [row] = await this.dbClient.db
      .select({ startedAt: operations.startedAt, submittedAt: operations.submittedAt })
      .from(operations)
      .where(eq(operations.id, operationId))
      .limit(1);
    const from = since ?? row?.startedAt ?? row?.submittedAt;
    return from !== undefined && Date.now() - from.getTime() > this.pollDeadlineMs;
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
    await this.#failSteps(operationId, stepMessage);
    await this.failOperation(operationId, errorCode, errorMessage);
  }

  async #failSteps(operationId: string, stepMessage: string): Promise<void> {
    await this.safeUpdateStep(operationId, "backup", "failed", stepMessage);
    await this.safeUpdateStep(
      operationId,
      "retention",
      "skipped",
      "Skipped because backup did not finish",
    );
  }

  /** @internal */
  public async succeedOperation(operationId: string): Promise<void> {
    await settleOperation(this.dbClient.db, operationId, { status: "succeeded" });
  }

  /** @internal */
  public async failOperation(
    operationId: string,
    errorCode: ErrorCode,
    errorMessage: string,
  ): Promise<void> {
    await settleOperation(this.dbClient.db, operationId, { status: "failed", errorCode, errorMessage });
  }

  /**
   * Deletes the given copies and, in the same transaction, the logical backups left with none: a crash between the
   * two steps must not leave an empty row for the boot repair to attach a phantom copy to. The archive prepared for a
   * backup about to go is released first.
   */
  async #removeCopies(
    copyIds: readonly string[],
    backupIds: readonly string[],
    rowsById: ReadonlyMap<string, typeof siteBackups.$inferSelect>,
  ): Promise<void> {
    if (copyIds.length === 0 && backupIds.length === 0) {
      return;
    }
    const ids = [...new Set(backupIds)];
    const removing = new Set(copyIds);
    const remaining = await listSiteBackupCopies(this.dbClient.db, ids);
    for (const id of ids.filter((x) => (remaining.get(x) ?? []).every((c) => removing.has(c.id)))) {
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
    await this.dbClient.db.transaction(async (tx) => {
      await deleteSiteBackupCopies(tx, [...copyIds]);
      await deleteEmptySiteBackups(tx, ids);
    });
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
