import { z } from "zod";
import { SITE_TEMPLATE_SIZE_PATTERN } from "../site-templates/spec.js";
import {
  APP_STACK_COMPONENT_KEY_MAX,
  APP_STACK_DIGEST_PATTERN,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_LIMITS,
  APP_TEMPLATE_OPTION_PATTERN,
  APP_TEMPLATE_SPEC_VERSION,
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
} from "./text.js";

const noControlCharacter = (text: string): boolean => !/\p{Cc}/u.test(text);
const Label = z.string().min(1).max(APP_TEMPLATE_LIMITS.parameterLabel).refine(noControlCharacter);
const ParameterHead = { key: AppTemplateParameterKeySchema, label: Label };
const IntegerBound = z.number().int().min(-APP_TEMPLATE_LIMITS.integerBound).max(APP_TEMPLATE_LIMITS.integerBound);

export const APP_TEMPLATE_PARAMETER_TYPES = ["enum", "integer", "string", "boolean", "size", "secret"] as const;
export type AppTemplateParameterType = (typeof APP_TEMPLATE_PARAMETER_TYPES)[number];

/** Key order follows the stored spec (fixture spec.json), so a parsed spec serialises like the validator's output. */
export const AppTemplateParameterSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...ParameterHead,
        type: z.literal("enum"),
        options: z.array(z.string().regex(APP_TEMPLATE_OPTION_PATTERN)).min(1).max(APP_TEMPLATE_LIMITS.options),
        default: z.string(),
        customer: z.boolean(),
      })
      .strict(),
    z
      .object({
        ...ParameterHead,
        type: z.literal("integer"),
        min: IntegerBound.optional(),
        max: IntegerBound.optional(),
        default: IntegerBound,
        customer: z.boolean(),
      })
      .strict(),
    z
      .object({ ...ParameterHead, type: z.literal("string"), default: z.string().max(APP_TEMPLATE_LIMITS.stringValue), customer: z.boolean() })
      .strict(),
    z.object({ ...ParameterHead, type: z.literal("boolean"), default: z.boolean(), customer: z.boolean() }).strict(),
    z.object({ ...ParameterHead, type: z.literal("size"), default: z.string().regex(SITE_TEMPLATE_SIZE_PATTERN), customer: z.boolean() }).strict(),
    z.object({ ...ParameterHead, type: z.literal("secret"), required: z.boolean(), customer: z.literal(true) }).strict(),
  ])
  .superRefine((parameter, ctx) => {
    if (parameter.type === "secret") return;
    if (parameter.type === "enum" && new Set(parameter.options).size !== parameter.options.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
    }
    if (parameter.type === "integer" && parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) {
      ctx.addIssue({ code: "custom", path: ["min"], message: "The minimum must not exceed the maximum" });
    }
    if (appTemplateValueProblem(parameter, parameter.default) !== null) {
      ctx.addIssue({ code: "custom", path: ["default"], message: `The default is not a valid ${parameter.type}` });
    }
  });
export type AppTemplateParameter = z.infer<typeof AppTemplateParameterSchema>;

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
export type AppTemplateService = z.infer<typeof AppTemplateServiceSchema>;

export const AppTemplateIngressSchema = z.object({ service: AppStackKeySchema, port: AppStackPortSchema }).strict();

type Path = (string | number)[];

/**
 * The last guard on what the validator produced (it reports each rule with a precise code first): a failure here is
 * SPEC_INTERNAL. Acyclicity is checked by the validator and by the plan order rule.
 */
export const AppTemplateSpecSchema = z
  .object({
    schemaVersion: z.literal(APP_TEMPLATE_SPEC_VERSION),
    name: z.string().min(1).max(APP_TEMPLATE_LIMITS.stackName).refine(noControlCharacter),
    category: z.string().regex(APP_TEMPLATE_CATEGORY_PATTERN),
    /** "" when the source has none. */
    description: z.string().max(APP_TEMPLATE_LIMITS.stackDescription).refine(noControlCharacter),
    parameters: z.array(AppTemplateParameterSchema).max(APP_TEMPLATE_LIMITS.parameters),
    services: z.array(AppTemplateServiceSchema).min(1).max(APP_TEMPLATE_LIMITS.services),
    volumes: z.array(z.object({ key: AppStackKeySchema }).strict()).max(APP_TEMPLATE_LIMITS.volumes),
    ingress: z.array(AppTemplateIngressSchema).max(APP_TEMPLATE_LIMITS.ingress),
  })
  .strict()
  .superRefine((spec, ctx) => {
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
          if (appStackSecretEnvNameProblem(entry.name) !== null) refuse(at("environment", e, "name"), "Invalid secret file name");
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
  });
export type AppTemplateSpec = z.infer<typeof AppTemplateSpecSchema>;
