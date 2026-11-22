import { z } from "zod";

/** x-hp-stack.schemaVersion and app_template_versions.spec_version. */
export const APP_TEMPLATE_SPEC_VERSION = 1 as const;
export const APP_STACK_PLAN_SCHEMA_VERSION = 1 as const;

export const APP_TEMPLATE_LIMITS = {
  sourceBytes: 65_536, // = TEMPLATE_SOURCE_MAX_BYTES (parser)
  depth: 16, // = YAML_MAX_DEPTH
  nodes: 4_096, // = YAML_MAX_NODES
  issues: 50,
  stackName: 80,
  stackDescription: 500,
  parameters: 32,
  secretParameters: 8, // IPC: 8 x 16 KiB secret values + plan < 1 MiB body
  parameterLabel: 80,
  options: 32,
  optionLength: 64,
  stringValue: 256, // = SITE_TEMPLATE_STRING_PARAMETER_MAX
  integerBound: 1_000_000_000,
  services: 8,
  argvItems: 64,
  argvItemLength: 1_024,
  environment: 64, // value + secret entries per service
  envValueLength: 4_096, // literal and after interpolation; = SITE_TEMPLATE_ENV_VALUE_MAX
  volumes: 8,
  mountsPerService: 8,
  containerPathLength: 255,
  expose: 16, // stack total
  dependsOn: 8,
  ingress: 8,
  healthPathLength: 256,
  healthIntervalMin: 5,
  healthIntervalMax: 300,
  healthIntervalDefault: 10,
  healthTimeoutMin: 1,
  healthTimeoutMax: 30,
  healthTimeoutDefault: 3,
  cpuMilliMin: 50,
  cpuMilliMax: 16_000, // <= MAX_SERVICE_CPU_MILLI
  memoryBytesMin: 33_554_432, // 32 MiB
  memoryBytesMax: 17_179_869_184, // 16 GiB, <= MAX_SERVICE_MEMORY_BYTES
  secretVersionMax: 2_147_483_647,
  imageReferenceLength: 255, // = parseImageReference MAX_LENGTH
} as const;

/** UTF-8 bytes of JSON.stringify(plan). */
export const APP_STACK_PLAN_MAX_BYTES = 262_144;
/** HostConfig.PidsLimit of every component: not an input, not in the plan. */
export const APP_STACK_PIDS_LIMIT = 256;
/** Container dir of the secret files; already a FORBIDDEN_CONTAINER_MOUNT_TARGET. */
export const APP_STACK_SECRET_DIR = "/run/secrets";

/** Must also not start with "hp_". */
export const APP_TEMPLATE_PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Service (component) and volume keys: no "_", DNS-label safe. */
export const APP_STACK_KEY_PATTERN = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Service (component) keys: "hp_app_" (7) + minted stack id "stk_" + 24 hex (28) + "_" (1) + 27 = 63, one DNS label. */
export const APP_STACK_COMPONENT_KEY_MAX = 27;
export const APP_STACK_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const APP_TEMPLATE_CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const APP_TEMPLATE_OPTION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Every id this feature mints (stack, template, version, revision, deployment, domain, secret). */
export const APP_STACK_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Ids of entities this feature does not mint (organisation `org_<uuid>`, host allocation). */
export const APP_FOREIGN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/;
export const APP_STACK_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const APP_STACK_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
/** Plus: no "//", no "." or ".." segment (appStackHealthPathProblem). */
export const APP_STACK_HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]{0,255}$/;
export const APP_STACK_RUN_AS_USER_PATTERN = /^[0-9]{1,10}(?::[0-9]{1,10})?$/;
export const APP_STACK_MEMORY_BYTES_PATTERN = /^[1-9][0-9]{0,11}$/;

export const AppStackKeySchema = z.string().regex(APP_STACK_KEY_PATTERN);
export const AppTemplateParameterKeySchema = z
  .string()
  .regex(APP_TEMPLATE_PARAMETER_KEY_PATTERN)
  .refine((key) => !key.startsWith("hp_"), "reserved prefix");
export const AppStackEnvNameSchema = z.string().regex(APP_STACK_ENV_NAME_PATTERN);
export const AppStackPortSchema = z.number().int().min(1).max(65_535);
export const AppStackResourcesSchema = z
  .object({
    cpuMilli: z.number().int().min(APP_TEMPLATE_LIMITS.cpuMilliMin).max(APP_TEMPLATE_LIMITS.cpuMilliMax),
    memoryBytes: z
      .string()
      .regex(APP_STACK_MEMORY_BYTES_PATTERN)
      .refine(
        (v) =>
          !APP_STACK_MEMORY_BYTES_PATTERN.test(v) ||
          (BigInt(v) >= BigInt(APP_TEMPLATE_LIMITS.memoryBytesMin) && BigInt(v) <= BigInt(APP_TEMPLATE_LIMITS.memoryBytesMax)),
      ),
  })
  .strict();
export const AppStackVolumeMountSchema = z
  .object({
    volumeKey: AppStackKeySchema,
    /** appStackContainerPathProblem === null is refined where the schema is used. */
    containerPath: z.string().min(2).max(APP_TEMPLATE_LIMITS.containerPathLength),
    readOnly: z.boolean(),
  })
  .strict();
