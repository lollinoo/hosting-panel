import type { SiteTemplatePreviewDto } from "./dto.js";
import { SITE_TEMPLATE_MODULES } from "./modules.js";
import { sampleSiteTemplateParameterMap } from "./parameters.js";
import {
  PHP_VERSION_PARAMETER_KEY,
  SITE_TEMPLATE_ENV_VALUE_MAX,
  type SiteTemplateParameterMap,
  type SiteTemplateParameterValue,
  type SiteTemplateSpec,
} from "./spec.js";

// Pure and browser-safe: no node: import, no I/O, the arguments are never mutated.

export const MODULE_IMAGE_VARIABLE = "HP_MODULE_IMAGE";
/** The variables a template may use besides its own parameters. HP_MODULE_IMAGE is valid only as a whole image. */
export const SITE_TEMPLATE_MAGIC_VARIABLES = ["HP_SITE_ID", "HP_SITE_DOMAIN", "HP_SITE_URL", MODULE_IMAGE_VARIABLE] as const;

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Piece = { readonly text: string } | { readonly name: string };
type ScanFailure = { ok: false; offset: number; reason: "lone_dollar" | "unterminated" | "bad_name" };

/** Grammar: "${NAME}" with NAME = [A-Za-z_][A-Za-z0-9_]*, and "$$" is one literal "$". Any other "$" is an error. */
function scan(raw: string): { ok: true; pieces: Piece[] } | ScanFailure {
  const pieces: Piece[] = [];
  let text = "";
  let index = 0;
  while (index < raw.length) {
    const char = raw.charAt(index);
    if (char !== "$") {
      text += char;
      index += 1;
    } else if (raw.charAt(index + 1) === "$") {
      text += "$";
      index += 2;
    } else if (raw.charAt(index + 1) !== "{") {
      return { ok: false, offset: index, reason: "lone_dollar" };
    } else {
      const end = raw.indexOf("}", index + 2);
      if (end < 0) return { ok: false, offset: index, reason: "unterminated" };
      const name = raw.slice(index + 2, end);
      if (!VARIABLE_NAME_PATTERN.test(name)) return { ok: false, offset: index, reason: "bad_name" };
      if (text) pieces.push({ text });
      pieces.push({ name });
      text = "";
      index = end + 1;
    }
  }
  if (text) pieces.push({ text });
  return { ok: true, pieces };
}

export type SiteTemplateScan = { ok: true; names: string[] } | ScanFailure;

/** The distinct variable names of a value, in first-seen order, or the position of the first malformed "$". */
export function listSiteTemplateVariables(raw: string): SiteTemplateScan {
  const scanned = scan(raw);
  if (!scanned.ok) return scanned;
  const names = new Set<string>();
  for (const piece of scanned.pieces) if ("name" in piece) names.add(piece.name);
  return { ok: true, names: [...names] };
}

export type SiteTemplateRenderErrorCode =
  | "unknown_variable"
  | "invalid_interpolation"
  | "missing_parameter"
  | "invalid_php_version"
  | "value_too_long"
  | "unknown_module";

export class SiteTemplateRenderError extends Error {
  public readonly code: SiteTemplateRenderErrorCode;

  public constructor(code: SiteTemplateRenderErrorCode, message: string) {
    super(message);
    this.name = "SiteTemplateRenderError";
    this.code = code;
  }
}

/** One pass over the value: the text that is substituted is never expanded again. */
export function interpolateSiteTemplateValue(raw: string, vars: ReadonlyMap<string, string>): string {
  const scanned = scan(raw);
  if (!scanned.ok) {
    throw new SiteTemplateRenderError("invalid_interpolation", `Invalid '$' at position ${scanned.offset} (${scanned.reason})`);
  }
  return scanned.pieces
    .map((piece) => {
      if ("text" in piece) return piece.text;
      const value = vars.get(piece.name);
      if (value === undefined) throw new SiteTemplateRenderError("unknown_variable", `Unknown variable '${piece.name}'`);
      return value;
    })
    .join("");
}

export interface SiteTemplateRenderContext {
  readonly siteId: string;
  readonly siteDomain: string;
  readonly siteUrl: string;
}

export interface RenderedSiteTemplate {
  /** The declarative configuration of the service revision: environment first, structured keys last so they win. */
  readonly configuration: Record<string, unknown>;
  readonly resourceLimits: { cpuMilli: number; memoryBytes: string };
  /** Always empty in this release. */
  readonly secretRefs: Record<string, string>;
  readonly phpVersion: string | null;
}

/**
 * Renders a template spec and its resolved parameter values into the service revision a site stores.
 * Deterministic; the template and version ids are not part of the result. `values` must hold every
 * declared parameter as an own property (resolveSiteTemplateParameters guarantees it).
 */
export function renderSiteTemplate(
  spec: SiteTemplateSpec,
  values: SiteTemplateParameterMap,
  context: SiteTemplateRenderContext,
): RenderedSiteTemplate {
  if (!Object.hasOwn(SITE_TEMPLATE_MODULES, spec.module)) {
    throw new SiteTemplateRenderError("unknown_module", `Unknown module '${spec.module}'`);
  }
  const facts = SITE_TEMPLATE_MODULES[spec.module];

  const vars = new Map<string, string>([
    ["HP_SITE_ID", context.siteId],
    ["HP_SITE_DOMAIN", context.siteDomain],
    ["HP_SITE_URL", context.siteUrl],
  ]);
  for (const { key } of spec.parameters) {
    const value: SiteTemplateParameterValue | undefined = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) throw new SiteTemplateRenderError("missing_parameter", `No value for parameter '${key}'`);
    vars.set(key, String(value));
  }

  let phpVersion: string | null = null;
  if (spec.parameters.some((parameter) => parameter.key === PHP_VERSION_PARAMETER_KEY)) {
    const value = values[PHP_VERSION_PARAMETER_KEY];
    if (typeof value !== "string" || !facts.phpVersions.includes(value)) {
      throw new SiteTemplateRenderError("invalid_php_version", `Unsupported PHP version '${String(value)}'`);
    }
    phpVersion = value;
  }

  const render = (raw: string): string => {
    const value = interpolateSiteTemplateValue(raw, vars);
    if (value.length > SITE_TEMPLATE_ENV_VALUE_MAX) {
      throw new SiteTemplateRenderError("value_too_long", `A rendered value is longer than ${SITE_TEMPLATE_ENV_VALUE_MAX} characters`);
    }
    return value;
  };

  let image: string;
  if (spec.service.image === `\${${MODULE_IMAGE_VARIABLE}}`) {
    if (phpVersion === null) {
      throw new SiteTemplateRenderError("invalid_php_version", "The module image needs a php_version parameter");
    }
    image = facts.image(phpVersion);
  } else {
    image = render(spec.service.image);
  }

  const entries: [string, unknown][] = [
    ...spec.service.environment.map((entry): [string, unknown] => [entry.name, render(entry.value)]),
    ["image", image],
    ["internalPort", spec.service.expose[0] ?? facts.internalPort],
    ["exposeHttp", facts.exposeHttp],
    ["siteMail", facts.siteMail],
    ["volumeMounts", spec.service.volumes.map((mount) => ({ volumeSuffix: mount.volume, containerPath: mount.containerPath }))],
  ];
  if (spec.php !== null) entries.push(["phpIni", Object.fromEntries(spec.php.map((setting) => [setting.key, setting.value]))]);

  const limits = spec.service.limits ?? facts.defaultLimits;
  return {
    configuration: Object.fromEntries(entries),
    resourceLimits: { cpuMilli: limits.cpuMilli, memoryBytes: limits.memoryBytes },
    secretRefs: {},
    phpVersion,
  };
}

/** Example site used by the Validate preview. */
export const SITE_TEMPLATE_PREVIEW_CONTEXT: SiteTemplateRenderContext = {
  siteId: "site_preview",
  siteDomain: "example.com",
  siteUrl: "https://example.com",
};

/**
 * The rendered service as arrays only. The environment is a name/value list built from the spec and
 * `configuration` is never returned: an environment variable called PASSWORD would redact the answer.
 */
export function toSiteTemplatePreview(
  spec: SiteTemplateSpec,
  values: SiteTemplateParameterMap = sampleSiteTemplateParameterMap(spec),
): SiteTemplatePreviewDto {
  const { configuration, resourceLimits } = renderSiteTemplate(spec, values, SITE_TEMPLATE_PREVIEW_CONTEXT);
  return {
    module: spec.module,
    image: String(configuration.image),
    internalPort: Number(configuration.internalPort),
    exposeHttp: configuration.exposeHttp === true,
    limits: resourceLimits,
    environment: spec.service.environment.map((entry) => ({ name: entry.name, value: String(configuration[entry.name]) })),
    volumes: spec.service.volumes.map((mount) => ({ volume: mount.volume, containerPath: mount.containerPath })),
    phpSettings: (spec.php ?? []).map((setting) => ({ key: setting.key, value: setting.value })),
    parameters: spec.parameters.map((parameter) => ({
      key: parameter.key,
      label: parameter.label,
      type: parameter.type,
      customer: parameter.customer,
      value: values[parameter.key] as SiteTemplateParameterValue,
    })),
  };
}
