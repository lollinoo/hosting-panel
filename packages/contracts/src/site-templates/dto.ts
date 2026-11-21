import { z } from "zod";
import { SiteTypeKeySchema } from "../site-types/keys.js";
import {
  PHP_VERSION_PARAMETER_KEY,
  SITE_TEMPLATE_PARAMETER_TYPES,
  SiteTemplateParameterValueSchema,
  type SiteTemplateSpec,
} from "./spec.js";
import { TEMPLATE_SOURCE_MAX_BYTES } from "./yaml-subset.js";

// Every collection a template admin or customer can name is an array of {key,value}-like items, never a
// keyed object: bffJsonResponse redacts keys such as "password" and "apiKey" anywhere in an answer.
// The create bodies take SiteTemplateParameterEntriesSchema from spec.ts.

const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const SiteTemplateIdSchema = z.string().regex(/^stpl_[a-z0-9_]{1,64}$/);
export const SiteTemplateVersionIdSchema = z.string().regex(/^stv_[a-z0-9_]{1,64}$/);
/** At most TEMPLATE_SOURCE_MAX_BYTES bytes (not characters); TextEncoder keeps it browser-safe. */
export const SiteTemplateSourceSchema = z
  .string()
  .min(1)
  .refine((source) => new TextEncoder().encode(source).length <= TEMPLATE_SOURCE_MAX_BYTES, "The template source is too large");

const NameSchema = z.string().trim().min(1).max(80);
const DescriptionSchema = z.string().trim().max(500);

// ---- Inputs ----

export const CreateSiteTemplateInputSchema = z
  .object({ module: SiteTypeKeySchema, name: NameSchema, description: DescriptionSchema.optional(), source: SiteTemplateSourceSchema })
  .strict();
export type CreateSiteTemplateInput = z.infer<typeof CreateSiteTemplateInputSchema>;

export const AddSiteTemplateVersionInputSchema = z
  .object({ source: SiteTemplateSourceSchema, makeDefault: z.boolean().default(true) })
  .strict();
export type AddSiteTemplateVersionInput = z.infer<typeof AddSiteTemplateVersionInputSchema>;

export const UpdateSiteTemplateInputSchema = z
  .object({
    name: NameSchema.optional(),
    description: DescriptionSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    defaultVersionId: SiteTemplateVersionIdSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), "Nothing to update");
export type UpdateSiteTemplateInput = z.infer<typeof UpdateSiteTemplateInputSchema>;

export const ValidateSiteTemplateInputSchema = z.object({ module: SiteTypeKeySchema, source: SiteTemplateSourceSchema }).strict();
export type ValidateSiteTemplateInput = z.infer<typeof ValidateSiteTemplateInputSchema>;

export const ChangeSiteTemplateVersionInputSchema = z.object({ versionId: SiteTemplateVersionIdSchema }).strict();
export type ChangeSiteTemplateVersionInput = z.infer<typeof ChangeSiteTemplateVersionInputSchema>;

// ---- Responses ----

export const SiteTemplateParameterDtoSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(SITE_TEMPLATE_PARAMETER_TYPES),
  options: z.array(z.string()).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  default: SiteTemplateParameterValueSchema.optional(),
  customer: z.boolean(),
});
export type SiteTemplateParameterDto = z.infer<typeof SiteTemplateParameterDtoSchema>;

/** What a customer sees of a parameter: every one is theirs to set, so there is no `customer` flag. */
export const CustomerSiteTypeParameterDtoSchema = SiteTemplateParameterDtoSchema.omit({ customer: true });
export type CustomerSiteTypeParameterDto = z.infer<typeof CustomerSiteTypeParameterDtoSchema>;

export const SiteTemplateModuleDtoSchema = z.object({ key: SiteTypeKeySchema, phpVersions: z.array(z.string()) });
export type SiteTemplateModuleDto = z.infer<typeof SiteTemplateModuleDtoSchema>;

export const AdminSiteTemplateSummaryDtoSchema = z.object({
  id: SiteTemplateIdSchema,
  module: SiteTypeKeySchema,
  name: z.string(),
  description: z.string().nullable(),
  builtIn: z.boolean(),
  enabled: z.boolean(),
  archivedAt: IsoDateTimeSchema.nullable(),
  defaultVersionId: SiteTemplateVersionIdSchema,
  defaultVersionNumber: z.number().int(),
  versionCount: z.number().int(),
  siteCount: z.number().int(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type AdminSiteTemplateSummaryDto = z.infer<typeof AdminSiteTemplateSummaryDtoSchema>;

/** Newest first, without the source (one version at a time carries it). */
export const AdminSiteTemplateVersionSummaryDtoSchema = z.object({
  id: SiteTemplateVersionIdSchema,
  versionNumber: z.number().int(),
  createdAt: IsoDateTimeSchema,
  siteCount: z.number().int(),
  isDefault: z.boolean(),
});
export type AdminSiteTemplateVersionSummaryDto = z.infer<typeof AdminSiteTemplateVersionSummaryDtoSchema>;

export const AdminSiteTemplateDetailDtoSchema = AdminSiteTemplateSummaryDtoSchema.extend({
  versions: z.array(AdminSiteTemplateVersionSummaryDtoSchema),
});
export type AdminSiteTemplateDetailDto = z.infer<typeof AdminSiteTemplateDetailDtoSchema>;

export const AdminSiteTemplatesListDtoSchema = z.object({
  templates: z.array(AdminSiteTemplateSummaryDtoSchema),
  modules: z.array(SiteTemplateModuleDtoSchema),
});
export type AdminSiteTemplatesListDto = z.infer<typeof AdminSiteTemplatesListDtoSchema>;

export const AdminSiteTemplateVersionDtoSchema = z.object({
  id: SiteTemplateVersionIdSchema,
  templateId: SiteTemplateIdSchema,
  versionNumber: z.number().int(),
  createdAt: IsoDateTimeSchema,
  source: z.string(),
});
export type AdminSiteTemplateVersionDto = z.infer<typeof AdminSiteTemplateVersionDtoSchema>;

/** `created: false` means the source is identical to the latest version and no version was added. */
export const AdminSiteTemplateVersionCreatedDtoSchema = AdminSiteTemplateVersionDtoSchema.extend({
  isDefault: z.boolean(),
  created: z.boolean(),
});
export type AdminSiteTemplateVersionCreatedDto = z.infer<typeof AdminSiteTemplateVersionCreatedDtoSchema>;

/** `line`, `column` and `path` are null for a problem that has no position in the source. */
export const SiteTemplateIssueDtoSchema = z.object({
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  path: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export type SiteTemplateIssueDto = z.infer<typeof SiteTemplateIssueDtoSchema>;

/** The rendered service as arrays only: an environment variable called PASSWORD must not redact the answer. */
export const SiteTemplatePreviewDtoSchema = z.object({
  module: SiteTypeKeySchema,
  image: z.string(),
  internalPort: z.number().int(),
  exposeHttp: z.boolean(),
  limits: z.object({ cpuMilli: z.number().int(), memoryBytes: z.string() }),
  environment: z.array(z.object({ name: z.string(), value: z.string() })),
  volumes: z.array(z.object({ volume: z.string(), containerPath: z.string() })),
  phpSettings: z.array(z.object({ key: z.string(), value: z.string() })),
  parameters: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(SITE_TEMPLATE_PARAMETER_TYPES),
      customer: z.boolean(),
      value: SiteTemplateParameterValueSchema,
    }),
  ),
});
export type SiteTemplatePreviewDto = z.infer<typeof SiteTemplatePreviewDtoSchema>;

export const SiteTemplateValidationDtoSchema = z.object({
  valid: z.boolean(),
  errors: z.array(SiteTemplateIssueDtoSchema),
  parameters: z.array(SiteTemplateParameterDtoSchema),
  preview: SiteTemplatePreviewDtoSchema.nullable(),
});
export type SiteTemplateValidationDto = z.infer<typeof SiteTemplateValidationDtoSchema>;

export const CustomerSiteTypeDtoSchema = z.object({
  id: SiteTemplateIdSchema,
  name: z.string(),
  description: z.string().nullable(),
  module: SiteTypeKeySchema,
  phpVersions: z.array(z.string()),
  defaultPhpVersion: z.string().nullable(),
  parameters: z.array(CustomerSiteTypeParameterDtoSchema),
});
export type CustomerSiteTypeDto = z.infer<typeof CustomerSiteTypeDtoSchema>;

/** Built-in first, then by name. */
export const CustomerSiteTypesDtoSchema = z.object({ siteTypes: z.array(CustomerSiteTypeDtoSchema) });
export type CustomerSiteTypesDto = z.infer<typeof CustomerSiteTypesDtoSchema>;

/** The template a site runs on, next to the newest version the administrator can move it to. */
export const AdminSiteTemplateRefDtoSchema = z.object({
  templateId: SiteTemplateIdSchema,
  templateName: z.string(),
  versionId: SiteTemplateVersionIdSchema,
  versionNumber: z.number().int(),
  defaultVersionId: SiteTemplateVersionIdSchema.nullable(),
  defaultVersionNumber: z.number().int().nullable(),
});
export type AdminSiteTemplateRefDto = z.infer<typeof AdminSiteTemplateRefDtoSchema>;

// ---- Mapping ----

export function toSiteTemplateParameterDtos(spec: SiteTemplateSpec): SiteTemplateParameterDto[] {
  return spec.parameters.map((parameter) => ({ ...parameter, ...(parameter.options ? { options: [...parameter.options] } : {}) }));
}

/**
 * The customer view of a template: its customer parameters without the `customer` flag, and the PHP
 * versions apart (`php_version` never travels as a parameter). The PHP choice is the parameter's options
 * when the customer may pick it, else only its default. No source, image, environment or limits.
 */
export function toCustomerSiteTypeDto(input: {
  id: string;
  name: string;
  description: string | null;
  spec: SiteTemplateSpec;
}): CustomerSiteTypeDto {
  const dtos = toSiteTemplateParameterDtos(input.spec);
  const php = dtos.find((parameter) => parameter.key === PHP_VERSION_PARAMETER_KEY);
  const defaultPhpVersion = typeof php?.default === "string" ? php.default : null;
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    module: input.spec.module,
    phpVersions: php?.customer ? (php.options ?? []) : defaultPhpVersion === null ? [] : [defaultPhpVersion],
    defaultPhpVersion,
    parameters: dtos
      .filter((parameter) => parameter.customer && parameter.key !== PHP_VERSION_PARAMETER_KEY)
      .map(({ customer: _customer, ...parameter }) => parameter),
  };
}
