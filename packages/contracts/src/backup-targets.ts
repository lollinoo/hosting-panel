import { z } from "zod";
import {
  BackupAccessKeyIdSchema,
  BackupBucketSchema,
  BackupEndpointSchema,
  BackupPrefixSchema,
  BackupProblemSchema,
  BackupRegionSchema,
  BackupSecretAccessKeySchema,
} from "./backups.js";
import { BACKUP_TARGET_ID_PATTERN, BackupTargetSchema } from "./ipc-schemas.js";

export const BACKUP_TARGET_KINDS = ["s3", "local"] as const;
export type BackupTargetKind = (typeof BACKUP_TARGET_KINDS)[number];

export const BACKUP_POLICY_SCOPES = ["default_site", "site", "panel"] as const;
export type BackupPolicyScope = (typeof BACKUP_POLICY_SCOPES)[number];

export const BACKUP_COPY_STATUSES = ["running", "succeeded", "failed", "missing", "unknown"] as const;
export type BackupCopyStatus = (typeof BACKUP_COPY_STATUSES)[number];

/** A policy chooses at most two targets (priority 1 and 2). */
export const MAX_BACKUP_POLICY_TARGETS = 2;

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const BytesSchema = z.number().int().nonnegative();
const RetentionDaysSchema = z.number().int().min(1).max(365);
const KindSchema = z.enum(BACKUP_TARGET_KINDS);

export const BackupTargetIdSchema = z.string().regex(BACKUP_TARGET_ID_PATTERN);
export type BackupTargetId = z.infer<typeof BackupTargetIdSchema>;

const TargetNameSchema = z.string().trim().min(1).max(128);

const areDistinct = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;
const NOT_DISTINCT = { error: "target_ids_not_distinct" } as const;
const PolicyTargetIdsSchema = z
  .array(BackupTargetIdSchema)
  .max(MAX_BACKUP_POLICY_TARGETS)
  .refine(areDistinct, NOT_DISTINCT);

/** Location and access key of an S3 target; the secret is write-only and never part of a config. */
export const S3BackupTargetConfigSchema = BackupTargetSchema.omit({ secretAccessKey: true }).strict();
export type S3BackupTargetConfig = z.infer<typeof S3BackupTargetConfigSchema>;

// A local target has no path field at all: the root comes from the server configuration.
export const CreateBackupTargetInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("s3"),
      name: TargetNameSchema,
      enabled: z.boolean().default(true),
      customerSelectable: z.boolean().default(false),
      endpoint: BackupEndpointSchema,
      region: BackupRegionSchema,
      bucket: BackupBucketSchema,
      prefix: BackupPrefixSchema.default(""),
      accessKeyId: BackupAccessKeyIdSchema,
      secretAccessKey: BackupSecretAccessKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("local"),
      name: TargetNameSchema,
      enabled: z.boolean().default(true),
      customerSelectable: z.boolean().default(false),
    })
    .strict(),
]);
export type CreateBackupTargetInput = z.infer<typeof CreateBackupTargetInputSchema>;

// Changing endpoint, bucket or prefix makes the API create a new target and archive the old one.
export const UpdateBackupTargetInputSchema = z
  .object({
    name: TargetNameSchema,
    enabled: z.boolean(),
    customerSelectable: z.boolean(),
    /** null = inherit the policy retention. */
    retentionDays: RetentionDaysSchema.nullable(),
    archived: z.literal(true),
    endpoint: BackupEndpointSchema,
    region: BackupRegionSchema,
    bucket: BackupBucketSchema,
    prefix: BackupPrefixSchema,
    accessKeyId: BackupAccessKeyIdSchema,
    secretAccessKey: BackupSecretAccessKeySchema,
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, { error: "update_empty" });
export type UpdateBackupTargetInput = z.infer<typeof UpdateBackupTargetInputSchema>;

/** Administrator view: location and access key id are visible, the secret only as a flag. */
export const AdminBackupTargetDtoSchema = z
  .object({
    id: BackupTargetIdSchema,
    kind: KindSchema,
    name: z.string(),
    enabled: z.boolean(),
    customerSelectable: z.boolean(),
    legacy: z.boolean(),
    archivedAt: IsoDateTimeSchema.nullable(),
    retentionDays: RetentionDaysSchema.nullable(),
    s3: S3BackupTargetConfigSchema.extend({ secretAccessKeySet: z.literal(true) }).strict().nullable(),
    local: z
      .object({ root: z.string().nullable(), initializedAt: IsoDateTimeSchema.nullable() })
      .strict()
      .nullable(),
    lastTest: z
      .object({
        at: IsoDateTimeSchema,
        outcome: z.enum(["ok", "failed"]),
        problem: BackupProblemSchema.nullable(),
        availableBytes: BytesSchema.nullable(),
        totalBytes: BytesSchema.nullable(),
      })
      .strict()
      .nullable(),
    usage: z
      .object({
        policies: z.array(z.enum(BACKUP_POLICY_SCOPES)),
        copies: BytesSchema,
      })
      .strict(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type AdminBackupTargetDto = z.infer<typeof AdminBackupTargetDtoSchema>;

export const BackupTargetsDtoSchema = z
  .object({
    targets: z.array(AdminBackupTargetDtoSchema),
    /** False when this install cannot offer a local target (no managed root). */
    localRootConfigured: z.boolean(),
  })
  .strict();
export type BackupTargetsDto = z.infer<typeof BackupTargetsDtoSchema>;

/** Customer view of a destination: an id and a kind, no name, endpoint, bucket or path. */
export const BackupTargetChoiceDtoSchema = z.object({ id: BackupTargetIdSchema, kind: KindSchema }).strict();
export type BackupTargetChoiceDto = z.infer<typeof BackupTargetChoiceDtoSchema>;

export const BackupPolicyTargetDtoSchema = z
  .object({
    targetId: BackupTargetIdSchema,
    kind: KindSchema,
    priority: z.union([z.literal(1), z.literal(2)]),
    required: z.boolean(),
  })
  .strict();
export type BackupPolicyTargetDto = z.infer<typeof BackupPolicyTargetDtoSchema>;

export const BackupPolicyDtoSchema = z
  .object({
    scope: z.enum(["default_site", "panel"]),
    siteId: z.null(),
    /** null for the panel policy: it has no schedule of its own. */
    scheduleHourUtc: z.number().int().min(0).max(23).nullable(),
    retentionDays: RetentionDaysSchema,
    targets: z.array(BackupPolicyTargetDtoSchema).max(MAX_BACKUP_POLICY_TARGETS),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type BackupPolicyDto = z.infer<typeof BackupPolicyDtoSchema>;

export const UpdateDefaultSiteBackupPolicyInputSchema = z
  .object({
    scheduleHourUtc: z.number().int().min(0).max(23),
    retentionDays: RetentionDaysSchema,
    /** Order is the priority. */
    targetIds: PolicyTargetIdsSchema,
  })
  .partial()
  .strict();
export type UpdateDefaultSiteBackupPolicyInput = z.infer<typeof UpdateDefaultSiteBackupPolicyInputSchema>;

export const UpdatePanelBackupPolicyInputSchema = z
  .object({ retentionDays: RetentionDaysSchema, targetIds: PolicyTargetIdsSchema })
  .partial()
  .strict();
export type UpdatePanelBackupPolicyInput = z.infer<typeof UpdatePanelBackupPolicyInputSchema>;

/** A site chooses destinations only; null means inherit the default policy. */
export const SetSiteBackupPolicyInputSchema = z
  .object({
    targetIds: z
      .array(BackupTargetIdSchema)
      .min(1)
      .max(MAX_BACKUP_POLICY_TARGETS)
      .refine(areDistinct, NOT_DISTINCT)
      .nullable(),
  })
  .strict();
export type SetSiteBackupPolicyInput = z.infer<typeof SetSiteBackupPolicyInputSchema>;

export const SiteBackupPolicyDtoSchema = z
  .object({
    targetIds: z.array(BackupTargetIdSchema).max(MAX_BACKUP_POLICY_TARGETS),
    inherited: z.boolean(),
    choices: z.array(BackupTargetChoiceDtoSchema),
  })
  .strict();
export type SiteBackupPolicyDto = z.infer<typeof SiteBackupPolicyDtoSchema>;

/** One copy of a site backup on one destination; no snapshot id for customers. */
export const SiteBackupCopyDtoSchema = z
  .object({
    targetId: BackupTargetIdSchema,
    kind: KindSchema,
    status: z.enum(BACKUP_COPY_STATUSES),
    sizeBytes: BytesSchema.nullable(),
    problem: BackupProblemSchema.nullable(),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type SiteBackupCopyDto = z.infer<typeof SiteBackupCopyDtoSchema>;
