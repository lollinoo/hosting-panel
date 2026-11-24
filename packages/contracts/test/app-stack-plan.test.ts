import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ApprovedStackPlanV1 as ApprovedStackPlan,
  type AppStackPlanComponentV1 as AppStackPlanComponent,
  ApprovedStackPlanSchema,
  AppStackPreviewSchema,
  appStackComponentHashInput,
  appStackEngineNameProblem,
  appStackPlanHashInput,
  sumAppStackPlanResources,
  toAppStackPreview,
} from "../src/app-templates/plan.js";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, findUnsafeDockerInputFields } from "../src/resources.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8"));
const PLAN_FIXTURE = fixture("plan.json");
const PREVIEW_FIXTURE = fixture("preview.json");
const SPEC_FIXTURE = fixture("spec.json");
const PLAN = ApprovedStackPlanSchema.parse(PLAN_FIXTURE) as ApprovedStackPlan;

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
/** A deep copy of the fixture plan changed by `change` (components: cache, app). */
const variant = (change: (plan: Mutable<ApprovedStackPlan>, cache: AppStackPlanComponent, app: AppStackPlanComponent) => void): unknown => {
  const plan = structuredClone(PLAN) as Mutable<ApprovedStackPlan>;
  change(plan, plan.components[0] as AppStackPlanComponent, plan.components[1] as AppStackPlanComponent);
  return plan;
};
const pathsOf = (value: unknown): string[] => {
  const result = ApprovedStackPlanSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join(".")).sort();
};
const envEntries = (count: number, value: string) =>
  Array.from({ length: count }, (_, i) => ({ name: `V${String(i).padStart(2, "0")}`, value }));
const ports = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);

describe("ApprovedStackPlanSchema: the fixture", () => {
  it("parses plan.json to an equal value with the same key order", () => {
    expect(PLAN).toEqual(PLAN_FIXTURE);
    expect(JSON.stringify(PLAN)).toBe(JSON.stringify(PLAN_FIXTURE));
  });
});

describe("ApprovedStackPlanSchema: ids", () => {
  it("accepts foreign organisation and allocation ids in UUID form", () => {
    const plan = variant((p) => {
      p.organizationId = "org_3984baf6-928d-40dd-b388-bfac50b5e54f";
      p.hostAllocationId = "alloc_3984baf6-928d-40dd-b388-bfac50b5e54f";
    });
    expect(pathsOf(plan)).toEqual([]);
    expect(pathsOf(variant((p) => void (p.organizationId = `o${"a".repeat(127)}`)))).toEqual([]);
  });

  it.each([
    ["a stack id with a hyphen", (p: Mutable<ApprovedStackPlan>) => void (p.stackId = "stk_3984baf6-928d"), ["stackId"]],
    ["a 65-character stack id", (p: Mutable<ApprovedStackPlan>) => void (p.stackId = `s${"a".repeat(64)}`), ["stackId"]],
    ["a revision id with a hyphen", (p: Mutable<ApprovedStackPlan>) => void (p.revisionId = "srev_a-b"), ["revisionId"]],
    ["a 129-character organisation id", (p: Mutable<ApprovedStackPlan>) => void (p.organizationId = `o${"a".repeat(128)}`), ["organizationId"]],
    ["an upper-case allocation id", (p: Mutable<ApprovedStackPlan>) => void (p.hostAllocationId = "Alloc_1"), ["hostAllocationId"]],
  ])("refuses %s", (_, change, paths) => {
    expect(pathsOf(variant(change))).toEqual(paths);
  });
});

describe("Engine name hp_app_<stackId>_<key> within one 63-character DNS label", () => {
  const MINTED = `stk_${"0".repeat(24)}`;
  const named = (stackId: string, appKey = "app") =>
    variant((p, _, app) => {
      p.stackId = stackId;
      app.key = appKey;
      (p.ingress[0] as { componentKey: string }).componentKey = appKey;
    });

  it("accepts a 27-character key and refuses a 28-character one with a minted stack id", () => {
    expect(pathsOf(named(MINTED, "a".repeat(27)))).toEqual([]);
    expect(pathsOf(named(MINTED, "a".repeat(28)))).toEqual(["components.1.key"]);
  });

  it("appStackEngineNameProblem refuses a name over 63 characters, a longer stack id with a shorter key included", () => {
    expect(appStackEngineNameProblem(MINTED, "a".repeat(27))).toBeNull();
    expect(appStackEngineNameProblem(MINTED, "a".repeat(28))).toBe("too_long");
    expect(appStackEngineNameProblem(`s${"a".repeat(49)}`, "cache")).toBeNull();
    expect(appStackEngineNameProblem(`s${"a".repeat(50)}`, "cache")).toBe("too_long");
  });
});

describe("ApprovedStackPlanSchema: refine rules", () => {
  const cases: Array<[string, (plan: Mutable<ApprovedStackPlan>, cache: AppStackPlanComponent, app: AppStackPlanComponent) => void, string[]]> = [
    ["plan over 262 144 bytes", (_, cache) => void (cache.environment = envEntries(64, "a".repeat(4_096))), [""]],
    ["dependsOn on a later component", (plan, cache, app) => void (plan.components = [app, cache]), ["components.0.dependsOn.0"]],
    ["cycle", (_, cache) => void (cache.dependsOn = ["app"]), ["components.0.dependsOn.0"]],
    ["self dependency", (_, __, app) => void (app.dependsOn = ["app"]), ["components.1.dependsOn.0"]],
    ["unknown dependency", (_, __, app) => void (app.dependsOn = ["db"]), ["components.1.dependsOn.0"]],
    ["duplicate dependency", (_, __, app) => void (app.dependsOn = ["cache", "cache"]), ["components.1.dependsOn.1"]],
    ["duplicate component key", (plan, cache) => void plan.components.push(structuredClone(cache)), ["components.2.key"]],
    ["unsorted environment", (_, __, app) => void app.environment.push({ name: "A_HOST", value: "x" }), ["components.1.environment.1.name"]],
    [
      "duplicate env name across kinds",
      (_, __, app) => void app.environment.unshift({ name: "APP_SECRET_FILE", value: "x" }),
      ["components.1.environment.0.name", "components.1.secretFiles.0.envName"],
    ],
    ["_FILE value entry", (_, __, app) => void (app.environment = [{ name: "CACHE_FILE", value: "cache" }]), ["components.1.environment.0.name"]],
    ["reserved value name", (_, __, app) => void (app.environment = [{ name: "LD_PRELOAD", value: "x" }]), ["components.1.environment.0.name"]],
    ["secret file name without _FILE", (_, __, app) => void ((app.secretFiles[0] as { envName: string }).envName = "APP_SECRET"), ["components.1.secretFiles.0.envName"]],
    [
      "unsorted secret files",
      (_, __, app) => void app.secretFiles.unshift({ envName: "B_FILE", parameterKey: "app_secret", version: 1 }),
      ["components.1.secretFiles.1.envName"],
    ],
    ["more than 64 env entries", (_, __, app) => void (app.environment = envEntries(64, "v")), ["components.1.environment"]],
    [
      "more than 8 secret parameters",
      (_, __, app) =>
        void (app.secretFiles = Array.from({ length: 9 }, (_, i) => ({ envName: `${String.fromCharCode(65 + i)}_FILE`, parameterKey: `p${i}`, version: 1 }))),
      ["components"],
    ],
    ["shell argv[0]", (_, __, app) => void (app.argv = ["/bin/sh", "-c", "serve"]), ["components.1.argv.0"]],
    ["env argv[0]", (_, __, app) => void (app.argv = ["/usr/bin/env", "serve"]), ["components.1.argv.0"]],
    ["shell argv[1]", (_, __, app) => void (app.argv = ["nohup", "sh", "-c", "serve"]), ["components.1.argv.1"]],
    ["shell argv[2]", (_, __, app) => void (app.argv = ["timeout", "5", "bash", "-c", "serve"]), ["components.1.argv.2"]],
    ["shell behind a loader", (_, __, app) => void (app.argv = ["/lib64/ld-linux-x86-64.so.2", "/bin/sh", "-c", "serve"]), ["components.1.argv.1"]],
    ["forbidden text in argv", (_, __, app) => void (app.argv = ["serve", "--socket=/run/docker.sock"]), ["components.1.argv.1"]],
    ["metadata endpoint in env", (_, __, app) => void ((app.environment[0] as { value: string }).value = "http://169.254.169.254/"), ["components.1.environment.0.value"]],
    ["control character in env", (_, __, app) => void ((app.environment[0] as { value: string }).value = "a\nb"), ["components.1.environment.0.value"]],
    ["unsorted expose", (_, __, app) => void (app.expose = [8081, 8080]), ["components.1.expose.1"]],
    ["expose over 16 in total", (_, cache, app) => void ((app.expose = ports(8080, 9)), (cache.expose = ports(6379, 9))), ["components"]],
    ["health port not exposed", (_, __, app) => void ((app.healthcheck as { port: number }).port = 9000), ["components.1.healthcheck.port"]],
    ["undeclared volume", (_, __, app) => void ((app.volumes[0] as { volumeKey: string }).volumeKey = "other"), ["components.1.volumes.0.volumeKey", "volumes.0.key"]],
    ["mount to /tmp", (_, __, app) => void ((app.volumes[0] as { containerPath: string }).containerPath = "/tmp/data"), ["components.1.volumes.0.containerPath"]],
    [
      "unsorted mounts",
      (_, __, app) => void app.volumes.unshift({ volumeKey: "data", containerPath: "/b", readOnly: true }),
      ["components.1.volumes.1.containerPath"],
    ],
    ["unmounted volume", (plan) => void plan.volumes.push({ key: "logs" }), ["volumes.1.key"]],
    ["duplicate plan volume", (plan) => void plan.volumes.push({ key: "data" }), ["volumes.1.key"]],
    ["ingress without health check", (plan) => void (plan.ingress = [{ componentKey: "cache", port: 6379 }]), ["ingress.0.componentKey"]],
    ["ingress to an unknown component", (plan) => void (plan.ingress = [{ componentKey: "db", port: 8080 }]), ["ingress.0.componentKey"]],
    ["ingress port not exposed", (plan) => void (plan.ingress = [{ componentKey: "app", port: 9000 }]), ["ingress.0.port"]],
    [
      "unsorted ingress",
      (plan, _, app) =>
        void ((app.expose = [8080, 8081]),
        (plan.ingress = [
          { componentKey: "app", port: 8081 },
          { componentKey: "app", port: 8080 },
        ])),
      ["ingress.1"],
    ],
    ["docker socket value (guard finders)", (_, cache) => void (cache.image = `/var/run/docker.sock@sha256:${"b".repeat(64)}`), [""]],
  ];

  it.each(cases)("refuses %s", (_, change, paths) => {
    expect(pathsOf(variant(change))).toEqual(paths);
  });

  it("refuses an extra key at every object", () => {
    const targets: Array<(plan: Record<string, unknown>) => object> = [
      (plan) => plan,
      (plan) => (plan.components as object[])[1] as object,
      (plan) => ((plan.components as Array<{ environment: object[] }>)[1] as { environment: object[] }).environment[0] as object,
      (plan) => ((plan.components as Array<{ secretFiles: object[] }>)[1] as { secretFiles: object[] }).secretFiles[0] as object,
      (plan) => ((plan.components as Array<{ resources: object }>)[1] as { resources: object }).resources,
      (plan) => ((plan.components as Array<{ volumes: object[] }>)[1] as { volumes: object[] }).volumes[0] as object,
      (plan) => ((plan.components as Array<{ healthcheck: object }>)[1] as { healthcheck: object }).healthcheck,
      (plan) => (plan.volumes as object[])[0] as object,
      (plan) => (plan.ingress as object[])[0] as object,
    ];
    for (const target of targets) {
      const plan = structuredClone(PLAN) as unknown as Record<string, unknown>;
      Object.assign(target(plan), { extra: 1 });
      expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(false);
    }
  });

  it("refuses an injected resolvedSecrets or password key", () => {
    expect(ApprovedStackPlanSchema.safeParse({ ...PLAN, resolvedSecrets: [{ parameterKey: "app_secret", value: "x" }] }).success).toBe(false);
    expect(pathsOf(variant((_, __, app) => Object.assign(app, { password: "x" })))).toEqual(["components.1"]);
  });
});

describe("hash-input selectors", () => {
  it("appStackPlanHashInput returns exactly the five hashed keys", () => {
    const input = appStackPlanHashInput(PLAN);
    expect(Object.keys(input).sort()).toEqual(["components", "ingress", "schemaVersion", "templateVersionId", "volumes"]);
    expect(input).not.toBe(PLAN);
  });

  it("appStackComponentHashInput returns schemaVersion, component and edge, or null", () => {
    const app = appStackComponentHashInput(PLAN, "app");
    expect(app && Object.keys(app).sort()).toEqual(["component", "edge", "schemaVersion"]);
    expect(app).toEqual({ schemaVersion: 1, component: PLAN.components[1], edge: true });
    expect(appStackComponentHashInput(PLAN, "cache")).toEqual({ schemaVersion: 1, component: PLAN.components[0], edge: false });
    expect(appStackComponentHashInput(PLAN, "db")).toBeNull();
  });
});

describe("preview", () => {
  it("toAppStackPreview gives preview.json: no ids, hash or secret versions", () => {
    const preview = toAppStackPreview(PLAN);
    expect(preview).toEqual(PREVIEW_FIXTURE);
    expect(JSON.stringify(preview)).toBe(JSON.stringify(PREVIEW_FIXTURE));
    expect(JSON.stringify(preview)).not.toMatch(/stackId|organizationId|hostAllocationId|templateVersionId|revisionId|planHash|"version"/);
  });

  it("AppStackPreviewSchema parses preview.json and refuses a version or an id", () => {
    expect(JSON.stringify(AppStackPreviewSchema.parse(PREVIEW_FIXTURE))).toBe(JSON.stringify(PREVIEW_FIXTURE));
    expect(AppStackPreviewSchema.safeParse({ ...(PREVIEW_FIXTURE as object), planHash: PLAN.planHash }).success).toBe(false);
    expect(AppStackPreviewSchema.safeParse({ ...(PREVIEW_FIXTURE as object), components: PLAN.components }).success).toBe(false);
  });
});

describe("sumAppStackPlanResources", () => {
  it("sums the fixture", () => {
    expect(sumAppStackPlanResources(PLAN)).toEqual({ components: 2, cpuMilli: 1_500, memoryBytes: "805306368" });
  });

  it("sums memory exactly beyond 2^32 and counts no component as zero", () => {
    const component = { ...PLAN.components[0], resources: { cpuMilli: 16_000, memoryBytes: "17179869184" } } as AppStackPlanComponent;
    expect(sumAppStackPlanResources({ components: Array.from({ length: 8 }, () => component) })).toEqual({
      components: 8,
      cpuMilli: 128_000,
      memoryBytes: "137438953472",
    });
    expect(sumAppStackPlanResources({ components: [] })).toEqual({ components: 0, cpuMilli: 0, memoryBytes: "0" });
  });
});

describe("§2.9 secret/redaction guards", () => {
  const KEYS =
    "schemaVersion name category description parameters key label type customer options min max default required services image tag digest command environment value secretParameter volumes volumeKey containerPath readOnly expose dependsOn healthcheck kind port path intervalSeconds timeoutSeconds limits cpuMilli memoryBytes ingress service stackId organizationId hostAllocationId templateVersionId revisionId planHash components runAsUser argv secretFiles envName parameterKey version resources componentKey edge".split(
      " ",
    );

  it.each([
    ["spec.json", SPEC_FIXTURE],
    ["plan.json", PLAN_FIXTURE],
    ["preview.json", PREVIEW_FIXTURE],
    ["the key list", Object.fromEntries(KEYS.map((key) => [key, "x"]))],
  ])("finds nothing in %s", (_, value) => {
    expect(findForbiddenPublicDtoKeys(value)).toEqual([]);
    expect(findPlaintextSecretKeys(value)).toEqual([]);
    expect(findUnsafeDockerInputFields(value)).toEqual([]);
  });
});
