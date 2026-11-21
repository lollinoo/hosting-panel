import { Inject, Injectable } from "@nestjs/common";
import {
  BackupSettingsInputSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  isBackupAvailable,
  type AdminSiteBackupStatusDto,
  type BackupSettingsDto,
  type BackupTestResultDto,
} from "@hosting-panel/contracts";
import {
  BackupTargetsRepositoryError,
  and,
  appendAuditEvent,
  archiveBackupTarget,
  backupPolicies,
  backupTargets,
  currentS3Target,
  decryptS3Secret,
  eq,
  getBackupSettingsPublic,
  getPolicy,
  insertS3Target,
  isNull,
  latestPanelBackupOutcome,
  listAdminBackupStatus,
  repointPolicyTarget,
  setPolicyTargets,
  sql,
  sumNewestBackupSizes,
  updateBackupTarget,
  updatePolicySettings,
  upsertBackupSettings,
  type BackupSettingsRow,
  type BackupTargetRow,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { BackupTargetsService } from "./backup-targets.service.js";

const S3_TARGET_NAME = "S3";
const secretRequired = (): ControlPlaneError =>
  new ControlPlaneError("VALIDATION_ERROR", "secret_access_key_required", {
    details: [{ field: "secretAccessKey", message: "secret_access_key_required" }],
  });

/** The S3 target the legacy routes show: the newest live one, read through the legacy settings row when it is the legacy target. */
interface CurrentS3 {
  target: BackupTargetRow;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  lastTest: { at: Date; outcome: "ok" | "failed"; problem: BackupTargetRow["lastTestProblem"] } | null;
  updatedAt: Date;
}

function toCurrentS3(target: BackupTargetRow | null, settings: BackupSettingsRow | null): CurrentS3 | null {
  if (target === null) {
    return null;
  }
  if (target.legacySettings) {
    // The legacy target reads backup_settings; without that row it cannot be used, so it is not "configured".
    return settings === null
      ? null
      : {
          target,
          endpoint: settings.endpoint,
          region: settings.region,
          bucket: settings.bucket,
          prefix: settings.prefix,
          accessKeyId: settings.accessKeyId,
          lastTest:
            settings.lastTestAt && settings.lastTestOutcome
              ? { at: settings.lastTestAt, outcome: settings.lastTestOutcome, problem: settings.lastTestProblem }
              : null,
          updatedAt: settings.updatedAt,
        };
  }
  const str = (key: string): string => String(target.config[key] ?? "");
  return {
    target,
    endpoint: str("endpoint"),
    region: str("region"),
    bucket: str("bucket"),
    prefix: str("prefix"),
    accessKeyId: str("accessKeyId"),
    lastTest:
      target.lastTestAt && target.lastTestOutcome
        ? { at: target.lastTestAt, outcome: target.lastTestOutcome, problem: target.lastTestProblem }
        : null,
    updatedAt: target.updatedAt,
  };
}

/** The first database error code in a cause chain. */
function dbErrorCode(err: unknown): string | null {
  for (let current: unknown = err, depth = 0; current && typeof current === "object" && depth < 4; depth += 1) {
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string") {
      return e.code;
    }
    current = e.cause;
  }
  return null;
}

function mapSaveError(err: unknown): unknown {
  if (err instanceof BackupTargetsRepositoryError) {
    return new ControlPlaneError(err.code, err.reason, { details: [{ message: err.reason, reason: err.reason }] });
  }
  // The backup_settings trigger refuses a location another live S3 target already owns (unique violation).
  return dbErrorCode(err) === "23505"
    ? new ControlPlaneError("ALREADY_EXISTS", "s3_location_taken", {
        details: [{ message: "s3_location_taken", reason: "s3_location_taken" }],
      })
    : err;
}

/**
 * Legacy `/v1/admin/backups` adapter (BKP-19). Same 15-key answer and same inputs as before 0022, built from the
 * current S3 target, the `default_site` policy and the newest panel backup. It never deletes history: `backup_settings`
 * is the frozen storage of the legacy target, and a changed location creates a new target and archives the old one.
 */
@Injectable()
export class BackupSettingsService {
  public constructor(
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(BackupTargetsService) private readonly targets: BackupTargetsService,
  ) {}

  /** Returns backup availability and sanitized settings without secrets. */
  public async get(): Promise<BackupSettingsDto> {
    const db = this.dbClient.db;
    const settings = await getBackupSettingsPublic(db);
    const current = toCurrentS3(await currentS3Target(db), settings);
    const policy = await getPolicy(db, "default_site");
    const [cursor] = await db
      .select({ lastNightlyRunOn: backupPolicies.lastNightlyRunOn })
      .from(backupPolicies)
      .where(and(eq(backupPolicies.scope, "default_site"), isNull(backupPolicies.siteId)))
      .limit(1);
    const panel = await latestPanelBackupOutcome(db);
    const lastPanelBackup = panel
      ? { at: panel.at.toISOString(), status: panel.status === "succeeded" ? ("succeeded" as const) : ("failed" as const), problem: panel.problem }
      : settings?.lastPanelBackupAt && settings.lastPanelBackupStatus
        ? { at: settings.lastPanelBackupAt.toISOString(), status: settings.lastPanelBackupStatus, problem: settings.lastPanelBackupProblem }
        : null;

    return {
      available: isBackupAvailable(this.config.runtimeBackend),
      configured: current !== null,
      endpoint: current?.endpoint ?? null,
      region: current?.region ?? null,
      bucket: current?.bucket ?? null,
      prefix: current?.prefix ?? "",
      accessKeyId: current?.accessKeyId ?? null,
      secretAccessKeySet: current !== null,
      scheduleHourUtc: policy.scheduleHourUtc ?? DEFAULT_BACKUP_HOUR_UTC,
      retentionDays: policy.retentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
      lastNightlyRunOn: cursor?.lastNightlyRunOn ?? null,
      lastTest: current?.lastTest
        ? { outcome: current.lastTest.outcome, problem: current.lastTest.problem, at: current.lastTest.at.toISOString() }
        : null,
      updatedAt: current
        ? new Date(Math.max(current.updatedAt.getTime(), policy.updatedAt.getTime())).toISOString()
        : null,
      lastPanelBackup,
      newestBackupsTotalBytes: await sumNewestBackupSizes(db),
    };
  }

  /**
   * Validates and saves the S3 settings. Schedule and retention go to the policies. Credentials of the current target are
   * rotated in place while its location is unchanged; a changed endpoint, bucket or prefix creates a new target (same
   * secret unless a new one is given), repoints the policies and archives the old target. No backup history is deleted
   * (SPEC 7.2.5, 7.2.6).
   */
  public async save(rawInput: unknown, actorId: string): Promise<BackupSettingsDto> {
    this.#assertAvailable();
    const input = BackupSettingsInputSchema.parse(rawInput ?? {});
    const { secretAccessKey, ...fields } = input;
    const key = this.config.secretsMasterKey;

    try {
      await this.dbClient.db.transaction(async (tx) => {
        // Serialises legacy saves and clears (the nightly tick takes the same row) while the target set is read.
        await tx.execute(sql`SELECT 1 FROM backup_policies WHERE scope = 'default_site' AND site_id IS NULL FOR UPDATE`);
        const settings = await getBackupSettingsPublic(tx);
        const live = await currentS3Target(tx);
        const [legacy] = await tx
          .select({ id: backupTargets.id })
          .from(backupTargets)
          .where(eq(backupTargets.legacySettings, true))
          .limit(1);
        const location = { endpoint: fields.endpoint, bucket: fields.bucket, prefix: fields.prefix };
        const sameLocation = (c: { endpoint: string; bucket: string; prefix: string }): boolean =>
          c.endpoint === location.endpoint && c.bucket === location.bucket && c.prefix === location.prefix;
        const upsertLegacy = async (): Promise<void> => {
          if (settings === null && secretAccessKey === undefined) {
            throw secretRequired();
          }
          await upsertBackupSettings(tx, key, {
            ...fields,
            ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
            updatedByUserId: actorId,
          });
        };

        let archivedId: string | null = null;
        let newTargetId: string | null = null;

        if (live === null) {
          if (secretAccessKey === undefined) {
            throw secretRequired();
          }
          if (legacy === undefined) {
            // First save ever: the settings row is the legacy target's storage; the database creates the target.
            await upsertLegacy();
          } else {
            // The legacy target is archived and its settings row is frozen: a new save is a new target.
            newTargetId = (
              await insertS3Target(tx, key, {
                name: S3_TARGET_NAME,
                ...fields,
                secretAccessKey,
                customerSelectable: false,
                actorId,
              })
            ).id;
            for (const scope of ["default_site", "panel"] as const) {
              const policy = await getPolicy(tx, scope);
              if (policy.targets.length === 0) {
                await setPolicyTargets(tx, policy.id, [newTargetId]);
              }
            }
          }
        } else if (live.legacySettings && (settings === null || sameLocation(settings))) {
          await upsertLegacy();
          if (
            settings !== null &&
            (settings.region !== fields.region ||
              settings.accessKeyId !== fields.accessKeyId ||
              secretAccessKey !== undefined)
          ) {
            await tx
              .update(backupTargets)
              .set({ lastTestAt: null, lastTestOutcome: null, lastTestProblem: null })
              .where(eq(backupTargets.id, live.id));
          }
        } else if (!live.legacySettings && sameLocation(toCurrentS3(live, null)!)) {
          const cur = toCurrentS3(live, null)!;
          const patch = {
            ...(cur.region !== fields.region ? { region: fields.region } : {}),
            ...(cur.accessKeyId !== fields.accessKeyId ? { accessKeyId: fields.accessKeyId } : {}),
            ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
          };
          if (Object.keys(patch).length > 0) {
            await updateBackupTarget(tx, live.id, { ...patch, actorId }, key);
          }
        } else {
          // Location change: a repository is a target, so the old one is kept (archived) with all its history.
          const secret = secretAccessKey ?? (await decryptS3Secret(tx, key, live.id));
          if (secret === null) {
            throw secretRequired();
          }
          newTargetId = (
            await insertS3Target(tx, key, {
              name: live.name,
              ...fields,
              secretAccessKey: secret,
              customerSelectable: live.customerSelectable,
              actorId,
            })
          ).id;
          if (!live.enabled) {
            await updateBackupTarget(tx, newTargetId, { enabled: false, actorId }, key);
          }
          await repointPolicyTarget(tx, live.id, newTargetId);
          await archiveBackupTarget(tx, live.id);
          archivedId = live.id;
        }
        await updatePolicySettings(
          tx,
          "default_site",
          { scheduleHourUtc: input.scheduleHourUtc, retentionDays: input.retentionDays },
          actorId,
        );
        await updatePolicySettings(tx, "panel", { retentionDays: input.retentionDays }, actorId);

        const audit = (action: string, targetType: string, targetId: string | null, details: Record<string, unknown>) =>
          appendAuditEvent(tx as unknown as HostingPanelDatabase, {
            actorId,
            actorType: "user",
            action,
            targetType,
            targetId,
            details,
          });
        await audit("admin.backups.update", "backups", null, {
          secretChanged: secretAccessKey !== undefined,
          targetChanged: archivedId !== null,
          scheduleHourUtc: input.scheduleHourUtc,
          retentionDays: input.retentionDays,
        });
        if (newTargetId !== null) {
          await audit("admin.backup_target.create", "backup_target", newTargetId, {
            targetId: newTargetId,
            targetKind: "s3",
          });
        }
        if (archivedId !== null) {
          await audit("admin.backup_target.archive", "backup_target", archivedId, {
            targetId: archivedId,
            targetKind: "s3",
          });
        }
      });
    } catch (err) {
      throw mapSaveError(err);
    }

    return this.get();
  }

  /** Archives the S3 target the legacy view shows and takes it out of the policies; other live S3 targets stay. Backups, copies and the settings row stay (SPEC 7.2.5). */
  public async clear(actorId: string): Promise<BackupSettingsDto> {
    this.#assertAvailable();

    await this.dbClient.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM backup_policies WHERE scope = 'default_site' AND site_id IS NULL FOR UPDATE`);
      const archivedTargetIds: string[] = [];
      const shown = await currentS3Target(tx);
      if (shown !== null) {
        await archiveBackupTarget(tx, shown.id);
        archivedTargetIds.push(shown.id);
      }
      await appendAuditEvent(tx as unknown as HostingPanelDatabase, {
        actorId,
        actorType: "user",
        action: "admin.backups.clear",
        targetType: "backups",
        targetId: null,
        details: { archivedTargetIds },
      });
    });

    return this.get();
  }

  /** Tests the current S3 target through the same path as `/backup-targets/:id/test` and records the outcome. */
  public async test(actorId: string): Promise<BackupTestResultDto> {
    this.#assertAvailable();

    const db = this.dbClient.db;
    const current = toCurrentS3(await currentS3Target(db), await getBackupSettingsPublic(db));
    if (current === null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "not_configured", {
        details: [{ message: "not_configured" }],
      });
    }

    const { outcome, problem } = await this.targets.test(current.target.id, actorId);
    await appendAuditEvent(db, {
      actorId,
      actorType: "user",
      action: "admin.backups.test",
      targetType: "backups",
      targetId: null,
      details: { outcome, problem },
    });
    return { outcome, problem };
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
