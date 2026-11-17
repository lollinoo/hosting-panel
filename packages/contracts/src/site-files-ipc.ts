import { z } from "zod";
import type { ErrorCode } from "./errors.js";
import { SITE_FILES_CORE_REQUESTS, SITE_FILES_CORE_RESULTS } from "./ipc-schemas.js";
import { SITE_FILE_CORE_ERROR_REASONS, SITE_FILE_CORE_REASON_CODES } from "./site-files.js";
import {
  SITE_TYPE_FILES_REQUESTS,
  SITE_TYPE_FILES_RESULTS,
  SITE_TYPE_FILE_ERROR_REASONS,
  SITE_TYPE_FILE_REASON_CODES,
} from "./site-types/index.js";

// The files requests, results and reasons: the core plus what the site types add (D9).
export const SiteFilesIpcRequestSchema = z.discriminatedUnion("op", [...SITE_FILES_CORE_REQUESTS, ...SITE_TYPE_FILES_REQUESTS]);
export type SiteFilesIpcRequest = z.infer<typeof SiteFilesIpcRequestSchema>;
export type SiteFilesOp = SiteFilesIpcRequest["op"];
export type SiteImportOp = Extract<SiteFilesOp, `import.${string}`>;

export const SITE_FILES_RESULT_SCHEMAS = { ...SITE_FILES_CORE_RESULTS, ...SITE_TYPE_FILES_RESULTS } as const;
export type SiteFilesResultByOp = {
  [K in SiteFilesOp]: z.infer<(typeof SITE_FILES_RESULT_SCHEMAS)[K]>;
};

export const SITE_FILE_ERROR_REASONS = [...SITE_FILE_CORE_ERROR_REASONS, ...SITE_TYPE_FILE_ERROR_REASONS] as const;
export type SiteFileErrorReason = (typeof SITE_FILE_ERROR_REASONS)[number];

export const SITE_FILE_REASON_CODES: Readonly<Record<SiteFileErrorReason, ErrorCode>> = {
  ...SITE_FILE_CORE_REASON_CODES,
  ...SITE_TYPE_FILE_REASON_CODES,
} as const;
