import { z } from "zod";
import {
  OperationStatusSchema,
  OperationStepStatusSchema,
  type OperationKind,
} from "./operations.js";

export const WORDPRESS_ITEM_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export const WORDPRESS_UPDATE_TARGET_PATTERN = /^(all|core|(plugin|theme):[A-Za-z0-9_][A-Za-z0-9._-]{0,99})$/;
export const WORDPRESS_USER_ID_PATTERN = /^[1-9][0-9]{0,9}$/;
export const WORDPRESS_RESULT_MAX_BYTES = 262_144;
export const WORDPRESS_RESET_CLIENT_WAIT_MS = 75_000;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u);
const version = text(40);

export const WordpressPluginSchema = z
  .object({
    name: text(200).min(1),
    title: text(200),
    status: z.enum(["active", "inactive", "active-network", "must-use", "dropin"]),
    version: version.nullable(),
    updateVersion: version.nullable(),
  })
  .strict();
export const WordpressThemeSchema = WordpressPluginSchema.extend({
  status: z.enum(["active", "inactive", "parent"]),
}).strict();
export const WordpressStateResultSchema = z
  .object({
    coreVersion: version.min(1),
    coreUpdate: version.nullable(),
    updatesKnown: z.boolean(),
    plugins: z.array(WordpressPluginSchema).max(500),
    themes: z.array(WordpressThemeSchema).max(200),
    administrators: z
      .array(z.object({ id: z.number().int().min(1).max(9_999_999_999), login: text(60).min(1) }).strict())
      .max(200),
  })
  .strict();
export type WordpressStateResult = z.infer<typeof WordpressStateResultSchema>;

export const WordpressUpdateItemSchema = z
  .object({
    type: z.enum(["core", "plugin", "theme"]),
    name: text(200).min(1),
    oldVersion: version.nullable(),
    newVersion: version.nullable(),
    status: z.enum(["updated", "failed"]),
  })
  .strict();
export const WordpressUpdateResultSchema = z
  .object({ items: z.array(WordpressUpdateItemSchema).max(701) })
  .strict();
export type WordpressUpdateResult = z.infer<typeof WordpressUpdateResultSchema>;

export const WORDPRESS_JOB_REASONS = [
  "not_wordpress",
  "broken_configuration",
  "database_unreachable",
  "wordpress_org_unreachable",
  "item_unknown",
  "update_failed",
  "not_administrator",
  "bad_request",
  "result_unreadable",
  "timed_out",
  "other",
] as const;
export type WordpressJobReason = (typeof WORDPRESS_JOB_REASONS)[number];
const BY_EXIT: Readonly<Record<number, WordpressJobReason>> = {
  21: "not_wordpress",
  22: "broken_configuration",
  23: "database_unreachable",
  30: "wordpress_org_unreachable",
  31: "item_unknown",
  32: "update_failed",
  40: "not_administrator",
  64: "bad_request",
  70: "result_unreadable",
  124: "timed_out",
  137: "timed_out",
};
/** null = success. needsResult: inspect and update. */
export function wordpressJobReason(
  exitCode: number,
  hasResult: boolean,
  needsResult: boolean,
): WordpressJobReason | null {
  if (exitCode === 0) return needsResult && !hasResult ? "result_unreadable" : null;
  return BY_EXIT[exitCode] ?? "other";
}

// API part: the DTOs of the WordPress tab (api-wp Contract, R128).
export const WORDPRESS_STATE_STALE_MS = 12 * 3_600_000;

/** Today's rule for a WordPress site; M6 replaces the body with the site type. */
export function isWordpressSite(site: { readonly phpVersion: string | null }): boolean {
  return site.phpVersion !== null;
}

export const WORDPRESS_OPERATION_KINDS = [
  "site.wordpress.inspect",
  "site.wordpress.update",
] as const satisfies readonly OperationKind[];

export const WORDPRESS_PROBLEMS = [
  "wordpress_org_unreachable",
  "config_broken",
  "database_unreachable",
  "not_installed",
  "backup_failed",
  "items_failed",
  "item_unknown",
  "outcome_unknown",
  "interrupted",
] as const;
export const WordpressProblemSchema = z.enum(WORDPRESS_PROBLEMS);
export type WordpressProblem = z.infer<typeof WordpressProblemSchema>;

const ItemNameSchema = z.string().regex(WORDPRESS_ITEM_NAME_PATTERN);
export const SiteWordpressUpdateRequestSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }).strict(),
  z.object({ scope: z.literal("core") }).strict(),
  z.object({ scope: z.literal("plugin"), name: ItemNameSchema }).strict(),
  z.object({ scope: z.literal("theme"), name: ItemNameSchema }).strict(),
]);
export type SiteWordpressUpdateRequest = z.infer<typeof SiteWordpressUpdateRequestSchema>;

export const SiteWordpressStateDtoSchema = WordpressStateResultSchema.extend({
  checkedAt: z.string().datetime(),
  coreVersion: z.string().min(1).max(40).nullable(), // null only on a problem row
  problem: WordpressProblemSchema.nullable(),
}).strict();
export type SiteWordpressStateDto = z.infer<typeof SiteWordpressStateDtoSchema>;

export const SiteWordpressLastUpdateDtoSchema = z
  .object({
    operationId: z.string().min(1),
    target: SiteWordpressUpdateRequestSchema,
    status: z.enum(["succeeded", "failed"]),
    finishedAt: z.string().datetime(),
    problem: WordpressProblemSchema.nullable(),
    backup: z.enum(["taken", "skipped", "failed"]),
    items: z.array(WordpressUpdateItemSchema).max(701),
  })
  .strict();
export type SiteWordpressLastUpdateDto = z.infer<typeof SiteWordpressLastUpdateDtoSchema>;

export const SiteWordpressRunningOperationDtoSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(WORDPRESS_OPERATION_KINDS),
    status: OperationStatusSchema,
    steps: z
      .array(
        z
          .object({
            key: z.enum(["inspect", "backup", "update", "settle"]),
            status: OperationStepStatusSchema,
          })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const SiteWordpressDtoSchema = z
  .object({
    backupsConfigured: z.boolean(),
    state: SiteWordpressStateDtoSchema.nullable(),
    runningOperation: SiteWordpressRunningOperationDtoSchema.nullable(),
    lastUpdate: SiteWordpressLastUpdateDtoSchema.nullable(),
  })
  .strict();
export type SiteWordpressDto = z.infer<typeof SiteWordpressDtoSchema>;

export const SiteWordpressAcceptedDtoSchema = z
  .object({ siteId: z.string().min(1), operationId: z.string().min(1) })
  .strict();
export type SiteWordpressAcceptedDto = z.infer<typeof SiteWordpressAcceptedDtoSchema>;

export const SiteWordpressPasswordResetDtoSchema = z
  .object({ temporaryPassword: z.string().regex(/^[A-Za-z0-9]{24,}$/) })
  .strict();
export type SiteWordpressPasswordResetDto = z.infer<typeof SiteWordpressPasswordResetDtoSchema>;
