/**
 * Compiler of an application template: the re-validated source, the customer's values and the stack's secret versions
 * become the deterministic, secret-free ApprovedStackPlan; the preview is the same body compiled with the defaults.
 * A v1 source gives a version 1 plan, byte for byte as before; a v2 source gives a version 2 plan, whose components
 * also carry the run profile and the environment secrets as pieces (text and references, never a value).
 * Pure, synchronous and never throws; a message never echoes a value.
 */
import {
  APP_FOREIGN_ID_PATTERN,
  APP_IMAGE_ALLOWLIST,
  APP_STACK_ID_PATTERN,
  APP_STACK_PLAN_MAX_BYTES,
  APP_STACK_PLAN_SCHEMA_VERSION,
  APP_STACK_PLAN_SCHEMA_VERSION_2,
  APP_TEMPLATE_ISSUE_REASON,
  APP_TEMPLATE_LIMITS,
  ApprovedStackPlanSchema,
  appStackArgvItemProblem,
  appStackTextProblem,
  appTemplateServiceProfile,
  appTemplateValueText,
  findAppImageAllowlistEntry,
  resolveAppTemplateParameters,
  sortAppTemplateIssues,
  toAppStackPreview,
  type AppImageAllowlistEntry,
  type AppStackPlanComponentV1,
  type AppStackPlanComponentV2,
  type AppStackPlanSecretEnvEntry,
  type AppStackPreview,
  type AppTemplateIssue,
  type AppTemplateIssueCode,
  type AppTemplateParameterEntry,
  type AppTemplateParameterMap,
  type AppTemplateSpec,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { orderAppTemplateServices } from "./app-template-graph.js";
import { validateAppTemplateSource, type AppTemplateValidationOptions } from "./app-template-validation.js";
import { expandPieces, scanInterpolation, type InterpolationPiece } from "./site-template-interpolation.js";

export interface AppStackPlanIds {
  readonly stackId: string;
  readonly organizationId: string;
  readonly hostAllocationId: string;
  readonly templateVersionId: string;
  readonly revisionId: string;
}

export interface AppStackCompileInput {
  /** The immutable app_template_versions.source, re-validated every time. */
  readonly source: string;
  /** The customer's given entries (app_stack_parameters). */
  readonly parameters: readonly AppTemplateParameterEntry[];
  /** parameterKey → current app_stack_secrets.version of this stack. */
  readonly secretVersions: ReadonlyMap<string, number>;
  readonly ids: AppStackPlanIds;
}

export type AppStackCompileResult =
  | { readonly ok: true; readonly plan: ApprovedStackPlan }
  /** Sorted, at most 50. */
  | { readonly ok: false; readonly issues: AppTemplateIssue[] };

export type AppTemplatePreviewResult =
  | { readonly ok: true; readonly spec: AppTemplateSpec; readonly preview: AppStackPreview }
  | { readonly ok: false; readonly errors: AppTemplateIssue[] };

type PlanTail = Pick<ApprovedStackPlan, "volumes" | "ingress">;
type PlanBody =
  | (PlanTail & { readonly schemaVersion: typeof APP_STACK_PLAN_SCHEMA_VERSION; readonly components: AppStackPlanComponentV1[] })
  | (PlanTail & { readonly schemaVersion: typeof APP_STACK_PLAN_SCHEMA_VERSION_2; readonly components: AppStackPlanComponentV2[] });
type SecretEnvPiece = AppStackPlanSecretEnvEntry["pieces"][number];
type Refusal = { readonly ok: false; readonly issues: AppTemplateIssue[] };
type PlanResult = { readonly ok: true; readonly plan: ApprovedStackPlan } | Refusal;

const MESSAGES = {
  SECRET_MISSING: "Set this secret before the stack is deployed.",
  PARAM_VALUE_ARGV_UNSAFE: "A command argument cannot be empty, start with '-' or name a shell.",
  RENDERED_VALUE_FORBIDDEN: "The value contains content that is not allowed once filled in.",
  PLAN_TOO_LARGE: `The stack plan would exceed ${APP_STACK_PLAN_MAX_BYTES} bytes.`,
  SPEC_INTERNAL: "The stack could not be compiled. This is a platform bug.",
} as const satisfies Partial<Record<AppTemplateIssueCode, string>>;

const issue = (code: keyof typeof MESSAGES, path: string): AppTemplateIssue => ({
  path,
  code,
  reason: APP_TEMPLATE_ISSUE_REASON[code],
  message: MESSAGES[code],
});
const refuse = (issues: AppTemplateIssue[]): Refusal => ({ ok: false, issues: sortAppTemplateIssues(issues) });
const internal = (): Refusal => refuse([issue("SPEC_INTERNAL", "")]);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const parameterPath = (key: string | undefined): string => (key === undefined ? "" : `parameters.${key}`);
const isVariable = (piece: InterpolationPiece): piece is { readonly variable: string } => "variable" in piece;

/** The validator already accepted every interpolation: a failure here is a platform bug (caught as SPEC_INTERNAL). */
function piecesOf(raw: string): readonly InterpolationPiece[] {
  const scan = scanInterpolation(raw);
  if (!scan.ok) throw new Error("unvalidated interpolation");
  return scan.pieces;
}

const secretKeysOf = (spec: AppTemplateSpec): Set<string> =>
  new Set(spec.parameters.flatMap((parameter) => (parameter.type === "secret" ? [parameter.key] : [])));

/**
 * The secret parameters a template delivers in a container's environment (v2): an entry `secret: <key>` whose name does
 * not end in `_FILE`, and every `${key}` inside a value. Always empty for a v1 template. The API holds these secrets to
 * the environment size limit when they are set.
 */
export function appTemplateEnvironmentSecretKeys(spec: AppTemplateSpec): Set<string> {
  const secrets = secretKeysOf(spec);
  const keys = new Set<string>();
  for (const service of spec.services) {
    for (const entry of service.environment) {
      if ("secretParameter" in entry) {
        if (!entry.name.endsWith("_FILE")) keys.add(entry.secretParameter);
        continue;
      }
      const scan = scanInterpolation(entry.value);
      if (!scan.ok) continue;
      for (const piece of scan.pieces) if (isVariable(piece) && secrets.has(piece.variable)) keys.add(piece.variable);
    }
  }
  return keys;
}

/** Steps 4–7: secrets, components in start order, volumes, ingress. */
function compileBody(
  spec: AppTemplateSpec,
  values: AppTemplateParameterMap,
  versionOf: (parameterKey: string) => number | undefined,
  allowlist: readonly AppImageAllowlistEntry[],
): { readonly ok: true; readonly body: PlanBody } | Refusal {
  const issues: AppTemplateIssue[] = [];
  const versions = new Map<string, number>();
  for (const parameter of spec.parameters) {
    if (parameter.type !== "secret") continue;
    const version = versionOf(parameter.key);
    if (version !== undefined) versions.set(parameter.key, version);
    else if (parameter.required) issues.push(issue("SECRET_MISSING", parameterPath(parameter.key)));
  }

  const known = new Map(Object.entries(values));
  const textOf = (key: string): string => {
    const value = known.get(key);
    if (value === undefined) throw new Error("undeclared parameter");
    return appTemplateValueText(value);
  };

  const order = orderAppTemplateServices(spec.services);
  if (!order.ok) return internal();
  const services = new Map(spec.services.map((service) => [service.key, service]));
  const secretKeys = secretKeysOf(spec);
  const isSecretPiece = (piece: InterpolationPiece): boolean => isVariable(piece) && secretKeys.has(piece.variable);
  const components: AppStackPlanComponentV2[] = [];
  for (const key of order.order) {
    const service = services.get(key);
    if (service === undefined) return internal();

    const argv =
      service.command?.map((raw) => {
        const pieces = piecesOf(raw);
        const [only] = pieces;
        if (pieces.length !== 1 || only === undefined || !isVariable(only)) return expandPieces(pieces, textOf);
        const item = textOf(only.variable);
        if (item === "" || item.startsWith("-") || appStackArgvItemProblem(item) !== null) {
          issues.push(issue("PARAM_VALUE_ARGV_UNSAFE", parameterPath(only.variable)));
        } else if (appStackTextProblem(item) !== null) issues.push(issue("RENDERED_VALUE_FORBIDDEN", parameterPath(only.variable)));
        return item;
      }) ?? null;

    const environment: AppStackPlanComponentV1["environment"][number][] = [];
    const secretFiles: AppStackPlanComponentV1["secretFiles"][number][] = [];
    // Only a v2 template can fill this: the validator refuses both of its forms in a v1 source.
    const secretEnvironment: AppStackPlanSecretEnvEntry[] = [];
    for (const entry of service.environment) {
      if ("secretParameter" in entry) {
        // An optional secret nobody set: the variable is left out, as its file always was.
        const version = versions.get(entry.secretParameter);
        if (version === undefined) continue;
        if (entry.name.endsWith("_FILE")) secretFiles.push({ envName: entry.name, parameterKey: entry.secretParameter, version });
        else secretEnvironment.push({ name: entry.name, pieces: [{ parameterKey: entry.secretParameter, version }] });
        continue;
      }
      const pieces = piecesOf(entry.value);
      if (pieces.some(isSecretPiece)) {
        const path = parameterPath(pieces.filter(isVariable).find((piece) => !isSecretPiece(piece))?.variable);
        const out: SecretEnvPiece[] = [];
        let literal = "";
        let unset = false;
        const flush = (): void => {
          if (literal === "") return;
          if (appStackTextProblem(literal) !== null) issues.push(issue("RENDERED_VALUE_FORBIDDEN", path));
          out.push({ literal });
          literal = "";
        };
        for (const piece of pieces) {
          if (!isVariable(piece)) literal += piece.literal;
          else if (!isSecretPiece(piece)) literal += textOf(piece.variable);
          else {
            const version = versions.get(piece.variable);
            if (version === undefined) unset = true;
            else {
              flush();
              out.push({ parameterKey: piece.variable, version });
            }
          }
        }
        flush();
        if (!unset) secretEnvironment.push({ name: entry.name, pieces: out });
        continue;
      }
      const value = expandPieces(pieces, textOf);
      if (appStackTextProblem(value) !== null) issues.push(issue("RENDERED_VALUE_FORBIDDEN", parameterPath(pieces.find(isVariable)?.variable)));
      environment.push({ name: entry.name, value });
    }

    components.push({
      key,
      image: `${service.image.name}@${service.image.digest}`,
      runAsUser: findAppImageAllowlistEntry(service.image.name, allowlist)?.runAsUser ?? null,
      argv,
      environment: environment.sort((a, b) => compare(a.name, b.name)),
      secretFiles: secretFiles.sort((a, b) => compare(a.envName, b.envName)),
      resources: service.limits,
      expose: [...service.expose].sort((a, b) => a - b),
      dependsOn: [...service.dependsOn].sort(compare),
      volumes: [...service.volumes].sort((a, b) => compare(a.containerPath, b.containerPath)),
      healthcheck: service.healthcheck,
      profile: appTemplateServiceProfile(service),
      secretEnvironment: secretEnvironment.sort((a, b) => compare(a.name, b.name)),
    });
  }
  if (issues.length > 0) return refuse(issues);

  const ingress = spec.ingress
    .map(({ service, port }) => ({ componentKey: service, port }))
    .sort((a, b) => compare(a.componentKey, b.componentKey) || a.port - b.port);
  const tail = { volumes: spec.volumes, ingress };
  if (spec.schemaVersion === APP_STACK_PLAN_SCHEMA_VERSION_2) {
    return { ok: true, body: { schemaVersion: APP_STACK_PLAN_SCHEMA_VERSION_2, components, ...tail } };
  }
  // A version 1 component has exactly its eleven keys: the two v2 keys never reach a v1 plan or its hash.
  const v1 = components.map(({ profile: _profile, secretEnvironment: _secretEnvironment, ...component }): AppStackPlanComponentV1 => component);
  return { ok: true, body: { schemaVersion: APP_STACK_PLAN_SCHEMA_VERSION, components: v1, ...tail } };
}

/** Steps 8–10 after the hash: the plan in schema key order, its byte cap and the final schema guard. */
function finishPlan(ids: AppStackPlanIds, planHash: string, { schemaVersion, components, volumes, ingress }: PlanBody): PlanResult {
  const { stackId, organizationId, hostAllocationId, templateVersionId, revisionId } = ids;
  const plan = { schemaVersion, stackId, organizationId, hostAllocationId, templateVersionId, revisionId, planHash, components, volumes, ingress };
  if (new TextEncoder().encode(JSON.stringify(plan)).length > APP_STACK_PLAN_MAX_BYTES) return refuse([issue("PLAN_TOO_LARGE", "")]);
  const parsed = ApprovedStackPlanSchema.safeParse(plan);
  return parsed.success ? { ok: true, plan: parsed.data } : internal();
}

/** The preview's plan: ids of the longest allowed length, so a preview that fits means an install with defaults fits. */
const PREVIEW_ID = "x".repeat(64);
const PREVIEW_FOREIGN_ID = "x".repeat(128);
const PREVIEW_IDS: AppStackPlanIds = {
  stackId: PREVIEW_ID,
  organizationId: PREVIEW_FOREIGN_ID,
  hostAllocationId: PREVIEW_FOREIGN_ID,
  templateVersionId: PREVIEW_ID,
  revisionId: PREVIEW_ID,
};
const PREVIEW_HASH = "0".repeat(64);

const isVersion = (version: number): boolean =>
  Number.isSafeInteger(version) && version >= 1 && version <= APP_TEMPLATE_LIMITS.secretVersionMax;

/** Source + customer values + secret versions + ids → the plan of one revision, or every problem found. */
export function compileAppStackPlan(input: AppStackCompileInput, options: AppTemplateValidationOptions = {}): AppStackCompileResult {
  try {
    const validation = validateAppTemplateSource(input.source, options);
    if (!validation.ok) return { ok: false, issues: validation.errors };
    const { stackId, organizationId, hostAllocationId, templateVersionId, revisionId } = input.ids;
    const ids = [stackId, templateVersionId, revisionId].every((id) => APP_STACK_ID_PATTERN.test(id)) &&
      [organizationId, hostAllocationId].every((id) => APP_FOREIGN_ID_PATTERN.test(id));
    if (!ids || ![...input.secretVersions.values()].every(isVersion)) return internal();

    const resolution = resolveAppTemplateParameters(validation.spec, input.parameters);
    if (!resolution.ok) return resolution;
    const compiled = compileBody(
      validation.spec,
      resolution.values,
      (key) => input.secretVersions.get(key),
      options.allowlist ?? APP_IMAGE_ALLOWLIST,
    );
    if (!compiled.ok) return compiled;

    const { schemaVersion, components, volumes, ingress } = compiled.body;
    const planHash = computeAppStackPlanHash({ schemaVersion, templateVersionId, components, volumes, ingress });
    return finishPlan(input.ids, planHash, compiled.body);
  } catch {
    return internal();
  }
}

/**
 * The admin `validate` result: the spec and its body compiled with every default and every secret parameter set, held
 * to the same byte cap and plan schema as an install.
 */
export function previewAppTemplateSource(source: string, options: AppTemplateValidationOptions = {}): AppTemplatePreviewResult {
  try {
    const validation = validateAppTemplateSource(source, options);
    if (!validation.ok) return validation;
    const resolution = resolveAppTemplateParameters(validation.spec, []);
    const compiled = resolution.ok
      ? compileBody(validation.spec, resolution.values, () => 1, options.allowlist ?? APP_IMAGE_ALLOWLIST)
      : resolution;
    const planned = compiled.ok ? finishPlan(PREVIEW_IDS, PREVIEW_HASH, compiled.body) : compiled;
    if (!planned.ok) return { ok: false, errors: planned.issues };
    return { ok: true, spec: validation.spec, preview: toAppStackPreview(planned.plan) };
  } catch {
    return { ok: false, errors: internal().issues };
  }
}
