import {
  PHP_VERSION_PARAMETER_KEY,
  siteTemplateValueProblem,
  type SiteTemplateParameter,
  type SiteTemplateParameterEntry,
  type SiteTemplateParameterMap,
  type SiteTemplateParameterValue,
  type SiteTemplateSpec,
  type SiteTemplateValueProblem,
} from "./spec.js";

export type SiteTemplateAudience = "customer" | "admin";
export type SiteTemplateParameterReason =
  | SiteTemplateValueProblem
  | "unknown"
  | "reserved"
  | "duplicate"
  | "not_customer"
  | "required"
  | "not_applicable";
/** `field` is "parameters.<key>", or "phpVersion" for the PHP version sent next to the parameters. */
export interface SiteTemplateParameterIssue {
  field: string;
  reason: SiteTemplateParameterReason;
  message: string;
}
export type ResolveSiteTemplateParametersResult =
  | { ok: true; values: SiteTemplateParameterMap }
  | { ok: false; issues: SiteTemplateParameterIssue[] };

const MESSAGES: Record<SiteTemplateParameterReason, string> = {
  unknown: "This template has no such parameter",
  reserved: "The PHP version is not a parameter entry: send it as phpVersion",
  duplicate: "The parameter is given more than once",
  not_customer: "Only an administrator can set this parameter",
  required: "A value is required",
  not_applicable: "This template has no PHP version",
  invalid_type: "The value has the wrong type for this parameter",
  not_in_options: "The value is not one of the allowed options",
  out_of_range: "The value is outside the allowed range",
  too_long: "The value is too long",
  invalid_characters: "The value contains characters that are not allowed",
};

/**
 * Checks the given entries (and the PHP version) against the spec and fills the defaults.
 * Never throws: every issue is collected, entries first (in their order), then the declaration order.
 * `values` holds every declared parameter as an own property; read it with Object.hasOwn.
 */
export function resolveSiteTemplateParameters(
  spec: SiteTemplateSpec,
  entries: readonly SiteTemplateParameterEntry[],
  options: { audience: SiteTemplateAudience; phpVersion?: string | null },
): ResolveSiteTemplateParametersResult {
  const issues: SiteTemplateParameterIssue[] = [];
  const refuse = (field: string, reason: SiteTemplateParameterReason) => issues.push({ field, reason, message: MESSAGES[reason] });
  const declared = new Map(spec.parameters.map((parameter) => [parameter.key, parameter]));
  const given = new Map<string, SiteTemplateParameterValue>();
  const seen = new Set<string>();
  const phpVersion = options.phpVersion ?? undefined;

  for (const { key, value } of entries) {
    const field = `parameters.${key}`;
    const parameter = declared.get(key);
    if (key === PHP_VERSION_PARAMETER_KEY) refuse(field, "reserved");
    else if (!parameter) refuse(field, "unknown");
    else if (seen.has(key)) refuse(field, "duplicate");
    else {
      seen.add(key);
      const problem = options.audience === "customer" && !parameter.customer ? "not_customer" : siteTemplateValueProblem(parameter, value);
      if (problem) refuse(field, problem);
      else given.set(key, value);
    }
  }
  if (phpVersion !== undefined && !declared.has(PHP_VERSION_PARAMETER_KEY)) refuse("phpVersion", "not_applicable");

  const phpValue = (parameter: SiteTemplateParameter): SiteTemplateParameterValue | undefined => {
    if (phpVersion === undefined) {
      if (parameter.default === undefined) refuse("phpVersion", "required");
      return parameter.default;
    }
    // A customer may only repeat the default of a PHP version the administrator fixed.
    const problem =
      options.audience === "customer" && !parameter.customer && phpVersion !== parameter.default
        ? "not_customer"
        : siteTemplateValueProblem(parameter, phpVersion);
    if (problem) refuse("phpVersion", problem);
    return problem ? undefined : phpVersion;
  };

  const pairs: [string, SiteTemplateParameterValue][] = [];
  for (const parameter of spec.parameters) {
    const { key } = parameter;
    let value: SiteTemplateParameterValue | undefined;
    if (key === PHP_VERSION_PARAMETER_KEY) value = phpValue(parameter);
    else if (given.has(key)) value = given.get(key);
    else if (!seen.has(key)) {
      value = parameter.default;
      if (value === undefined) refuse(`parameters.${key}`, "required");
    }
    if (value !== undefined) pairs.push([key, value]);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, values: Object.fromEntries(pairs) };
}

/**
 * The values to store in sites.template_parameters: every declared parameter except php_version
 * (that one lives in sites.php_version), sorted by key; null when there is none.
 */
export function toStoredSiteTemplateParameters(
  spec: SiteTemplateSpec,
  values: SiteTemplateParameterMap,
): SiteTemplateParameterEntry[] | null {
  const stored: SiteTemplateParameterEntry[] = [];
  for (const { key } of spec.parameters) {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (key !== PHP_VERSION_PARAMETER_KEY && value !== undefined) stored.push({ key, value });
  }
  return stored.length > 0 ? stored.sort((a, b) => (a.key < b.key ? -1 : 1)) : null;
}

/** A value that is valid for the type, for a preview or for a parameter a newer version added without a default. */
function sampleValue(parameter: SiteTemplateParameter): SiteTemplateParameterValue {
  switch (parameter.type) {
    case "enum":
      return parameter.options?.[0] ?? "";
    case "integer":
      return parameter.min ?? Math.min(0, parameter.max ?? 0);
    case "string":
      return "sample";
    case "boolean":
      return false;
    case "size":
      return "1M";
  }
}

/**
 * Rebuilds the values of a site from sites.template_parameters and sites.php_version against a spec
 * (possibly a newer version than the one the values were stored for). Lenient, never throws: an unknown
 * key or an invalid value is dropped and the default (else a sample value) takes its place. A strict
 * answer for an upgrade needs resolveSiteTemplateParameters.
 */
export function restoreSiteTemplateParameterMap(
  spec: SiteTemplateSpec,
  stored: unknown,
  phpVersion: string | null,
): SiteTemplateParameterMap {
  const storedValues = new Map<string, unknown>();
  for (const item of Array.isArray(stored) ? stored : []) {
    if (typeof item === "object" && item !== null && "key" in item && "value" in item && typeof item.key === "string") {
      storedValues.set(item.key, item.value);
    }
  }
  return Object.fromEntries(
    spec.parameters.map((parameter): [string, SiteTemplateParameterValue] => {
      const candidate = parameter.key === PHP_VERSION_PARAMETER_KEY ? phpVersion : storedValues.get(parameter.key);
      return [
        parameter.key,
        siteTemplateValueProblem(parameter, candidate) === null
          ? (candidate as SiteTemplateParameterValue)
          : (parameter.default ?? sampleValue(parameter)),
      ];
    }),
  );
}

/** The default of every parameter, else a sample value: what the validate preview renders. */
export function sampleSiteTemplateParameterMap(spec: SiteTemplateSpec): SiteTemplateParameterMap {
  return Object.fromEntries(spec.parameters.map((parameter) => [parameter.key, parameter.default ?? sampleValue(parameter)]));
}
