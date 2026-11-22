/**
 * Compiler of an application template: the re-validated source, the customer's values and the stack's secret versions
 * become the deterministic, secret-free ApprovedStackPlan; the preview is the same body compiled with the defaults.
 * Pure, synchronous and never throws; a message never echoes a value.
 */
import {
  APP_IMAGE_ALLOWLIST,
  APP_STACK_ID_PATTERN,
  APP_STACK_PLAN_MAX_BYTES,
  APP_STACK_PLAN_SCHEMA_VERSION,
  APP_TEMPLATE_ISSUE_REASON,
  APP_TEMPLATE_LIMITS,
  ApprovedStackPlanSchema,
  appStackArgvItemProblem,
  appStackTextProblem,
  appTemplateValueText,
  findAppImageAllowlistEntry,
  resolveAppTemplateParameters,
  sortAppTemplateIssues,
  toAppStackPreview,
  type AppImageAllowlistEntry,
  type AppStackPlanComponent,
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

type PlanBody = Pick<ApprovedStackPlan, "components" | "volumes" | "ingress">;
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
  const components: AppStackPlanComponent[] = [];
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

    const environment: AppStackPlanComponent["environment"][number][] = [];
    const secretFiles: AppStackPlanComponent["secretFiles"][number][] = [];
    for (const entry of service.environment) {
      if ("secretParameter" in entry) {
        const version = versions.get(entry.secretParameter);
        if (version !== undefined) secretFiles.push({ envName: entry.name, parameterKey: entry.secretParameter, version });
        continue;
      }
      const pieces = piecesOf(entry.value);
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
    });
  }
  if (issues.length > 0) return refuse(issues);

  const ingress = spec.ingress
    .map(({ service, port }) => ({ componentKey: service, port }))
    .sort((a, b) => compare(a.componentKey, b.componentKey) || a.port - b.port);
  return { ok: true, body: { components, volumes: spec.volumes, ingress } };
}

/** Steps 8–10 after the hash: the plan in schema key order, its byte cap and the final schema guard. */
function finishPlan(ids: AppStackPlanIds, planHash: string, { components, volumes, ingress }: PlanBody): PlanResult {
  const { stackId, organizationId, hostAllocationId, templateVersionId, revisionId } = ids;
  const schemaVersion = APP_STACK_PLAN_SCHEMA_VERSION;
  const plan = { schemaVersion, stackId, organizationId, hostAllocationId, templateVersionId, revisionId, planHash, components, volumes, ingress };
  if (new TextEncoder().encode(JSON.stringify(plan)).length > APP_STACK_PLAN_MAX_BYTES) return refuse([issue("PLAN_TOO_LARGE", "")]);
  const parsed = ApprovedStackPlanSchema.safeParse(plan);
  return parsed.success ? { ok: true, plan: parsed.data } : internal();
}

/** The preview's plan: ids of the longest allowed length, so a preview that fits means an install with defaults fits. */
const PREVIEW_ID = "x".repeat(64);
const PREVIEW_IDS: AppStackPlanIds = {
  stackId: PREVIEW_ID,
  organizationId: PREVIEW_ID,
  hostAllocationId: PREVIEW_ID,
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
    const ids = [stackId, organizationId, hostAllocationId, templateVersionId, revisionId];
    if (!ids.every((id) => APP_STACK_ID_PATTERN.test(id)) || ![...input.secretVersions.values()].every(isVersion)) return internal();

    const resolution = resolveAppTemplateParameters(validation.spec, input.parameters);
    if (!resolution.ok) return resolution;
    const compiled = compileBody(
      validation.spec,
      resolution.values,
      (key) => input.secretVersions.get(key),
      options.allowlist ?? APP_IMAGE_ALLOWLIST,
    );
    if (!compiled.ok) return compiled;

    const { components, volumes, ingress } = compiled.body;
    const planHash = computeAppStackPlanHash({ schemaVersion: APP_STACK_PLAN_SCHEMA_VERSION, templateVersionId, components, volumes, ingress });
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
