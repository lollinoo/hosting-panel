import { Inject, Injectable } from "@nestjs/common";
import {
  BACKUP_FAILURE_CLASSES,
  BackupSettingsInputSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  isBackupAvailable,
  type AdminSiteBackupStatusDto,
  type BackupProblem,
  type BackupSettingsDto,
  type BackupTestResultDto,
} from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  deleteAllSiteBackups,
  deleteBackupSettings,
  getBackupSettingsPublic,
  getBackupTarget,
  listAdminBackupStatus,
  recordBackupTest,
  upsertBackupSettings,
  type BackupSettingsRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  DOCKER_EXECUTOR_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const FAILURE_CLASS_SET: ReadonlySet<string> = new Set(BACKUP_FAILURE_CLASSES);

function toSettingsDto(available: boolean, row: BackupSettingsRow | null): BackupSettingsDto {
  return {
    available,
    configured: row !== null,
    endpoint: row?.endpoint ?? null,
    region: row?.region ?? null,
    bucket: row?.bucket ?? null,
    prefix: row?.prefix ?? "",
    accessKeyId: row?.accessKeyId ?? null,
    secretAccessKeySet: row !== null,
    scheduleHourUtc: row?.scheduleHourUtc ?? DEFAULT_BACKUP_HOUR_UTC,
    retentionDays: row?.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
    lastNightlyRunOn: row?.lastNightlyRunOn ?? null,
    lastTest:
      row?.lastTestAt && row.lastTestOutcome
        ? {
            outcome: row.lastTestOutcome,
            problem: row.lastTestProblem,
            at: row.lastTestAt.toISOString(),
          }
        : null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

function mapExecutorTestError(err: unknown): ControlPlaneError {
  if (err instanceof ControlPlaneError) {
    return err;
  }
  const obj = typeof err === "object" && err !== null ? (err as { code?: unknown; ambiguousOutcome?: unknown }) : null;
  if (obj?.ambiguousOutcome === true || obj?.code === "OPERATION_AMBIGUOUS") {
    return new ControlPlaneError(
      "OPERATION_AMBIGUOUS",
      "The backup connectivity test timed out before an outcome was received.",
    );
  }
  if (obj?.code === "RESOURCE_LOCKED") {
    return new ControlPlaneError(
      "RESOURCE_LOCKED",
      "Another backup connectivity test is already in progress.",
      { retryable: true },
    );
  }
  return new ControlPlaneError(
    "DOCKER_ENGINE_UNAVAILABLE",
    "Backup executor is temporarily unavailable.",
    { retryable: true },
  );
}

/** Manages platform-wide encrypted backup target settings and connectivity tests. */
@Injectable()
export class BackupSettingsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(DOCKER_EXECUTOR_TOKEN) private readonly dockerExecutor: DockerExecutorPort,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
  ) {}

  /** Returns backup availability and sanitized settings without secrets. */
  public async get(): Promise<BackupSettingsDto> {
    const available = isBackupAvailable(this.config.runtimeBackend);
    const row = await getBackupSettingsPublic(this.dbClient.db);
    return toSettingsDto(available, row);
  }

  /** Validates and saves the S3 target settings, wiping stale backup records when target location changes. */
  public async save(rawInput: unknown, actorId: string): Promise<BackupSettingsDto> {
    this.#assertAvailable();
    const input = BackupSettingsInputSchema.parse(rawInput ?? {});
    const { secretAccessKey, ...fields } = input;

    await this.dbClient.db.transaction(async (tx) => {
      const existing = await getBackupSettingsPublic(tx);
      if (existing === null && secretAccessKey === undefined) {
        throw new ControlPlaneError("VALIDATION_ERROR", "secret_access_key_required", {
          details: [{ field: "secretAccessKey", message: "secret_access_key_required" }],
        });
      }

      const { targetChanged } = await upsertBackupSettings(tx, this.config.secretsMasterKey, {
        ...fields,
        ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
        updatedByUserId: actorId,
      });

      // R60: an endpoint, bucket, or prefix change points at another repository so old records no longer apply.
      if (targetChanged) {
        await deleteAllSiteBackups(tx);
      }

      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId,
        actorType: "user",
        action: "admin.backups.update",
        targetType: "backups",
        targetId: null,
        details: {
          secretChanged: secretAccessKey !== undefined,
          targetChanged,
          scheduleHourUtc: input.scheduleHourUtc,
          retentionDays: input.retentionDays,
        },
      });
    });

    return this.get();
  }

  /** Clears stored backup settings and removes all site backup history records. */
  public async clear(actorId: string): Promise<BackupSettingsDto> {
    this.#assertAvailable();

    await this.dbClient.db.transaction(async (tx) => {
      await deleteBackupSettings(tx);
      await deleteAllSiteBackups(tx);
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId,
        actorType: "user",
        action: "admin.backups.clear",
        targetType: "backups",
        targetId: null,
        details: {},
      });
    });

    return this.get();
  }

  /** Decrypts the stored S3 target for a live connectivity test and records the outcome. */
  public async test(actorId: string): Promise<BackupTestResultDto> {
    this.#assertAvailable();

    const target = await getBackupTarget(this.dbClient.db, this.config.secretsMasterKey);
    if (!target) {
      throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
        details: [{ message: "not_configured" }],
      });
    }

    let result: BackupTestResultDto;
    try {
      const raw = await this.dockerExecutor.backups({ action: "test", target });
      const problem: BackupProblem | null =
        raw.outcome === "ok"
          ? null
          : raw.problem !== null && FAILURE_CLASS_SET.has(raw.problem)
            ? raw.problem
            : "other";
      result = { outcome: raw.outcome, problem };
    } catch (err: unknown) {
      throw mapExecutorTestError(err);
    }

    await this.dbClient.db.transaction(async (tx) => {
      await recordBackupTest(tx, new Date(), result.outcome, result.problem);
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId,
        actorType: "user",
        action: "admin.backups.test",
        targetType: "backups",
        targetId: null,
        details: {
          outcome: result.outcome,
          problem: result.problem,
        },
      });
    });

    return result;
  }

  /** Lists per-site backup status for all existing sites. */
  public async listSites(): Promise<AdminSiteBackupStatusDto[]> {
    return listAdminBackupStatus(this.dbClient.db);
  }

  #assertAvailable(): void {
    if (!isBackupAvailable(this.config.runtimeBackend)) {
      throw new ControlPlaneError(
        "NOT_SUPPORTED",
        "Backups are only available on the linux-systemd runtime backend",
      );
    }
  }
}
