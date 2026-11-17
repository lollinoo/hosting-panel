import { z } from "zod";
import { OperationStatusSchema, OperationStepStatusSchema } from "./operations.js";
import { SiteFileChunkBase64Schema, SiteFileItemPathSchema, SiteFileUploadIdSchema } from "./site-files.js";
import { SITE_IMPORT_LEFT_OUT } from "./site-wordpress-files.js";
import { IMPORT_ORIGIN_PATTERN } from "./site-wordpress.js";

export const WORDPRESS_IMPORT_KIND = "site.wordpress.import" as const;
export const WORDPRESS_IMPORT_STEP_KEYS = ["check", "backup", "unpack", "database", "switch", "finish"] as const;
export const WORDPRESS_IMPORT_SLOTS = ["archive", "dump"] as const;
export const WordpressImportSlotSchema = z.enum(WORDPRESS_IMPORT_SLOTS);
export type WordpressImportSlot = z.infer<typeof WordpressImportSlotSchema>;

export const WORDPRESS_IMPORT_OUTCOMES = ["imported", "nothing_changed", "site_restored", "undo_incomplete"] as const;

// R157: the closed list of 29 reasons.
export const WORDPRESS_IMPORT_REASONS = [
  // API
  "files_missing", "earlier_import_unfinished", "backup_failed", "interrupted", "timed_out", "unavailable", "other",
  // files side
  "archive_not_zip", "dump_not_sql", "archive_unsafe", "archive_limit", "archive_not_wordpress", "disk_full", "staging_unsafe",
  // database side
  "dump_unsafe", "dump_too_large", "dump_incomplete", "dump_statement_unsupported", "dump_load_failed",
  "dump_not_wordpress", "dump_ambiguous", "multisite_unsupported", "address_unsupported",
  "dump_objects_unsupported", "dump_names_unsupported", "dump_too_many_tables", "site_objects_unsupported",
  "address_rewrite_failed", "site_check_failed",
] as const;
export type WordpressImportReason = (typeof WORDPRESS_IMPORT_REASONS)[number];

/** R161: the only names an outcome may list as left out. */
export const WORDPRESS_IMPORT_LEFT_OUT = SITE_IMPORT_LEFT_OUT;

/** Route refusals carried in details[0].reason. */
export const WORDPRESS_IMPORT_REFUSALS = ["import_running", "files_incomplete", "earlier_import_unfinished"] as const;

export const SiteWordpressImportSlotDtoSchema = z
  .object({
    state: z.enum(["empty", "partial", "complete"]),
    size: z.number().int().nonnegative(),
    uploadId: SiteFileUploadIdSchema.nullable(), // resume: offset = size
  })
  .strict();
export type SiteWordpressImportSlotDto = z.infer<typeof SiteWordpressImportSlotDtoSchema>;

export const SiteWordpressImportRunningOperationDtoSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal(WORDPRESS_IMPORT_KIND),
    status: OperationStatusSchema,
    steps: z
      .array(z.object({ key: z.enum(WORDPRESS_IMPORT_STEP_KEYS), status: OperationStepStatusSchema }).strict())
      .max(6),
  })
  .strict();

export const SiteWordpressLastImportDtoSchema = z
  .object({
    operationId: z.string().regex(/^op_[0-9a-f]{32}$/),
    finishedAt: z.string().datetime(),
    outcome: z.enum(WORDPRESS_IMPORT_OUTCOMES),
    reason: z.enum(WORDPRESS_IMPORT_REASONS).nullable(),
    backup: z.enum(["taken", "skipped", "failed"]),
    oldAddress: z.string().max(300).regex(IMPORT_ORIGIN_PATTERN).nullable(),
    leftOut: z.array(z.enum(WORDPRESS_IMPORT_LEFT_OUT)).max(16),
    tables: z.number().int().nonnegative().nullable(),
    line: z.number().int().nonnegative().nullable(),
    errorNumber: z.number().int().min(1).max(99999).nullable(),
  })
  .strict();
export type SiteWordpressLastImportDto = z.infer<typeof SiteWordpressLastImportDtoSchema>;

export const SiteWordpressImportDtoSchema = z
  .object({
    available: z.boolean(),
    backupsConfigured: z.boolean(),
    slots: z
      .object({ archive: SiteWordpressImportSlotDtoSchema, dump: SiteWordpressImportSlotDtoSchema })
      .strict()
      .nullable(),
    earlierImportUnfinished: z.boolean(),
    runningOperation: SiteWordpressImportRunningOperationDtoSchema.nullable(),
    lastImport: SiteWordpressLastImportDtoSchema.nullable(),
  })
  .strict();
export type SiteWordpressImportDto = z.infer<typeof SiteWordpressImportDtoSchema>;

export const SiteWordpressImportChunkRequestSchema = z
  .object({
    uploadId: SiteFileUploadIdSchema,
    offset: z.number().int().nonnegative(),
    dataBase64: SiteFileChunkBase64Schema,
    final: z.boolean(),
  })
  .strict();
export type SiteWordpressImportChunkRequest = z.infer<typeof SiteWordpressImportChunkRequestSchema>;

export const SiteWordpressImportPickRequestSchema = z.object({ path: SiteFileItemPathSchema }).strict();

export const SiteWordpressImportStartRequestSchema = z.object({ confirm: z.literal(true) }).strict();
// 202 body reuses SiteWordpressAcceptedDtoSchema (site-wordpress.ts).
