import { z } from "zod";
import { BACKUP_FAILURE_CLASSES, BackupTargetSchema } from "./ipc-schemas.js";
import type { OperationKind } from "./operations.js";
import { SiteFileChunkDtoSchema } from "./site-files.js";

export const MANUAL_BACKUPS_KEPT = 3;
export const PRE_UPDATE_BACKUPS_KEPT = 3;
export const DEFAULT_BACKUP_HOUR_UTC = 2;
export const DEFAULT_BACKUP_RETENTION_DAYS = 14;
export const HEAVY_ACTIONS_PER_HOUR = 6;
export const HEAVY_ACTION_WINDOW_MS = 60 * 60_000;
export const HEAVY_BACKUP_OPERATION_KINDS = [
  "site.backups.create",
  "site.backups.restore",
  "site.backups.download",
  "site.wordpress.update",
  "site.wordpress.import",
] as const satisfies readonly OperationKind[];

export const BACKUP_PROBLEMS = [
  ...BACKUP_FAILURE_CLASSES,
  "site_busy",
  "address_not_updated",
  "panel_dump_failed",
  "panel_dump_tool_missing",
  "site_not_started",
] as const;
export const BackupProblemSchema = z.enum(BACKUP_PROBLEMS);
export type BackupProblem = z.infer<typeof BackupProblemSchema>;

export const BACKUP_KINDS = ["nightly", "manual", "pre_update"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const BACKUP_STATUSES = ["running", "succeeded", "failed"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

function deriveTargetField(schema: z.ZodType<string>, message: string) {
  return z.string({ error: message }).refine((value) => schema.safeParse(value).success, {
    error: message,
  });
}

// Target fields reuse BackupTargetSchema so public input and IPC enforcement cannot drift.
export const BackupEndpointSchema = deriveTargetField(
  BackupTargetSchema.shape.endpoint,
  "endpoint_invalid",
);
export const BackupRegionSchema = deriveTargetField(
  BackupTargetSchema.shape.region,
  "region_invalid",
);
export const BackupBucketSchema = deriveTargetField(
  BackupTargetSchema.shape.bucket,
  "bucket_invalid",
);
export const BackupPrefixSchema = deriveTargetField(
  BackupTargetSchema.shape.prefix,
  "prefix_invalid",
);
export const BackupAccessKeyIdSchema = deriveTargetField(
  BackupTargetSchema.shape.accessKeyId,
  "access_key_id_invalid",
);
export const BackupSecretAccessKeySchema = deriveTargetField(
  BackupTargetSchema.shape.secretAccessKey,
  "secret_access_key_invalid",
);

export const BackupSettingsInputSchema = z
  .object({
    endpoint: BackupEndpointSchema,
    region: BackupRegionSchema,
    bucket: BackupBucketSchema,
    prefix: BackupPrefixSchema.default(""),
    accessKeyId: BackupAccessKeyIdSchema,
    secretAccessKey: BackupSecretAccessKeySchema.optional(),
    scheduleHourUtc: z
      .number({ error: "schedule_hour_invalid" })
      .int({ error: "schedule_hour_invalid" })
      .min(0, { error: "schedule_hour_invalid" })
      .max(23, { error: "schedule_hour_invalid" })
      .default(DEFAULT_BACKUP_HOUR_UTC),
    retentionDays: z
      .number({ error: "retention_days_invalid" })
      .int({ error: "retention_days_invalid" })
      .min(1, { error: "retention_days_invalid" })
      .max(365, { error: "retention_days_invalid" })
      .default(DEFAULT_BACKUP_RETENTION_DAYS),
  })
  .strict();

export type BackupSettingsInput = z.infer<typeof BackupSettingsInputSchema>;

export const BackupTestResultDtoSchema = z.object({
  outcome: z.enum(["ok", "failed"]),
  problem: BackupProblemSchema.nullable(),
});
export type BackupTestResultDto = z.infer<typeof BackupTestResultDtoSchema>;

export const PanelBackupLineSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    status: z.enum(["succeeded", "failed"]),
    problem: BackupProblemSchema.nullable(),
  })
  .strict();
export type PanelBackupLine = z.infer<typeof PanelBackupLineSchema>;

export const BackupSettingsDtoSchema = z.object({
  available: z.boolean(),
  configured: z.boolean(),
  endpoint: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  prefix: z.string(),
  accessKeyId: z.string().nullable(),
  secretAccessKeySet: z.boolean(),
  scheduleHourUtc: z.number().int(),
  retentionDays: z.number().int(),
  lastNightlyRunOn: z.string().nullable(),
  lastTest: BackupTestResultDtoSchema.extend({ at: z.string() }).nullable(),
  updatedAt: z.string().nullable(),
  lastPanelBackup: PanelBackupLineSchema.nullable(),
  newestBackupsTotalBytes: z.number().int().nonnegative(),
});
export type BackupSettingsDto = z.infer<typeof BackupSettingsDtoSchema>;

export const RestoreBackupInputSchema = z
  .object({
    confirmName: z.string().max(255),
  })
  .strict();
export type RestoreBackupInput = z.infer<typeof RestoreBackupInputSchema>;

export const AdminRestoreBackupInputSchema = z
  .object({
    backupId: z
      .string()
      .regex(/^bkp_[0-9a-f]{32}$/)
      .optional(),
    confirmName: z.string().max(255),
  })
  .strict();
export type AdminRestoreBackupInput = z.infer<typeof AdminRestoreBackupInputSchema>;

export const BackupArchiveDtoSchema = z.object({
  status: z.enum(["preparing", "ready", "failed"]),
  readyUntil: z.string().nullable(),
  problem: BackupProblemSchema.nullable(),
});
export type BackupArchiveDto = z.infer<typeof BackupArchiveDtoSchema>;

export const BackupLastRestoreDtoSchema = z.object({
  backupId: z.string(),
  backupStartedAt: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  finishedAt: z.string().nullable(),
  problem: BackupProblemSchema.nullable(),
});
export type BackupLastRestoreDto = z.infer<typeof BackupLastRestoreDtoSchema>;

export const SiteBackupDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(BACKUP_KINDS),
  status: z.enum(BACKUP_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  problem: BackupProblemSchema.nullable(),
  archive: BackupArchiveDtoSchema.nullable(),
});
export type SiteBackupDto = z.infer<typeof SiteBackupDtoSchema>;

export const SiteBackupsDtoSchema = z.object({
  available: z.boolean(),
  configured: z.boolean(),
  retentionDays: z.number().int(),
  manualKept: z.literal(MANUAL_BACKUPS_KEPT),
  runningOperationId: z.string().nullable(),
  lastRestore: BackupLastRestoreDtoSchema.nullable(),
  backups: z.array(SiteBackupDtoSchema),
});
export type SiteBackupsDto = z.infer<typeof SiteBackupsDtoSchema>;

export const BackupArchiveChunkDtoSchema = SiteFileChunkDtoSchema.extend({
  fileName: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.zip$/),
}).strict();
export type BackupArchiveChunkDto = z.infer<typeof BackupArchiveChunkDtoSchema>;

/** Builds a safe UTC download file name (<site>-backup-YYYY-MM-DD-HHmm.zip). */
export function backupArchiveFileName(siteName: string, startedAt: Date): string {
  const safe =
    siteName
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[.-]+/, "")
      .slice(0, 80) || "site";
  const t = startedAt.toISOString();
  return `${safe}-backup-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.zip`;
}

export const AdminSiteBackupStatusDtoSchema = z.object({
  siteId: z.string(),
  siteName: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  lastStatus: z.enum(BACKUP_STATUSES).nullable(),
  problem: BackupProblemSchema.nullable(),
  runningOperationId: z.string().nullable(),
  lastSuccessBackupId: z.string().nullable(),
  lastSuccessSizeBytes: z.number().int().nonnegative().nullable(),
  lastRestore: BackupLastRestoreDtoSchema.nullable(),
});
export type AdminSiteBackupStatusDto = z.infer<typeof AdminSiteBackupStatusDtoSchema>;

export const SiteBackupAcceptedDtoSchema = z.object({
  siteId: z.string(),
  backupId: z.string(),
  operationId: z.string(),
});
export type SiteBackupAcceptedDto = z.infer<typeof SiteBackupAcceptedDtoSchema>;
