import { z } from "zod";
import type { ErrorCode } from "./errors.js";
import { SiteFileOffsetSchema, SiteFilesServiceIdSchema } from "./ipc-schemas.js";
import { SiteFileChunkBase64Schema, SiteFileItemPathSchema, SiteFileUploadIdSchema } from "./site-files.js";
import { SiteTypeKeySchema } from "./site-types/keys.js";

// The WordPress import's part of the files requests (D9): composed with the core in site-files-ipc.ts.

export const SITE_TYPE_FILE_ERROR_REASONS = ["files_missing", "archive_not_wordpress", "staging_unsafe", "dump_not_sql"] as const;

export const SITE_TYPE_FILE_REASON_CODES: Readonly<Record<(typeof SITE_TYPE_FILE_ERROR_REASONS)[number], ErrorCode>> = {
  files_missing: "NOT_FOUND",
  archive_not_wordpress: "VALIDATION_ERROR",
  staging_unsafe: "RESOURCE_LOCKED",
  dump_not_sql: "VALIDATION_ERROR",
} as const;

/** What an import never takes from the archive, each the path from the site root (R161). */
export const SITE_IMPORT_LEFT_OUT = [
  "wp-config.php",
  ".htaccess",
  ".maintenance",
  "wp-content/mu-plugins",
  "wp-content/advanced-cache.php",
  "wp-content/object-cache.php",
  "wp-content/db.php",
  "wp-content/db-error.php",
  "wp-content/install.php",
  "wp-content/maintenance.php",
  "wp-content/php-error.php",
  "wp-content/fatal-error-handler.php",
  "wp-content/sunrise.php",
  "wp-content/blog-deleted.php",
  "wp-content/blog-inactive.php",
  "wp-content/blog-suspended.php",
] as const;

export const SITE_IMPORT_SLOTS = ["archive", "dump"] as const;
export const SiteImportSlotSchema = z.enum(SITE_IMPORT_SLOTS);
export const SiteImportIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const SITE_TYPE_FILES_REQUESTS = [
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      siteType: SiteTypeKeySchema.optional(),
      op: z.literal("import.put"),
      slot: SiteImportSlotSchema,
      uploadId: SiteFileUploadIdSchema,
      offset: SiteFileOffsetSchema,
      dataBase64: SiteFileChunkBase64Schema,
      final: z.boolean(),
    })
    .strict(),
  z
    .object({
      serviceInstanceId: SiteFilesServiceIdSchema,
      siteType: SiteTypeKeySchema.optional(),
      op: z.literal("import.take"),
      slot: SiteImportSlotSchema,
      path: SiteFileItemPathSchema,
    })
    .strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.stat") }).strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.discard") }).strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.unpack"), importId: SiteImportIdSchema }).strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.switch"), importId: SiteImportIdSchema }).strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.undo"), importId: SiteImportIdSchema }).strict(),
  z.object({ serviceInstanceId: SiteFilesServiceIdSchema, siteType: SiteTypeKeySchema.optional(), op: z.literal("import.finish"), importId: SiteImportIdSchema }).strict(),
] as const;

const SiteFilesEmptyResultSchema = z.object({}).strict();
const SiteImportSlotStateSchema = z
  .object({
    state: z.enum(["empty", "partial", "complete"]),
    size: z.number().int().nonnegative(),
    uploadId: SiteFileUploadIdSchema.nullable(),
  })
  .strict();

export const SITE_TYPE_FILES_RESULTS = {
  "import.put": z.object({ received: z.number().int().nonnegative() }),
  "import.take": z.object({ size: z.number().int().nonnegative() }),
  "import.stat": z.object({ archive: SiteImportSlotStateSchema, dump: SiteImportSlotStateSchema, remains: z.boolean() }),
  "import.discard": SiteFilesEmptyResultSchema,
  "import.unpack": z.object({
    entries: z.number().int().nonnegative(),
    leftOut: z.array(z.enum(SITE_IMPORT_LEFT_OUT)).max(SITE_IMPORT_LEFT_OUT.length),
  }),
  "import.switch": z.object({ moved: z.number().int().nonnegative() }),
  "import.undo": z.object({ complete: z.boolean() }).strict(),
  "import.finish": SiteFilesEmptyResultSchema,
} as const;
