import { z } from "zod";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, findUnsafeDockerInputFields } from "../resources.js";
import { APP_STACK_PLAN_IMAGE_PATTERN } from "./images.js";
import {
  APP_STACK_HASH_PATTERN,
  APP_STACK_ID_PATTERN,
  APP_STACK_PLAN_MAX_BYTES,
  APP_STACK_PLAN_SCHEMA_VERSION,
  APP_STACK_RUN_AS_USER_PATTERN,
  APP_TEMPLATE_LIMITS,
  AppStackEnvNameSchema,
  AppStackKeySchema,
  AppStackPortSchema,
  AppStackResourcesSchema,
  AppStackVolumeMountSchema,
  AppTemplateParameterKeySchema,
} from "./limits.js";
import {
  AppStackHealthcheckSchema,
  appStackArgvExecutableProblem,
  appStackArgvItemProblem,
  appStackContainerPathProblem,
  appStackEnvValueNameProblem,
  appStackSecretEnvNameProblem,
  appStackTextProblem,
} from "./text.js";

const AppStackIdSchema = z.string().regex(APP_STACK_ID_PATTERN);

export const AppStackPlanEnvEntrySchema = z
  .object({ name: AppStackEnvNameSchema, value: z.string().max(APP_TEMPLATE_LIMITS.envValueLength) })
  .strict();
export const AppStackPlanSecretFileSchema = z
  .object({
    envName: AppStackEnvNameSchema,
    /** = app_stack_secrets.parameter_key */
    parameterKey: AppTemplateParameterKeySchema,
    /** = app_stack_secrets.version */
    version: z.number().int().min(1).max(APP_TEMPLATE_LIMITS.secretVersionMax),
  })
  .strict();

export const AppStackPlanComponentSchema = z
  .object({
    key: AppStackKeySchema,
    image: z.string().regex(APP_STACK_PLAN_IMAGE_PATTERN),
    runAsUser: z.string().regex(APP_STACK_RUN_AS_USER_PATTERN).nullable(),
    /** Docker Cmd; null = the image CMD; Entrypoint is never set. */
    argv: z.array(z.string().min(1).max(APP_TEMPLATE_LIMITS.argvItemLength)).min(1).max(APP_TEMPLATE_LIMITS.argvItems).nullable(),
    environment: z.array(AppStackPlanEnvEntrySchema).max(APP_TEMPLATE_LIMITS.environment),
    /** One parameter may feed several env names. */
    secretFiles: z.array(AppStackPlanSecretFileSchema).max(APP_TEMPLATE_LIMITS.environment),
    resources: AppStackResourcesSchema,
    expose: z.array(AppStackPortSchema).max(APP_TEMPLATE_LIMITS.expose),
    dependsOn: z.array(AppStackKeySchema).max(APP_TEMPLATE_LIMITS.dependsOn),
    volumes: z.array(AppStackVolumeMountSchema).max(APP_TEMPLATE_LIMITS.mountsPerService),
    healthcheck: AppStackHealthcheckSchema.nullable(),
  })
  .strict();
export type AppStackPlanComponent = z.infer<typeof AppStackPlanComponentSchema>;

export const AppStackPlanVolumeSchema = z.object({ key: AppStackKeySchema }).strict();
export const AppStackPlanIngressSchema = z.object({ componentKey: AppStackKeySchema, port: AppStackPortSchema }).strict();

type Path = (string | number)[];
type PlanShape = {
  readonly components: readonly AppStackPlanComponent[];
  readonly volumes: readonly { readonly key: string }[];
  readonly ingress: readonly { readonly componentKey: string; readonly port: number }[];
};

/** Executor-side re-check of everything the compiler guarantees; each issue path is the offending field. */
function appStackPlanRefine(plan: PlanShape, ctx: z.RefinementCtx): void {
  const refuse = (path: Path, message: string) => ctx.addIssue({ code: "custom", path, message });
  const ascending = <T>(items: readonly T[], before: (a: T, b: T) => boolean, pathOf: (index: number) => Path, message: string) => {
    items.forEach((item, index) => {
      if (index > 0 && !before(items[index - 1] as T, item)) refuse(pathOf(index), message);
    });
  };
  const lower = (a: string, b: string) => a < b;

  if (new TextEncoder().encode(JSON.stringify(plan)).length > APP_STACK_PLAN_MAX_BYTES) refuse([], "The plan is too large");

  const earlier = new Set<string>();
  const volumeKeys = new Set(plan.volumes.map((volume) => volume.key));
  const mounted = new Set<string>();
  const parameterKeys = new Set<string>();
  let exposeTotal = 0;

  plan.components.forEach((component, c) => {
    const at = (...path: Path): Path => ["components", c, ...path];
    if (earlier.has(component.key)) refuse(at("key"), "Duplicate component key");
    component.dependsOn.forEach((dependency, d) => {
      if (!earlier.has(dependency)) refuse(at("dependsOn", d), "A dependency must be an earlier component");
    });
    ascending(component.dependsOn, lower, (d) => at("dependsOn", d), "Dependencies must be sorted and unique");
    earlier.add(component.key);

    if (component.environment.length + component.secretFiles.length > APP_TEMPLATE_LIMITS.environment) {
      refuse(at("environment"), "Too many environment entries");
    }
    const valueNames = new Set(component.environment.map((entry) => entry.name));
    component.environment.forEach((entry, e) => {
      if (appStackEnvValueNameProblem(entry.name) !== null) refuse(at("environment", e, "name"), "Invalid environment name");
      if (appStackTextProblem(entry.value) !== null) refuse(at("environment", e, "value"), "Forbidden environment value");
    });
    ascending(component.environment, (a, b) => a.name < b.name, (e) => at("environment", e, "name"), "Environment must be sorted by unique name");
    component.secretFiles.forEach((file, f) => {
      parameterKeys.add(file.parameterKey);
      if (appStackSecretEnvNameProblem(file.envName) !== null || valueNames.has(file.envName)) {
        refuse(at("secretFiles", f, "envName"), "Invalid secret file name");
      }
    });
    ascending(component.secretFiles, (a, b) => a.envName < b.envName, (f) => at("secretFiles", f, "envName"), "Secret files must be sorted by unique name");

    component.argv?.forEach((item, a) => {
      if (appStackTextProblem(item) !== null || (a === 0 ? appStackArgvExecutableProblem(item) : appStackArgvItemProblem(item)) !== null) {
        refuse(at("argv", a), "Forbidden argument");
      }
    });

    ascending(component.expose, (a, b) => a < b, (x) => at("expose", x), "Exposed ports must be sorted and unique");
    exposeTotal += component.expose.length;
    if (component.healthcheck && !component.expose.includes(component.healthcheck.port)) {
      refuse(at("healthcheck", "port"), "The health check port is not exposed");
    }

    component.volumes.forEach((mount, m) => {
      mounted.add(mount.volumeKey);
      if (!volumeKeys.has(mount.volumeKey)) refuse(at("volumes", m, "volumeKey"), "Undeclared volume");
      if (appStackContainerPathProblem(mount.containerPath) !== null) refuse(at("volumes", m, "containerPath"), "Invalid container path");
    });
    ascending(component.volumes, (a, b) => a.containerPath < b.containerPath, (m) => at("volumes", m, "containerPath"), "Mounts must be sorted by unique path");
  });
  if (parameterKeys.size > APP_TEMPLATE_LIMITS.secretParameters) refuse(["components"], "Too many secret parameters");
  if (exposeTotal > APP_TEMPLATE_LIMITS.expose) refuse(["components"], "Too many exposed ports");

  plan.volumes.forEach((volume, v) => {
    if (!mounted.has(volume.key)) refuse(["volumes", v, "key"], "Unused volume");
  });
  ascending(plan.volumes, (a, b) => a.key < b.key, (v) => ["volumes", v, "key"], "Volumes must be sorted by unique key");

  const components = new Map(plan.components.map((component) => [component.key, component]));
  plan.ingress.forEach((route, i) => {
    const target = components.get(route.componentKey);
    if (!target || target.healthcheck === null) refuse(["ingress", i, "componentKey"], "The ingress target needs a health check");
    else if (!target.expose.includes(route.port)) refuse(["ingress", i, "port"], "The ingress port is not exposed");
  });
  ascending(
    plan.ingress,
    (a, b) => a.componentKey < b.componentKey || (a.componentKey === b.componentKey && a.port < b.port),
    (i) => ["ingress", i],
    "Ingress must be sorted and unique",
  );

  for (const field of new Set([...findUnsafeDockerInputFields(plan), ...findPlaintextSecretKeys(plan), ...findForbiddenPublicDtoKeys(plan)])) {
    refuse([], `Forbidden key or value at ${field}`);
  }
}

export const ApprovedStackPlanSchema = z
  .object({
    schemaVersion: z.literal(APP_STACK_PLAN_SCHEMA_VERSION),
    stackId: AppStackIdSchema,
    organizationId: AppStackIdSchema,
    hostAllocationId: AppStackIdSchema,
    templateVersionId: AppStackIdSchema,
    /** = app_stack_revisions.id of the row that stores this plan. */
    revisionId: AppStackIdSchema,
    planHash: z.string().regex(APP_STACK_HASH_PATTERN),
    /** Deterministic topological order. */
    components: z.array(AppStackPlanComponentSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    volumes: z.array(AppStackPlanVolumeSchema).max(APP_TEMPLATE_LIMITS.volumes),
    ingress: z.array(AppStackPlanIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
  })
  .strict()
  .superRefine(appStackPlanRefine);
export type ApprovedStackPlan = z.infer<typeof ApprovedStackPlanSchema>;

export type AppStackPlanHashSource = Pick<ApprovedStackPlan, "schemaVersion" | "templateVersionId" | "components" | "volumes" | "ingress">;

/** The exact object hashed into planHash. */
export function appStackPlanHashInput(plan: AppStackPlanHashSource): AppStackPlanHashSource {
  const { schemaVersion, templateVersionId, components, volumes, ingress } = plan;
  return { schemaVersion, templateVersionId, components, volumes, ingress };
}

/** The exact object hashed into a component hash; null when the key is not in the plan. edge = some ingress entry targets it. */
export function appStackComponentHashInput(
  plan: Pick<ApprovedStackPlan, "schemaVersion" | "components" | "ingress">,
  componentKey: string,
): { readonly schemaVersion: 1; readonly component: AppStackPlanComponent; readonly edge: boolean } | null {
  const component = plan.components.find((candidate) => candidate.key === componentKey);
  if (component === undefined) return null;
  return { schemaVersion: plan.schemaVersion, component, edge: plan.ingress.some((route) => route.componentKey === componentKey) };
}

/** Quota helper for the API: sums of the components; memory as a decimal string. */
export function sumAppStackPlanResources(plan: Pick<ApprovedStackPlan, "components">): {
  readonly components: number;
  readonly cpuMilli: number;
  readonly memoryBytes: string;
} {
  return {
    components: plan.components.length,
    cpuMilli: plan.components.reduce((sum, component) => sum + component.resources.cpuMilli, 0),
    memoryBytes: plan.components.reduce((sum, component) => sum + BigInt(component.resources.memoryBytes), BigInt(0)).toString(),
  };
}

/** Preview = the plan body without ids, hash and secret versions. Same ordering rules as the plan. */
export const AppStackPreviewComponentSchema = AppStackPlanComponentSchema.extend({
  secretFiles: z
    .array(z.object({ envName: AppStackEnvNameSchema, parameterKey: AppTemplateParameterKeySchema }).strict())
    .max(APP_TEMPLATE_LIMITS.environment),
}).strict();
export const AppStackPreviewSchema = z
  .object({
    components: z.array(AppStackPreviewComponentSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    volumes: z.array(AppStackPlanVolumeSchema).max(APP_TEMPLATE_LIMITS.volumes),
    ingress: z.array(AppStackPlanIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
  })
  .strict();
export type AppStackPreview = z.infer<typeof AppStackPreviewSchema>;

export function toAppStackPreview(body: Pick<ApprovedStackPlan, "components" | "volumes" | "ingress">): AppStackPreview {
  return {
    components: body.components.map((component) => ({
      ...component,
      secretFiles: component.secretFiles.map(({ envName, parameterKey }) => ({ envName, parameterKey })),
    })),
    volumes: body.volumes,
    ingress: body.ingress,
  };
}
