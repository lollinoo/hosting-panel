import { z } from "zod";
import { AppTemplateIssueSchema } from "./issues.js";
import { APP_STACK_HASH_PATTERN, APP_TEMPLATE_CATEGORY_PATTERN, APP_TEMPLATE_LIMITS } from "./limits.js";
import { AppStackPreviewSchema } from "./plan.js";
import { AppTemplateAnyParameterSchema } from "./spec.js";
import { AppEntityIdSchema } from "./stack-ids.js";
import { APP_TEMPLATE_STATES, AppStackStatusSchema } from "./stack-status.js";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const noControl = (s: string): boolean => !/[\p{Cc}\p{Cs}]/u.test(s);

/** = the 0025 CHECK on app_templates.slug: 2..48 chars. */
export const APP_TEMPLATE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;
/** UTF-8 bytes ≤ 65 536 (= parser limit); TextEncoder keeps it browser-safe. */
export const AppTemplateSourceSchema = z
  .string()
  .min(1)
  .refine((s) => new TextEncoder().encode(s).length <= APP_TEMPLATE_LIMITS.sourceBytes, { message: "The template is larger than 64 KiB." });
const TemplateNameSchema = z.string().trim().min(1).max(APP_TEMPLATE_LIMITS.stackName).refine(noControl);
const TemplateDescriptionSchema = z.string().trim().max(APP_TEMPLATE_LIMITS.stackDescription).refine(noControl);
const TemplateCategorySchema = z.string().regex(APP_TEMPLATE_CATEGORY_PATTERN);
const QueryText = z.string().max(256);

// ---- inputs ----
export const ValidateAppTemplateInputSchema = z.object({ source: AppTemplateSourceSchema }).strict();
export type ValidateAppTemplateInput = z.infer<typeof ValidateAppTemplateInputSchema>;
/** name, description and category come from the source header (x-hp-stack); PATCH may change them later. */
export const CreateAppTemplateInputSchema = z
  .object({ slug: z.string().regex(APP_TEMPLATE_SLUG_PATTERN), source: AppTemplateSourceSchema })
  .strict();
export type CreateAppTemplateInput = z.infer<typeof CreateAppTemplateInputSchema>;
export const AddAppTemplateVersionInputSchema = z
  .object({ source: AppTemplateSourceSchema, makeDefault: z.boolean().default(false) })
  .strict();
export type AddAppTemplateVersionInput = z.infer<typeof AddAppTemplateVersionInputSchema>;
export const UpdateAppTemplateInputSchema = z
  .object({
    name: TemplateNameSchema.optional(),
    description: TemplateDescriptionSchema.nullable().optional(), // "" and null both store NULL
    category: TemplateCategorySchema.optional(),
    enabled: z.boolean().optional(),
    defaultVersionId: AppEntityIdSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), { message: "Nothing to update." });
export type UpdateAppTemplateInput = z.infer<typeof UpdateAppTemplateInputSchema>;
export const ArchiveAppTemplateInputSchema = z.object({}).strict();
/** Query of GET /v1/admin/app-templates; limit/cursor are then read by parsePaginationQuery. Unknown keys → 400. */
export const AdminAppTemplateListQuerySchema = z
  .object({
    state: z.enum(APP_TEMPLATE_STATES).optional(),
    category: TemplateCategorySchema.optional(),
    limit: QueryText.optional(),
    cursor: QueryText.optional(),
  })
  .strict();
export type AdminAppTemplateListQuery = z.infer<typeof AdminAppTemplateListQuerySchema>;

// ---- responses ----
export const AppTemplateValidationDtoSchema = z.object({
  valid: z.boolean(),
  issues: z.array(AppTemplateIssueSchema), // [] when valid; sorted, ≤ 50
  parameters: z.array(AppTemplateAnyParameterSchema), // all of spec.parameters (customer:false and secret too); [] when invalid
  preview: AppStackPreviewSchema.nullable(), // null when invalid
});
export type AppTemplateValidationDto = z.infer<typeof AppTemplateValidationDtoSchema>;

export const AdminAppTemplateSummaryDtoSchema = z.object({
  id: AppEntityIdSchema,
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  builtIn: z.boolean(),
  enabled: z.boolean(),
  archivedAt: IsoDateTimeSchema.nullable(),
  state: z.enum(APP_TEMPLATE_STATES),
  defaultVersionId: AppEntityIdSchema.nullable(),
  defaultVersionNumber: z.number().int().positive().nullable(),
  installations: z.number().int().nonnegative(), // non-deleted stacks on any version
  componentCount: z.number().int().nonnegative(), // of the default version (display figures)
  hasIngress: z.boolean(),
  hasVolumes: z.boolean(),
  updatedAt: IsoDateTimeSchema,
});
export type AdminAppTemplateSummaryDto = z.infer<typeof AdminAppTemplateSummaryDtoSchema>;
export const AdminAppTemplateVersionSummaryDtoSchema = z.object({
  id: AppEntityIdSchema,
  versionNumber: z.number().int().positive(),
  specHash: z.string().regex(APP_STACK_HASH_PATTERN),
  createdAt: IsoDateTimeSchema,
  installations: z.number().int().nonnegative(),
});
export const AdminAppTemplateDetailDtoSchema = AdminAppTemplateSummaryDtoSchema.extend({
  createdAt: IsoDateTimeSchema,
  versions: z.array(AdminAppTemplateVersionSummaryDtoSchema), // version_number DESC
});
export type AdminAppTemplateDetailDto = z.infer<typeof AdminAppTemplateDetailDtoSchema>;
export const AdminAppTemplateVersionCreatedDtoSchema = z.object({
  template: AdminAppTemplateDetailDtoSchema,
  versionId: AppEntityIdSchema,
  versionNumber: z.number().int().positive(),
  created: z.boolean(), // false: same source and spec hash as the latest, nothing stored
});
export type AdminAppTemplateVersionCreatedDto = z.infer<typeof AdminAppTemplateVersionCreatedDtoSchema>;
/** The stored source re-validated with today's validator: an old version may now be invalid. */
export const AdminAppTemplateVersionDtoSchema = z.object({
  id: AppEntityIdSchema,
  templateId: AppEntityIdSchema,
  versionNumber: z.number().int().positive(),
  specHash: z.string().regex(APP_STACK_HASH_PATTERN),
  createdAt: IsoDateTimeSchema,
  source: z.string(),
  valid: z.boolean(),
  issues: z.array(AppTemplateIssueSchema),
  parameters: z.array(AppTemplateAnyParameterSchema),
  preview: AppStackPreviewSchema.nullable(),
});
export type AdminAppTemplateVersionDto = z.infer<typeof AdminAppTemplateVersionDtoSchema>;
export const ADMIN_APP_TEMPLATE_USAGE_MAX = 200;
export const AdminAppTemplateUsageDtoSchema = z.object({
  templateId: AppEntityIdSchema,
  // ORDER BY organization name, stack name, id; ≤ ADMIN_APP_TEMPLATE_USAGE_MAX
  stacks: z.array(
    z.object({
      id: AppEntityIdSchema,
      name: z.string(),
      organizationId: z.string(),
      organizationName: z.string(),
      versionNumber: z.number().int().positive(),
      status: AppStackStatusSchema,
    }),
  ),
  truncated: z.boolean(), // more than ADMIN_APP_TEMPLATE_USAGE_MAX non-deleted stacks exist
});
export type AdminAppTemplateUsageDto = z.infer<typeof AdminAppTemplateUsageDtoSchema>;
export const ADMIN_APP_STACKS_MAX = 200;
/** The administrator's «Applicazioni» list: every customer's live application stacks, read-only. No secret, no parameter value, no plan. */
export const AdminAppStacksDtoSchema = z.object({
  // non-deleted stacks of every organization; ORDER BY organization name, stack name, id; ≤ ADMIN_APP_STACKS_MAX
  stacks: z.array(
    z.object({
      id: AppEntityIdSchema,
      name: z.string(),
      organizationName: z.string(),
      templateId: AppEntityIdSchema,
      templateName: z.string(),
      versionNumber: z.number().int().positive(),
      status: AppStackStatusSchema,
      primaryHostname: z.string().nullable(), // first active domain by hostname, else first domain, else null
    }),
  ),
  truncated: z.boolean(), // more than ADMIN_APP_STACKS_MAX live stacks exist
});
export type AdminAppStacksDto = z.infer<typeof AdminAppStacksDtoSchema>;
