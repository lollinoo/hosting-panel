import { z } from "zod";
import type { ErrorCode } from "./errors.js";

export const SITE_FILE_CHUNK_BYTES = 524_288;
export const SITE_FILE_CHUNK_BASE64_MAX = 699_052; // 4 * ceil(524288 / 3)
export const SITE_FILE_PATH_MAX = 1024;
export const SITE_FILE_SEGMENT_MAX_BYTES = 255;
export const SITE_FILE_BATCH_MAX = 100;

export const SITE_FILE_ERROR_REASONS = [
  "invalid_path",
  "not_found",
  "exists",
  "not_a_directory",
  "is_a_directory",
  "protected",
  "too_large",
  "archive_limit",
  "upload_mismatch",
  "not_a_zip",
  "disk_full",
  "archive_unsafe",
  "zip_unavailable",
  "not_ready",
] as const;
export type SiteFileErrorReason = (typeof SITE_FILE_ERROR_REASONS)[number];

export const SITE_FILE_REASON_CODES: Readonly<Record<SiteFileErrorReason, ErrorCode>> = {
  invalid_path: "VALIDATION_ERROR",
  not_a_directory: "VALIDATION_ERROR",
  is_a_directory: "VALIDATION_ERROR",
  upload_mismatch: "VALIDATION_ERROR",
  not_a_zip: "VALIDATION_ERROR",
  archive_unsafe: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
  exists: "ALREADY_EXISTS",
  protected: "PERMISSION_DENIED",
  too_large: "QUOTA_EXCEEDED",
  archive_limit: "QUOTA_EXCEEDED",
  disk_full: "QUOTA_EXCEEDED",
  zip_unavailable: "NOT_SUPPORTED",
  not_ready: "RESOURCE_LOCKED",
} as const;

const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length; // browser-safe, no Buffer

// Relative, "/"-separated, "" = root. Backslash is an ordinary character.
export const SiteFilePathSchema = z
  .string()
  .max(SITE_FILE_PATH_MAX)
  .transform((raw) => raw.replace(/\/{2,}/g, "/"))
  .superRefine((p, ctx) => {
    const trimmed = p.replace(/\/$/, "");
    const bad =
      p.startsWith("/") ||
      hasControlChar(p) ||
      trimmed
        .split("/")
        .some(
          (s) =>
            (trimmed !== "" && s === "") ||
            s === "." ||
            s === ".." ||
            s.startsWith(".htpanel-") ||
            utf8Bytes(s) > SITE_FILE_SEGMENT_MAX_BYTES,
        );
    if (bad) ctx.addIssue({ code: "custom", message: "invalid_path" });
  })
  .transform((p) => p.replace(/\/$/, ""));

export const SiteFileItemPathSchema = SiteFilePathSchema.refine((p) => p !== "", {
  message: "invalid_path",
});
const ZipPathSchema = SiteFileItemPathSchema.refine((p) => /\.zip$/i.test(p), {
  message: "not_a_zip",
});
const BatchSchema = z.array(SiteFileItemPathSchema).min(1).max(SITE_FILE_BATCH_MAX);

export const SiteFileUploadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const SiteFileChunkBase64Schema = z
  .string()
  .max(SITE_FILE_CHUNK_BASE64_MAX)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((s) => s.length % 4 === 0, { message: "invalid_base64" })
  .refine(
    (s) => (s.length / 4) * 3 - (s.match(/=+$/)?.[0].length ?? 0) <= SITE_FILE_CHUNK_BYTES,
    {
      message: "too_large",
    },
  );

export const SiteFileEntrySchema = z
  .object({
    name: z.string().min(1).max(SITE_FILE_SEGMENT_MAX_BYTES),
    kind: z.enum(["file", "dir", "link", "other"]),
    size: z.number().int().nonnegative(),
    modifiedAt: z.iso.datetime({ offset: true }),
    writable: z.boolean(),
  })
  .strict();

// Requests (query values arrive as strings: coerce)
export const SiteFileListQuerySchema = z.object({ path: SiteFilePathSchema.default("") }).strict();
export const SiteFileReadQuerySchema = z
  .object({
    path: SiteFileItemPathSchema,
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    length: z.coerce.number().int().min(1).max(SITE_FILE_CHUNK_BYTES).default(SITE_FILE_CHUNK_BYTES),
  })
  .strict();
export const SiteFileWriteRequestSchema = z
  .object({
    path: SiteFileItemPathSchema,
    uploadId: SiteFileUploadIdSchema,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    dataBase64: SiteFileChunkBase64Schema,
    final: z.boolean(),
    overwrite: z.boolean(),
  })
  .strict();
export const SiteFileFolderRequestSchema = z.object({ path: SiteFileItemPathSchema }).strict();
export const SiteFileMoveRequestSchema = z
  .object({ from: SiteFileItemPathSchema, to: SiteFileItemPathSchema })
  .strict()
  .refine((b) => b.from !== b.to && !b.to.startsWith(`${b.from}/`), {
    message: "invalid_path",
    path: ["to"],
  });
export const SiteFileDeleteRequestSchema = z.object({ paths: BatchSchema }).strict();
export const SiteFileArchiveRequestSchema = z
  .object({ paths: BatchSchema, to: ZipPathSchema })
  .strict();
export const SiteFileExtractRequestSchema = z
  .object({ path: ZipPathSchema, to: SiteFilePathSchema })
  .strict();

// Responses (names agreed with architect D)
export const SiteFileListDtoSchema = z
  .object({ entries: z.array(SiteFileEntrySchema), truncated: z.boolean() })
  .strict();
export const SiteFileChunkDtoSchema = z
  .object({
    dataBase64: z.string(),
    size: z.number().int().nonnegative(),
    eof: z.boolean(),
  })
  .strict();
export const SiteFileWriteResultDtoSchema = z
  .object({ received: z.number().int().nonnegative() })
  .strict();

export type SiteFileEntryDto = z.infer<typeof SiteFileEntrySchema>;
export type SiteFileListDto = z.infer<typeof SiteFileListDtoSchema>;
export type SiteFileChunkDto = z.infer<typeof SiteFileChunkDtoSchema>;
export type SiteFileWriteResultDto = z.infer<typeof SiteFileWriteResultDtoSchema>;
export type SiteFileArchiveRequest = z.infer<typeof SiteFileArchiveRequestSchema>;
export type SiteFileExtractRequest = z.infer<typeof SiteFileExtractRequestSchema>;
