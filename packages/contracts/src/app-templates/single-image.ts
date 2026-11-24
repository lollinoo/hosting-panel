// A one-component template written from a few fields (ADR-0043): the single-image form of the administrator.
// The function below writes an HCP-STACK/v1 source and nothing else: it saves nothing, installs nothing and contacts
// nobody. The source it writes is validated by the server like any hand-written one; what is refused here is only what
// could never be a valid source, so that the form can say which field is wrong.

import { APP_IMAGE_ALLOWLIST, findAppImageAllowlistEntry, type AppImageAllowlistEntry } from "./images.js";
import {
  APP_STACK_DIGEST_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_STACK_COMPONENT_KEY_MAX,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_LIMITS,
  APP_TEMPLATE_PARAMETER_KEY_PATTERN,
  APP_TEMPLATE_SPEC_VERSION,
} from "./limits.js";
import {
  appStackContainerPathProblem,
  appStackEnvValueNameProblem,
  appStackHealthPathProblem,
  appStackSecretEnvNameProblem,
  appStackTextProblem,
} from "./text.js";

/** The volume of the one folder the form lets the application keep. */
export const APP_SINGLE_IMAGE_VOLUME_KEY = "data";
export const APP_SINGLE_IMAGE_DEFAULT_COMPONENT_KEY = "app";
/** A tag as a registry accepts it. "latest" is refused: the digest pins the image, the tag is for people. */
export const APP_SINGLE_IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const APP_SINGLE_IMAGE_SETTINGS_MAX = 24;

export type AppSingleImageSetting =
  /** A value the administrator fixes: the same in every application made from the template. */
  | { readonly kind: "fixed"; readonly name: string; readonly value: string }
  /** A value the customer chooses when installing, with the administrator's default. */
  | { readonly kind: "customer"; readonly name: string; readonly label: string; readonly default: string }
  /** A private value only the customer sets; the software reads it from the file whose path is in `name` (…_FILE). */
  | { readonly kind: "private"; readonly name: string; readonly label: string; readonly required: boolean };

export type AppSingleImageHealth =
  | { readonly kind: "none" }
  | { readonly kind: "tcp" }
  | { readonly kind: "http"; readonly path: string };

export interface AppSingleImageTemplateInput {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly componentKey: string;
  /** One of the repositories of the allowlist, exactly as its row writes it. */
  readonly repository: string;
  /** For people only; null = none. */
  readonly tag: string | null;
  /** "sha256:" and 64 hexadecimal characters. */
  readonly digest: string;
  /** The port the software listens on; null = it listens on none. */
  readonly port: number | null;
  /** Customers can give the application a web address (HTTP on `port`). */
  readonly webAddress: boolean;
  readonly health: AppSingleImageHealth;
  readonly settings: readonly AppSingleImageSetting[];
  /** The one folder whose content is kept across restarts and updates; null = nothing is kept. */
  readonly dataPath: string | null;
  readonly cpuMilli: number;
  readonly memoryMb: number;
}

export const APP_SINGLE_IMAGE_PROBLEM_CODES = [
  "name",
  "category",
  "description",
  "component_key",
  "repository_not_allowed",
  "tag",
  "digest",
  "image_too_long",
  "port",
  "web_needs_port",
  "web_needs_health",
  "health_needs_port",
  "health_path",
  "settings_too_many",
  "private_too_many",
  "setting_name",
  "setting_name_reserved",
  "setting_name_private",
  "setting_name_duplicate",
  "setting_key",
  "setting_label",
  "setting_value",
  "data_path",
  "cpu",
  "memory",
] as const;
export type AppSingleImageProblemCode = (typeof APP_SINGLE_IMAGE_PROBLEM_CODES)[number];

/** `field` is a field of the input; for a setting, "settings.<index>". */
export interface AppSingleImageProblem {
  readonly field: string;
  readonly code: AppSingleImageProblemCode;
}

export type AppSingleImageTemplateResult =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly problems: readonly AppSingleImageProblem[] };

const MIB = 1_048_576;
const isPlainText = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max && appStackTextProblem(value) === null && !/[\r\n]/.test(value);
/** A YAML double-quoted scalar: the JSON form of a string is one. */
const quoted = (text: string): string => JSON.stringify(text);
/** In a value a "$" starts a placeholder: a literal one is written twice. */
const literal = (text: string): string => text.replaceAll("$", "$$$$");

/** The parameter a customer or private setting becomes: the lower-case name, without the "_FILE" of a private one. */
export function appSingleImageParameterKey(setting: Pick<AppSingleImageSetting, "kind" | "name">): string {
  const base = setting.kind === "private" && setting.name.endsWith("_FILE") ? setting.name.slice(0, -"_FILE".length) : setting.name;
  return base.toLowerCase();
}

/** 250 -> "0.25", 1000 -> "1", 1500 -> "1.5". */
function cpus(cpuMilli: number): string {
  const whole = Math.trunc(cpuMilli / 1000);
  const rest = String(cpuMilli % 1000).padStart(3, "0").replace(/0+$/, "");
  return rest === "" ? String(whole) : `${String(whole)}.${rest}`;
}

const imageOf = (input: AppSingleImageTemplateInput): string =>
  `${input.repository}${input.tag === null ? "" : `:${input.tag}`}@${input.digest}`;

function problemsOf(input: AppSingleImageTemplateInput, allowlist: readonly AppImageAllowlistEntry[]): AppSingleImageProblem[] {
  const problems: AppSingleImageProblem[] = [];
  const add = (field: string, code: AppSingleImageProblemCode): void => {
    problems.push({ field, code });
  };
  const L = APP_TEMPLATE_LIMITS;
  if (!isPlainText(input.name, L.stackName, 1)) add("name", "name");
  if (typeof input.category !== "string" || !APP_TEMPLATE_CATEGORY_PATTERN.test(input.category)) add("category", "category");
  if (!isPlainText(input.description, L.stackDescription)) add("description", "description");
  if (
    typeof input.componentKey !== "string" ||
    !APP_STACK_KEY_PATTERN.test(input.componentKey) ||
    input.componentKey.length > APP_STACK_COMPONENT_KEY_MAX
  ) {
    add("componentKey", "component_key");
  }

  const repositoryOk = typeof input.repository === "string" && findAppImageAllowlistEntry(input.repository, allowlist) !== null;
  if (!repositoryOk) add("repository", "repository_not_allowed");
  const tagOk = input.tag === null || (typeof input.tag === "string" && APP_SINGLE_IMAGE_TAG_PATTERN.test(input.tag) && input.tag !== "latest");
  if (!tagOk) add("tag", "tag");
  const digestOk = typeof input.digest === "string" && APP_STACK_DIGEST_PATTERN.test(input.digest);
  if (!digestOk) add("digest", "digest");
  if (repositoryOk && tagOk && digestOk && imageOf(input).length > L.imageReferenceLength) add("repository", "image_too_long");

  const portOk = input.port === null || (Number.isSafeInteger(input.port) && input.port >= 1 && input.port <= 65_535);
  if (!portOk) add("port", "port");
  if (input.webAddress && input.port === null) add("webAddress", "web_needs_port");
  if (input.webAddress && input.health.kind === "none") add("health", "web_needs_health");
  if (input.health.kind !== "none" && input.port === null) add("health", "health_needs_port");
  if (input.health.kind === "http" && (typeof input.health.path !== "string" || appStackHealthPathProblem(input.health.path) !== null)) {
    add("health", "health_path");
  }

  if (input.settings.length > APP_SINGLE_IMAGE_SETTINGS_MAX) add("settings", "settings_too_many");
  if (input.settings.filter((setting) => setting.kind === "private").length > L.secretParameters) add("settings", "private_too_many");
  const names = new Set<string>();
  const keys = new Set<string>();
  input.settings.forEach((setting, index) => {
    const field = `settings.${String(index)}`;
    if (typeof setting.name !== "string") return add(field, "setting_name");
    if (setting.kind === "private") {
      if (appStackSecretEnvNameProblem(setting.name) !== null) return add(field, "setting_name_private");
    } else {
      const nameProblem = appStackEnvValueNameProblem(setting.name);
      if (nameProblem !== null) return add(field, nameProblem === "invalid" ? "setting_name" : "setting_name_reserved");
    }
    if (names.has(setting.name)) return add(field, "setting_name_duplicate");
    names.add(setting.name);
    if (setting.kind === "fixed") {
      if (!isPlainText(setting.value, L.envValueLength)) add(field, "setting_value");
      return;
    }
    const key = appSingleImageParameterKey(setting);
    if (!APP_TEMPLATE_PARAMETER_KEY_PATTERN.test(key) || key.startsWith("hp_")) return add(field, "setting_key");
    if (keys.has(key)) return add(field, "setting_name_duplicate");
    keys.add(key);
    if (!isPlainText(setting.label, L.parameterLabel, 1)) add(field, "setting_label");
    if (setting.kind === "customer" && !isPlainText(setting.default, L.stringValue)) add(field, "setting_value");
  });

  if (input.dataPath !== null && (typeof input.dataPath !== "string" || appStackContainerPathProblem(input.dataPath) !== null || input.dataPath.includes(":"))) {
    add("dataPath", "data_path");
  }
  if (!Number.isSafeInteger(input.cpuMilli) || input.cpuMilli < L.cpuMilliMin || input.cpuMilli > L.cpuMilliMax) add("cpuMilli", "cpu");
  if (
    !Number.isSafeInteger(input.memoryMb) ||
    input.memoryMb * MIB < L.memoryBytesMin ||
    input.memoryMb * MIB > L.memoryBytesMax
  ) {
    add("memoryMb", "memory");
  }
  return problems;
}

/**
 * The template source of a one-component application, or the fields that cannot be written. Pure and synchronous.
 * `allowlist` is the list the server validates against (tests pass their own).
 */
export function buildAppSingleImageTemplate(
  input: AppSingleImageTemplateInput,
  allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST,
): AppSingleImageTemplateResult {
  const problems = problemsOf(input, allowlist);
  if (problems.length > 0) return { ok: false, problems };

  const lines: string[] = ["x-hp-stack:", `  schemaVersion: ${String(APP_TEMPLATE_SPEC_VERSION)}`, `  name: ${quoted(input.name)}`, `  category: ${input.category}`];
  if (input.description !== "") lines.push(`  description: ${quoted(input.description)}`);

  const parameters = input.settings.filter((setting) => setting.kind !== "fixed");
  if (parameters.length > 0) {
    lines.push("x-hp-parameters:");
    for (const setting of parameters) {
      lines.push(`  - key: ${appSingleImageParameterKey(setting)}`, `    label: ${quoted(setting.label)}`);
      if (setting.kind === "private") lines.push("    type: secret", `    required: ${String(setting.required)}`);
      else lines.push("    type: string", `    default: ${quoted(setting.default)}`);
      lines.push("    customer: true");
    }
  }

  lines.push("services:", `  ${input.componentKey}:`, `    image: ${imageOf(input)}`);
  if (input.settings.length > 0) {
    lines.push("    environment:");
    for (const setting of input.settings) {
      lines.push(`      - name: ${setting.name}`);
      if (setting.kind === "fixed") lines.push(`        value: ${quoted(literal(setting.value))}`);
      else if (setting.kind === "customer") lines.push(`        value: ${quoted(`\${${appSingleImageParameterKey(setting)}}`)}`);
      else lines.push(`        secret: ${appSingleImageParameterKey(setting)}`);
    }
  }
  if (input.dataPath !== null) lines.push("    volumes:", `      - ${quoted(`${APP_SINGLE_IMAGE_VOLUME_KEY}:${input.dataPath}`)}`);
  if (input.port !== null) lines.push("    expose:", `      - ${String(input.port)}`);
  if (input.health.kind !== "none" && input.port !== null) {
    lines.push("    healthcheck:", `      kind: ${input.health.kind}`, `      port: ${String(input.port)}`);
    if (input.health.kind === "http") lines.push(`      path: ${quoted(input.health.path)}`);
    lines.push(
      `      intervalSeconds: ${String(APP_TEMPLATE_LIMITS.healthIntervalDefault)}`,
      `      timeoutSeconds: ${String(APP_TEMPLATE_LIMITS.healthTimeoutDefault)}`,
    );
  }
  lines.push("    deploy:", "      resources:", "        limits:", `          cpus: ${quoted(cpus(input.cpuMilli))}`, `          memory: ${String(input.memoryMb)}M`);
  if (input.dataPath !== null) lines.push("volumes:", `  ${APP_SINGLE_IMAGE_VOLUME_KEY}: {}`);
  if (input.webAddress && input.port !== null) {
    lines.push("x-hp-ingress:", `  - service: ${input.componentKey}`, `    port: ${String(input.port)}`, "    protocol: http");
  }
  return { ok: true, source: `${lines.join("\n")}\n` };
}
