import { z } from "zod";
import { SITE_TEMPLATE_SIZE_PATTERN } from "../site-templates/spec.js";
import {
  APP_SECRET_GENERATE_BOUNDS,
  APP_SECRET_GENERATE_KINDS,
  APP_STACK_COMPONENT_KEY_MAX,
  APP_STACK_DEFAULT_RUN_PROFILE,
  APP_STACK_DIGEST_PATTERN,
  APP_STACK_RUN_PROFILES,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_LIMITS,
  APP_TEMPLATE_OPTION_PATTERN,
  APP_TEMPLATE_SPEC_VERSION,
  APP_TEMPLATE_SPEC_VERSION_2,
  type AppStackRunProfile,
  AppStackEnvNameSchema,
  AppStackKeySchema,
  AppStackPortSchema,
  AppStackResourcesSchema,
  AppStackVolumeMountSchema,
  AppTemplateParameterKeySchema,
} from "./limits.js";
import { appTemplateValueProblem } from "./parameters.js";
import {
  AppStackHealthcheckSchema,
  appStackContainerPathProblem,
  appStackEnvValueNameProblem,
  appStackSecretEnvNameProblem,
  appStackSecretEnvironmentNameProblem,
  appStackTaskArgvProblem,
} from "./text.js";

const noControlCharacter = (text: string): boolean => !/\p{Cc}/u.test(text);
const Label = z.string().min(1).max(APP_TEMPLATE_LIMITS.parameterLabel).refine(noControlCharacter);
const ParameterHead = { key: AppTemplateParameterKeySchema, label: Label };
const IntegerBound = z.number().int().min(-APP_TEMPLATE_LIMITS.integerBound).max(APP_TEMPLATE_LIMITS.integerBound);

export const APP_TEMPLATE_PARAMETER_TYPES = ["enum", "integer", "string", "boolean", "size", "secret"] as const;
export type AppTemplateParameterType = (typeof APP_TEMPLATE_PARAMETER_TYPES)[number];

/** Key order follows the stored spec (fixture spec.json), so a parsed spec serialises like the validator's output. */
const EnumParameter = z
  .object({
    ...ParameterHead,
    type: z.literal("enum"),
    options: z.array(z.string().regex(APP_TEMPLATE_OPTION_PATTERN)).min(1).max(APP_TEMPLATE_LIMITS.options),
    default: z.string(),
    customer: z.boolean(),
  })
  .strict();
const IntegerParameter = z
  .object({
    ...ParameterHead,
    type: z.literal("integer"),
    min: IntegerBound.optional(),
    max: IntegerBound.optional(),
    default: IntegerBound,
    customer: z.boolean(),
  })
  .strict();
const StringParameter = z
  .object({ ...ParameterHead, type: z.literal("string"), default: z.string().max(APP_TEMPLATE_LIMITS.stringValue), customer: z.boolean() })
  .strict();
const BooleanParameter = z.object({ ...ParameterHead, type: z.literal("boolean"), default: z.boolean(), customer: z.boolean() }).strict();
const SizeParameter = z
  .object({ ...ParameterHead, type: z.literal("size"), default: z.string().regex(SITE_TEMPLATE_SIZE_PATTERN), customer: z.boolean() })
  .strict();
const SecretParameter = z.object({ ...ParameterHead, type: z.literal("secret"), required: z.boolean(), customer: z.literal(true) }).strict();

type ValueParameter =
  | z.infer<typeof EnumParameter>
  | z.infer<typeof IntegerParameter>
  | z.infer<typeof StringParameter>
  | z.infer<typeof BooleanParameter>
  | z.infer<typeof SizeParameter>;

/** The rules of a parameter with a default: the same in both formats. */
function refineValueParameter(parameter: ValueParameter, ctx: z.RefinementCtx): void {
  if (parameter.type === "enum" && new Set(parameter.options).size !== parameter.options.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
  }
  if (parameter.type === "integer" && parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) {
    ctx.addIssue({ code: "custom", path: ["min"], message: "The minimum must not exceed the maximum" });
  }
  if (appTemplateValueProblem(parameter, parameter.default) !== null) {
    ctx.addIssue({ code: "custom", path: ["default"], message: `The default is not a valid ${parameter.type}` });
  }
}

/** A parameter of an `HCP-STACK/v1` template: a secret is always set by the customer. */
export const AppTemplateParameterSchema = z
  .discriminatedUnion("type", [EnumParameter, IntegerParameter, StringParameter, BooleanParameter, SizeParameter, SecretParameter])
  .superRefine((parameter, ctx) => {
    if (parameter.type !== "secret") refineValueParameter(parameter, ctx);
  });

/** How the platform makes a secret nobody types (v2). Bounds per kind: APP_SECRET_GENERATE_BOUNDS. */
export const AppSecretGenerateSchema = z
  .object({ kind: z.enum(APP_SECRET_GENERATE_KINDS), length: z.number().int().min(1).max(APP_TEMPLATE_LIMITS.stringValue) })
  .strict();
export type AppSecretGenerate = z.infer<typeof AppSecretGenerateSchema>;

export function appSecretGenerateProblem(generate: AppSecretGenerate): "length" | null {
  const bounds = APP_SECRET_GENERATE_BOUNDS[generate.kind];
  return generate.length < bounds.min || generate.length > bounds.max ? "length" : null;
}

/** v2: `generate` null = the customer sets it (customer must be true); otherwise the platform makes it at install, it is
 *  always required, and `customer` says whether the customer may replace it afterwards. */
const SecretParameterV2 = z
  .object({
    ...ParameterHead,
    type: z.literal("secret"),
    required: z.boolean(),
    customer: z.boolean(),
    generate: AppSecretGenerateSchema.nullable(),
  })
  .strict();

/** A parameter of an `HCP-STACK/v2` template. */
export const AppTemplateParameterV2Schema = z
  .discriminatedUnion("type", [EnumParameter, IntegerParameter, StringParameter, BooleanParameter, SizeParameter, SecretParameterV2])
  .superRefine((parameter, ctx) => {
    if (parameter.type !== "secret") return refineValueParameter(parameter, ctx);
    if (parameter.generate === null) {
      if (!parameter.customer) ctx.addIssue({ code: "custom", path: ["customer"], message: "A secret the customer does not set must be generated" });
      return;
    }
    if (appSecretGenerateProblem(parameter.generate) !== null) {
      ctx.addIssue({ code: "custom", path: ["generate", "length"], message: "The generated length is outside the bounds of its kind" });
    }
    if (!parameter.required) ctx.addIssue({ code: "custom", path: ["required"], message: "A generated secret is always required" });
  });
export type AppTemplateParameterV1 = z.infer<typeof AppTemplateParameterSchema>;
export type AppTemplateParameterV2 = z.infer<typeof AppTemplateParameterV2Schema>;
export type AppTemplateParameter = AppTemplateParameterV1 | AppTemplateParameterV2;

/** The generation rule of a parameter; null for every v1 parameter and for a v2 secret the customer sets. */
export function appTemplateSecretGenerate(parameter: AppTemplateParameter): AppSecretGenerate | null {
  return parameter.type === "secret" && "generate" in parameter ? parameter.generate : null;
}

/** A parameter of either format, as the administrator's pages receive it. */
export const AppTemplateAnyParameterSchema = z.union([AppTemplateParameterSchema, AppTemplateParameterV2Schema]);

/** What the install form asks and the customer may set afterwards, in the version 1 shape: the customer's parameters
 *  without the secrets the platform generates (nobody types those, even when the customer may replace them later). */
export function appTemplateInstallParameters(parameters: readonly AppTemplateParameter[]): AppTemplateParameterV1[] {
  return parameters.flatMap((parameter): AppTemplateParameterV1[] => {
    if (!parameter.customer) return [];
    if (parameter.type !== "secret") return [parameter];
    if (appTemplateSecretGenerate(parameter) !== null) return [];
    return [{ key: parameter.key, label: parameter.label, type: "secret", required: parameter.required, customer: true }];
  });
}

/** The secrets the customer never sees or sets: generated ones with `customer: false` (v2 only). */
export function appTemplateHiddenSecretKeys(parameters: readonly AppTemplateParameter[]): Set<string> {
  return new Set(parameters.filter((parameter) => parameter.type === "secret" && !parameter.customer).map((parameter) => parameter.key));
}

export const AppTemplateImageSchema = z
  .object({
    /** "[registry/]repository" exactly as written. */
    name: z.string().min(1).max(APP_TEMPLATE_LIMITS.imageReferenceLength),
    /** Informative only: the digest is authoritative. */
    tag: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/)
      .refine((tag) => tag !== "latest")
      .nullable(),
    digest: z.string().regex(APP_STACK_DIGEST_PATTERN),
  })
  .strict();

export const AppTemplateEnvValueEntrySchema = z
  .object({ name: AppStackEnvNameSchema, value: z.string().max(APP_TEMPLATE_LIMITS.envValueLength) })
  .strict();
export const AppTemplateEnvSecretEntrySchema = z.object({ name: AppStackEnvNameSchema, secretParameter: AppTemplateParameterKeySchema }).strict();
export const AppTemplateEnvEntrySchema = z.union([AppTemplateEnvValueEntrySchema, AppTemplateEnvSecretEntrySchema]);

export const AppTemplateServiceSchema = z
  .object({
    key: AppStackKeySchema.max(APP_STACK_COMPONENT_KEY_MAX),
    image: AppTemplateImageSchema,
    /** Raw: an item may be a whole "${key}" placeholder. */
    command: z.array(z.string().min(1).max(APP_TEMPLATE_LIMITS.argvItemLength)).min(1).max(APP_TEMPLATE_LIMITS.argvItems).nullable(),
    /** Value entries are raw (placeholders, "$$"). */
    environment: z.array(AppTemplateEnvEntrySchema).max(APP_TEMPLATE_LIMITS.environment),
    volumes: z.array(AppStackVolumeMountSchema).max(APP_TEMPLATE_LIMITS.mountsPerService),
    expose: z.array(AppStackPortSchema).max(APP_TEMPLATE_LIMITS.expose),
    dependsOn: z.array(AppStackKeySchema).max(APP_TEMPLATE_LIMITS.dependsOn),
    /** Defaults already applied by the validator. */
    healthcheck: AppStackHealthcheckSchema.nullable(),
    limits: AppStackResourcesSchema,
  })
  .strict();
/** v2: the service also names its run profile (YAML key `x-hp-profile`; absent = "strict"). */
export const AppTemplateServiceV2Schema = AppTemplateServiceSchema.extend({ profile: z.enum(APP_STACK_RUN_PROFILES) }).strict();
export type AppTemplateServiceV1 = z.infer<typeof AppTemplateServiceSchema>;
export type AppTemplateServiceV2 = z.infer<typeof AppTemplateServiceV2Schema>;
export type AppTemplateService = AppTemplateServiceV1 | AppTemplateServiceV2;

export function appTemplateServiceProfile(service: AppTemplateService): AppStackRunProfile {
  return "profile" in service ? service.profile : APP_STACK_DEFAULT_RUN_PROFILE;
}

export const AppTemplateIngressSchema = z.object({ service: AppStackKeySchema, port: AppStackPortSchema }).strict();

/**
 * A command the template declares for one of its components (ADR-0042). A customer runs it or chooses when it runs;
 * nobody sends its arguments, and nothing is filled into them.
 */
export const AppTemplateTaskSchema = z
  .object({
    key: AppStackKeySchema.max(APP_STACK_COMPONENT_KEY_MAX),
    label: z.string().min(1).max(APP_TEMPLATE_LIMITS.taskLabel).refine(noControlCharacter),
    /** "" when the source has none. */
    description: z.string().max(APP_TEMPLATE_LIMITS.taskDescription).refine(noControlCharacter),
    service: AppStackKeySchema,
    /** The arguments exactly as they are run: no placeholder, and a "$$" of the source is already "$". */
    command: z.array(z.string()).refine((argv) => appStackTaskArgvProblem(argv) === null),
    /** The default is already applied by the validator. */
    timeoutSeconds: z.number().int().min(APP_TEMPLATE_LIMITS.taskTimeoutMin).max(APP_TEMPLATE_LIMITS.taskTimeoutMax),
  })
  .strict();
export type AppTemplateTask = z.infer<typeof AppTemplateTaskSchema>;

type Path = (string | number)[];
type SpecShape = {
  readonly schemaVersion: number;
  readonly parameters: readonly AppTemplateParameter[];
  readonly services: readonly AppTemplateService[];
  readonly volumes: readonly { readonly key: string }[];
  readonly ingress: readonly { readonly service: string; readonly port: number }[];
  readonly tasks?: readonly { readonly key: string; readonly service: string }[];
};

/** The cross-field rules of both formats; each issue path is the offending field. */
function appTemplateSpecRefine(spec: SpecShape, ctx: z.RefinementCtx): void {
  const refuse = (path: Path, message: string) => ctx.addIssue({ code: "custom", path, message });
  const unique = (items: readonly unknown[], pathOf: (index: number) => Path, message: string) => {
    const seen = new Set<unknown>();
    items.forEach((item, index) => {
      if (seen.has(item)) refuse(pathOf(index), message);
      seen.add(item);
    });
  };
  const ascending = (keys: readonly string[], pathOf: (index: number) => Path, message: string) => {
    keys.forEach((key, index) => {
      if (index > 0 && !((keys[index - 1] as string) < key)) refuse(pathOf(index), message);
    });
  };
  /** v2 only: a secret entry whose name does not end in "_FILE" is delivered as an environment variable. */
  const environmentSecrets = spec.schemaVersion === APP_TEMPLATE_SPEC_VERSION_2;

  unique(spec.parameters.map((parameter) => parameter.key), (i) => ["parameters", i, "key"], "Duplicate parameter key");
  const secretKeys = new Set(spec.parameters.filter((parameter) => parameter.type === "secret").map((parameter) => parameter.key));
  if (secretKeys.size > APP_TEMPLATE_LIMITS.secretParameters) refuse(["parameters"], "Too many secret parameters");

  ascending(spec.services.map((service) => service.key), (i) => ["services", i, "key"], "Services must be sorted by unique key");
  ascending(spec.volumes.map((volume) => volume.key), (i) => ["volumes", i, "key"], "Volumes must be sorted by unique key");
  const services = new Map(spec.services.map((service) => [service.key, service]));
  const declaredVolumes = new Set(spec.volumes.map((volume) => volume.key));
  const mountedVolumes = new Set<string>();
  let exposeTotal = 0;

  spec.services.forEach((service, s) => {
    const at = (...path: Path): Path => ["services", s, ...path];
    service.volumes.forEach((mount, m) => {
      mountedVolumes.add(mount.volumeKey);
      if (!declaredVolumes.has(mount.volumeKey)) refuse(at("volumes", m, "volumeKey"), "Undeclared volume");
      if (appStackContainerPathProblem(mount.containerPath) !== null) refuse(at("volumes", m, "containerPath"), "Invalid container path");
    });
    unique(service.volumes.map((mount) => mount.containerPath), (m) => at("volumes", m, "containerPath"), "Duplicate container path");
    unique(service.expose, (e) => at("expose", e), "Duplicate exposed port");
    exposeTotal += service.expose.length;
    unique(service.dependsOn, (d) => at("dependsOn", d), "Duplicate dependency");
    service.dependsOn.forEach((dependency, d) => {
      if (dependency === service.key || !services.has(dependency)) refuse(at("dependsOn", d), "Invalid dependency");
    });
    unique(service.environment.map((entry) => entry.name), (e) => at("environment", e, "name"), "Duplicate environment name");
    service.environment.forEach((entry, e) => {
      if ("value" in entry) {
        if (appStackEnvValueNameProblem(entry.name) !== null) refuse(at("environment", e, "name"), "Invalid environment name");
      } else {
        const asFile = appStackSecretEnvNameProblem(entry.name) === null;
        const asVariable = environmentSecrets && appStackSecretEnvironmentNameProblem(entry.name) === null;
        if (!asFile && !asVariable) refuse(at("environment", e, "name"), environmentSecrets ? "Invalid secret name" : "Invalid secret file name");
        if (!secretKeys.has(entry.secretParameter)) refuse(at("environment", e, "secretParameter"), "Not a secret parameter");
      }
    });
    if (service.healthcheck && !service.expose.includes(service.healthcheck.port)) {
      refuse(at("healthcheck", "port"), "The health check port is not exposed");
    }
  });
  spec.volumes.forEach((volume, v) => {
    if (!mountedVolumes.has(volume.key)) refuse(["volumes", v, "key"], "Unused volume");
  });
  if (exposeTotal > APP_TEMPLATE_LIMITS.expose) refuse(["services"], "Too many exposed ports");

  unique(spec.ingress.map((route) => `${route.service}:${route.port}`), (i) => ["ingress", i], "Duplicate ingress");
  spec.ingress.forEach((route, i) => {
    const target = services.get(route.service);
    if (!target || target.healthcheck === null) refuse(["ingress", i, "service"], "The ingress target needs a health check");
    else if (!target.expose.includes(route.port)) refuse(["ingress", i, "port"], "The ingress port is not exposed");
  });

  const tasks = spec.tasks ?? [];
  unique(tasks.map((task) => task.key), (t) => ["tasks", t, "key"], "Duplicate task key");
  tasks.forEach((task, t) => {
    if (!services.has(task.service)) refuse(["tasks", t, "service"], "The task names no component of this template");
  });
}

const SpecHead = {
  name: z.string().min(1).max(APP_TEMPLATE_LIMITS.stackName).refine(noControlCharacter),
  category: z.string().regex(APP_TEMPLATE_CATEGORY_PATTERN),
  /** "" when the source has none. */
  description: z.string().max(APP_TEMPLATE_LIMITS.stackDescription).refine(noControlCharacter),
};
const SpecTail = {
  volumes: z.array(z.object({ key: AppStackKeySchema }).strict()).max(APP_TEMPLATE_LIMITS.volumes),
  ingress: z.array(AppTemplateIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
  /** Both formats (ADR-0042). Only when the source declares a task, in its order: a template without tasks keeps its spec and its hash. */
  tasks: z.array(AppTemplateTaskSchema).min(1).max(APP_TEMPLATE_LIMITS.tasks).optional(),
};

/** `HCP-STACK/v1`: unchanged since ADR-0035; its stored specs and their hashes never move. */
export const AppTemplateSpecV1Schema = z
  .object({
    schemaVersion: z.literal(APP_TEMPLATE_SPEC_VERSION),
    ...SpecHead,
    parameters: z.array(AppTemplateParameterSchema).max(APP_TEMPLATE_LIMITS.parameters),
    services: z.array(AppTemplateServiceSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    ...SpecTail,
  })
  .strict();
/** `HCP-STACK/v2` (ADR-0036): generated secrets, environment secrets, a run profile per service. */
export const AppTemplateSpecV2Schema = z
  .object({
    schemaVersion: z.literal(APP_TEMPLATE_SPEC_VERSION_2),
    ...SpecHead,
    parameters: z.array(AppTemplateParameterV2Schema).max(APP_TEMPLATE_LIMITS.parameters),
    services: z.array(AppTemplateServiceV2Schema).min(1).max(APP_TEMPLATE_LIMITS.services),
    ...SpecTail,
  })
  .strict();

/**
 * The last guard on what the validator produced (it reports each rule with a precise code first): a failure here is
 * SPEC_INTERNAL. Acyclicity is checked by the validator and by the plan order rule. A key of one format in a spec of
 * the other is an unknown key.
 */
export const AppTemplateSpecSchema = z
  .discriminatedUnion("schemaVersion", [AppTemplateSpecV1Schema, AppTemplateSpecV2Schema])
  .superRefine(appTemplateSpecRefine);
export type AppTemplateSpecV1 = z.infer<typeof AppTemplateSpecV1Schema>;
export type AppTemplateSpecV2 = z.infer<typeof AppTemplateSpecV2Schema>;
export type AppTemplateSpec = z.infer<typeof AppTemplateSpecSchema>;
