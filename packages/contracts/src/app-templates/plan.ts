import { z } from "zod";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, findUnsafeDockerInputFields } from "../resources.js";
import { APP_STACK_PLAN_IMAGE_PATTERN } from "./images.js";
import {
  APP_STACK_COMPONENT_KEY_MAX,
  APP_STACK_HASH_PATTERN,
  APP_STACK_ID_PATTERN,
  APP_STACK_PLAN_MAX_BYTES,
  APP_STACK_DEFAULT_RUN_PROFILE,
  APP_STACK_PLAN_SCHEMA_VERSION,
  APP_STACK_PLAN_SCHEMA_VERSION_2,
  APP_STACK_RUN_AS_USER_PATTERN,
  APP_STACK_RUN_PROFILES,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_TEMPLATE_LIMITS,
  type AppStackRunProfile,
  AppStackEnvNameSchema,
  AppStackKeySchema,
  AppStackPortSchema,
  AppStackResourcesSchema,
  AppStackVolumeMountSchema,
  AppTemplateParameterKeySchema,
} from "./limits.js";
import { AppForeignIdSchema } from "./stack-ids.js";
import {
  AppStackHealthcheckSchema,
  appStackArgvExecutableProblem,
  appStackArgvItemProblem,
  appStackContainerPathProblem,
  appStackEnvValueNameProblem,
  appStackSecretEnvNameProblem,
  appStackSecretEnvironmentNameProblem,
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
    key: AppStackKeySchema.max(APP_STACK_COMPONENT_KEY_MAX),
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

const SecretVersion = z.number().int().min(1).max(APP_TEMPLATE_LIMITS.secretVersionMax);
const SecretEnvLiteralPiece = z.object({ literal: z.string().min(1).max(APP_TEMPLATE_LIMITS.envValueLength) }).strict();
/** One piece of an environment secret (v2): template text, or the stored value of a stack secret at a pinned version. */
export const AppStackPlanSecretEnvPieceSchema = z.union([
  SecretEnvLiteralPiece,
  z.object({ parameterKey: AppTemplateParameterKeySchema, version: SecretVersion }).strict(),
]);
/** A variable whose value only the executor assembles, at container creation. The plan carries no secret value. */
export const AppStackPlanSecretEnvEntrySchema = z
  .object({ name: AppStackEnvNameSchema, pieces: z.array(AppStackPlanSecretEnvPieceSchema).min(1).max(APP_STACK_SECRET_ENV_LIMITS.pieces) })
  .strict();
export type AppStackPlanSecretEnvEntry = z.infer<typeof AppStackPlanSecretEnvEntrySchema>;

/** A component of a version 2 plan: the v1 component, the name of its run profile and its environment secrets. */
export const AppStackPlanComponentV2Schema = AppStackPlanComponentSchema.extend({
  profile: z.enum(APP_STACK_RUN_PROFILES),
  secretEnvironment: z.array(AppStackPlanSecretEnvEntrySchema).max(APP_TEMPLATE_LIMITS.environment),
}).strict();
export type AppStackPlanComponentV1 = z.infer<typeof AppStackPlanComponentSchema>;
export type AppStackPlanComponentV2 = z.infer<typeof AppStackPlanComponentV2Schema>;
export type AppStackPlanComponent = AppStackPlanComponentV1 | AppStackPlanComponentV2;

/** "strict" for every component of a version 1 plan. */
export function appStackComponentProfile(component: AppStackPlanComponent): AppStackRunProfile {
  return "profile" in component ? component.profile : APP_STACK_DEFAULT_RUN_PROFILE;
}

/** [] for every component of a version 1 plan. */
export function appStackComponentSecretEnvironment(component: AppStackPlanComponent): readonly AppStackPlanSecretEnvEntry[] {
  return "secretEnvironment" in component ? component.secretEnvironment : [];
}

export interface AppStackSecretRef {
  readonly parameterKey: string;
  readonly version: number;
}

function distinctSecretRefs(refs: readonly AppStackSecretRef[]): AppStackSecretRef[] {
  const seen = new Set<string>();
  return refs
    .filter(({ parameterKey, version }) => {
      const id = `${parameterKey}:${String(version)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.parameterKey < b.parameterKey ? -1 : a.parameterKey > b.parameterKey ? 1 : a.version - b.version));
}

/** Every (parameterKey, version) the component needs to run, as a file or in its environment: distinct, by key. */
export function appStackComponentSecretRefs(component: AppStackPlanComponent): AppStackSecretRef[] {
  return distinctSecretRefs([
    ...component.secretFiles.map(({ parameterKey, version }) => ({ parameterKey, version })),
    ...appStackComponentEnvironmentSecretRefs(component),
  ]);
}

/** Only the references of the component's environment secrets: what the executor needs at creation. */
export function appStackComponentEnvironmentSecretRefs(component: AppStackPlanComponent): AppStackSecretRef[] {
  return distinctSecretRefs(
    appStackComponentSecretEnvironment(component).flatMap((entry) =>
      entry.pieces.flatMap((piece) => ("parameterKey" in piece ? [{ parameterKey: piece.parameterKey, version: piece.version }] : [])),
    ),
  );
}

/** The environment-secret references of the whole plan: non-empty exactly when a create call must carry contents. */
export function appStackPlanEnvironmentSecretRefs(plan: { readonly components: readonly AppStackPlanComponent[] }): AppStackSecretRef[] {
  return distinctSecretRefs(plan.components.flatMap(appStackComponentEnvironmentSecretRefs));
}

/** Every reference of the whole plan, files and environment. */
export function appStackPlanSecretRefs(plan: { readonly components: readonly AppStackPlanComponent[] }): AppStackSecretRef[] {
  return distinctSecretRefs(plan.components.flatMap(appStackComponentSecretRefs));
}

export const AppStackPlanVolumeSchema = z.object({ key: AppStackKeySchema }).strict();
export const AppStackPlanIngressSchema = z.object({ componentKey: AppStackKeySchema, port: AppStackPortSchema }).strict();

/** hp_app_<stackId>_<componentKey> is the proxy's backend host name: one DNS label, at most 63 characters. */
export function appStackEngineNameProblem(stackId: string, componentKey: string): "too_long" | null {
  return `hp_app_${stackId}_${componentKey}`.length > 63 ? "too_long" : null;
}

type Path = (string | number)[];
type PlanShape = {
  readonly schemaVersion: number;
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
  /** Version 2 only: one version per secret in the whole plan, so one content entry serves files and environment. */
  const pinned = new Map<string, number>();
  const pinVersion = (ref: { readonly parameterKey: string; readonly version: number }, path: Path) => {
    if (plan.schemaVersion !== APP_STACK_PLAN_SCHEMA_VERSION_2) return;
    const known = pinned.get(ref.parameterKey);
    if (known === undefined) pinned.set(ref.parameterKey, ref.version);
    else if (known !== ref.version) refuse(path, "A secret has one version in a plan");
  };
  let exposeTotal = 0;

  plan.components.forEach((component, c) => {
    const at = (...path: Path): Path => ["components", c, ...path];
    if (earlier.has(component.key)) refuse(at("key"), "Duplicate component key");
    component.dependsOn.forEach((dependency, d) => {
      if (!earlier.has(dependency)) refuse(at("dependsOn", d), "A dependency must be an earlier component");
    });
    ascending(component.dependsOn, lower, (d) => at("dependsOn", d), "Dependencies must be sorted and unique");
    earlier.add(component.key);

    const secretEnvironment = appStackComponentSecretEnvironment(component);
    if (component.environment.length + component.secretFiles.length + secretEnvironment.length > APP_TEMPLATE_LIMITS.environment) {
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
    component.secretFiles.forEach((file, f) => pinVersion(file, at("secretFiles", f, "version")));

    secretEnvironment.forEach((entry, s) => {
      if (appStackSecretEnvironmentNameProblem(entry.name) !== null || valueNames.has(entry.name)) {
        refuse(at("secretEnvironment", s, "name"), "Invalid environment secret name");
      }
      let references = 0;
      let literalLength = 0;
      entry.pieces.forEach((piece, p) => {
        if ("parameterKey" in piece) {
          references += 1;
          parameterKeys.add(piece.parameterKey);
          pinVersion(piece, at("secretEnvironment", s, "pieces", p, "version"));
          return;
        }
        literalLength += piece.literal.length;
        if (appStackTextProblem(piece.literal) !== null) refuse(at("secretEnvironment", s, "pieces", p, "literal"), "Forbidden environment value");
        const previous = entry.pieces[p - 1];
        if (previous !== undefined && "literal" in previous) refuse(at("secretEnvironment", s, "pieces", p), "Adjacent literal pieces must be one piece");
      });
      if (references === 0) refuse(at("secretEnvironment", s, "pieces"), "An environment secret needs a secret reference");
      if (references > APP_STACK_SECRET_ENV_LIMITS.referencesPerValue) refuse(at("secretEnvironment", s, "pieces"), "Too many secret references");
      if (literalLength > APP_TEMPLATE_LIMITS.envValueLength) refuse(at("secretEnvironment", s, "pieces"), "The environment value is too long");
    });
    ascending(secretEnvironment, (a, b) => a.name < b.name, (s) => at("secretEnvironment", s, "name"), "Environment secrets must be sorted by unique name");

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

const PlanIds = {
  stackId: AppStackIdSchema,
  organizationId: AppForeignIdSchema,
  hostAllocationId: AppForeignIdSchema,
  templateVersionId: AppStackIdSchema,
  /** = app_stack_revisions.id of the row that stores this plan. */
  revisionId: AppStackIdSchema,
  planHash: z.string().regex(APP_STACK_HASH_PATTERN),
};
const PlanTail = {
  volumes: z.array(AppStackPlanVolumeSchema).max(APP_TEMPLATE_LIMITS.volumes),
  ingress: z.array(AppStackPlanIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
};

/** The plan of an `HCP-STACK/v1` template: unchanged since ADR-0035, so stored plans and their hashes never move. */
export const ApprovedStackPlanV1Schema = z
  .object({
    schemaVersion: z.literal(APP_STACK_PLAN_SCHEMA_VERSION),
    ...PlanIds,
    /** Deterministic topological order. */
    components: z.array(AppStackPlanComponentSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    ...PlanTail,
  })
  .strict();
/** The plan of an `HCP-STACK/v2` template (ADR-0036). */
export const ApprovedStackPlanV2Schema = z
  .object({
    schemaVersion: z.literal(APP_STACK_PLAN_SCHEMA_VERSION_2),
    ...PlanIds,
    /** Deterministic topological order. */
    components: z.array(AppStackPlanComponentV2Schema).min(1).max(APP_TEMPLATE_LIMITS.services),
    ...PlanTail,
  })
  .strict();

/** A key of one version in a plan of the other is an unknown key: a v1 plan can never carry a profile. */
export const ApprovedStackPlanSchema = z
  .discriminatedUnion("schemaVersion", [ApprovedStackPlanV1Schema, ApprovedStackPlanV2Schema])
  .superRefine(appStackPlanRefine);
export type ApprovedStackPlanV1 = z.infer<typeof ApprovedStackPlanV1Schema>;
export type ApprovedStackPlanV2 = z.infer<typeof ApprovedStackPlanV2Schema>;
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
): { readonly schemaVersion: ApprovedStackPlan["schemaVersion"]; readonly component: AppStackPlanComponent; readonly edge: boolean } | null {
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

/** Preview = the plan body without ids, hash and secret versions. Same ordering rules as the plan. `profile` and
 *  `secretEnvironment` are present only for a version 2 body. */
export const AppStackPreviewSecretEnvEntrySchema = z
  .object({
    name: AppStackEnvNameSchema,
    pieces: z
      .array(z.union([SecretEnvLiteralPiece, z.object({ parameterKey: AppTemplateParameterKeySchema }).strict()]))
      .min(1)
      .max(APP_STACK_SECRET_ENV_LIMITS.pieces),
  })
  .strict();
export const AppStackPreviewComponentSchema = AppStackPlanComponentSchema.extend({
  secretFiles: z
    .array(z.object({ envName: AppStackEnvNameSchema, parameterKey: AppTemplateParameterKeySchema }).strict())
    .max(APP_TEMPLATE_LIMITS.environment),
  profile: z.enum(APP_STACK_RUN_PROFILES).optional(),
  secretEnvironment: z.array(AppStackPreviewSecretEnvEntrySchema).max(APP_TEMPLATE_LIMITS.environment).optional(),
}).strict();
export type AppStackPreviewComponent = z.infer<typeof AppStackPreviewComponentSchema>;
export const AppStackPreviewSchema = z
  .object({
    components: z.array(AppStackPreviewComponentSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    volumes: z.array(AppStackPlanVolumeSchema).max(APP_TEMPLATE_LIMITS.volumes),
    ingress: z.array(AppStackPlanIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
  })
  .strict();
export type AppStackPreview = z.infer<typeof AppStackPreviewSchema>;

export function toAppStackPreview(body: {
  readonly components: readonly AppStackPlanComponent[];
  readonly volumes: ApprovedStackPlan["volumes"];
  readonly ingress: ApprovedStackPlan["ingress"];
}): AppStackPreview {
  return {
    components: body.components.map((component): AppStackPreviewComponent => {
      const secretFiles = component.secretFiles.map(({ envName, parameterKey }) => ({ envName, parameterKey }));
      if (!("secretEnvironment" in component)) return { ...component, secretFiles };
      return {
        ...component,
        secretFiles,
        secretEnvironment: component.secretEnvironment.map(({ name, pieces }) => ({
          name,
          pieces: pieces.map((piece) => ("parameterKey" in piece ? { parameterKey: piece.parameterKey } : piece)),
        })),
      };
    }),
    volumes: body.volumes,
    ingress: body.ingress,
  };
}
