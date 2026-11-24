import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_IMAGE_ALLOWLIST,
  appStackFreeImageProblem,
  appStackImageLookupProblem,
  appStackPlanImageProblems,
} from "../src/app-templates/images.js";
import { APP_TEMPLATE_ISSUE_CODES, APP_TEMPLATE_ISSUE_REASON } from "../src/app-templates/issues.js";
import {
  APP_SECRET_GENERATE_BOUNDS,
  APP_SECRET_GENERATE_KINDS,
  APP_STACK_PIDS_LIMIT,
  APP_STACK_PLAN_SCHEMA_VERSION,
  APP_STACK_PLAN_SCHEMA_VERSION_2,
  APP_STACK_RUN_PROFILES,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_STACK_SECRET_VALUE_LIMITS,
  APP_STACK_STANDARD_PIDS_LIMIT,
  APP_TEMPLATE_LIMITS,
  APP_TEMPLATE_SPEC_VERSION,
  APP_TEMPLATE_SPEC_VERSION_2,
  APP_TEMPLATE_SPEC_VERSIONS,
} from "../src/app-templates/limits.js";
import {
  type AppStackPlanComponentV2,
  type ApprovedStackPlanV2,
  ApprovedStackPlanSchema,
  AppStackPreviewSchema,
  appStackComponentEnvironmentSecretRefs,
  appStackComponentHashInput,
  appStackComponentProfile,
  appStackComponentSecretEnvironment,
  appStackComponentSecretRefs,
  appStackPlanEnvironmentSecretRefs,
  appStackPlanHashInput,
  appStackPlanSecretRefs,
  toAppStackPreview,
} from "../src/app-templates/plan.js";
import {
  type AppTemplateParameterV2,
  type AppTemplateSpecV2,
  AppTemplateAnyParameterSchema,
  AppTemplateParameterSchema,
  AppTemplateParameterV2Schema,
  AppTemplateSpecSchema,
  appSecretGenerateProblem,
  appTemplateHiddenSecretKeys,
  appTemplateInstallParameters,
  appTemplateSecretGenerate,
  appTemplateServiceProfile,
} from "../src/app-templates/spec.js";
import { AdminAppTemplateVersionDtoSchema, AppTemplateValidationDtoSchema } from "../src/app-templates/admin-dto.js";
import { CustomerAppTemplateDtoSchema } from "../src/app-templates/stack-dto.js";
import {
  AppStackCreateIpcRequestSchema,
  AppStackImageResolveIpcRequestSchema,
  AppStackImageResolveIpcResultSchema,
  AppStackPlanIpcRequestSchema,
} from "../src/app-templates/stack-ipc.js";
import { appStackSecretEnvironmentNameProblem } from "../src/app-templates/text.js";
import { ErrorDetailSchema } from "../src/errors.js";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, findUnsafeDockerInputFields } from "../src/resources.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8"));
const SPEC_V1 = fixture("spec.json") as Record<string, unknown>;
const PLAN_V1 = fixture("plan.json") as Record<string, unknown>;
const DIGEST_A = `sha256:${"a".repeat(64)}`;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

/** The v1 fixture spec in the second format: every service names its profile, the secret gains its generation rule. */
const SPEC_V2 = AppTemplateSpecSchema.parse({
  ...SPEC_V1,
  schemaVersion: 2,
  parameters: [
    { key: "worker_count", label: "Worker count", type: "integer", min: 1, max: 4, default: 2, customer: true },
    { key: "app_secret", label: "Application secret", type: "secret", required: true, customer: false, generate: { kind: "password", length: 32 } },
    { key: "api_key", label: "API key", type: "secret", required: false, customer: true, generate: null },
  ],
  services: (SPEC_V1.services as Record<string, unknown>[]).map((service, index) => ({
    ...service,
    ...(index === 0
      ? {
          environment: [
            { name: "CACHE_HOST", value: "cache" },
            { name: "DATABASE_URL", value: "postgres://app:${app_secret}@db:5432/app" },
            { name: "APP_SECRET_FILE", secretParameter: "app_secret" },
            { name: "APP_SECRET", secretParameter: "app_secret" },
          ],
        }
      : {}),
    profile: index === 0 ? "standard" : "strict",
  })),
}) as AppTemplateSpecV2;

const specVariant = (change: (spec: Mutable<AppTemplateSpecV2>) => void): unknown => {
  const spec = structuredClone(SPEC_V2) as Mutable<AppTemplateSpecV2>;
  change(spec);
  return spec;
};
const specPaths = (value: unknown): string[] => {
  const result = AppTemplateSpecSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")).sort();
};

/** The v1 fixture plan as a version 2 plan: `app` runs "standard" with two environment secrets. */
const PLAN_V2 = ApprovedStackPlanSchema.parse({
  ...PLAN_V1,
  schemaVersion: 2,
  components: (PLAN_V1.components as Record<string, unknown>[]).map((component) =>
    component.key === "app"
      ? {
          ...component,
          profile: "standard",
          secretEnvironment: [
            { name: "APP_SECRET", pieces: [{ parameterKey: "app_secret", version: 1 }] },
            {
              name: "DATABASE_URL",
              pieces: [{ literal: "postgres://app:" }, { parameterKey: "db_password", version: 3 }, { literal: "@db:5432/app" }],
            },
          ],
        }
      : { ...component, profile: "strict", secretEnvironment: [] },
  ),
}) as ApprovedStackPlanV2;

const planVariant = (change: (plan: Mutable<ApprovedStackPlanV2>, app: Mutable<AppStackPlanComponentV2>) => void): unknown => {
  const plan = structuredClone(PLAN_V2) as Mutable<ApprovedStackPlanV2>;
  change(plan, plan.components[1] as Mutable<AppStackPlanComponentV2>);
  return plan;
};
const planPaths = (value: unknown): string[] => {
  const result = ApprovedStackPlanSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")).sort();
};
const planMessages = (value: unknown): string[] => {
  const result = ApprovedStackPlanSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("HCP-STACK/v2 constants", () => {
  it("adds a second version next to the first, which keeps its value", () => {
    expect(APP_TEMPLATE_SPEC_VERSION).toBe(1);
    expect(APP_STACK_PLAN_SCHEMA_VERSION).toBe(1);
    expect(APP_TEMPLATE_SPEC_VERSION_2).toBe(2);
    expect(APP_STACK_PLAN_SCHEMA_VERSION_2).toBe(2);
    expect(APP_TEMPLATE_SPEC_VERSIONS).toEqual([1, 2]);
  });

  it("knows two run profiles and the pids limit of each", () => {
    expect(APP_STACK_RUN_PROFILES).toEqual(["strict", "standard"]);
    expect(APP_STACK_PIDS_LIMIT).toBe(256);
    expect(APP_STACK_STANDARD_PIDS_LIMIT).toBe(512);
  });

  it("bounds every generation kind", () => {
    expect(APP_SECRET_GENERATE_KINDS).toEqual(["password", "hex", "base64", "user"]);
    expect(APP_SECRET_GENERATE_BOUNDS).toEqual({
      password: { min: 16, max: 128 },
      hex: { min: 16, max: 128 },
      base64: { min: 16, max: 96 },
      user: { min: 8, max: 32 },
    });
    expect(Object.isFrozen(APP_SECRET_GENERATE_BOUNDS)).toBe(true);
  });

  it("keeps an expanded environment value within the executor's bound", () => {
    const { referencesPerValue, pieces, secretBytes, expandedBytes } = APP_STACK_SECRET_ENV_LIMITS;
    expect(pieces).toBe(2 * referencesPerValue + 1);
    expect(referencesPerValue * secretBytes + 3 * APP_TEMPLATE_LIMITS.envValueLength).toBeLessThanOrEqual(expandedBytes);
  });

  it("names the two bounds a private value the customer types can pass, a closed value of the refusal's detail", () => {
    expect(APP_STACK_SECRET_VALUE_LIMITS).toEqual(["environment", "store"]);
    const detail = { field: "value", message: "too long", reason: "value_too_long" };
    for (const limit of APP_STACK_SECRET_VALUE_LIMITS) expect(ErrorDetailSchema.parse({ ...detail, limit })).toEqual({ ...detail, limit });
    expect(ErrorDetailSchema.safeParse({ ...detail, limit: "file" }).success).toBe(false);
    expect(ErrorDetailSchema.parse(detail)).toEqual(detail);
  });

  it("gives the three new validator codes the template reason", () => {
    for (const code of ["PARAM_GENERATE_INVALID", "SERVICE_PROFILE_INVALID", "ENV_SECRET_REFERENCES_TOO_MANY"] as const) {
      expect(APP_TEMPLATE_ISSUE_CODES).toContain(code);
      expect(APP_TEMPLATE_ISSUE_REASON[code]).toBe("STACK_TEMPLATE_INVALID");
    }
  });
});

describe("AppTemplateSpecSchema: the second format", () => {
  it("parses a v2 spec to an equal value and keeps the key order of the first format, then the profile", () => {
    expect(AppTemplateSpecSchema.parse(JSON.parse(JSON.stringify(SPEC_V2)))).toEqual(SPEC_V2);
    expect(Object.keys(SPEC_V2)).toEqual(Object.keys(SPEC_V1));
    expect(Object.keys(SPEC_V2.services[0] as object)).toEqual([...Object.keys((SPEC_V1.services as object[])[0] as object), "profile"]);
    expect(Object.keys(SPEC_V2.parameters[1] as object)).toEqual(["key", "label", "type", "required", "customer", "generate"]);
  });

  it("still parses the v1 fixture to the same text", () => {
    expect(JSON.stringify(AppTemplateSpecSchema.parse(SPEC_V1))).toBe(JSON.stringify(SPEC_V1));
  });

  it("refuses a key of the second format in a spec of the first", () => {
    const services = SPEC_V1.services as Record<string, unknown>[];
    expect(specPaths({ ...SPEC_V1, services: [{ ...services[0], profile: "standard" }, services[1]] })).toEqual(["services.0"]);
    const generated = { key: "app_secret", label: "S", type: "secret", required: true, customer: true, generate: { kind: "hex", length: 32 } };
    expect(specPaths({ ...SPEC_V1, parameters: [generated] })).toEqual(["parameters.0"]);
    const notCustomer = { key: "app_secret", label: "S", type: "secret", required: true, customer: false };
    expect(specPaths({ ...SPEC_V1, parameters: [notCustomer] })).toEqual(["parameters.0.customer"]);
    expect(AppTemplateParameterSchema.safeParse(generated).success).toBe(false);
  });

  it("refuses a v2 spec without a profile, with an unknown one, or with a version it does not know", () => {
    expect(specPaths(specVariant((s) => delete (s.services[0] as { profile?: string }).profile))).toEqual(["services.0.profile"]);
    expect(specPaths(specVariant((s) => ((s.services[0] as { profile: string }).profile = "privileged")))).toEqual(["services.0.profile"]);
    expect(specPaths({ ...SPEC_V2, schemaVersion: 3 })).toEqual(["schemaVersion"]);
  });

  it("accepts a secret as an environment variable only in the second format", () => {
    const entry = { name: "APP_SECRET", secretParameter: "app_secret" };
    const services = SPEC_V1.services as Record<string, unknown>[];
    expect(specPaths({ ...SPEC_V1, services: [{ ...services[0], environment: [entry] }, services[1]] })).toEqual(["services.0.environment.0.name"]);
    expect(specPaths(specVariant((s) => void (s.services[0]!.environment = [entry])))).toEqual([]);
  });

  it.each(["HP_TOKEN", "LD_PRELOAD", "DOCKER_HOST", "PATH", "_FILE", "PATH_FILE"])("refuses the secret name %s", (name) => {
    expect(specPaths(specVariant((s) => void (s.services[0]!.environment = [{ name, secretParameter: "app_secret" }])))).toEqual([
      "services.0.environment.0.name",
    ]);
  });

  it("refuses a secret entry of a parameter that is not a secret", () => {
    expect(specPaths(specVariant((s) => void (s.services[0]!.environment = [{ name: "WORKERS", secretParameter: "worker_count" }])))).toEqual([
      "services.0.environment.0.secretParameter",
    ]);
  });
});

describe("AppTemplateParameterV2Schema: generated secrets", () => {
  const generated = (generate: unknown, extra: Record<string, unknown> = {}) => ({
    key: "db_password",
    label: "Database password",
    type: "secret",
    required: true,
    customer: false,
    generate,
    ...extra,
  });
  const paths = (value: unknown): string[] => {
    const result = AppTemplateParameterV2Schema.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  };

  it.each(APP_SECRET_GENERATE_KINDS.map((kind) => [kind, APP_SECRET_GENERATE_BOUNDS[kind]] as const))(
    "accepts %s exactly within its bounds",
    (kind, { min, max }) => {
      expect(paths(generated({ kind, length: min }))).toEqual([]);
      expect(paths(generated({ kind, length: max }))).toEqual([]);
      expect(paths(generated({ kind, length: min - 1 }))).toEqual(["generate.length"]);
      expect(paths(generated({ kind, length: max + 1 }))).toEqual(["generate.length"]);
      expect(appSecretGenerateProblem({ kind, length: min })).toBeNull();
      expect(appSecretGenerateProblem({ kind, length: max + 1 })).toBe("length");
    },
  );

  it("refuses an unknown kind, a fractional length and an extra key", () => {
    expect(paths(generated({ kind: "uuid", length: 32 }))).toEqual(["generate.kind"]);
    expect(paths(generated({ kind: "hex", length: 32.5 }))).toEqual(["generate.length"]);
    expect(paths(generated({ kind: "hex", length: 32, alphabet: "abc" }))).toEqual(["generate"]);
  });

  it("requires `generate`, as a rule or as null", () => {
    expect(paths({ key: "db_password", label: "D", type: "secret", required: true, customer: true })).toEqual(["generate"]);
  });

  it("lets the customer replace a generated secret, and refuses a generated secret that is not required", () => {
    expect(paths(generated({ kind: "password", length: 32 }, { customer: true }))).toEqual([]);
    expect(paths(generated({ kind: "password", length: 32 }, { required: false }))).toEqual(["required"]);
  });

  it("refuses a secret that nobody sets: not generated and not the customer's", () => {
    expect(paths(generated(null))).toEqual(["customer"]);
    expect(paths(generated(null, { customer: true }))).toEqual([]);
    expect(paths(generated(null, { customer: true, required: false }))).toEqual([]);
  });

  it("keeps the rules of a parameter with a default", () => {
    expect(paths({ key: "mode", label: "M", type: "enum", options: ["a", "a"], default: "a", customer: true })).toEqual(["options"]);
    expect(paths({ key: "n", label: "N", type: "integer", min: 5, max: 1, default: 3, customer: true })).toEqual(["min", "default"]);
    expect(paths({ key: "n", label: "N", type: "string", default: "x", customer: true, generate: null })).toEqual([""]);
  });

  it("reads the generation rule and the profile through the helpers of both formats", () => {
    expect(SPEC_V2.parameters.map(appTemplateSecretGenerate)).toEqual([null, { kind: "password", length: 32 }, null]);
    expect(SPEC_V2.services.map(appTemplateServiceProfile)).toEqual(["standard", "strict"]);
    const v1 = AppTemplateSpecSchema.parse(SPEC_V1);
    expect(v1.parameters.map(appTemplateSecretGenerate)).toEqual([null, null]);
    expect(v1.services.map(appTemplateServiceProfile)).toEqual(["strict", "strict"]);
  });
});

describe("ApprovedStackPlanSchema: version 2", () => {
  it("parses a version 2 plan to an equal value: the v1 keys in their order, then profile and secretEnvironment", () => {
    expect(ApprovedStackPlanSchema.parse(JSON.parse(JSON.stringify(PLAN_V2)))).toEqual(PLAN_V2);
    expect(Object.keys(PLAN_V2)).toEqual(Object.keys(PLAN_V1));
    expect(Object.keys(PLAN_V2.components[0] as object)).toEqual([
      ...Object.keys((PLAN_V1.components as object[])[0] as object),
      "profile",
      "secretEnvironment",
    ]);
  });

  it("still parses the v1 fixture to the same text", () => {
    expect(JSON.stringify(ApprovedStackPlanSchema.parse(PLAN_V1))).toBe(JSON.stringify(PLAN_V1));
  });

  it("refuses a profile or an environment secret in a version 1 plan", () => {
    const [cache, app] = PLAN_V1.components as Record<string, unknown>[];
    expect(planPaths({ ...PLAN_V1, components: [cache, { ...app, profile: "standard" }] })).toEqual(["components.1"]);
    expect(planPaths({ ...PLAN_V1, components: [cache, { ...app, secretEnvironment: [] }] })).toEqual(["components.1"]);
  });

  it("refuses a version 2 component without its two keys, an unknown profile and an unknown version", () => {
    expect(planPaths(planVariant((_, app) => delete (app as { profile?: string }).profile))).toEqual(["components.1.profile"]);
    expect(planPaths(planVariant((_, app) => delete (app as { secretEnvironment?: unknown }).secretEnvironment))).toEqual([
      "components.1.secretEnvironment",
    ]);
    expect(planPaths(planVariant((_, app) => void ((app as { profile: string }).profile = "host")))).toEqual(["components.1.profile"]);
    expect(planPaths({ ...PLAN_V2, schemaVersion: 3 })).toEqual(["schemaVersion"]);
  });

  it.each([
    ["capAdd", ["NET_ADMIN"]],
    ["privileged", true],
    ["user", "0:0"],
    ["readOnly", false],
    ["devices", ["/dev/kmsg"]],
    ["networkMode", "host"],
  ])("refuses the key %s on a version 2 component", (key, value) => {
    expect(planPaths(planVariant((_, app) => void ((app as Record<string, unknown>)[key] = value)))).toContain("components.1");
  });

  it("holds no key or value the three finders refuse", () => {
    expect(findUnsafeDockerInputFields(PLAN_V2)).toEqual([]);
    expect(findPlaintextSecretKeys(PLAN_V2)).toEqual([]);
    expect(findForbiddenPublicDtoKeys(PLAN_V2)).toEqual([]);
    expect(findForbiddenPublicDtoKeys(toAppStackPreview(PLAN_V2))).toEqual([]);
  });
});

describe("ApprovedStackPlanSchema: environment secrets", () => {
  const at = (path: string) => `components.1.secretEnvironment.${path}`;
  const ref = (parameterKey: string, version = 1) => ({ parameterKey, version });

  it.each([
    ["a name ending in _FILE", "APP_SECRET_FILE"],
    ["a reserved prefix", "HP_SECRET"],
    ["the name PATH", "PATH"],
    ["a lower-case name", "app_secret"],
  ])("refuses %s", (_, name) => {
    const paths = planPaths(planVariant((_plan, app) => void (app.secretEnvironment[0]!.name = name)));
    expect(paths.some((path) => path.startsWith(at("0.name")))).toBe(true);
  });

  it("refuses a name the plain environment already uses", () => {
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.name = "CACHE_HOST")))).toEqual([at("0.name")]);
  });

  it("refuses entries that are not sorted by unique name", () => {
    expect(planPaths(planVariant((_, app) => void app.secretEnvironment.reverse()))).toEqual([at("1.name")]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[1]!.name = "APP_SECRET")))).toEqual([at("1.name")]);
  });

  it("refuses an entry without a secret reference: that is a plain value", () => {
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [{ literal: "plain" }])))).toEqual([at("0.pieces")]);
    expect(new Set(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = []))))).toEqual(new Set([at("0.pieces")]));
  });

  it("accepts four secret references in one value and refuses five", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const pieces = (count: number) => keys.slice(0, count).flatMap((key, index) => (index === 0 ? [ref(key)] : [{ literal: ":" }, ref(key)]));
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = pieces(4))))).toEqual([]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = pieces(5))))).toEqual([at("0.pieces")]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [ref("a"), ref("b"), ref("c"), ref("d"), ref("e")])))).toEqual([
      at("0.pieces"),
    ]);
  });

  it("refuses two literal pieces side by side and an empty literal", () => {
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [{ literal: "a" }, { literal: "b" }, ref("a")])))).toEqual([
      at("0.pieces.1"),
    ]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [{ literal: "" }, ref("a")])))).toEqual([at("0.pieces.0.literal")]);
  });

  it.each([
    ["the Docker socket", "unix:///var/run/docker.sock"],
    ["a metadata endpoint", "http://169.254.169.254/latest"],
    ["whole URL credentials", "https://user:hunter2hunter2@example.invalid/"],
    ["a control character", "a\u0000b"],
  ])("refuses a literal piece with %s", (_, literal) => {
    const paths = planPaths(planVariant((_plan, app) => void (app.secretEnvironment[0]!.pieces = [{ literal }, ref("a")])));
    expect(paths).toContain(at("0.pieces.0.literal"));
  });

  it("accepts a URL whose password is the secret reference", () => {
    expect(PLAN_V2.components[1]!.secretEnvironment[1]!.pieces).toEqual([
      { literal: "postgres://app:" },
      { parameterKey: "db_password", version: 3 },
      { literal: "@db:5432/app" },
    ]);
  });

  it("bounds the literal text of one value at the length of a plain value", () => {
    const long = "x".repeat(APP_TEMPLATE_LIMITS.envValueLength / 2);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [{ literal: long }, ref("a"), { literal: long }])))).toEqual([]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [{ literal: long }, ref("a"), { literal: `${long}x` }])))).toEqual([
      at("0.pieces"),
    ]);
  });

  it("counts plain values, secret files and environment secrets together: 64 at most", () => {
    const fill = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `V${String(i).padStart(2, "0")}`, value: "v" }));
    expect(planPaths(planVariant((_, app) => void (app.environment = fill(61))))).toEqual([]);
    expect(planPaths(planVariant((_, app) => void (app.environment = fill(62))))).toEqual(["components.1.environment"]);
  });

  it("counts the secrets of files and environment together: 8 at most", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ name: `S${String(i)}`, pieces: [ref(`key_${String(i)}`)] }));
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment = entries(7))))).toEqual([]);
    expect(planPaths(planVariant((_, app) => void (app.secretEnvironment = entries(8))))).toEqual(["components"]);
  });

  it("refuses two versions of one secret in a version 2 plan, and leaves version 1 plans as they were", () => {
    const twoVersions = planVariant((_, app) => void (app.secretEnvironment[0]!.pieces = [ref("app_secret", 2)]));
    expect(planPaths(twoVersions)).toEqual([at("0.pieces.0.version")]);
    expect(planMessages(twoVersions)).toEqual(["A secret has one version in a plan"]);
    const [cache, app] = PLAN_V1.components as Record<string, unknown>[];
    const files = [
      { envName: "A_FILE", parameterKey: "app_secret", version: 1 },
      { envName: "B_FILE", parameterKey: "app_secret", version: 2 },
    ];
    expect(planPaths({ ...PLAN_V1, components: [cache, { ...app, secretFiles: files }] })).toEqual([]);
  });

  it("names an environment secret by the same rule as a plain value", () => {
    expect(appStackSecretEnvironmentNameProblem("WORDPRESS_DB_PASSWORD")).toBeNull();
    expect(appStackSecretEnvironmentNameProblem("WORDPRESS_DB_PASSWORD_FILE")).toBe("reserved");
    expect(appStackSecretEnvironmentNameProblem("HP_X")).toBe("reserved");
    expect(appStackSecretEnvironmentNameProblem("1X")).toBe("invalid");
  });
});

describe("Plan helpers over both versions", () => {
  const v1 = ApprovedStackPlanSchema.parse(PLAN_V1);

  it("reads the profile and the environment secrets of a component", () => {
    expect(PLAN_V2.components.map(appStackComponentProfile)).toEqual(["strict", "standard"]);
    expect(v1.components.map(appStackComponentProfile)).toEqual(["strict", "strict"]);
    expect(v1.components.map(appStackComponentSecretEnvironment)).toEqual([[], []]);
    expect(appStackComponentSecretEnvironment(PLAN_V2.components[1]!).map((entry) => entry.name)).toEqual(["APP_SECRET", "DATABASE_URL"]);
  });

  it("lists the secret references of a component and of a plan: distinct, by key", () => {
    const app = PLAN_V2.components[1]!;
    expect(appStackComponentEnvironmentSecretRefs(app)).toEqual([
      { parameterKey: "app_secret", version: 1 },
      { parameterKey: "db_password", version: 3 },
    ]);
    expect(appStackComponentSecretRefs(app)).toEqual([
      { parameterKey: "app_secret", version: 1 },
      { parameterKey: "db_password", version: 3 },
    ]);
    expect(appStackComponentSecretRefs(PLAN_V2.components[0]!)).toEqual([]);
    expect(appStackPlanEnvironmentSecretRefs(PLAN_V2)).toEqual(appStackComponentEnvironmentSecretRefs(app));
    expect(appStackPlanSecretRefs(PLAN_V2)).toEqual(appStackComponentSecretRefs(app));
    expect(appStackPlanEnvironmentSecretRefs(v1)).toEqual([]);
    expect(appStackPlanSecretRefs(v1)).toEqual([{ parameterKey: "app_secret", version: 1 }]);
  });

  it("hashes the version, the profile and the environment secrets of a version 2 plan", () => {
    expect(appStackPlanHashInput(PLAN_V2).schemaVersion).toBe(2);
    const input = appStackComponentHashInput(PLAN_V2, "app");
    expect(input).toEqual({ schemaVersion: 2, component: PLAN_V2.components[1], edge: true });
    expect(input?.component).toHaveProperty("profile", "standard");
    expect(input?.component).toHaveProperty("secretEnvironment");
    expect(appStackComponentHashInput(v1, "app")).toEqual({ schemaVersion: 1, component: v1.components[1], edge: true });
    expect(Object.keys(appStackComponentHashInput(v1, "app")!.component)).not.toContain("profile");
  });

  it("drops every secret version from the preview and keeps the v1 preview unchanged", () => {
    const preview = toAppStackPreview(PLAN_V2);
    expect(AppStackPreviewSchema.parse(preview)).toEqual(preview);
    expect(JSON.stringify(preview)).not.toContain('"version"');
    expect(preview.components[1]!.profile).toBe("standard");
    expect(preview.components[1]!.secretEnvironment).toEqual([
      { name: "APP_SECRET", pieces: [{ parameterKey: "app_secret" }] },
      { name: "DATABASE_URL", pieces: [{ literal: "postgres://app:" }, { parameterKey: "db_password" }, { literal: "@db:5432/app" }] },
    ]);
    expect(JSON.stringify(toAppStackPreview(v1))).toBe(JSON.stringify(fixture("preview.json")));
  });
});

describe("Images of the second format", () => {
  const user = APP_IMAGE_ALLOWLIST.find((entry) => entry.runAsUser !== null)!;

  it("accepts any digest-pinned repository with the image's own user", () => {
    expect(appStackFreeImageProblem(`wordpress@${DIGEST_A}`, null)).toBeNull();
    expect(appStackFreeImageProblem(`ghcr.io/example/app@${DIGEST_A}`, null)).toBeNull();
  });

  it("refuses a reference without digest and a user the plan chose", () => {
    expect(appStackFreeImageProblem("wordpress:7.1.4", null)).toBe("not_digest_pinned");
    expect(appStackFreeImageProblem(`wordpress@${DIGEST_A}`, "0:0")).toBe("user_mismatch");
  });

  it("keeps forcing the user of a repository that has an allowlist row", () => {
    expect(appStackFreeImageProblem(`${user.repository}@${DIGEST_A}`, user.runAsUser)).toBeNull();
    expect(appStackFreeImageProblem(`${user.repository}@${DIGEST_A}`, null)).toBe("user_mismatch");
  });

  it("checks a plan by the rule of its version", () => {
    const components = [{ key: "web", image: `wordpress@${DIGEST_A}`, runAsUser: null }];
    expect(appStackPlanImageProblems({ schemaVersion: 2, components })).toEqual([]);
    expect(appStackPlanImageProblems({ schemaVersion: 1, components })).toEqual([{ componentKey: "web", problem: "not_allowlisted" }]);
    expect(appStackPlanImageProblems({ components })).toEqual([{ componentKey: "web", problem: "not_allowlisted" }]);
    expect(appStackPlanImageProblems(PLAN_V2)).toEqual([]);
  });

  it.each(["wordpress", "wordpress:7.1.4-php8.4-apache", "library/mariadb:12.3.3", "ghcr.io/example/app:1.0", "registry.example.invalid:5000/a/b/c:v1"])(
    "looks up %s",
    (image) => {
      expect(appStackImageLookupProblem(image)).toBeNull();
    },
  );

  it.each([
    ["an empty reference", ""],
    ["a digest", `wordpress@${DIGEST_A}`],
    ["credentials", "user:pass@registry.example.invalid/app:1"],
    ["a scheme", "https://registry.example.invalid/app:1"],
    ["a space", "wordpress 7"],
    ["an upper-case repository", "WordPress:7"],
    ["a path traversal", "../wordpress"],
    ["a query", "wordpress?tag=7"],
    ["a 256-character reference", `a/${"b".repeat(254)}`],
  ])("refuses to look up %s", (_, image) => {
    expect(appStackImageLookupProblem(image)).toBe("invalid");
  });
});

describe("Executor requests of the second format", () => {
  const contents = [{ parameterKey: "app_secret", version: 1, content: "s3cr3t-value" }];

  it("creates with or without secret contents, and refuses anything else", () => {
    expect(AppStackCreateIpcRequestSchema.safeParse({ plan: PLAN_V1 }).success).toBe(true);
    expect(AppStackCreateIpcRequestSchema.safeParse({ plan: PLAN_V2, secretContents: contents }).success).toBe(true);
    expect(AppStackCreateIpcRequestSchema.safeParse({ plan: PLAN_V2, secretContents: [...contents, ...contents] }).success).toBe(false);
    expect(AppStackCreateIpcRequestSchema.safeParse({ plan: PLAN_V2, secretFileContents: contents }).success).toBe(false);
    expect(AppStackCreateIpcRequestSchema.safeParse({ plan: PLAN_V2, secretContents: [{ ...contents[0], content: "a\u0000b" }] }).success).toBe(false);
  });

  it("prepares without contents", () => {
    expect(AppStackPlanIpcRequestSchema.safeParse({ plan: PLAN_V2 }).success).toBe(true);
    expect(AppStackPlanIpcRequestSchema.safeParse({ plan: PLAN_V2, secretContents: contents }).success).toBe(false);
  });

  it("resolves a tag to a digest", () => {
    expect(AppStackImageResolveIpcRequestSchema.safeParse({ image: "wordpress:7.1.4-php8.4-apache" }).success).toBe(true);
    expect(AppStackImageResolveIpcRequestSchema.safeParse({ image: `wordpress@${DIGEST_A}` }).success).toBe(false);
    expect(AppStackImageResolveIpcRequestSchema.safeParse({ image: "wordpress", registryAuth: "x" }).success).toBe(false);
    expect(AppStackImageResolveIpcResultSchema.safeParse({ image: "wordpress:7.1.4", digest: DIGEST_A }).success).toBe(true);
    expect(AppStackImageResolveIpcResultSchema.safeParse({ image: "wordpress:7.1.4", digest: "sha256:abc" }).success).toBe(false);
  });
});

describe("What each side sees of the parameters of the second format", () => {
  const PARAMETERS: AppTemplateParameterV2[] = [
    { key: "title", label: "Title", type: "string", default: "Demo", customer: true },
    { key: "replicas", label: "Replicas", type: "integer", min: 1, max: 4, default: 2, customer: false },
    { key: "db_password", label: "Database password", type: "secret", required: true, customer: false, generate: { kind: "password", length: 32 } },
    { key: "admin_password", label: "Administrator password", type: "secret", required: true, customer: true, generate: { kind: "hex", length: 24 } },
    { key: "api_key", label: "API key", type: "secret", required: false, customer: true, generate: null },
  ];

  it("the install form: the customer's parameters, without a generated secret, in the shape of the first format", () => {
    const asked = appTemplateInstallParameters(PARAMETERS);
    expect(asked).toEqual([
      { key: "title", label: "Title", type: "string", default: "Demo", customer: true },
      { key: "api_key", label: "API key", type: "secret", required: false, customer: true },
    ]);
    for (const parameter of asked) expect(AppTemplateParameterSchema.safeParse(parameter).success).toBe(true);
    expect(JSON.stringify(asked)).not.toContain("generate");
    expect(appTemplateInstallParameters([])).toEqual([]);
  });

  it("the install form of a template of the first format is its customer parameters, unchanged", () => {
    const v1 = AppTemplateSpecSchema.parse(SPEC_V1);
    expect(appTemplateInstallParameters(v1.parameters)).toEqual(v1.parameters.filter((parameter) => parameter.customer));
    expect(appTemplateInstallParameters(v1.parameters).map((parameter) => parameter.key)).toEqual(["worker_count", "app_secret"]);
  });

  it("the hidden secrets are the ones the customer may not set, and only secrets", () => {
    expect([...appTemplateHiddenSecretKeys(PARAMETERS)]).toEqual(["db_password"]);
    expect([...appTemplateHiddenSecretKeys(SPEC_V2.parameters)]).toEqual(["app_secret"]);
    expect(appTemplateHiddenSecretKeys(AppTemplateSpecSchema.parse(SPEC_V1).parameters).size).toBe(0);
  });

  it("a parameter of either format is accepted by the administrator's pages, and nothing else", () => {
    for (const parameter of [...PARAMETERS, ...AppTemplateSpecSchema.parse(SPEC_V1).parameters]) {
      expect(AppTemplateAnyParameterSchema.safeParse(parameter).success, parameter.key).toBe(true);
    }
    for (const bad of [
      { key: "db_password", label: "D", type: "secret", required: true, customer: false },
      { key: "db_password", label: "D", type: "secret", required: true, customer: false, generate: { kind: "uuid", length: 32 } },
      { key: "db_password", label: "D", type: "secret", required: true, customer: true, generate: null, value: "x" },
      { key: "n", label: "N", type: "string", default: "x", customer: true, generate: null },
    ]) {
      expect(AppTemplateAnyParameterSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the administrator's answers carry the generation rule; the customer's catalogue cannot", () => {
    const preview = toAppStackPreview(PLAN_V2);
    const validation = AppTemplateValidationDtoSchema.parse({ valid: true, issues: [], parameters: PARAMETERS, preview });
    expect(validation.parameters[2]).toEqual(PARAMETERS[2]);
    const version = AdminAppTemplateVersionDtoSchema.parse({
      id: "atv_demo_2",
      templateId: "atpl_demo",
      versionNumber: 2,
      specHash: "a".repeat(64),
      createdAt: "2026-11-22T10:00:00.000Z",
      source: "x-hp-stack: {}\n",
      valid: true,
      issues: [],
      parameters: PARAMETERS,
      preview,
    });
    expect(version.parameters).toEqual(PARAMETERS);

    const customer = {
      id: "atpl_demo",
      name: "Notes",
      description: "Notes app",
      category: "productivity",
      versionId: "atv_demo_2",
      versionNumber: 2,
      componentCount: 2,
      cpuMilli: 1500,
      memoryBytes: "805306368",
      volumeCount: 1,
      hasIngress: true,
      ingress: [{ componentKey: "app", port: 8080 }],
      components: [{ key: "app", cpuMilli: 1000, memoryBytes: "536870912" }],
    };
    expect(CustomerAppTemplateDtoSchema.safeParse({ ...customer, parameters: appTemplateInstallParameters(PARAMETERS) }).success).toBe(true);
    expect(CustomerAppTemplateDtoSchema.safeParse({ ...customer, parameters: [PARAMETERS[2]] }).success).toBe(false);
    expect(CustomerAppTemplateDtoSchema.safeParse({ ...customer, parameters: [PARAMETERS[4]] }).success).toBe(false);
  });
});
