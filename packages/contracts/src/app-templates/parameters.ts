import { z } from "zod";
import { siteTemplateValueProblem, type SiteTemplateValueProblem } from "../site-templates/spec.js";
import { APP_TEMPLATE_ISSUE_REASON, sortAppTemplateIssues, type AppTemplateIssue, type AppTemplateIssueCode } from "./issues.js";
import { APP_TEMPLATE_LIMITS, AppTemplateParameterKeySchema } from "./limits.js";
import type { AppTemplateParameter, AppTemplateSpec } from "./spec.js";
import { appStackTextProblem } from "./text.js";

export const AppTemplateParameterValueSchema = z.union([z.string().max(APP_TEMPLATE_LIMITS.stringValue), z.number().int(), z.boolean()]);
export type AppTemplateParameterValue = z.infer<typeof AppTemplateParameterValueSchema>;
export const AppTemplateParameterEntrySchema = z.object({ key: AppTemplateParameterKeySchema, value: AppTemplateParameterValueSchema }).strict();
export type AppTemplateParameterEntry = z.infer<typeof AppTemplateParameterEntrySchema>;
/** Wire and stored list: an array, never a keyed object (bffJsonResponse redacts keys such as "password"). */
export const AppTemplateParameterEntriesSchema = z
  .array(AppTemplateParameterEntrySchema)
  .max(APP_TEMPLATE_LIMITS.parameters)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach(({ key }, index) => {
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "Duplicate parameter" });
      seen.add(key);
    });
  });
/** Every non-secret parameter as an own property; read it with Object.hasOwn. */
export type AppTemplateParameterMap = Readonly<Record<string, AppTemplateParameterValue>>;

export type AppTemplateValueProblem =
  | "PARAM_VALUE_INVALID_TYPE"
  | "PARAM_VALUE_NOT_IN_OPTIONS"
  | "PARAM_VALUE_OUT_OF_RANGE"
  | "PARAM_VALUE_TOO_LONG"
  | "PARAM_VALUE_INVALID_CHARACTERS"
  | "PARAM_VALUE_FORBIDDEN_CONTENT"
  | "PARAM_VALUE_SECRET";

const SITE_PROBLEM_CODES: Record<SiteTemplateValueProblem, AppTemplateValueProblem> = {
  invalid_type: "PARAM_VALUE_INVALID_TYPE",
  not_in_options: "PARAM_VALUE_NOT_IN_OPTIONS",
  out_of_range: "PARAM_VALUE_OUT_OF_RANGE",
  too_long: "PARAM_VALUE_TOO_LONG",
  invalid_characters: "PARAM_VALUE_INVALID_CHARACTERS",
};

/** The one value rule: defaults in the validator, given values here. A secret has no inline value. */
export function appTemplateValueProblem(parameter: AppTemplateParameter, value: unknown): AppTemplateValueProblem | null {
  if (parameter.type === "secret") return "PARAM_VALUE_SECRET";
  const problem = siteTemplateValueProblem(parameter, value);
  if (problem !== null) return SITE_PROBLEM_CODES[problem];
  if (parameter.type === "integer" && Math.abs(value as number) > APP_TEMPLATE_LIMITS.integerBound) return "PARAM_VALUE_OUT_OF_RANGE";
  if (parameter.type === "string") {
    const textProblem = appStackTextProblem(value as string);
    if (textProblem === "control_character") return "PARAM_VALUE_INVALID_CHARACTERS";
    if (textProblem !== null) return "PARAM_VALUE_FORBIDDEN_CONTENT";
  }
  return null;
}

export type AppTemplateParameterResolution =
  | { readonly ok: true; readonly values: AppTemplateParameterMap }
  | { readonly ok: false; readonly issues: AppTemplateIssue[] };

/** Fixed texts: they never echo the value given. */
const MESSAGES = {
  PARAM_VALUE_UNKNOWN: "This template has no such parameter.",
  PARAM_VALUE_DUPLICATE: "The parameter is given more than once.",
  PARAM_VALUE_SECRET: "A secret parameter takes no inline value: set it on its own secret route.",
  PARAM_VALUE_NOT_CUSTOMER: "Only the template sets this parameter.",
  PARAM_VALUE_INVALID_TYPE: "The value has the wrong type for this parameter.",
  PARAM_VALUE_NOT_IN_OPTIONS: "The value is not one of the allowed options.",
  PARAM_VALUE_OUT_OF_RANGE: "The value is outside the allowed range.",
  PARAM_VALUE_TOO_LONG: "The value is too long.",
  PARAM_VALUE_INVALID_CHARACTERS: "The value contains characters that are not allowed.",
  PARAM_VALUE_FORBIDDEN_CONTENT: "The value contains content that is not allowed.",
} as const satisfies Partial<Record<AppTemplateIssueCode, string>>;

/**
 * Customer input only: a customer:false parameter always takes its default. Per entry, in the given order, the first
 * matching rule wins: unknown, duplicate, secret, not customer (even when equal to the default), value problem.
 * On success `values` = the defaults overridden by the given entries. Pure, never throws, does not mutate its inputs.
 */
export function resolveAppTemplateParameters(
  spec: AppTemplateSpec,
  entries: readonly AppTemplateParameterEntry[],
): AppTemplateParameterResolution {
  const issues: AppTemplateIssue[] = [];
  const declared = new Map(spec.parameters.map((parameter) => [parameter.key, parameter]));
  const given = new Map<string, AppTemplateParameterValue>();
  const seen = new Set<string>();

  for (const { key, value } of entries) {
    const parameter = declared.get(key);
    let code: keyof typeof MESSAGES | null;
    if (!parameter) code = "PARAM_VALUE_UNKNOWN";
    else if (seen.has(key)) code = "PARAM_VALUE_DUPLICATE";
    else if (parameter.type === "secret") code = "PARAM_VALUE_SECRET";
    else if (!parameter.customer) code = "PARAM_VALUE_NOT_CUSTOMER";
    else code = appTemplateValueProblem(parameter, value);
    seen.add(key);
    if (code === null) given.set(key, value);
    else issues.push({ path: `parameters.${key}`, code, reason: APP_TEMPLATE_ISSUE_REASON[code], message: MESSAGES[code] });
  }
  if (issues.length > 0) return { ok: false, issues: sortAppTemplateIssues(issues) };
  const values: [string, AppTemplateParameterValue][] = [];
  for (const parameter of spec.parameters) {
    if (parameter.type !== "secret") values.push([parameter.key, given.get(parameter.key) ?? parameter.default]);
  }
  return { ok: true, values: Object.fromEntries(values) };
}

/** Interpolation text of a resolved value: an integer in decimal, a boolean as "true" or "false". */
export function appTemplateValueText(value: AppTemplateParameterValue): string {
  return String(value);
}
