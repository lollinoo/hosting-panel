import { z } from "zod";
import { SiteTypeKeySchema } from "../site-types/keys.js";

// A leaf module: it imports only zod and the site type keys, so site-runtime.ts can use
// SiteTemplateParameterEntriesSchema without an import cycle.

export const SITE_TEMPLATE_SPEC_VERSION = 1 as const;
export const SITE_TEMPLATE_PARAMETER_TYPES = ["enum", "integer", "string", "boolean", "size"] as const;
export type SiteTemplateParameterType = (typeof SITE_TEMPLATE_PARAMETER_TYPES)[number];
export const SITE_TEMPLATE_PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const SITE_TEMPLATE_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Same shape as a PHP size setting: 1 to 99999 followed by K, M or G. */
export const SITE_TEMPLATE_SIZE_PATTERN = /^[1-9][0-9]{0,4}[KMG]$/;
/** The executor's VOLUME_SUFFIX_PATTERN, repeated so this file stays a leaf (a test keeps both equal). */
export const SITE_TEMPLATE_VOLUME_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;
export const PHP_VERSION_PARAMETER_KEY = "php_version";
export const SITE_TEMPLATE_STRING_PARAMETER_MAX = 256;
export const SITE_TEMPLATE_ENV_VALUE_MAX = 4096;
export const SITE_TEMPLATE_LIMITS = { parameters: 32, options: 32, environment: 64, volumes: 8, expose: 8, php: 6 } as const;

export const SiteTemplateParameterValueSchema = z.union([
  z.string().max(SITE_TEMPLATE_STRING_PARAMETER_MAX),
  z.number().int(),
  z.boolean(),
]);
export type SiteTemplateParameterValue = z.infer<typeof SiteTemplateParameterValueSchema>;

function addDuplicateIssues(
  ctx: z.RefinementCtx,
  names: readonly string[],
  pathOf: (index: number) => (string | number)[],
  what: string,
): void {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) ctx.addIssue({ code: "custom", path: pathOf(index), message: `Duplicate ${what} '${name}'` });
    seen.add(name);
  });
}

/** Wire and stored entry. Arrays, never keyed objects (bffJsonResponse redacts keys such as "password"). */
export const SiteTemplateParameterEntrySchema = z
  .object({ key: z.string().regex(SITE_TEMPLATE_PARAMETER_KEY_PATTERN), value: SiteTemplateParameterValueSchema })
  .strict();
export type SiteTemplateParameterEntry = z.infer<typeof SiteTemplateParameterEntrySchema>;
export const SiteTemplateParameterEntriesSchema = z
  .array(SiteTemplateParameterEntrySchema)
  .max(SITE_TEMPLATE_LIMITS.parameters)
  .superRefine((entries, ctx) =>
    addDuplicateIssues(ctx, entries.map((entry) => entry.key), (index) => [index, "key"], "parameter"),
  );
/** What resolveSiteTemplateParameters returns: every declared parameter, own properties only. */
export type SiteTemplateParameterMap = Readonly<Record<string, SiteTemplateParameterValue>>;

export type SiteTemplateValueProblem = "invalid_type" | "not_in_options" | "out_of_range" | "too_long" | "invalid_characters";

/**
 * The one rule for a parameter value, used for defaults here and for given values in parameters.ts.
 * A string is at most 256 characters, has no control character and no "${" (it is never interpolated twice).
 */
export function siteTemplateValueProblem(
  parameter: Pick<SiteTemplateParameter, "type" | "options" | "min" | "max">,
  value: unknown,
): SiteTemplateValueProblem | null {
  switch (parameter.type) {
    case "enum":
      if (typeof value !== "string") return "invalid_type";
      return parameter.options?.includes(value) ? null : "not_in_options";
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return "invalid_type";
      return (parameter.min === undefined || value >= parameter.min) && (parameter.max === undefined || value <= parameter.max)
        ? null
        : "out_of_range";
    case "string":
      if (typeof value !== "string") return "invalid_type";
      if (value.length > SITE_TEMPLATE_STRING_PARAMETER_MAX) return "too_long";
      return /\p{Cc}/u.test(value) || value.includes("${") ? "invalid_characters" : null;
    case "boolean":
      return typeof value === "boolean" ? null : "invalid_type";
    case "size":
      return typeof value === "string" && SITE_TEMPLATE_SIZE_PATTERN.test(value) ? null : "invalid_type";
  }
}

export const SiteTemplateParameterSchema = z
  .object({
    key: z.string().regex(SITE_TEMPLATE_PARAMETER_KEY_PATTERN),
    label: z.string().min(1).max(80),
    type: z.enum(SITE_TEMPLATE_PARAMETER_TYPES),
    options: z.array(z.string().min(1).max(64)).min(1).max(SITE_TEMPLATE_LIMITS.options).optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
    default: SiteTemplateParameterValueSchema.optional(),
    customer: z.boolean(),
  })
  .strict()
  .superRefine((parameter, ctx) => {
    const refuse = (field: string, message: string) => ctx.addIssue({ code: "custom", path: [field], message });
    if (parameter.type === "enum") {
      if (!parameter.options) refuse("options", "An enum needs options");
      else if (new Set(parameter.options).size !== parameter.options.length) refuse("options", "Options must be unique");
    } else if (parameter.options) refuse("options", "Only an enum has options");
    if (parameter.type !== "integer") {
      if (parameter.min !== undefined) refuse("min", "Only an integer has a minimum");
      if (parameter.max !== undefined) refuse("max", "Only an integer has a maximum");
    } else if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) {
      refuse("min", "The minimum must not exceed the maximum");
    }
    if (parameter.default !== undefined && siteTemplateValueProblem(parameter, parameter.default) !== null) {
      refuse("default", `The default is not a valid ${parameter.type}`);
    }
  });
export type SiteTemplateParameter = z.infer<typeof SiteTemplateParameterSchema>;

const ServiceEnvironmentEntrySchema = z
  .object({ name: z.string().regex(SITE_TEMPLATE_ENV_NAME_PATTERN), value: z.string().max(SITE_TEMPLATE_ENV_VALUE_MAX) })
  .strict();

export const SiteTemplateSpecSchema = z
  .object({
    specVersion: z.literal(SITE_TEMPLATE_SPEC_VERSION),
    module: SiteTypeKeySchema,
    parameters: z.array(SiteTemplateParameterSchema).max(SITE_TEMPLATE_LIMITS.parameters),
    service: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        /** Raw: may hold ${parameter} references, or be exactly ${HP_MODULE_IMAGE}. */
        image: z.string().min(1).max(256),
        environment: z.array(ServiceEnvironmentEntrySchema).max(SITE_TEMPLATE_LIMITS.environment),
        volumes: z
          .array(
            z
              .object({ volume: z.string().regex(SITE_TEMPLATE_VOLUME_PATTERN), containerPath: z.string().min(2).max(512) })
              .strict(),
          )
          .max(SITE_TEMPLATE_LIMITS.volumes),
        expose: z.array(z.number().int().min(1).max(65535)).max(SITE_TEMPLATE_LIMITS.expose),
        limits: z
          .object({ cpuMilli: z.number().int().min(100).max(64000), memoryBytes: z.string().regex(/^[1-9][0-9]{0,14}$/) })
          .strict()
          .nullable(),
      })
      .strict(),
    php: z
      .array(z.object({ key: z.string().regex(/^[a-z][a-z_]{0,39}$/), value: z.string().min(1).max(32) }).strict())
      .min(1)
      .max(SITE_TEMPLATE_LIMITS.php)
      .nullable(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    addDuplicateIssues(ctx, spec.parameters.map((p) => p.key), (index) => ["parameters", index, "key"], "parameter");
    addDuplicateIssues(
      ctx,
      spec.service.environment.map((e) => e.name),
      (index) => ["service", "environment", index, "name"],
      "environment variable",
    );
  });
export type SiteTemplateSpec = z.infer<typeof SiteTemplateSpecSchema>;
