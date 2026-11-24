import { z } from "zod";
import { YAML_ERROR_CODES } from "../site-templates/yaml-subset.js";
import { APP_TEMPLATE_LIMITS } from "./limits.js";

/** Spec §16 names verbatim + STACK_PARAMETER_INVALID for customer values. Used as details[].reason. */
export const APP_STACK_REASONS = [
  "STACK_TEMPLATE_INVALID",
  "STACK_TEMPLATE_UNPUBLISHED",
  "STACK_IMAGE_NOT_ALLOWED",
  "STACK_QUOTA_EXCEEDED",
  "STACK_DEPENDENCY_CYCLE",
  "STACK_HEALTH_TIMEOUT",
  "STACK_PORT_UNAVAILABLE",
  "STACK_SECRET_MISSING",
  "STACK_VOLUME_IN_USE",
  "STACK_UNSUPPORTED_FEATURE",
  "STACK_PARAMETER_INVALID",
] as const;
export type AppStackReason = (typeof APP_STACK_REASONS)[number];
export const AppStackReasonSchema = z.enum(APP_STACK_REASONS);

/** Source and structure codes of the validator. */
export const APP_TEMPLATE_VALIDATOR_ISSUE_CODES = [
  "DOCUMENT_NOT_MAPPING",
  "TYPE_MISMATCH",
  "KEY_UNKNOWN",
  "KEY_FORBIDDEN_SECURITY",
  "KEY_FORBIDDEN_NETWORK",
  "KEY_FORBIDDEN_HOST_ACCESS",
  "KEY_UNSUPPORTED",
  "HEADER_MISSING",
  "HEADER_VERSION_UNSUPPORTED",
  "HEADER_NAME_INVALID",
  "HEADER_CATEGORY_INVALID",
  "HEADER_DESCRIPTION_INVALID",
  "PARAM_TOO_MANY",
  "PARAM_SECRET_TOO_MANY",
  "PARAM_FIELD_MISSING",
  "PARAM_KEY_INVALID",
  "PARAM_KEY_DUPLICATE",
  "PARAM_TYPE_INVALID",
  "PARAM_TYPE_UNSUPPORTED",
  "PARAM_LABEL_INVALID",
  "PARAM_OPTIONS_INVALID",
  "PARAM_BOUNDS_INVALID",
  "PARAM_DEFAULT_MISSING",
  "PARAM_DEFAULT_INVALID",
  "PARAM_DEFAULT_NOT_ALLOWED",
  "PARAM_REQUIRED_INVALID",
  "PARAM_SECRET_NOT_CUSTOMER",
  "PARAM_GENERATE_INVALID",
  "SERVICES_MISSING",
  "SERVICES_TOO_MANY",
  "SERVICE_NAME_INVALID",
  "SERVICE_PROFILE_INVALID",
  "IMAGE_MISSING",
  "IMAGE_MALFORMED",
  "IMAGE_DIGEST_REQUIRED",
  "IMAGE_TAG_LATEST",
  "IMAGE_NOT_ALLOWLISTED",
  "ARGV_EMPTY",
  "ARGV_TOO_MANY",
  "ARGV_ITEM_NOT_STRING",
  "ARGV_ITEM_INVALID",
  "ARGV_SHELL_REFUSED",
  "ARGV_EXECUTABLE_PLACEHOLDER",
  "ARGV_PLACEHOLDER_NOT_WHOLE",
  "ENV_TOO_MANY",
  "ENV_ENTRY_INVALID",
  "ENV_NAME_INVALID",
  "ENV_NAME_DUPLICATE",
  "ENV_NAME_RESERVED",
  "ENV_NAME_SECRET_LIKE",
  "ENV_VALUE_NOT_STRING",
  "ENV_VALUE_INVALID",
  "ENV_VALUE_TOO_LONG",
  "ENV_VALUE_SECRET_LIKE",
  "ENV_VALUE_DOCKER_SOCKET",
  "ENV_VALUE_METADATA_ENDPOINT",
  "ENV_VALUE_PROCESS_MARK",
  "ENV_SECRET_NAME_INVALID",
  "ENV_SECRET_UNKNOWN",
  "ENV_SECRET_REFERENCES_TOO_MANY",
  "INTERP_SYNTAX",
  "INTERP_UNKNOWN_VARIABLE",
  "INTERP_SECRET_PARAMETER",
  "VOLUME_NAME_INVALID",
  "VOLUME_TOO_MANY",
  "VOLUME_OPTIONS_REFUSED",
  "VOLUME_UNUSED",
  "VOLUME_MOUNTS_TOO_MANY",
  "VOLUME_SYNTAX",
  "VOLUME_HOST_PATH",
  "VOLUME_DOCKER_SOCKET",
  "VOLUME_UNDECLARED",
  "VOLUME_TARGET_INVALID",
  "VOLUME_TARGET_RESERVED",
  "VOLUME_MODE_INVALID",
  "VOLUME_DUPLICATE",
  "EXPOSE_INVALID",
  "EXPOSE_DUPLICATE",
  "EXPOSE_TOO_MANY",
  "DEPENDS_ON_INVALID",
  "DEPENDS_ON_TOO_MANY",
  "DEPENDS_ON_DUPLICATE",
  "DEPENDS_ON_UNKNOWN",
  "DEPENDS_ON_SELF",
  "DEPENDENCY_CYCLE",
  "HEALTH_KIND_INVALID",
  "HEALTH_PORT_NOT_EXPOSED",
  "HEALTH_PATH_MISSING",
  "HEALTH_PATH_NOT_ALLOWED",
  "HEALTH_PATH_INVALID",
  "HEALTH_INTERVAL_INVALID",
  "HEALTH_TIMEOUT_INVALID",
  "LIMIT_MISSING",
  "LIMIT_CPU_FORMAT",
  "LIMIT_CPU_RANGE",
  "LIMIT_MEMORY_FORMAT",
  "LIMIT_MEMORY_RANGE",
  "INGRESS_TOO_MANY",
  "INGRESS_SERVICE_UNKNOWN",
  "INGRESS_PORT_NOT_EXPOSED",
  "INGRESS_PROTOCOL_UNSUPPORTED",
  "INGRESS_DUPLICATE",
  "INGRESS_HEALTHCHECK_MISSING",
  "SPEC_INTERNAL",
] as const;

/** Customer value and compile codes (path "parameters.<key>"). */
export const APP_TEMPLATE_VALUE_ISSUE_CODES = [
  "PARAM_VALUE_UNKNOWN",
  "PARAM_VALUE_DUPLICATE",
  "PARAM_VALUE_NOT_CUSTOMER",
  "PARAM_VALUE_SECRET",
  "PARAM_VALUE_INVALID_TYPE",
  "PARAM_VALUE_NOT_IN_OPTIONS",
  "PARAM_VALUE_OUT_OF_RANGE",
  "PARAM_VALUE_TOO_LONG",
  "PARAM_VALUE_INVALID_CHARACTERS",
  "PARAM_VALUE_FORBIDDEN_CONTENT",
  "PARAM_VALUE_ARGV_UNSAFE",
  "RENDERED_VALUE_FORBIDDEN",
  "SECRET_MISSING",
  "PLAN_TOO_LARGE",
] as const;

export const APP_TEMPLATE_ISSUE_CODES = [...YAML_ERROR_CODES, ...APP_TEMPLATE_VALIDATOR_ISSUE_CODES, ...APP_TEMPLATE_VALUE_ISSUE_CODES] as const;
export type AppTemplateIssueCode = (typeof APP_TEMPLATE_ISSUE_CODES)[number];

/** Every code not listed here maps to STACK_PARAMETER_INVALID when it is a value code, else STACK_TEMPLATE_INVALID. */
const OTHER_REASONS: Partial<Record<AppTemplateIssueCode, AppStackReason>> = {
  KEY_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
  HEADER_VERSION_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
  PARAM_TYPE_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
  INGRESS_PROTOCOL_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
  IMAGE_MISSING: "STACK_IMAGE_NOT_ALLOWED",
  IMAGE_MALFORMED: "STACK_IMAGE_NOT_ALLOWED",
  IMAGE_DIGEST_REQUIRED: "STACK_IMAGE_NOT_ALLOWED",
  IMAGE_TAG_LATEST: "STACK_IMAGE_NOT_ALLOWED",
  IMAGE_NOT_ALLOWLISTED: "STACK_IMAGE_NOT_ALLOWED",
  DEPENDS_ON_SELF: "STACK_DEPENDENCY_CYCLE",
  DEPENDENCY_CYCLE: "STACK_DEPENDENCY_CYCLE",
  SECRET_MISSING: "STACK_SECRET_MISSING",
  PLAN_TOO_LARGE: "STACK_TEMPLATE_INVALID",
};
const VALUE_CODES: readonly string[] = APP_TEMPLATE_VALUE_ISSUE_CODES;

/** Total and frozen: every code has exactly one reason. */
export const APP_TEMPLATE_ISSUE_REASON: Readonly<Record<AppTemplateIssueCode, AppStackReason>> = Object.freeze(
  Object.fromEntries(
    APP_TEMPLATE_ISSUE_CODES.map((code) => [
      code,
      OTHER_REASONS[code] ?? (VALUE_CODES.includes(code) ? "STACK_PARAMETER_INVALID" : "STACK_TEMPLATE_INVALID"),
    ]),
  ) as Record<AppTemplateIssueCode, AppStackReason>,
);

export const AppTemplateIssueSchema = z
  .object({
    /** formatTemplatePath(...) or "parameters.<key>"; "" = whole document. */
    path: z.string().max(512),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    code: z.enum(APP_TEMPLATE_ISSUE_CODES),
    reason: AppStackReasonSchema,
    /** Fixed English; never echoes a value; may echo a key name clipped to 64 chars. */
    message: z.string().min(1).max(300),
  })
  .strict();
export type AppTemplateIssue = z.infer<typeof AppTemplateIssueSchema>;

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Ascending; an absent position sorts last. */
const comparePositions = (a: number | undefined, b: number | undefined): number =>
  a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a - b;

/** Sort by line, column, path, code (absent positions last, code-unit order), dedupe on path + code + message, cut to 50. */
export function sortAppTemplateIssues(issues: readonly AppTemplateIssue[]): AppTemplateIssue[] {
  const sorted = [...issues].sort(
    (a, b) =>
      comparePositions(a.line, b.line) ||
      comparePositions(a.column, b.column) ||
      compareCodeUnits(a.path, b.path) ||
      compareCodeUnits(a.code, b.code),
  );
  const seen = new Set<string>();
  return sorted
    .filter((issue) => {
      const key = JSON.stringify([issue.path, issue.code, issue.message]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, APP_TEMPLATE_LIMITS.issues);
}
