/**
 * Validator of an application template (`HCP-STACK/v1` and `HCP-STACK/v2`): turns the parsed document into the typed,
 * secret-free `AppTemplateSpec`, or into every problem found, each with a code, a reason, a path and, when a locator is
 * given, a line and column. Every key is checked against the key table of the declared version
 * (APP_TEMPLATE_KEY_LEVELS, APP_TEMPLATE_KEY_LEVELS_V2), so a Compose feature that could reach the host can never slip
 * in by being forgotten. A v1 source is held to exactly the v1 rules: it never gains a v2 key.
 * Pure, synchronous and never throws; a message never echoes a value.
 */
import {
  APP_IMAGE_ALLOWLIST,
  APP_SECRET_GENERATE_BOUNDS,
  APP_SECRET_GENERATE_KINDS,
  APP_STACK_COMPONENT_KEY_MAX,
  APP_STACK_ENV_NAME_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_STACK_PROCESS_MARKS,
  APP_STACK_RUN_PROFILES,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_ISSUE_REASON,
  APP_TEMPLATE_LIMITS as LIMITS,
  APP_TEMPLATE_OPTION_PATTERN,
  APP_TEMPLATE_PARAMETER_KEY_PATTERN,
  APP_TEMPLATE_PARAMETER_TYPES,
  APP_TEMPLATE_SPEC_VERSION,
  APP_TEMPLATE_SPEC_VERSION_2,
  AppTemplateSpecSchema,
  appStackArgvExecutableProblem,
  appStackArgvItemProblem,
  appStackContainerPathProblem,
  appStackHealthPathProblem,
  appStackImageRegistryProblem,
  appStackSecretEnvNameProblem,
  appStackTextProblem,
  appTemplateValueProblem,
  findAppImageAllowlistEntry,
  formatTemplatePath,
  parseTemplateYaml,
  sortAppTemplateIssues,
  type AppImageAllowlistEntry,
  type AppSecretGenerate,
  type AppSecretGenerateKind,
  type AppStackRunProfile,
  type AppTemplateIssue,
  type AppTemplateIssueCode,
  type AppTemplateParameter,
  type AppTemplateService,
  type AppTemplateSpec,
  type AppTemplateSpecVersion,
  type AppTemplateTask,
  type TemplateLocator,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { appTemplateKeyVerdict, type AppTemplateKeyLevelName, type AppTemplateRefusalCode } from "./app-template-keys.js";
import { orderAppTemplateServices } from "./app-template-graph.js";
import { parseImageReference } from "./image-reference.js";
import { envNameProblem, envValueProblem } from "./site-template-env.js";
import { scanInterpolation, type InterpolationPiece } from "./site-template-interpolation.js";

export interface AppTemplateValidationOptions {
  readonly allowlist?: readonly AppImageAllowlistEntry[];
  /**
   * true only where an administrator writes a source now (check, create, new version): it adds the rules a stored
   * version predates, such as a public registry (ADR-0036). A stored version is never judged with it, so an
   * application installed from one keeps deploying, starting and restarting.
   */
  readonly newVersion?: boolean;
}

export type AppTemplateValidationResult =
  | { readonly ok: true; readonly spec: AppTemplateSpec }
  /** sortAppTemplateIssues: sorted, at most 50. */
  | { readonly ok: false; readonly errors: AppTemplateIssue[] };

export const APP_TEMPLATE_CPU_PATTERN = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,3})?$/;
/** Binary units; a bare number is bytes. */
export const APP_TEMPLATE_MEMORY_PATTERN = /^([1-9][0-9]{0,11})([bB]|[kKmMgG][bB]?)?$/;

const REFUSAL_MESSAGES: Readonly<Record<AppTemplateRefusalCode | "KEY_UNKNOWN", string>> = {
  KEY_FORBIDDEN_SECURITY: "is not allowed: a template cannot change the container's security settings.",
  KEY_FORBIDDEN_NETWORK: "is not allowed: the platform controls networking and publishes the stack itself.",
  KEY_FORBIDDEN_HOST_ACCESS: "is not allowed: a template cannot reach host files, secrets, builds or platform labels.",
  KEY_UNSUPPORTED: "is not available in this version.",
  KEY_UNKNOWN: "is not a known key. Remove it.",
};

const CONTROL_CHARACTER = /\p{Cc}/u;
const LONE_SURROGATE = /\p{Cs}/u;
/** AppTemplateIssueSchema.path. */
const ISSUE_PATH_MAX = 512;
const HOST_PATH_SOURCE = /^[/.~]|\\|\.\./;
const WINDOWS_DRIVE = /^[A-Za-z]:\\/;
const PARAMETER_TYPES: readonly string[] = APP_TEMPLATE_PARAMETER_TYPES;

type Mapping = Readonly<Record<string, unknown>>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
/** Own property only: a document may carry keys such as `constructor` or `__proto__`. */
const own = (mapping: Mapping, key: string): unknown => (Object.hasOwn(mapping, key) ? mapping[key] : undefined);
/** `fallback` only when the key is absent: an explicit YAML null stays null. */
const ownOr = (mapping: Mapping, key: string, fallback: unknown): unknown => (Object.hasOwn(mapping, key) ? mapping[key] : fallback);
/** Never cuts a surrogate pair in two. */
const clip = (text: string, max = 64): string =>
  text.length > max ? `${text.slice(0, max - 3).replace(/[\ud800-\udbff]$/, "")}...` : text;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isText = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max && !CONTROL_CHARACTER.test(value);
const quoted = (path: TemplatePath): string => `'${clip(formatTemplatePath(path)) || "the document"}'`;

class Issues {
  readonly list: AppTemplateIssue[] = [];

  /** `version`: the format the document declares; it picks the key table and the rules. */
  constructor(
    private readonly locate: TemplateLocator | undefined,
    readonly version: AppTemplateSpecVersion = APP_TEMPLATE_SPEC_VERSION,
  ) {}

  add(code: AppTemplateIssueCode, path: TemplatePath, message: string, part: "key" | "value" = "value"): void {
    const formatted = clip(formatTemplatePath(path), ISSUE_PATH_MAX);
    const reason = APP_TEMPLATE_ISSUE_REASON[code];
    const at = this.locate?.(path, part) ?? null;
    this.list.push(
      at ? { path: formatted, line: at.line, column: at.column, code, reason, message } : { path: formatted, code, reason, message },
    );
  }

  mismatch(path: TemplatePath, expected: string): void {
    this.add("TYPE_MISMATCH", path, `${quoted(path)} must be ${expected}.`);
  }
}

/** Reports every key of `mapping` that is not allowed at `level`: a named refusal, else KEY_UNKNOWN. */
function checkKeys(issues: Issues, mapping: Mapping, path: TemplatePath, level: AppTemplateKeyLevelName): void {
  for (const key of Object.keys(mapping)) {
    const code = appTemplateKeyVerdict(level, key, issues.version);
    if (code !== null) issues.add(code, [...path, key], `'${clip(key)}' ${REFUSAL_MESSAGES[code]}`, "key");
  }
}

/** A list at `path` (absent = empty), else a type mismatch and null. */
function listAt(issues: Issues, raw: unknown, path: TemplatePath, expected = "a list"): readonly unknown[] | null {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  issues.mismatch(path, expected);
  return null;
}

interface ParameterInfo {
  readonly secret: boolean;
  /** Longest text the parameter can contribute to an environment value. */
  readonly maxLength: number;
}

interface Context {
  readonly issues: Issues;
  readonly version: AppTemplateSpecVersion;
  readonly allowlist: readonly AppImageAllowlistEntry[];
  readonly newVersion: boolean;
  readonly parameters: ReadonlyMap<string, ParameterInfo>;
  readonly volumes: ReadonlySet<string>;
  readonly mounted: Set<string>;
  readonly serviceKeys: readonly string[];
}

/** The format the document declares. Anything but 2 is checked as v1, and refused at the header when it is not 1. */
function declaredVersion(root: unknown): AppTemplateSpecVersion {
  const header = isMapping(root) ? own(root, "x-hp-stack") : undefined;
  return isMapping(header) && own(header, "schemaVersion") === APP_TEMPLATE_SPEC_VERSION_2 ? APP_TEMPLATE_SPEC_VERSION_2 : APP_TEMPLATE_SPEC_VERSION;
}

function validateHeader(issues: Issues, root: Mapping): Pick<AppTemplateSpec, "name" | "category" | "description"> | null {
  const path: TemplatePath = ["x-hp-stack"];
  const header = own(root, "x-hp-stack");
  if (header === undefined) {
    issues.add("HEADER_MISSING", [], "Add the 'x-hp-stack' header (schemaVersion, name, category).");
    return null;
  }
  if (!isMapping(header)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  checkKeys(issues, header, path, "header");
  const at = (key: string): TemplatePath => (own(header, key) === undefined ? path : [...path, key]);
  const version = own(header, "schemaVersion");
  const name = own(header, "name");
  const category = own(header, "category");
  const description = ownOr(header, "description", "");
  if (version !== APP_TEMPLATE_SPEC_VERSION && version !== APP_TEMPLATE_SPEC_VERSION_2) {
    issues.add(
      "HEADER_VERSION_UNSUPPORTED",
      at("schemaVersion"),
      `Set 'schemaVersion: ${APP_TEMPLATE_SPEC_VERSION}' or 'schemaVersion: ${APP_TEMPLATE_SPEC_VERSION_2}': no other version is supported.`,
    );
  }
  if (!isText(name, LIMITS.stackName, 1)) {
    issues.add("HEADER_NAME_INVALID", at("name"), `The name is 1 to ${LIMITS.stackName} characters of plain text.`);
  }
  if (typeof category !== "string" || !APP_TEMPLATE_CATEGORY_PATTERN.test(category)) {
    issues.add("HEADER_CATEGORY_INVALID", at("category"), "The category starts with a lower-case letter and uses lower-case letters, digits and '-' (at most 32).");
  }
  if (description === null) issues.mismatch(at("description"), "a string");
  else if (!isText(description, LIMITS.stackDescription)) {
    issues.add("HEADER_DESCRIPTION_INVALID", at("description"), `The description is at most ${LIMITS.stackDescription} characters of plain text.`);
  }
  return isText(name, LIMITS.stackName, 1) && typeof category === "string" && isText(description, LIMITS.stackDescription)
    ? { name, category, description }
    : null;
}

function maxLengthOf(parameter: AppTemplateParameter): number {
  switch (parameter.type) {
    case "enum": return Math.max(...parameter.options.map((option) => option.length));
    case "integer": return Math.max(String(parameter.min ?? -LIMITS.integerBound).length, String(parameter.max ?? LIMITS.integerBound).length);
    case "boolean": return 5;
    case "size": return 6;
    default: return LIMITS.stringValue;
  }
}

interface ParametersResult {
  readonly parameters: AppTemplateParameter[];
  readonly infos: ReadonlyMap<string, ParameterInfo>;
}

function validateParameters(issues: Issues, root: Mapping): ParametersResult {
  const path: TemplatePath = ["x-hp-parameters"];
  const parameters: AppTemplateParameter[] = [];
  const infos = new Map<string, ParameterInfo>();
  const raw = listAt(issues, own(root, "x-hp-parameters"), path) ?? [];
  if (raw.length > LIMITS.parameters) {
    issues.add("PARAM_TOO_MANY", path, `At most ${LIMITS.parameters} parameters are allowed; found ${raw.length}.`);
    for (const item of raw) {
      if (!isMapping(item)) continue;
      const key = own(item, "key");
      if (typeof key === "string" && !infos.has(key)) infos.set(key, { secret: own(item, "type") === "secret", maxLength: 0 });
    }
    return { parameters, infos };
  }
  raw.forEach((item, index) => {
    const parameter = validateParameter(issues, item, [...path, index], infos);
    if (parameter !== null) parameters.push(parameter);
  });
  const secrets = [...infos.values()].filter((info) => info.secret).length;
  if (secrets > LIMITS.secretParameters) {
    issues.add("PARAM_SECRET_TOO_MANY", path, `At most ${LIMITS.secretParameters} secret parameters are allowed; found ${secrets}.`);
  }
  return { parameters, infos };
}

/** v2: how the platform makes a secret nobody types. Null (with an issue) when it is not a valid rule. */
function validateGenerate(issues: Issues, raw: unknown, path: TemplatePath): AppSecretGenerate | null {
  const invalid = (at: TemplatePath, message: string): null => {
    issues.add("PARAM_GENERATE_INVALID", at, message);
    return null;
  };
  if (!isMapping(raw)) return invalid(path, "'generate' is a mapping with 'kind' and 'length'.");
  checkKeys(issues, raw, path, "generate");
  const kind = own(raw, "kind");
  const length = own(raw, "length");
  const kinds: readonly string[] = APP_SECRET_GENERATE_KINDS;
  if (typeof kind !== "string" || !kinds.includes(kind)) {
    return invalid(kind === undefined ? path : [...path, "kind"], `kind must be one of ${kinds.join(", ")}.`);
  }
  const bounds = APP_SECRET_GENERATE_BOUNDS[kind as AppSecretGenerateKind];
  if (!isSafeInt(length) || length < bounds.min || length > bounds.max) {
    return invalid(length === undefined ? path : [...path, "length"], `length is a whole number from ${bounds.min} to ${bounds.max} for kind '${kind}'.`);
  }
  return { kind: kind as AppSecretGenerateKind, length };
}

/** The typed parameter when the item has no issue; its key is declared either way (no cascade into the interpolation checks). */
function validateParameter(issues: Issues, item: unknown, path: TemplatePath, infos: Map<string, ParameterInfo>): AppTemplateParameter | null {
  const before = issues.list.length;
  if (!isMapping(item)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  checkKeys(issues, item, path, "parameter");
  const field = (key: string): unknown => own(item, key);
  const at = (key: string): TemplatePath => [...path, key];
  for (const key of ["key", "label", "type", "customer"]) {
    if (field(key) === undefined) issues.add("PARAM_FIELD_MISSING", path, `A parameter needs '${key}'.`);
  }

  const keyRaw = field("key");
  const key = typeof keyRaw === "string" ? keyRaw : null;
  if (keyRaw !== undefined && (key === null || !APP_TEMPLATE_PARAMETER_KEY_PATTERN.test(key) || key.startsWith("hp_"))) {
    issues.add(
      "PARAM_KEY_INVALID",
      at("key"),
      "A parameter key starts with a lower-case letter, uses lower-case letters, digits and '_' (at most 32) and does not start with 'hp_'.",
    );
  } else if (key !== null && infos.has(key)) {
    issues.add("PARAM_KEY_DUPLICATE", at("key"), `The parameter key '${clip(key)}' is used twice.`);
  }

  const label = field("label");
  if (label !== undefined && !isText(label, LIMITS.parameterLabel, 1)) {
    issues.add("PARAM_LABEL_INVALID", at("label"), `A label is 1 to ${LIMITS.parameterLabel} characters of plain text.`);
  }
  const typeRaw = field("type");
  const type = typeof typeRaw === "string" && PARAMETER_TYPES.includes(typeRaw) ? (typeRaw as AppTemplateParameter["type"]) : null;
  if (typeRaw === "port_choice") {
    issues.add("PARAM_TYPE_UNSUPPORTED", at("type"), "The 'port_choice' type is not available in this version.");
  } else if (typeRaw !== undefined && type === null) {
    issues.add("PARAM_TYPE_INVALID", at("type"), `type must be one of ${PARAMETER_TYPES.join(", ")}.`);
  }
  const customer = field("customer");
  if (customer !== undefined && typeof customer !== "boolean") issues.mismatch(at("customer"), "true or false");

  if (key !== null && !infos.has(key)) infos.set(key, { secret: typeRaw === "secret", maxLength: 0 });
  if (type === null) return null;

  const options = field("options");
  if (type === "enum") {
    if (!Array.isArray(options) || options.length < 1 || options.length > LIMITS.options) {
      issues.add("PARAM_OPTIONS_INVALID", options === undefined ? path : at("options"), `An enum has 1 to ${LIMITS.options} options.`);
    } else {
      options.forEach((option: unknown, index) => {
        if (typeof option !== "string" || !APP_TEMPLATE_OPTION_PATTERN.test(option)) {
          issues.add("PARAM_OPTIONS_INVALID", [...path, "options", index], "An option is 1 to 64 letters, digits, '.', '_' or '-'.");
        } else if (options.indexOf(option) !== index) {
          issues.add("PARAM_OPTIONS_INVALID", [...path, "options", index], "Options must be distinct.");
        }
      });
    }
  } else if (options !== undefined) {
    issues.add("PARAM_OPTIONS_INVALID", at("options"), "Only an enum parameter has options.");
  }

  const min = field("min");
  const max = field("max");
  for (const [name, bound] of [["min", min], ["max", max]] as const) {
    if (bound === undefined) continue;
    if (type !== "integer") issues.add("PARAM_BOUNDS_INVALID", at(name), "Only an integer parameter has min and max.");
    else if (!isSafeInt(bound) || Math.abs(bound) > LIMITS.integerBound) {
      issues.add("PARAM_BOUNDS_INVALID", at(name), `min and max are whole numbers between -${LIMITS.integerBound} and ${LIMITS.integerBound}.`);
    }
  }
  if (type === "integer" && isSafeInt(min) && isSafeInt(max) && min > max) {
    issues.add("PARAM_BOUNDS_INVALID", at("min"), "min must not exceed max.");
  }

  const value = field("default");
  const required = field("required");
  // In v1 the key 'generate' is already refused as unknown.
  const generateRaw = issues.version === APP_TEMPLATE_SPEC_VERSION_2 ? field("generate") : undefined;
  let generate: AppSecretGenerate | null = null;
  if (type === "secret") {
    if (value !== undefined) issues.add("PARAM_DEFAULT_NOT_ALLOWED", at("default"), "A secret parameter has no default: the customer sets it.");
    if (typeof required !== "boolean") {
      issues.add("PARAM_REQUIRED_INVALID", required === undefined ? path : at("required"), "A secret parameter needs 'required: true' or 'required: false'.");
    }
    if (generateRaw !== undefined) {
      generate = validateGenerate(issues, generateRaw, at("generate"));
      if (required === false) issues.add("PARAM_REQUIRED_INVALID", at("required"), "A generated secret is always set: write 'required: true'.");
    } else if (customer === false) {
      issues.add(
        "PARAM_SECRET_NOT_CUSTOMER",
        at("customer"),
        issues.version === APP_TEMPLATE_SPEC_VERSION_2
          ? "A secret parameter is 'customer: true' unless the platform generates it: add 'generate'."
          : "A secret parameter must be 'customer: true': only the customer can set it.",
      );
    }
  } else {
    if (generateRaw !== undefined) issues.add("PARAM_GENERATE_INVALID", at("generate"), "Only a secret parameter can be generated.");
    if (required !== undefined) issues.add("PARAM_REQUIRED_INVALID", at("required"), "Only a secret parameter has 'required'.");
    if (value === undefined) issues.add("PARAM_DEFAULT_MISSING", path, "Every parameter that is not a secret needs a default.");
  }
  if (key === null || typeof label !== "string" || typeof customer !== "boolean" || issues.list.length > before) return null;

  const head = { key, label, type };
  let parameter: AppTemplateParameter;
  switch (type) {
    case "secret":
      parameter =
        issues.version === APP_TEMPLATE_SPEC_VERSION_2
          ? { ...head, type, required: required as boolean, customer, generate }
          : { ...head, type, required: required as boolean, customer: true };
      break;
    case "enum":
      parameter = { ...head, type, options: [...(options as string[])], default: value as string, customer };
      break;
    case "integer":
      parameter = {
        ...head,
        type,
        ...(min !== undefined ? { min: min as number } : {}),
        ...(max !== undefined ? { max: max as number } : {}),
        default: value as number,
        customer,
      };
      break;
    default:
      parameter = { ...head, type, default: value, customer } as AppTemplateParameter;
  }
  if (parameter.type !== "secret" && appTemplateValueProblem(parameter, parameter.default) !== null) {
    issues.add("PARAM_DEFAULT_INVALID", at("default"), `The default is not a valid ${type} value for this parameter.`);
    return null;
  }
  const valueProblem = parameter.type === "string" ? envValueProblem(parameter.default) : null;
  if (valueProblem !== null) {
    issues.add(valueProblem, at("default"), VALUE_PROBLEM_MESSAGES[valueProblem]);
    return null;
  }
  infos.set(key, { secret: type === "secret", maxLength: maxLengthOf(parameter) });
  return parameter;
}

/** The names declared under the root `volumes`; any option on a volume is a disguised host bind. */
function validateDeclaredVolumes(issues: Issues, root: Mapping): string[] {
  const raw = own(root, "volumes");
  if (raw === undefined) return [];
  if (!isMapping(raw)) {
    issues.mismatch(["volumes"], "a mapping of volume names");
    return [];
  }
  const names = Object.keys(raw);
  if (names.length > LIMITS.volumes) issues.add("VOLUME_TOO_MANY", ["volumes"], `At most ${LIMITS.volumes} volumes are allowed; found ${names.length}.`);
  for (const name of names) {
    if (!APP_STACK_KEY_PATTERN.test(name)) {
      issues.add("VOLUME_NAME_INVALID", ["volumes", name], "A volume name uses lower-case letters, digits and '-' (at most 32, no '_').", "key");
    }
    const options = own(raw, name);
    if (options !== null && !(isMapping(options) && Object.keys(options).length === 0)) {
      issues.add("VOLUME_OPTIONS_REFUSED", ["volumes", name], "Volume options (driver, driver_opts, external, name, labels...) are refused: declare the volume as '{}'.");
    }
  }
  return names;
}

interface ServiceResult {
  readonly expose: readonly number[];
  readonly dependsOn: readonly string[];
  readonly hasHealthcheck: boolean;
  readonly service: AppTemplateService | null;
}

function validateService(ctx: Context, key: string, raw: unknown): ServiceResult | null {
  const { issues } = ctx;
  const path: TemplatePath = ["services", key];
  if (!APP_STACK_KEY_PATTERN.test(key) || key.length > APP_STACK_COMPONENT_KEY_MAX) {
    issues.add("SERVICE_NAME_INVALID", path, `A service name uses lower-case letters, digits and '-' (at most ${APP_STACK_COMPONENT_KEY_MAX}, no '_').`, "key");
  }
  if (!isMapping(raw)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  checkKeys(issues, raw, path, "service");
  const image = validateImage(ctx, own(raw, "image"), path);
  const command = validateCommand(ctx, own(raw, "command"), [...path, "command"]);
  const environment = validateEnvironment(ctx, own(raw, "environment"), [...path, "environment"]);
  const volumes = validateMounts(ctx, own(raw, "volumes"), [...path, "volumes"]);
  const expose = validateExpose(issues, own(raw, "expose"), [...path, "expose"]);
  const dependsOn = validateDependsOn(ctx, key, own(raw, "depends_on"), [...path, "depends_on"]);
  const healthcheck = validateHealthcheck(issues, own(raw, "healthcheck"), [...path, "healthcheck"], expose);
  const limits = validateLimits(issues, own(raw, "deploy"), path);
  const base = image && limits ? { key, image, command, environment, volumes, expose, dependsOn, healthcheck, limits } : null;
  let service: AppTemplateService | null = base;
  if (ctx.version === APP_TEMPLATE_SPEC_VERSION_2) {
    const profile = validateProfile(issues, own(raw, "x-hp-profile"), [...path, "x-hp-profile"]);
    service = base && profile ? { ...base, profile } : null;
  }
  return { expose, dependsOn, hasHealthcheck: own(raw, "healthcheck") !== undefined, service };
}

/** v2: the closed run profile of a service. Absent = "strict"; a template never names a capability or a user itself. */
function validateProfile(issues: Issues, raw: unknown, path: TemplatePath): AppStackRunProfile | null {
  if (raw === undefined) return "strict";
  const profile = APP_STACK_RUN_PROFILES.find((name) => name === raw);
  if (profile === undefined) {
    issues.add("SERVICE_PROFILE_INVALID", path, `x-hp-profile is one of ${APP_STACK_RUN_PROFILES.join(", ")}.`);
    return null;
  }
  return profile;
}

function validateImage(ctx: Context, raw: unknown, servicePath: TemplatePath): AppTemplateService["image"] | null {
  const { issues } = ctx;
  const path = [...servicePath, "image"];
  if (raw === undefined) {
    issues.add("IMAGE_MISSING", servicePath, "A service needs an image.");
    return null;
  }
  const parsed = typeof raw === "string" ? parseImageReference(raw) : null;
  if (!parsed?.ok) {
    issues.add("IMAGE_MALFORMED", path, "The image is not a valid reference ([registry/]repository[:tag]@sha256:<digest>, no variables).");
    return null;
  }
  const { registry, repository, tag, digest } = parsed.value;
  const name = registry === null ? repository : `${registry}/${repository}`;
  if (digest === null) issues.add("IMAGE_DIGEST_REQUIRED", path, "Pin the image by digest: add '@sha256:<64 hex digits>'.");
  if (tag === "latest") issues.add("IMAGE_TAG_LATEST", path, "The tag 'latest' is refused: write the version tag or none.");
  if (ctx.newVersion && appStackImageRegistryProblem(name) !== null) {
    issues.add(
      "IMAGE_REGISTRY_NOT_PUBLIC",
      path,
      "The registry of this image is this server, an IP address or a private network name: use an image of a public registry.",
    );
  }
  // v2 (ADR-0036): any repository, always pinned by digest; the allowlist only gives the user of the images it lists.
  if (ctx.version === APP_TEMPLATE_SPEC_VERSION && findAppImageAllowlistEntry(name, ctx.allowlist) === null) {
    issues.add("IMAGE_NOT_ALLOWLISTED", path, "This image repository is not on the platform's allowlist.");
  }
  return digest !== null && tag !== "latest" ? { name, tag, digest } : null;
}

/** Every `${NAME}` must be a declared parameter that is not a secret (v2: a secret is allowed in an environment value only). */
function checkVariable(ctx: Context, name: string, path: TemplatePath): ParameterInfo | null {
  const info = ctx.parameters.get(name);
  if (info === undefined) ctx.issues.add("INTERP_UNKNOWN_VARIABLE", path, "A '${...}' must name a parameter declared under 'x-hp-parameters'.");
  else if (info.secret) {
    ctx.issues.add(
      "INTERP_SECRET_PARAMETER",
      path,
      ctx.version === APP_TEMPLATE_SPEC_VERSION_2
        ? "A secret parameter cannot be interpolated here: only an environment value can carry it."
        : "A secret parameter cannot be interpolated: pass it as a file with an environment entry 'secret: <key>'.",
    );
  } else return info;
  return null;
}

/** "HP_TERMINAL_SESSION=, HP_TASK_RUN=": the marks a value may not hold, as a message names them. */
const PROCESS_MARKS_TEXT = APP_STACK_PROCESS_MARKS.map((mark) => `${mark}=`).join(", ");

/**
 * The command of a component, or of a task when `fixed`: a task takes no placeholder, and what comes back is then the
 * arguments as they are run (a "$$" already "$"), not the raw items.
 */
function validateCommand(ctx: Context, raw: unknown, path: TemplatePath, fixed = false): string[] | null {
  const { issues } = ctx;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    issues.mismatch(path, "a list of strings (there is no shell form)");
    return null;
  }
  if (raw.length === 0) {
    issues.add("ARGV_EMPTY", path, fixed ? "A task needs at least one command item." : "Remove 'command' to use the image's own, or give at least one item.");
  }
  const literals: string[] = [];
  if (raw.length > LIMITS.argvItems) issues.add("ARGV_TOO_MANY", path, `At most ${LIMITS.argvItems} command items are allowed.`);
  raw.forEach((item: unknown, index) => {
    const itemPath = [...path, index];
    if (typeof item !== "string") return issues.add("ARGV_ITEM_NOT_STRING", itemPath, "Every command item must be a string: quote it.");
    if (item === "" || item.length > LIMITS.argvItemLength || appStackTextProblem(item) !== null) {
      return issues.add("ARGV_ITEM_INVALID", itemPath, `A command item is 1 to ${LIMITS.argvItemLength} characters without control characters, the Docker socket, metadata endpoints, URL credentials or a platform mark (${PROCESS_MARKS_TEXT}).`);
    }
    const scan = scanInterpolation(item);
    if (!scan.ok) return issues.add(scan.code, itemPath, scan.message);
    const variables = scan.pieces.flatMap((piece) => ("variable" in piece ? [piece.variable] : []));
    if (fixed && variables.length > 0) {
      return issues.add("TASK_COMMAND_PLACEHOLDER", itemPath, "A task command takes no placeholder: the template fixes every argument (write '$$' for a dollar sign).");
    }
    if (variables.length > 0 && scan.pieces.length !== 1) {
      issues.add("ARGV_PLACEHOLDER_NOT_WHOLE", itemPath, "A placeholder must be a whole command item, alone: split the item.");
    }
    const literal = scan.pieces.map((piece) => ("literal" in piece ? piece.literal : "")).join("");
    literals.push(literal);
    if (index === 0) {
      if (variables.length > 0) issues.add("ARGV_EXECUTABLE_PLACEHOLDER", itemPath, "The executable (first item) cannot be a placeholder.");
      else {
        const problem = appStackArgvExecutableProblem(literal);
        if (problem === "shell") issues.add("ARGV_SHELL_REFUSED", itemPath, "A shell or a launcher (sh, bash, env, busybox...) cannot be the executable.");
        else if (problem === "empty") issues.add("ARGV_ITEM_INVALID", itemPath, "The executable must name a program, not a directory.");
      }
    } else if (variables.length === 0 && appStackArgvItemProblem(literal) !== null) {
      issues.add("ARGV_SHELL_REFUSED", itemPath, "A shell or a launcher (sh, bash, env, busybox...) cannot be a command item either.");
    }
    for (const variable of variables) checkVariable(ctx, variable, itemPath);
  });
  return fixed ? literals : raw.filter((item): item is string => typeof item === "string");
}

const NAME_PROBLEM_MESSAGES = {
  ENV_NAME_INVALID: "The name is not valid (upper-case letters, digits and '_', not starting with a digit, at most 64).",
  ENV_NAME_RESERVED: "The name is reserved by the platform (HP_, LD_, DOCKER_, *_FILE, PATH...).",
  ENV_NAME_SECRET_LIKE: "The name looks like a secret: declare a 'secret' parameter and use an entry 'secret: <key>' with a *_FILE name.",
} as const;

const VALUE_PROBLEM_MESSAGES = {
  ENV_VALUE_INVALID: "The value contains a control character or a line break.",
  ENV_VALUE_SECRET_LIKE: "The value looks like a secret or a credential: use a 'secret' parameter.",
  ENV_VALUE_DOCKER_SOCKET: "The value refers to the Docker socket, which is never available to a stack.",
} as const;

function validateEnvironment(ctx: Context, raw: unknown, path: TemplatePath): AppTemplateService["environment"] {
  const { issues } = ctx;
  const entries = listAt(issues, raw, path, "a list of {name, value} or {name, secret} entries") ?? [];
  if (entries.length > LIMITS.environment) issues.add("ENV_TOO_MANY", path, `At most ${LIMITS.environment} environment entries are allowed.`);
  const environment: AppTemplateService["environment"] = [];
  const names = new Set<string>();
  entries.forEach((entry: unknown, index) => {
    const entryPath = [...path, index];
    if (!isMapping(entry)) return issues.add("ENV_ENTRY_INVALID", entryPath, "An entry is a mapping with 'name' and either 'value' or 'secret'.");
    checkKeys(issues, entry, entryPath, "environmentEntry");
    const name = own(entry, "name");
    const value = own(entry, "value");
    const secret = own(entry, "secret");
    const namePath = [...entryPath, "name"];
    if ((value === undefined) === (secret === undefined)) {
      issues.add("ENV_ENTRY_INVALID", entryPath, "An entry has a 'name' and exactly one of 'value' or 'secret'.");
    }
    if (typeof name !== "string" || !APP_STACK_ENV_NAME_PATTERN.test(name)) {
      return issues.add("ENV_NAME_INVALID", name === undefined ? entryPath : namePath, NAME_PROBLEM_MESSAGES.ENV_NAME_INVALID);
    }
    if (names.has(name)) issues.add("ENV_NAME_DUPLICATE", namePath, "The variable is set twice.");
    names.add(name);
    if (value !== undefined && secret === undefined) {
      const typed = validateEnvValue(ctx, name, value, entryPath);
      if (typed !== null) environment.push({ name, value: typed });
    } else if (secret !== undefined && value === undefined) {
      if (ctx.version === APP_TEMPLATE_SPEC_VERSION_2 && !name.endsWith("_FILE")) {
        // v2: the secret itself is the variable's value. Its name may look like a secret; it is never a reserved one.
        if (secretEnvNameProblem(name) !== null) {
          issues.add("ENV_SECRET_NAME_INVALID", namePath, "A secret entry's name is not reserved by the platform (HP_, LD_, DOCKER_, PATH...).");
        }
      } else if (appStackSecretEnvNameProblem(name) !== null) {
        issues.add("ENV_SECRET_NAME_INVALID", namePath, "A secret entry's name ends in '_FILE' after a non-reserved name (it receives the file path).");
      }
      if (typeof secret !== "string" || ctx.parameters.get(secret)?.secret !== true) {
        issues.add("ENV_SECRET_UNKNOWN", [...entryPath, "secret"], "'secret' must name a parameter of type secret.");
      } else environment.push({ name, secretParameter: secret });
    }
  });
  return environment;
}

/** The name rule of an entry that carries a secret as its value (v2): never a reserved name; it may look like a secret. */
function secretEnvNameProblem(name: string): "ENV_NAME_INVALID" | "ENV_NAME_RESERVED" | null {
  const problem = name === "PORT" ? null : envNameProblem(name);
  return problem === "ENV_NAME_SECRET_LIKE" ? null : problem;
}

/**
 * The text around the secret references of a value, one string per stretch: literals, with the placeholders of the
 * other parameters left as written. A value without a secret reference is one stretch, the whole value.
 */
function textAroundSecrets(pieces: readonly InterpolationPiece[], isSecret: (variable: string) => boolean): string[] {
  const stretches = [""];
  for (const piece of pieces) {
    if ("variable" in piece && isSecret(piece.variable)) stretches.push("");
    else stretches[stretches.length - 1] += "literal" in piece ? piece.literal : `\${${piece.variable}}`;
  }
  return stretches;
}

function validateEnvValue(ctx: Context, name: string, value: unknown, entryPath: TemplatePath): string | null {
  const { issues } = ctx;
  const namePath = [...entryPath, "name"];
  const path = [...entryPath, "value"];
  const scan = typeof value === "string" ? scanInterpolation(value) : null;
  const isSecret = (variable: string): boolean => ctx.parameters.get(variable)?.secret === true;
  // v2 (ADR-0036 §2.5): a value that names a secret parameter is an environment secret, held to its own rules.
  const secretReferences =
    ctx.version === APP_TEMPLATE_SPEC_VERSION_2 && scan?.ok === true
      ? scan.pieces.filter((piece) => "variable" in piece && isSecret(piece.variable)).length
      : 0;
  const nameProblem = secretReferences > 0 ? secretEnvNameProblem(name) : name === "PORT" ? null : envNameProblem(name);
  if (nameProblem !== null) issues.add(nameProblem, namePath, NAME_PROBLEM_MESSAGES[nameProblem]);
  if (typeof value !== "string" || scan === null) {
    issues.add("ENV_VALUE_NOT_STRING", path, "The value must be a string: quote it.");
    return null;
  }
  const tooLong = (): void => issues.add("ENV_VALUE_TOO_LONG", path, `The value could exceed ${LIMITS.envValueLength} characters once filled in.`);
  if (value.length > LIMITS.envValueLength) tooLong();
  // Without a secret reference the whole value is checked as written; with one, each stretch of text around them is.
  const checked = secretReferences > 0 && scan.ok ? textAroundSecrets(scan.pieces, isSecret) : [value];
  const valueProblem = checked.map((text) => envValueProblem(text)).find((problem) => problem !== null) ?? null;
  const textProblems = valueProblem === null ? checked.map((text) => appStackTextProblem(text)) : [];
  if (valueProblem !== null) issues.add(valueProblem, path, VALUE_PROBLEM_MESSAGES[valueProblem]);
  else if (textProblems.includes("metadata_endpoint")) {
    issues.add("ENV_VALUE_METADATA_ENDPOINT", path, "The value names a cloud metadata endpoint, which is never reachable from a stack.");
  } else if (textProblems.includes("process_mark")) {
    issues.add("ENV_VALUE_PROCESS_MARK", path, `The value holds a mark the platform sets on its own programs (${PROCESS_MARKS_TEXT}).`);
  }
  if (!scan.ok) {
    issues.add(scan.code, path, scan.message);
    return value;
  }
  if (secretReferences > APP_STACK_SECRET_ENV_LIMITS.referencesPerValue) {
    issues.add(
      "ENV_SECRET_REFERENCES_TOO_MANY",
      path,
      `A value can name at most ${APP_STACK_SECRET_ENV_LIMITS.referencesPerValue} secret parameters.`,
    );
  }
  let worstCase = 0;
  for (const piece of scan.pieces) {
    if ("literal" in piece) worstCase += piece.literal.length;
    // A secret counts as nothing here: its own size is bounded where it is set.
    else if (secretReferences === 0 || !isSecret(piece.variable)) worstCase += checkVariable(ctx, piece.variable, path)?.maxLength ?? 0;
  }
  if (worstCase > LIMITS.envValueLength) tooLong();
  return value;
}

function validateMounts(ctx: Context, raw: unknown, path: TemplatePath): AppTemplateService["volumes"] {
  const { issues } = ctx;
  const items = listAt(issues, raw, path) ?? [];
  if (items.length > LIMITS.mountsPerService) issues.add("VOLUME_MOUNTS_TOO_MANY", path, `At most ${LIMITS.mountsPerService} volume mounts are allowed per service.`);
  const mounts: AppTemplateService["volumes"] = [];
  const targets = new Set<string>();
  items.forEach((item: unknown, index) => {
    const itemPath = [...path, index];
    const syntax = (): void => issues.add("VOLUME_SYNTAX", itemPath, "Write a mount as 'volume:/path' or 'volume:/path:ro' (lower-case volume name; no long syntax).");
    if (typeof item !== "string") return syntax();
    if (/docker\.sock/i.test(item)) return issues.add("VOLUME_DOCKER_SOCKET", itemPath, "The Docker socket can never be mounted.");
    const parts = item.split(":");
    if (parts.length !== 2 && parts.length !== 3) return syntax();
    const [source = "", target = "", mode] = parts;
    if (HOST_PATH_SOURCE.test(source) || WINDOWS_DRIVE.test(item)) {
      return issues.add("VOLUME_HOST_PATH", itemPath, "Bind mounts and host paths are refused: use a named volume declared under 'volumes'.");
    }
    if (!APP_STACK_KEY_PATTERN.test(source)) return syntax();
    const before = issues.list.length;
    if (!ctx.volumes.has(source)) issues.add("VOLUME_UNDECLARED", itemPath, "Declare the volume under the root 'volumes'.");
    else ctx.mounted.add(source);
    const targetProblem = appStackContainerPathProblem(target);
    if (targetProblem === "invalid") {
      issues.add("VOLUME_TARGET_INVALID", itemPath, "The target is an absolute container path outside the system directories, without '//', '.', '..' or a trailing '/'.");
    } else if (targetProblem === "reserved") {
      issues.add("VOLUME_TARGET_RESERVED", itemPath, "The target is reserved by the platform (/run, /tmp).");
    }
    if (mode !== undefined && mode !== "ro" && mode !== "rw") issues.add("VOLUME_MODE_INVALID", itemPath, "The mode is 'ro' or 'rw'.");
    if (targets.has(target)) issues.add("VOLUME_DUPLICATE", itemPath, "A container path can be mounted once per service.");
    targets.add(target);
    if (issues.list.length === before) mounts.push({ volumeKey: source, containerPath: target, readOnly: mode === "ro" });
  });
  return mounts;
}

function validateExpose(issues: Issues, raw: unknown, path: TemplatePath): number[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    issues.add("EXPOSE_INVALID", path, "expose is a list of port numbers.");
    return [];
  }
  const ports: number[] = [];
  (raw ?? []).forEach((port: unknown, index: number) => {
    if (!isSafeInt(port) || port < 1 || port > 65_535) issues.add("EXPOSE_INVALID", [...path, index], "A port is a number from 1 to 65535.");
    else if (ports.includes(port)) issues.add("EXPOSE_DUPLICATE", [...path, index], "The port is exposed twice.");
    else ports.push(port);
  });
  return ports;
}

function validateDependsOn(ctx: Context, self: string, raw: unknown, path: TemplatePath): string[] {
  const { issues } = ctx;
  if (raw !== undefined && !Array.isArray(raw)) {
    issues.add("DEPENDS_ON_INVALID", path, "depends_on is a list of service names.");
    return [];
  }
  const items: readonly unknown[] = raw ?? [];
  if (items.length > LIMITS.dependsOn) issues.add("DEPENDS_ON_TOO_MANY", path, `At most ${LIMITS.dependsOn} dependencies are allowed.`);
  const dependsOn: string[] = [];
  items.forEach((item, index) => {
    const itemPath = [...path, index];
    if (typeof item !== "string") issues.add("DEPENDS_ON_INVALID", itemPath, "A dependency is a service name.");
    else if (dependsOn.includes(item)) issues.add("DEPENDS_ON_DUPLICATE", itemPath, "The dependency is listed twice.");
    else {
      if (item === self) issues.add("DEPENDS_ON_SELF", itemPath, "A service cannot depend on itself.");
      else if (!ctx.serviceKeys.includes(item)) issues.add("DEPENDS_ON_UNKNOWN", itemPath, "The dependency names no service of this template.");
      dependsOn.push(item);
    }
  });
  return dependsOn;
}

function validateHealthcheck(issues: Issues, raw: unknown, path: TemplatePath, expose: readonly number[]): AppTemplateService["healthcheck"] {
  if (raw === undefined) return null;
  if (!isMapping(raw)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  checkKeys(issues, raw, path, "healthcheck");
  const at = (key: string): TemplatePath => (own(raw, key) === undefined ? path : [...path, key]);
  const kind = own(raw, "kind");
  const port = own(raw, "port");
  const probePath = own(raw, "path");
  const interval = ownOr(raw, "intervalSeconds", LIMITS.healthIntervalDefault);
  const timeout = ownOr(raw, "timeoutSeconds", LIMITS.healthTimeoutDefault);
  const before = issues.list.length;
  if (kind !== "tcp" && kind !== "http") issues.add("HEALTH_KIND_INVALID", at("kind"), "kind is 'tcp' or 'http'.");
  if (!isSafeInt(port) || !expose.includes(port)) issues.add("HEALTH_PORT_NOT_EXPOSED", at("port"), "port must be one of the service's exposed ports.");
  if (kind === "http" && probePath === undefined) issues.add("HEALTH_PATH_MISSING", path, "An http health check needs a path such as '/health'.");
  if (kind === "http" && probePath !== undefined && (typeof probePath !== "string" || appStackHealthPathProblem(probePath) !== null)) {
    issues.add("HEALTH_PATH_INVALID", at("path"), "The path starts with '/' and uses letters, digits, '.', '_', '~', '-' and '/' (no '//', '.' or '..' segment).");
  }
  if (kind === "tcp" && probePath !== undefined) issues.add("HEALTH_PATH_NOT_ALLOWED", at("path"), "A tcp health check has no path.");
  const intervalOk = isSafeInt(interval) && interval >= LIMITS.healthIntervalMin && interval <= LIMITS.healthIntervalMax;
  if (interval === null) issues.mismatch(at("intervalSeconds"), "a whole number of seconds");
  else if (!intervalOk) {
    issues.add("HEALTH_INTERVAL_INVALID", at("intervalSeconds"), `intervalSeconds is a whole number from ${LIMITS.healthIntervalMin} to ${LIMITS.healthIntervalMax}.`);
  }
  if (timeout === null) issues.mismatch(at("timeoutSeconds"), "a whole number of seconds");
  else if (!isSafeInt(timeout) || timeout < LIMITS.healthTimeoutMin || timeout > LIMITS.healthTimeoutMax || (intervalOk && timeout > interval)) {
    issues.add(
      "HEALTH_TIMEOUT_INVALID",
      at("timeoutSeconds"),
      `timeoutSeconds is a whole number from ${LIMITS.healthTimeoutMin} to ${LIMITS.healthTimeoutMax}, not above intervalSeconds.`,
    );
  }
  if (issues.list.length > before) return null;
  const timing = { intervalSeconds: interval as number, timeoutSeconds: timeout as number };
  return kind === "http"
    ? { kind, port: port as number, path: probePath as string, ...timing }
    : { kind: "tcp", port: port as number, ...timing };
}

function validateLimits(issues: Issues, deploy: unknown, servicePath: TemplatePath): AppTemplateService["limits"] | null {
  const missing = (path: TemplatePath): null => {
    issues.add("LIMIT_MISSING", path, "Set deploy.resources.limits.cpus and deploy.resources.limits.memory.");
    return null;
  };
  const levels = ["deploy", "resources", "limits"] as const;
  let node = deploy;
  let path = servicePath;
  let limits: Mapping = {};
  for (const [index, level] of levels.entries()) {
    if (node === undefined) return missing(path);
    path = [...path, level];
    if (!isMapping(node)) {
      issues.mismatch(path, "a mapping");
      return null;
    }
    checkKeys(issues, node, path, level);
    limits = node;
    node = own(node, levels[index + 1] ?? "");
  }
  const cpus = own(limits, "cpus");
  const memory = own(limits, "memory");
  if (cpus === undefined || memory === undefined) return missing(path);
  const cpuMilli = parseCpus(issues, cpus, [...path, "cpus"]);
  const memoryBytes = parseMemory(issues, memory, [...path, "memory"]);
  return cpuMilli !== null && memoryBytes !== null ? { cpuMilli, memoryBytes: memoryBytes.toString() } : null;
}

/** Integer arithmetic only: "0.1" -> 100, "1.5" -> 1500. */
function parseCpus(issues: Issues, raw: unknown, path: TemplatePath): number | null {
  if (typeof raw !== "string" && !isSafeInt(raw)) {
    issues.mismatch(path, "a quoted decimal such as \"0.5\" or a whole number");
    return null;
  }
  const match = APP_TEMPLATE_CPU_PATTERN.exec(String(raw));
  if (!match) {
    issues.add("LIMIT_CPU_FORMAT", path, "cpus is a decimal number of at most 3 decimals, such as \"0.5\".");
    return null;
  }
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? "").slice(1).padEnd(3, "0"));
  if (milli < LIMITS.cpuMilliMin || milli > LIMITS.cpuMilliMax) {
    issues.add("LIMIT_CPU_RANGE", path, `cpus must be between ${LIMITS.cpuMilliMin / 1000} and ${LIMITS.cpuMilliMax / 1000}.`);
    return null;
  }
  return milli;
}

/** "512M" -> 536870912n; a bare integer is bytes; binary units. */
function parseMemory(issues: Issues, raw: unknown, path: TemplatePath): bigint | null {
  if (typeof raw !== "string" && !isSafeInt(raw)) {
    issues.mismatch(path, "a string such as \"512M\" or a whole number of bytes");
    return null;
  }
  const match = APP_TEMPLATE_MEMORY_PATTERN.exec(String(raw));
  if (!match) {
    issues.add("LIMIT_MEMORY_FORMAT", path, "memory is a whole number of bytes or a size such as 512M or 1G.");
    return null;
  }
  const bytes = BigInt(match[1] ?? "0") * 1024n ** BigInt("bkmg".indexOf((match[2] ?? "b").charAt(0).toLowerCase()));
  if (bytes < BigInt(LIMITS.memoryBytesMin) || bytes > BigInt(LIMITS.memoryBytesMax)) {
    issues.add("LIMIT_MEMORY_RANGE", path, "memory must be between 32M and 16G.");
    return null;
  }
  return bytes;
}

function validateIngress(issues: Issues, root: Mapping, services: ReadonlyMap<string, ServiceResult>): AppTemplateSpec["ingress"] {
  const path: TemplatePath = ["x-hp-ingress"];
  const items = listAt(issues, own(root, "x-hp-ingress"), path) ?? [];
  if (items.length > LIMITS.ingress) issues.add("INGRESS_TOO_MANY", path, `At most ${LIMITS.ingress} ingress routes are allowed.`);
  const ingress: AppTemplateSpec["ingress"] = [];
  const seen = new Set<string>();
  items.forEach((item: unknown, index) => {
    const itemPath = [...path, index];
    if (!isMapping(item)) return issues.mismatch(itemPath, "a mapping");
    checkKeys(issues, item, itemPath, "ingress");
    const at = (key: string): TemplatePath => (own(item, key) === undefined ? itemPath : [...itemPath, key]);
    const service = own(item, "service");
    const port = own(item, "port");
    const protocol = own(item, "protocol");
    const before = issues.list.length;
    const target = typeof service === "string" ? services.get(service) : undefined;
    if (target === undefined) issues.add("INGRESS_SERVICE_UNKNOWN", at("service"), "service must name a service of this template.");
    else {
      if (!isSafeInt(port) || !target.expose.includes(port)) issues.add("INGRESS_PORT_NOT_EXPOSED", at("port"), "port must be one of that service's exposed ports.");
      if (!target.hasHealthcheck) issues.add("INGRESS_HEALTHCHECK_MISSING", at("service"), "An ingress target needs a health check: the route is published once it is healthy.");
    }
    if (protocol !== "http") issues.add("INGRESS_PROTOCOL_UNSUPPORTED", at("protocol"), "Set 'protocol: http': other protocols are not available in this version.");
    const id = JSON.stringify([service, port]);
    if (seen.has(id)) issues.add("INGRESS_DUPLICATE", itemPath, "The same service and port are routed twice.");
    seen.add(id);
    if (issues.list.length === before) ingress.push({ service: service as string, port: port as number });
  });
  return ingress;
}

/**
 * `x-hp-tasks` (ADR-0042): commands of the template that a customer may run, or schedule, in one of its components.
 * A task names a declared service, so a service with a problem of its own does not add a second issue here.
 */
function validateTasks(ctx: Context, root: Mapping): AppTemplateTask[] {
  const { issues } = ctx;
  const path: TemplatePath = ["x-hp-tasks"];
  const items = listAt(issues, own(root, "x-hp-tasks"), path) ?? [];
  if (items.length > LIMITS.tasks) issues.add("TASK_TOO_MANY", path, `At most ${LIMITS.tasks} tasks are allowed.`);
  const tasks: AppTemplateTask[] = [];
  const seen = new Set<string>();
  items.forEach((item: unknown, index) => {
    const itemPath = [...path, index];
    if (!isMapping(item)) return issues.mismatch(itemPath, "a mapping");
    const before = issues.list.length;
    checkKeys(issues, item, itemPath, "task");
    const at = (key: string): TemplatePath => [...itemPath, key];
    for (const key of ["key", "label", "service", "command"]) {
      if (own(item, key) === undefined) issues.add("TASK_FIELD_MISSING", itemPath, `A task needs '${key}'.`);
    }
    const key = own(item, "key");
    if (key !== undefined && (typeof key !== "string" || !APP_STACK_KEY_PATTERN.test(key) || key.length > APP_STACK_COMPONENT_KEY_MAX)) {
      issues.add(
        "TASK_KEY_INVALID",
        at("key"),
        `A task key starts with a lower-case letter, uses lower-case letters, digits and '-' (at most ${APP_STACK_COMPONENT_KEY_MAX}) and does not end with '-'.`,
      );
    } else if (typeof key === "string") {
      if (seen.has(key)) issues.add("TASK_KEY_DUPLICATE", at("key"), `The task key '${clip(key)}' is used twice.`);
      seen.add(key);
    }
    const label = own(item, "label");
    if (label !== undefined && !isText(label, LIMITS.taskLabel, 1)) {
      issues.add("TASK_LABEL_INVALID", at("label"), `A label is 1 to ${LIMITS.taskLabel} characters of plain text.`);
    }
    const description = ownOr(item, "description", "");
    if (!isText(description, LIMITS.taskDescription)) {
      issues.add("TASK_DESCRIPTION_INVALID", at("description"), `A description is at most ${LIMITS.taskDescription} characters of plain text.`);
    }
    const service = own(item, "service");
    if (service !== undefined && (typeof service !== "string" || !ctx.serviceKeys.includes(service))) {
      issues.add("TASK_SERVICE_UNKNOWN", at("service"), "service must name a service of this template.");
    }
    const command = validateCommand(ctx, own(item, "command"), at("command"), true);
    const timeout = ownOr(item, "timeoutSeconds", LIMITS.taskTimeoutDefault);
    if (!isSafeInt(timeout) || timeout < LIMITS.taskTimeoutMin || timeout > LIMITS.taskTimeoutMax) {
      issues.add(
        "TASK_TIMEOUT_INVALID",
        at("timeoutSeconds"),
        `timeoutSeconds is a whole number from ${LIMITS.taskTimeoutMin} to ${LIMITS.taskTimeoutMax}.`,
      );
    }
    if (issues.list.length > before || command === null) return;
    tasks.push({
      key: key as string,
      label: label as string,
      description: description as string,
      service: service as string,
      command,
      timeoutSeconds: timeout as number,
    });
  });
  return tasks;
}

function fail(issues: readonly AppTemplateIssue[]): AppTemplateValidationResult {
  return { ok: false, errors: sortAppTemplateIssues(issues) };
}

const internal = (): AppTemplateValidationResult =>
  fail([{ path: "", code: "SPEC_INTERNAL", reason: APP_TEMPLATE_ISSUE_REASON.SPEC_INTERNAL, message: "The template could not be checked. This is a platform bug." }]);

/**
 * Validates a parsed document. `locate` (from `parseTemplateYaml`) adds line and column to each issue; `allowlist`
 * defaults to APP_IMAGE_ALLOWLIST. Never throws: an unexpected failure is one SPEC_INTERNAL issue.
 */
export function validateAppTemplate(
  value: unknown,
  locate?: TemplateLocator,
  options: AppTemplateValidationOptions = {},
): AppTemplateValidationResult {
  try {
    const version = declaredVersion(value);
    const issues = new Issues(locate, version);
    if (!isMapping(value)) {
      issues.add("DOCUMENT_NOT_MAPPING", [], "The template must be a mapping of keys (x-hp-stack, services, ...).");
      return fail(issues.list);
    }
    checkKeys(issues, value, [], "root");
    const header = validateHeader(issues, value);
    const { parameters, infos } = validateParameters(issues, value);
    const volumes = validateDeclaredVolumes(issues, value);

    const rawServices = own(value, "services");
    const serviceMap = isMapping(rawServices) ? rawServices : {};
    const serviceKeys = Object.keys(serviceMap);
    if (rawServices === undefined) issues.add("SERVICES_MISSING", [], "Add a 'services' mapping with 1 to 8 services.");
    else if (!isMapping(rawServices)) issues.mismatch(["services"], "a mapping");
    else if (serviceKeys.length === 0) issues.add("SERVICES_MISSING", ["services"], "Add at least one service.");
    else if (serviceKeys.length > LIMITS.services) {
      issues.add("SERVICES_TOO_MANY", ["services"], `At most ${LIMITS.services} services are allowed; found ${serviceKeys.length}.`);
    }

    const ctx: Context = {
      issues,
      version,
      allowlist: options.allowlist ?? APP_IMAGE_ALLOWLIST,
      newVersion: options.newVersion === true,
      parameters: infos,
      volumes: new Set(volumes),
      mounted: new Set(),
      serviceKeys,
    };
    const results = new Map<string, ServiceResult>();
    for (const key of serviceKeys) {
      const result = validateService(ctx, key, own(serviceMap, key));
      if (result !== null) results.set(key, result);
    }

    const exposed = [...results.values()].reduce((total, result) => total + result.expose.length, 0);
    if (exposed > LIMITS.expose) issues.add("EXPOSE_TOO_MANY", ["services"], `At most ${LIMITS.expose} ports can be exposed by the whole stack.`);
    if (!issues.list.some((issue) => issue.code.startsWith("DEPENDS_ON_"))) {
      const order = orderAppTemplateServices([...results].map(([key, result]) => ({ key, dependsOn: result.dependsOn })));
      if (!order.ok) {
        for (const key of order.unordered) {
          issues.add("DEPENDENCY_CYCLE", ["services", key, "depends_on"], "The dependencies form a cycle: no start order exists.");
        }
      }
    }
    for (const name of volumes) {
      if (!ctx.mounted.has(name)) issues.add("VOLUME_UNUSED", ["volumes", name], "The volume is mounted by no service: remove it.", "key");
    }
    const ingress = validateIngress(issues, value, results);
    const tasks = validateTasks(ctx, value);
    if (issues.list.length > 0) return fail(issues.list);

    const parsed = AppTemplateSpecSchema.safeParse({
      schemaVersion: version,
      ...header,
      parameters,
      services: [...results.values()].flatMap((result) => (result.service ? [result.service] : [])).sort((a, b) => compare(a.key, b.key)),
      volumes: [...volumes].sort(compare).map((key) => ({ key })),
      ingress,
      ...(tasks.length > 0 ? { tasks } : {}),
    });
    return parsed.success ? { ok: true, spec: parsed.data } : internal();
  } catch {
    return internal();
  }
}

/**
 * Parses the YAML subset, then validates it. A syntax error, or a lone UTF-16 surrogate (which a TEXT or JSONB column
 * cannot store as written), is one issue with path "" and the position.
 */
export function validateAppTemplateSource(source: string, options?: AppTemplateValidationOptions): AppTemplateValidationResult {
  const surrogate = LONE_SURROGATE.exec(source)?.index;
  if (surrogate !== undefined) {
    const lines = source.slice(0, surrogate).replace(/^\uFEFF/, "").split(/\r\n?|\n/);
    const at = { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
    const code = "CONTROL_CHARACTER";
    return { ok: false, errors: [{ path: "", ...at, code, reason: APP_TEMPLATE_ISSUE_REASON[code], message: "an unpaired UTF-16 surrogate is not allowed" }] };
  }
  const parsed = parseTemplateYaml(source);
  if (!parsed.ok) {
    const [error] = parsed.errors;
    const reason = APP_TEMPLATE_ISSUE_REASON[error.code];
    const message = error.code === "DUPLICATE_KEY" ? error.message.replace(/"(.*)"/s, (_, key: string) => `"${clip(key)}"`) : error.message;
    return { ok: false, errors: [{ path: "", line: error.line, column: error.column, code: error.code, reason, message }] };
  }
  return validateAppTemplate(parsed.value, parsed.locate, options);
}
