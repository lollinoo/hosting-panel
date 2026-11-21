/**
 * Validator of a site template: turns the parsed document (a Compose-like YAML subset) into a `SiteTemplateSpec`, or
 * into every problem found, each with a code, a path and, when a locator is given, a line and column.
 *
 * The document is a closed allowlist. A key that is not named here is refused, so a Compose feature that could reach
 * the host (privileged, bind mounts, host ports, the docker socket...) can never slip in by being forgotten.
 * Pure, synchronous and never throws; a message never echoes an environment value.
 */
import {
  PHP_SETTING_DEFAULTS,
  PHP_SETTING_KEYS,
  PHP_SIZE_PATTERN,
  SITE_TEMPLATE_LIMITS,
  SITE_TEMPLATE_MODULES,
  SITE_TEMPLATE_PARAMETER_KEY_PATTERN,
  SiteTemplateSpecSchema,
  YAML_ERROR_CODES,
  formatTemplatePath,
  parseTemplateYaml,
  phpSettingProblem,
  phpSizeToBytes,
  validateServiceVolumeMount,
  type PhpSettingKey,
  type SiteTemplateSpec,
  type SiteTypeKey,
  type TemplateLocator,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { parseImageReference } from "./image-reference.js";
import { MAX_SERVICE_CPU_MILLI, MAX_SERVICE_MEMORY_BYTES } from "./service-validation.js";
import { ENV_MAX_ENTRIES, ENV_VALUE_MAX_LENGTH, envNameProblem, envValueProblem } from "./site-template-env.js";
import {
  HP_MAGIC_VARIABLES,
  HP_MODULE_IMAGE_VARIABLE,
  HP_VARIABLE_MAX_LENGTH,
  expandPieces,
  scanInterpolation,
} from "./site-template-interpolation.js";
import { getSiteTemplatePolicy, type SiteTemplateModulePolicy } from "./site-template-policies.js";

const VALIDATOR_ISSUE_CODES = [
  "DOCUMENT_NOT_MAPPING", "MODULE_MISSING", "MODULE_MISMATCH", "TYPE_MISMATCH", "KEY_UNKNOWN", "KEY_FORBIDDEN_SECURITY",
  "KEY_FORBIDDEN_NETWORK", "KEY_FORBIDDEN_HOST_ACCESS", "KEY_UNSUPPORTED", "SERVICES_MISSING", "SERVICES_MULTIPLE",
  "SERVICE_NAME_INVALID", "IMAGE_MISSING", "IMAGE_MALFORMED", "IMAGE_REPOSITORY_NOT_ALLOWED", "IMAGE_DIGEST_NOT_ALLOWED",
  "IMAGE_TAG_NOT_ALLOWED", "IMAGE_VARIABLE_NOT_ALLOWED", "INTERP_SYNTAX", "INTERP_UNKNOWN_VARIABLE",
  "INTERP_MODULE_IMAGE_MISPLACED", "ENV_TOO_MANY", "ENV_NAME_INVALID", "ENV_NAME_DUPLICATE", "ENV_NAME_RESERVED",
  "ENV_NAME_SECRET_LIKE", "ENV_VALUE_MISSING", "ENV_VALUE_INVALID", "ENV_VALUE_TOO_LONG", "ENV_VALUE_SECRET_LIKE",
  "ENV_VALUE_DOCKER_SOCKET", "VOLUME_SYNTAX", "VOLUME_HOST_PATH", "VOLUME_DOCKER_SOCKET", "VOLUME_TARGET_INVALID",
  "VOLUME_MODE_UNSUPPORTED", "VOLUME_DUPLICATE", "VOLUME_UNDECLARED", "VOLUME_OPTIONS_REFUSED", "VOLUME_REQUIRED_MISSING",
  "VOLUME_EXTRA_NOT_ALLOWED", "EXPOSE_INVALID", "LIMIT_INCOMPLETE", "LIMIT_CPU_FORMAT", "LIMIT_CPU_RANGE",
  "LIMIT_MEMORY_FORMAT", "LIMIT_MEMORY_RANGE", "PARAM_TOO_MANY", "PARAM_KEY_INVALID", "PARAM_KEY_DUPLICATE",
  "PARAM_TYPE_INVALID", "PARAM_LABEL_INVALID", "PARAM_OPTIONS_INVALID", "PARAM_BOUNDS_INVALID", "PARAM_DEFAULT_MISSING",
  "PARAM_DEFAULT_INVALID", "PARAM_CUSTOMER_NOT_ALLOWED", "PHP_PARAM_MISSING", "PHP_PARAM_INVALID",
  "PHP_VERSION_UNSUPPORTED", "PHP_NOT_SUPPORTED", "PHP_EMPTY", "PHP_KEY_UNKNOWN", "PHP_VALUE_INVALID",
  "PHP_POST_BELOW_UPLOAD", "PHP_MEMORY_EXCEEDS_CONTAINER", "SPEC_INTERNAL",
] as const;

export const SITE_TEMPLATE_ISSUE_CODES = [...YAML_ERROR_CODES, ...VALIDATOR_ISSUE_CODES] as const;
export type SiteTemplateIssueCode = (typeof SITE_TEMPLATE_ISSUE_CODES)[number];

export interface SiteTemplateIssue {
  /** Dotted path of the offending key or value ("" for the whole document). */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly code: SiteTemplateIssueCode;
  readonly message: string;
}

export type SiteTemplateValidationResult =
  | { readonly ok: true; readonly spec: SiteTemplateSpec }
  /** Sorted by (line, column, path, code), at most SITE_TEMPLATE_MAX_ISSUES. */
  | { readonly ok: false; readonly errors: SiteTemplateIssue[] };

export const SITE_TEMPLATE_MAX_ISSUES = 50;

type RefusalCode = "KEY_FORBIDDEN_SECURITY" | "KEY_FORBIDDEN_NETWORK" | "KEY_FORBIDDEN_HOST_ACCESS" | "KEY_UNSUPPORTED";
type KeyRefusals = Readonly<Partial<Record<RefusalCode, readonly string[]>>>;

/** Keys of the document root that are refused with a reason. Any other unlisted key is KEY_UNKNOWN. */
export const ROOT_KEY_REFUSALS: KeyRefusals = {
  KEY_FORBIDDEN_NETWORK: ["networks"],
  KEY_FORBIDDEN_HOST_ACCESS: ["secrets", "configs", "include", "extends"],
  KEY_UNSUPPORTED: ["name", "version", "models"],
};

/** Keys of the service that are refused with a reason. Any other unlisted key is KEY_UNKNOWN. */
export const SERVICE_KEY_REFUSALS: KeyRefusals = {
  KEY_FORBIDDEN_SECURITY: [
    "privileged", "cap_add", "cap_drop", "devices", "device_cgroup_rules", "security_opt", "sysctls", "userns_mode", "pid",
    "ipc", "uts", "cgroup", "cgroup_parent", "runtime", "isolation", "group_add", "user", "oom_kill_disable",
    "oom_score_adj", "gpus", "credential_spec",
  ],
  KEY_FORBIDDEN_NETWORK: [
    "ports", "network_mode", "networks", "extra_hosts", "dns", "dns_search", "dns_opt", "mac_address", "links",
    "external_links", "hostname", "domainname",
  ],
  KEY_FORBIDDEN_HOST_ACCESS: [
    "build", "container_name", "env_file", "secrets", "configs", "labels", "label_file", "volumes_from", "tmpfs", "extends",
    "develop", "annotations", "storage_opt", "post_start", "pre_stop",
  ],
  KEY_UNSUPPORTED: [
    "command", "entrypoint", "healthcheck", "depends_on", "restart", "logging", "working_dir", "read_only", "stop_signal",
    "stop_grace_period", "init", "tty", "stdin_open", "profiles", "pull_policy", "platform", "scale", "ulimits", "mem_limit",
    "memswap_limit", "mem_reservation", "cpus", "cpu_shares", "cpu_quota", "pids_limit", "shm_size",
  ],
};

const DEPLOY_KEY_REFUSALS: KeyRefusals = {
  KEY_UNSUPPORTED: ["mode", "replicas", "endpoint_mode", "labels", "update_config", "rollback_config", "restart_policy", "placement"],
};
const RESOURCES_KEY_REFUSALS: KeyRefusals = { KEY_UNSUPPORTED: ["reservations"] };
const LIMITS_KEY_REFUSALS: KeyRefusals = { KEY_UNSUPPORTED: ["pids", "devices"] };

const refusalIndex = (table: KeyRefusals): ReadonlyMap<string, RefusalCode> =>
  new Map(Object.entries(table).flatMap(([code, keys]) => keys.map((key) => [key, code as RefusalCode] as const)));
const ROOT_REFUSALS = refusalIndex(ROOT_KEY_REFUSALS);
const SERVICE_REFUSALS = refusalIndex(SERVICE_KEY_REFUSALS);
const DEPLOY_REFUSALS = refusalIndex(DEPLOY_KEY_REFUSALS);
const RESOURCES_REFUSALS = refusalIndex(RESOURCES_KEY_REFUSALS);
const LIMITS_REFUSALS = refusalIndex(LIMITS_KEY_REFUSALS);

const REFUSAL_MESSAGES: Readonly<Record<RefusalCode | "KEY_UNKNOWN", string>> = {
  KEY_FORBIDDEN_SECURITY: "is not allowed: a template cannot change the container's security settings.",
  KEY_FORBIDDEN_NETWORK: "is not allowed: the platform controls networking and publishes the site itself.",
  KEY_FORBIDDEN_HOST_ACCESS: "is not allowed: a template cannot reach host files, secrets or platform labels.",
  KEY_UNSUPPORTED: "is not available in this version: the platform manages it.",
  KEY_UNKNOWN: "is not a known key. Remove it.",
};

const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const VOLUME_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const VOLUME_TARGET_PATTERN = /^\/[A-Za-z0-9._/-]{1,254}$/;
const OPTION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CPU_PATTERN = /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,3})?$/;
const MEMORY_PATTERN = /^([1-9][0-9]{0,11})([bB]|[kKmMgG][bB]?)?$/;
const PARAMETER_TYPES: readonly string[] = ["enum", "integer", "string", "boolean", "size"];
const MAX_PARAMETERS = 16;
const MAX_LABEL = 80;
const MAX_IMAGE = 256;
const INTEGER_BOUND = 1_000_000_000;
const STRING_DEFAULT_MAX = 256;
const MAGIC_VARIABLES: readonly string[] = HP_MAGIC_VARIABLES;
/** The whole-value placeholder that resolves to the module's pinned image. */
const WHOLE_MODULE_IMAGE = `\${${HP_MODULE_IMAGE_VARIABLE}}`;
const CONTROL_CHARACTER = /\p{Cc}/u;

type Mapping = Readonly<Record<string, unknown>>;
const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
/** Own property only: a document may carry keys such as `constructor` or `__proto__`. */
const own = (mapping: Mapping, key: string): unknown => (Object.hasOwn(mapping, key) ? mapping[key] : undefined);
const clip = (text: string): string => (text.length > 64 ? `${text.slice(0, 61)}...` : text);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

class Issues {
  readonly list: SiteTemplateIssue[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly locate: TemplateLocator | undefined) {}

  add(code: SiteTemplateIssueCode, path: TemplatePath, message: string, part: "key" | "value" = "value"): void {
    const formatted = formatTemplatePath(path);
    const id = `${formatted}\u0000${code}\u0000${message}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    const at = this.locate?.(path, part) ?? null;
    this.list.push(at ? { path: formatted, line: at.line, column: at.column, code, message } : { path: formatted, code, message });
  }

  mismatch(path: TemplatePath, expected: string): void {
    this.add("TYPE_MISMATCH", path, `${quoted(path)} must be ${expected}.`);
  }
}

const quoted = (path: TemplatePath): string => `'${clip(formatTemplatePath(path)) || "the document"}'`;

/** Reports every key of `mapping` that is not in `allowed`: a named refusal, else KEY_UNKNOWN. */
function checkKeys(
  issues: Issues,
  mapping: Mapping,
  path: TemplatePath,
  allowed: readonly string[],
  refusals: ReadonlyMap<string, RefusalCode>,
): void {
  for (const key of Object.keys(mapping)) {
    if (allowed.includes(key)) continue;
    const code = refusals.get(key) ?? "KEY_UNKNOWN";
    issues.add(code, [...path, key], `'${clip(key)}' ${REFUSAL_MESSAGES[code]}`, "key");
  }
}

interface Context {
  readonly issues: Issues;
  readonly module: SiteTypeKey;
  readonly policy: SiteTemplateModulePolicy;
}

interface ParameterInfo {
  readonly path: TemplatePath;
  readonly type: string | null;
  readonly customer: boolean | null;
  /** The options when the parameter is an enum whose options are all valid; else null. */
  readonly options: readonly string[] | null;
  /** Longest text the parameter can contribute to an environment value. */
  readonly maxLength: number;
}

interface ParametersResult {
  readonly parameters: SiteTemplateSpec["parameters"];
  readonly infos: ReadonlyMap<string, ParameterInfo>;
}

function validateParameters(ctx: Context, root: Mapping): ParametersResult {
  const { issues, policy } = ctx;
  const path: TemplatePath = ["x-hp-parameters"];
  const parameters: SiteTemplateSpec["parameters"] = [];
  const infos = new Map<string, ParameterInfo>();
  const raw = own(root, "x-hp-parameters");
  if (raw !== undefined) {
    if (!Array.isArray(raw)) issues.mismatch(path, "a list");
    else {
      if (raw.length > MAX_PARAMETERS) {
        issues.add("PARAM_TOO_MANY", path, `At most ${MAX_PARAMETERS} parameters are allowed; found ${raw.length}.`);
      }
      let customers = 0;
      raw.forEach((item: unknown, index) => {
        const before = issues.list.length;
        const result = validateParameter(ctx, item, [...path, index], infos);
        if (result === null) return;
        if (result.parameter.customer && ++customers > policy.maxCustomerParameters) {
          issues.add(
            "PARAM_CUSTOMER_NOT_ALLOWED",
            [...path, index, "customer"],
            `At most ${policy.maxCustomerParameters} parameters can be customer choices.`,
          );
        }
        if (issues.list.length === before) parameters.push(result.parameter);
      });
    }
  }

  const variant = policy.variantParameter;
  if (variant) {
    const info = infos.get(variant.key);
    if (!info) {
      issues.add("PHP_PARAM_MISSING", raw === undefined ? [] : path, `Declare the '${variant.key}' parameter: it selects the runtime variant of this site type.`);
    } else {
      if (info.type !== "enum" || info.customer !== true) {
        issues.add("PHP_PARAM_INVALID", info.path, `'${variant.key}' must be an enum parameter with customer: true.`, "key");
      }
      info.options?.forEach((option, index) => {
        if (!variant.options.includes(option)) {
          issues.add(
            "PHP_VERSION_UNSUPPORTED",
            [...info.path, "options", index],
            `'${clip(option)}' is not supported. Supported: ${variant.options.join(", ")}.`,
          );
        }
      });
    }
  }
  return { parameters, infos };
}

function maxLengthOf(type: string | null, options: readonly string[] | null): number {
  switch (type) {
    case "enum": return Math.max(0, ...(options ?? []).map((option) => option.length));
    case "integer": return 16;
    case "boolean": return 5;
    case "size": return 8;
    default: return STRING_DEFAULT_MAX;
  }
}

function validateParameter(
  ctx: Context,
  item: unknown,
  path: TemplatePath,
  infos: Map<string, ParameterInfo>,
): { parameter: SiteTemplateSpec["parameters"][number] } | null {
  const { issues } = ctx;
  if (!isMapping(item)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  const typeRaw = own(item, "type");
  const type = typeof typeRaw === "string" && PARAMETER_TYPES.includes(typeRaw) ? typeRaw : null;
  const allowed = ["key", "label", "type", "default", "customer"];
  if (type === null || type === "enum") allowed.push("options");
  if (type === null || type === "integer") allowed.push("min", "max");
  checkKeys(issues, item, path, allowed, new Map());

  const keyRaw = own(item, "key");
  const key = typeof keyRaw === "string" && SITE_TEMPLATE_PARAMETER_KEY_PATTERN.test(keyRaw) && !keyRaw.startsWith("hp_") ? keyRaw : null;
  if (key === null) {
    issues.add(
      "PARAM_KEY_INVALID",
      keyRaw === undefined ? path : [...path, "key"],
      "A parameter key starts with a lower-case letter, uses lower-case letters, digits and '_' (at most 32) and does not start with 'hp_'.",
    );
  } else if (infos.has(key)) {
    issues.add("PARAM_KEY_DUPLICATE", [...path, "key"], `The parameter key '${key}' is used twice.`);
  }

  const label = own(item, "label");
  if (typeof label !== "string" || label.length < 1 || label.length > MAX_LABEL || CONTROL_CHARACTER.test(label)) {
    issues.add("PARAM_LABEL_INVALID", label === undefined ? path : [...path, "label"], `A label is 1 to ${MAX_LABEL} characters of plain text.`);
  }
  if (type === null) {
    issues.add("PARAM_TYPE_INVALID", typeRaw === undefined ? path : [...path, "type"], `type must be one of ${PARAMETER_TYPES.join(", ")}.`);
  }

  const customerRaw = own(item, "customer");
  if (customerRaw !== undefined && typeof customerRaw !== "boolean") issues.mismatch([...path, "customer"], "true or false");
  const customer = customerRaw === undefined ? false : typeof customerRaw === "boolean" ? customerRaw : null;

  const defaultPath = [...path, "default"];
  const value = own(item, "default");
  const options = type === "enum" ? validateOptions(ctx, own(item, "options"), path) : null;
  let min: number | undefined;
  let max: number | undefined;
  let defaultOk = false;
  const invalidDefault = (what: string): void => {
    issues.add("PARAM_DEFAULT_INVALID", defaultPath, `The default must be ${what}.`);
  };
  if (value === undefined && type !== null) {
    issues.add("PARAM_DEFAULT_MISSING", path, "Every parameter needs a default.");
  } else {
    switch (type) {
      case "enum": {
        const text = typeof value === "string" || typeof value === "number" ? String(value) : null;
        if (options !== null) {
          defaultOk = text !== null && options.includes(text);
          if (!defaultOk) invalidDefault("one of the options");
        }
        break;
      }
      case "integer": {
        const low = own(item, "min");
        const high = own(item, "max");
        const bounded = (bound: unknown): bound is number => isSafeInt(bound) && Math.abs(bound) <= INTEGER_BOUND;
        if (!bounded(low) || !bounded(high)) {
          issues.add("PARAM_BOUNDS_INVALID", path, `min and max are required whole numbers between -${INTEGER_BOUND} and ${INTEGER_BOUND}.`);
        } else if (low > high) {
          issues.add("PARAM_BOUNDS_INVALID", [...path, "min"], "min must not exceed max.");
        } else {
          min = low;
          max = high;
        }
        defaultOk = isSafeInt(value) && (min === undefined || max === undefined || (value >= min && value <= max));
        if (!defaultOk) invalidDefault("a whole number within min and max");
        break;
      }
      case "string":
        defaultOk =
          typeof value === "string" && value.length <= STRING_DEFAULT_MAX && !CONTROL_CHARACTER.test(value) && !value.includes("${") && !value.includes("$$");
        if (!defaultOk) invalidDefault(`text of at most ${STRING_DEFAULT_MAX} printable characters without '$\{' or '$$'`);
        break;
      case "boolean":
        defaultOk = typeof value === "boolean";
        if (!defaultOk) invalidDefault("true or false");
        break;
      case "size":
        defaultOk = typeof value === "string" && PHP_SIZE_PATTERN.test(value);
        if (!defaultOk) invalidDefault("a size such as 64M (K, M or G)");
        break;
      default:
    }
  }
  if (type === "size" && customer === true) {
    issues.add("PARAM_CUSTOMER_NOT_ALLOWED", [...path, "customer"], "A size parameter is fixed by the administrator and cannot be a customer choice.");
  }

  if (key !== null && !infos.has(key)) {
    infos.set(key, { path, type, customer, options, maxLength: maxLengthOf(type, options) });
  }
  if (key === null || type === null || typeof label !== "string" || customer === null || !defaultOk) return null;
  const stringified = type === "enum" ? String(value) : value;
  return {
    parameter: {
      key,
      label,
      type: type as SiteTemplateSpec["parameters"][number]["type"],
      ...(options !== null ? { options: [...options] } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      default: stringified as string | number | boolean,
      customer,
    },
  };
}

function validateOptions(ctx: Context, raw: unknown, parameterPath: TemplatePath): string[] | null {
  const { issues } = ctx;
  const path = [...parameterPath, "options"];
  if (raw === undefined) {
    issues.add("PARAM_OPTIONS_INVALID", parameterPath, "An enum parameter needs options.");
    return null;
  }
  if (!Array.isArray(raw)) {
    issues.mismatch(path, "a list");
    return null;
  }
  const max = SITE_TEMPLATE_LIMITS.options;
  if (raw.length < 1 || raw.length > max) {
    issues.add("PARAM_OPTIONS_INVALID", path, `An enum has 1 to ${max} options.`);
    return null;
  }
  const options: string[] = [];
  let valid = true;
  raw.forEach((option: unknown, index) => {
    const text = typeof option === "string" || typeof option === "number" ? String(option) : null;
    if (text === null || !OPTION_PATTERN.test(text)) {
      issues.add("PARAM_OPTIONS_INVALID", [...path, index], "An option is 1 to 64 letters, digits, '.', '_' or '-'.");
      valid = false;
    } else if (options.includes(text)) {
      issues.add("PARAM_OPTIONS_INVALID", [...path, index], "Options must be distinct.");
      valid = false;
    } else options.push(text);
  });
  return valid ? options : null;
}

/** The names declared under the top-level `volumes`; any option on a volume is a disguised host bind. */
function validateDeclaredVolumes(ctx: Context, root: Mapping): ReadonlySet<string> {
  const { issues } = ctx;
  const raw = own(root, "volumes");
  const declared = new Set<string>();
  if (raw === undefined) return declared;
  if (!isMapping(raw)) {
    issues.mismatch(["volumes"], "a mapping of volume names");
    return declared;
  }
  for (const [name, options] of Object.entries(raw)) {
    declared.add(name);
    if (options === null || (isMapping(options) && Object.keys(options).length === 0)) continue;
    if (isMapping(options)) {
      issues.add("VOLUME_OPTIONS_REFUSED", ["volumes", name], "Volume options (driver, driver_opts, external, name, labels...) are refused: declare the volume as '{}'.");
    } else issues.mismatch(["volumes", name], "empty ('{}')");
  }
  return declared;
}

interface ServiceResult {
  readonly service: SiteTemplateSpec["service"];
  /** The container memory the PHP settings are checked against; null when unknown (invalid limits). */
  readonly memoryBytes: bigint | null;
}

const EMPTY_SERVICE: ServiceResult = {
  service: { name: "", image: "", environment: [], volumes: [], expose: [], limits: null },
  memoryBytes: null,
};

function validateServices(ctx: Context, root: Mapping, parameters: ParametersResult, declaredVolumes: ReadonlySet<string>): ServiceResult {
  const { issues } = ctx;
  const raw = own(root, "services");
  if (raw === undefined) {
    issues.add("SERVICES_MISSING", [], "Add a 'services' mapping with exactly one service.");
    return EMPTY_SERVICE;
  }
  if (!isMapping(raw)) {
    issues.mismatch(["services"], "a mapping");
    return EMPTY_SERVICE;
  }
  const names = Object.keys(raw);
  const [name] = names;
  if (name === undefined) {
    issues.add("SERVICES_MISSING", ["services"], "Add exactly one service under 'services'.");
    return EMPTY_SERVICE;
  }
  if (names.length > 1) {
    issues.add("SERVICES_MULTIPLE", ["services", names[1]!], "Multi-service templates are not supported in this version: keep one service.", "key");
  }
  const path: TemplatePath = ["services", name];
  if (!SERVICE_NAME_PATTERN.test(name)) {
    issues.add("SERVICE_NAME_INVALID", path, "A service name starts with a lower-case letter and uses lower-case letters, digits, '_' and '-' (at most 32).", "key");
  }
  const service = own(raw, name);
  if (!isMapping(service)) {
    issues.mismatch(path, "a mapping");
    return EMPTY_SERVICE;
  }
  checkKeys(issues, service, path, ["image", "environment", "volumes", "expose", "deploy"], SERVICE_REFUSALS);

  const { policy } = ctx;
  const variant = policy.variantParameter;
  const variantInfo = variant ? parameters.infos.get(variant.key) : undefined;
  // Variants the image must be valid for: every supported option of the variant parameter, or none when it is absent.
  const variants: readonly (string | null)[] = variant
    ? (variantInfo?.options ?? []).filter((option) => variant.options.includes(option))
    : [null];
  const image = validateImage(ctx, own(service, "image"), [...path, "image"], path, variants);
  const environment = validateEnvironment(ctx, own(service, "environment"), [...path, "environment"], parameters.infos);
  const volumes = validateServiceVolumes(ctx, own(service, "volumes"), [...path, "volumes"], path, declaredVolumes);
  const expose = validateExpose(ctx, own(service, "expose"), [...path, "expose"]);
  const limits = validateDeploy(ctx, own(service, "deploy"), [...path, "deploy"]);
  return {
    service: { name, image, environment, volumes, expose, limits: limits.limits },
    memoryBytes: limits.memoryBytes,
  };
}

function validateImage(
  ctx: Context,
  raw: unknown,
  path: TemplatePath,
  servicePath: TemplatePath,
  variants: readonly (string | null)[],
): string {
  const { issues, policy } = ctx;
  if (raw === undefined || raw === null || raw === "") {
    issues.add("IMAGE_MISSING", raw === undefined ? servicePath : path, "A service needs an image.");
    return "";
  }
  if (typeof raw !== "string") {
    issues.mismatch(path, "a string");
    return "";
  }
  if (raw === WHOLE_MODULE_IMAGE) return raw;
  if (raw.length > MAX_IMAGE) {
    issues.add("IMAGE_MALFORMED", path, `The image reference is longer than ${MAX_IMAGE} characters.`);
    return raw;
  }
  const scan = scanInterpolation(raw);
  if (!scan.ok) {
    issues.add(scan.code, path, scan.message);
    return raw;
  }
  let placeholdersOk = true;
  for (const piece of scan.pieces) {
    if (!("variable" in piece)) continue;
    if (piece.variable === HP_MODULE_IMAGE_VARIABLE) {
      issues.add("INTERP_MODULE_IMAGE_MISPLACED", path, "'${HP_MODULE_IMAGE}' is only allowed as the whole image value.");
      placeholdersOk = false;
    } else if (piece.variable !== policy.variantParameter?.key) {
      issues.add(
        "IMAGE_VARIABLE_NOT_ALLOWED",
        path,
        `The image can only use the '${policy.variantParameter?.key ?? "(none)"}' parameter as a variable, not '${clip(piece.variable)}'.`,
      );
      placeholdersOk = false;
    }
  }
  if (!placeholdersOk) return raw;

  const variantKey = policy.variantParameter?.key;
  for (const variant of variants) {
    const parsed = parseImageReference(expandPieces(scan.pieces, () => variant ?? ""));
    if (!parsed.ok) {
      issues.add("IMAGE_MALFORMED", path, "The image reference is not valid (repository[:tag], lower-case, no spaces).");
      continue;
    }
    const { registry, repository, tag, digest } = parsed.value;
    if (registry !== null || repository !== policy.image.repository) {
      issues.add(
        "IMAGE_REPOSITORY_NOT_ALLOWED",
        path,
        `Only the official '${policy.image.repository}' image, written without a registry prefix, is allowed.`,
      );
    } else if (digest !== null) {
      issues.add(
        "IMAGE_DIGEST_NOT_ALLOWED",
        path,
        "A digest pins one variant and cannot follow the chosen version. Use a tag, or '${HP_MODULE_IMAGE}'.",
      );
    } else if (tag === null || tag === "latest" || !policy.image.tagPattern(variant).test(tag)) {
      const subject = variant !== null && variantKey !== undefined ? ` for ${variantKey} ${clip(variant)}` : "";
      issues.add(
        "IMAGE_TAG_NOT_ALLOWED",
        path,
        `The image tag${subject} must be an exact version pin of the official image built for that value ('latest' and floating tags are refused). Use '\${HP_MODULE_IMAGE}' to follow the platform's pin.`,
      );
    }
  }
  return raw;
}

interface EnvCandidate {
  readonly name: string;
  readonly value: string;
  readonly path: TemplatePath;
}

const NAME_PROBLEM_MESSAGES = {
  ENV_NAME_INVALID: "is not a valid environment variable name (upper-case letters, digits and '_', not starting with a digit, at most 64 characters).",
  ENV_NAME_RESERVED: "is reserved by the platform.",
  ENV_NAME_SECRET_LIKE: "looks like a secret. Templates cannot hold secrets: the platform manages credentials.",
} as const;

const VALUE_PROBLEM_MESSAGES = {
  ENV_VALUE_INVALID: "contains a control character or a line break.",
  ENV_VALUE_SECRET_LIKE: "looks like a secret or a credential. Templates cannot hold secrets.",
  ENV_VALUE_DOCKER_SOCKET: "refers to the Docker socket, which is never available to a site.",
} as const;

function validateEnvironment(
  ctx: Context,
  raw: unknown,
  path: TemplatePath,
  infos: ReadonlyMap<string, ParameterInfo>,
): SiteTemplateSpec["service"]["environment"] {
  const { issues } = ctx;
  if (raw === undefined) return [];
  const candidates: EnvCandidate[] = [];
  let total: number;
  if (isMapping(raw)) {
    const entries = Object.entries(raw);
    total = entries.length;
    for (const [name, value] of entries) {
      const entryPath = [...path, name];
      if (value === null) issues.add("ENV_VALUE_MISSING", entryPath, "Give the variable a value: it is never taken from the host.");
      else if (typeof value === "string") candidates.push({ name, value, path: entryPath });
      else if (typeof value === "number" || typeof value === "boolean") candidates.push({ name, value: String(value), path: entryPath });
      else issues.mismatch(entryPath, "a string, number or boolean");
    }
  } else if (Array.isArray(raw)) {
    total = raw.length;
    raw.forEach((item: unknown, index) => {
      const entryPath = [...path, index];
      if (typeof item !== "string") return issues.mismatch(entryPath, "a 'NAME=value' string");
      const separator = item.indexOf("=");
      if (separator === -1) {
        return issues.add("ENV_VALUE_MISSING", entryPath, "Write 'NAME=value': a name alone would be taken from the host.");
      }
      candidates.push({ name: item.slice(0, separator), value: item.slice(separator + 1), path: entryPath });
    });
  } else {
    issues.mismatch(path, "a mapping or a list");
    return [];
  }
  if (total > ENV_MAX_ENTRIES) issues.add("ENV_TOO_MANY", path, `At most ${ENV_MAX_ENTRIES} environment variables are allowed; found ${total}.`);

  const names = new Set<string>();
  for (const { name, value, path: entryPath } of candidates) {
    const nameProblem = envNameProblem(name);
    if (nameProblem) issues.add(nameProblem, entryPath, `The name ${NAME_PROBLEM_MESSAGES[nameProblem]}`, "key");
    else if (names.has(name)) issues.add("ENV_NAME_DUPLICATE", entryPath, "The variable is set twice.", "key");
    names.add(name);

    const valueProblem = envValueProblem(value);
    if (valueProblem) issues.add(valueProblem, entryPath, `The value ${VALUE_PROBLEM_MESSAGES[valueProblem]}`);
    checkEnvPlaceholders(ctx, value, entryPath, infos);
  }
  return candidates.map(({ name, value }) => ({ name, value }));
}

/** Every `${NAME}` must be a declared parameter or a magic variable, and the filled-in value must fit. */
function checkEnvPlaceholders(ctx: Context, value: string, path: TemplatePath, infos: ReadonlyMap<string, ParameterInfo>): void {
  const { issues } = ctx;
  const scan = scanInterpolation(value);
  if (!scan.ok) {
    issues.add(scan.code, path, scan.message);
    return;
  }
  let worstCase = 0;
  for (const piece of scan.pieces) {
    if ("literal" in piece) worstCase += piece.literal.length;
    else if (piece.variable === HP_MODULE_IMAGE_VARIABLE) {
      issues.add("INTERP_MODULE_IMAGE_MISPLACED", path, "'${HP_MODULE_IMAGE}' is only allowed as the whole image value.");
    } else if (MAGIC_VARIABLES.includes(piece.variable)) {
      worstCase += HP_VARIABLE_MAX_LENGTH[piece.variable as keyof typeof HP_VARIABLE_MAX_LENGTH];
    } else {
      const info = infos.get(piece.variable);
      if (info) worstCase += info.maxLength;
      else issues.add("INTERP_UNKNOWN_VARIABLE", path, `'${clip(piece.variable)}' is neither a declared parameter nor one of ${HP_MAGIC_VARIABLES.join(", ")}.`);
    }
  }
  // The stored text keeps the placeholders, so it is capped too, not only the filled-in value.
  if (worstCase > ENV_VALUE_MAX_LENGTH || value.length > ENV_VALUE_MAX_LENGTH) {
    issues.add("ENV_VALUE_TOO_LONG", path, `The value could exceed ${ENV_VALUE_MAX_LENGTH} characters once filled in.`);
  }
}

const HOST_PATH_SOURCE = /^[/.~]|\\|\.\./;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function validateServiceVolumes(
  ctx: Context,
  raw: unknown,
  path: TemplatePath,
  servicePath: TemplatePath,
  declared: ReadonlySet<string>,
): SiteTemplateSpec["service"]["volumes"] {
  const { issues, policy, module } = ctx;
  const required = SITE_TEMPLATE_MODULES[module].requiredMount;
  const volumes: SiteTemplateSpec["service"]["volumes"] = [];
  if (raw !== undefined && !Array.isArray(raw)) {
    issues.mismatch(path, "a list");
    return volumes;
  }
  const sources = new Set<string>();
  const targets = new Set<string>();
  let hasRequired = false;
  (raw ?? []).forEach((item: unknown, index: number) => {
    const itemPath = [...path, index];
    if (typeof item !== "string") {
      return issues.add("VOLUME_SYNTAX", itemPath, "Write a volume as 'name:/path'; the long mapping syntax is not supported.");
    }
    if (/docker\.sock/i.test(item)) {
      return issues.add("VOLUME_DOCKER_SOCKET", itemPath, "The Docker socket can never be mounted.");
    }
    const parts = item.split(":");
    const source = parts[0] ?? "";
    if (WINDOWS_DRIVE.test(item) || HOST_PATH_SOURCE.test(source)) {
      return issues.add("VOLUME_HOST_PATH", itemPath, "Bind mounts and host paths are refused: use a named volume declared under 'volumes'.");
    }
    const target = parts[1] ?? "";
    if ((parts.length !== 2 && parts.length !== 3) || !VOLUME_NAME_PATTERN.test(source)) {
      return issues.add("VOLUME_SYNTAX", itemPath, "Write a volume as 'name:/path' (a name of lower-case letters, digits, '_' and '-').");
    }
    if (source === required.name && target === required.target) hasRequired = true;
    const mount = validateServiceVolumeMount({ volumeSuffix: source, containerPath: target });
    if (!mount.valid) return issues.add("VOLUME_TARGET_INVALID", itemPath, mount.reason);
    if (!VOLUME_TARGET_PATTERN.test(target) || target.includes("//") || target.endsWith("/")) {
      return issues.add("VOLUME_TARGET_INVALID", itemPath, "The target is an absolute path of letters, digits, '.', '_', '-' and '/', without '//' or a trailing '/'.");
    }
    if (parts.length === 3 && parts[2] !== "rw") {
      issues.add("VOLUME_MODE_UNSUPPORTED", itemPath, "Only read-write volumes are supported: remove the mode or use 'rw'.");
    }
    if (sources.has(source) || targets.has(target)) {
      issues.add("VOLUME_DUPLICATE", itemPath, "A volume name and a target path can each be used once.");
    }
    sources.add(source);
    targets.add(target);
    if (!declared.has(source)) {
      issues.add("VOLUME_UNDECLARED", itemPath, `Declare the volume '${source}' under the top-level 'volumes'.`);
    }
    if (source !== required.name && !policy.extraVolumes) {
      issues.add("VOLUME_EXTRA_NOT_ALLOWED", itemPath, `Only the '${required.name}' volume, mounted at ${required.target}, is available for this site type.`);
    }
    volumes.push({ volume: source, containerPath: target });
  });
  if (!hasRequired) {
    issues.add("VOLUME_REQUIRED_MISSING", raw === undefined ? servicePath : path, `Mount the '${required.name}' volume at ${required.target}: this site type needs it.`);
  }
  return volumes;
}

function validateExpose(ctx: Context, raw: unknown, path: TemplatePath): number[] {
  const { issues, module } = ctx;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.mismatch(path, "a list");
    return [];
  }
  const port = SITE_TEMPLATE_MODULES[module].internalPort;
  const message = `Only the site's own port, ${port}, can be exposed (one entry, no host mapping or protocol).`;
  if (raw.length > 1) issues.add("EXPOSE_INVALID", path, message);
  const exposed = raw.slice(0, 1).filter((entry: unknown, index) => {
    const matches = (isSafeInt(entry) || (typeof entry === "string" && /^[1-9][0-9]{0,4}$/.test(entry))) && Number(entry) === port;
    if (!matches) issues.add("EXPOSE_INVALID", [...path, index], message);
    return matches;
  });
  return exposed.map(() => port);
}

interface LimitsResult {
  readonly limits: SiteTemplateSpec["service"]["limits"];
  readonly memoryBytes: bigint | null;
}

function validateDeploy(ctx: Context, raw: unknown, path: TemplatePath): LimitsResult {
  const { issues, module } = ctx;
  if (raw === undefined) return { limits: null, memoryBytes: BigInt(SITE_TEMPLATE_MODULES[module].defaultLimits.memoryBytes) };
  const unknown: LimitsResult = { limits: null, memoryBytes: null };
  if (!isMapping(raw)) {
    issues.mismatch(path, "a mapping");
    return unknown;
  }
  checkKeys(issues, raw, path, ["resources"], DEPLOY_REFUSALS);
  const resources = own(raw, "resources");
  const incomplete = (at: TemplatePath): LimitsResult => {
    issues.add("LIMIT_INCOMPLETE", at, "A 'deploy' block needs both resources.limits.cpus and resources.limits.memory.");
    return unknown;
  };
  if (resources === undefined) return incomplete(path);
  const resourcesPath = [...path, "resources"];
  if (!isMapping(resources)) {
    issues.mismatch(resourcesPath, "a mapping");
    return unknown;
  }
  checkKeys(issues, resources, resourcesPath, ["limits"], RESOURCES_REFUSALS);
  const limits = own(resources, "limits");
  if (limits === undefined) return incomplete(resourcesPath);
  const limitsPath = [...resourcesPath, "limits"];
  if (!isMapping(limits)) {
    issues.mismatch(limitsPath, "a mapping");
    return unknown;
  }
  checkKeys(issues, limits, limitsPath, ["cpus", "memory"], LIMITS_REFUSALS);
  const cpus = own(limits, "cpus");
  const memory = own(limits, "memory");
  if (cpus === undefined || memory === undefined) return incomplete(limitsPath);
  const cpuMilli = parseCpus(ctx, cpus, [...limitsPath, "cpus"]);
  const memoryBytes = parseMemory(ctx, memory, [...limitsPath, "memory"]);
  return {
    limits: cpuMilli !== null && memoryBytes !== null ? { cpuMilli, memoryBytes: memoryBytes.toString() } : null,
    memoryBytes,
  };
}

/** Integer arithmetic only: "0.1" -> 100, "1.5" -> 1500. */
function parseCpus(ctx: Context, raw: unknown, path: TemplatePath): number | null {
  const { issues, policy } = ctx;
  if (typeof raw !== "string" && typeof raw !== "number") {
    issues.mismatch(path, "a number or a string such as \"1.5\"");
    return null;
  }
  const match = CPU_PATTERN.exec(String(raw));
  if (!match) {
    issues.add("LIMIT_CPU_FORMAT", path, "cpus is a decimal number of at most 3 decimals, such as 0.5 or \"1.5\".");
    return null;
  }
  const milli = Number(match[1]) * 1000 + Number((match[2] ?? "").slice(1).padEnd(3, "0"));
  if (milli < policy.limits.minCpuMilli || milli > MAX_SERVICE_CPU_MILLI) {
    issues.add("LIMIT_CPU_RANGE", path, `cpus must be between ${policy.limits.minCpuMilli / 1000} and ${MAX_SERVICE_CPU_MILLI / 1000}.`);
    return null;
  }
  return milli;
}

/** "512M" -> 536870912n; a bare integer is bytes; binary units. */
function parseMemory(ctx: Context, raw: unknown, path: TemplatePath): bigint | null {
  const { issues, policy } = ctx;
  if (typeof raw !== "string" && typeof raw !== "number") {
    issues.mismatch(path, "a string such as \"512M\" or a number of bytes");
    return null;
  }
  const match = MEMORY_PATTERN.exec(String(raw));
  if (!match) {
    issues.add("LIMIT_MEMORY_FORMAT", path, "memory is a whole number of bytes or a size such as 512M or 1G.");
    return null;
  }
  const unit = (match[2] ?? "b").charAt(0).toLowerCase();
  const bytes = BigInt(match[1] ?? "0") * 1024n ** BigInt("bkmg".indexOf(unit));
  if (bytes < policy.limits.minMemoryBytes || bytes > MAX_SERVICE_MEMORY_BYTES) {
    issues.add(
      "LIMIT_MEMORY_RANGE",
      path,
      `memory must be between ${policy.limits.minMemoryBytes / 1024n ** 2n}M and ${MAX_SERVICE_MEMORY_BYTES / 1024n ** 3n}G.`,
    );
    return null;
  }
  return bytes;
}

function validatePhp(ctx: Context, root: Mapping, memoryBytes: bigint | null): SiteTemplateSpec["php"] {
  const { issues, policy } = ctx;
  const raw = own(root, "x-hp-php");
  if (raw === undefined) return null;
  const path: TemplatePath = ["x-hp-php"];
  if (!policy.phpSettings) {
    issues.add("PHP_NOT_SUPPORTED", path, "This site type does not support PHP settings: remove 'x-hp-php'.", "key");
    return null;
  }
  if (!isMapping(raw)) {
    issues.mismatch(path, "a mapping");
    return null;
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    issues.add("PHP_EMPTY", path, "Set at least one PHP setting or remove 'x-hp-php'.");
    return null;
  }
  const settings = new Map<PhpSettingKey, string>();
  for (const [key, value] of entries) {
    const entryPath = [...path, key];
    if (!(PHP_SETTING_KEYS as readonly string[]).includes(key)) {
      issues.add("PHP_KEY_UNKNOWN", entryPath, `'${clip(key)}' is not a PHP setting you can change. Allowed: ${PHP_SETTING_KEYS.join(", ")}.`, "key");
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      issues.mismatch(entryPath, "a string or a number");
      continue;
    }
    const problem = phpSettingProblem(key as PhpSettingKey, String(value));
    if (problem) issues.add("PHP_VALUE_INVALID", entryPath, problem);
    else settings.set(key as PhpSettingKey, String(value));
  }
  const bytesOf = (key: PhpSettingKey): bigint | undefined => {
    const value = settings.get(key);
    return value === undefined ? undefined : phpSizeToBytes(value);
  };
  const upload = bytesOf("upload_max_filesize");
  const post = bytesOf("post_max_size");
  if ((upload ?? post) !== undefined && (post ?? PHP_SETTING_DEFAULTS.post_max_size) < (upload ?? PHP_SETTING_DEFAULTS.upload_max_filesize)) {
    issues.add("PHP_POST_BELOW_UPLOAD", path, "post_max_size must be at least upload_max_filesize (PHP defaults: 8M and 2M).");
  }
  const memory = bytesOf("memory_limit");
  if (memory !== undefined && memoryBytes !== null && memory > memoryBytes) {
    issues.add("PHP_MEMORY_EXCEEDS_CONTAINER", [...path, "memory_limit"], "memory_limit must not exceed the container memory.");
  }
  return [...settings].map(([key, value]) => ({ key, value })).sort((a, b) => compare(a.key, b.key));
}

const byPosition = (a: SiteTemplateIssue, b: SiteTemplateIssue): number =>
  (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0) || compare(a.path, b.path) || compare(a.code, b.code);

function fail(issues: readonly SiteTemplateIssue[]): SiteTemplateValidationResult {
  return { ok: false, errors: [...issues].sort(byPosition).slice(0, SITE_TEMPLATE_MAX_ISSUES) };
}

/**
 * Validates a parsed document for `module`. `locate` (from `parseTemplateYaml`) adds line and column to each issue.
 * Never throws: an unexpected failure is one SPEC_INTERNAL issue.
 */
export function validateSiteTemplate(value: unknown, module: SiteTypeKey, locate?: TemplateLocator): SiteTemplateValidationResult {
  try {
    const issues = new Issues(locate);
    const ctx: Context = { issues, module, policy: getSiteTemplatePolicy(module) };
    if (!isMapping(value)) {
      issues.add("DOCUMENT_NOT_MAPPING", [], "The template must be a mapping of keys (x-hp-module, services, ...).");
      return fail(issues.list);
    }
    checkKeys(issues, value, [], ["x-hp-module", "x-hp-parameters", "x-hp-php", "services", "volumes"], ROOT_REFUSALS);

    const declared = own(value, "x-hp-module");
    if (declared === undefined) issues.add("MODULE_MISSING", [], `Add 'x-hp-module: ${module}'.`);
    else if (typeof declared !== "string") issues.mismatch(["x-hp-module"], "a string");
    else if (declared !== module) issues.add("MODULE_MISMATCH", ["x-hp-module"], `This template is for '${module}', not '${clip(declared)}'.`);

    const parameters = validateParameters(ctx, value);
    const declaredVolumes = validateDeclaredVolumes(ctx, value);
    const { service, memoryBytes } = validateServices(ctx, value, parameters, declaredVolumes);
    const php = validatePhp(ctx, value, memoryBytes);
    if (issues.list.length > 0) return fail(issues.list);

    const parsed = SiteTemplateSpecSchema.safeParse({ specVersion: 1, module, parameters: parameters.parameters, service, php });
    if (!parsed.success) {
      const at = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
      issues.add("SPEC_INTERNAL", [], `The validated template does not match the specification (${at}). This is a platform bug.`);
      return fail(issues.list);
    }
    return { ok: true, spec: parsed.data };
  } catch {
    return { ok: false, errors: [{ path: "", code: "SPEC_INTERNAL", message: "The template could not be checked. This is a platform bug." }] };
  }
}

/** Parses the YAML subset, then validates it. A syntax error is one issue with path "" and the position. */
export function validateSiteTemplateSource(source: string, module: SiteTypeKey): SiteTemplateValidationResult {
  const parsed = parseTemplateYaml(source);
  if (!parsed.ok) {
    const [error] = parsed.errors;
    return { ok: false, errors: [{ path: "", line: error.line, column: error.column, code: error.code, message: error.message }] };
  }
  return validateSiteTemplate(parsed.value, module, parsed.locate);
}
